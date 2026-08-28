/**
 * `NaverOrderSnapshot.dailyAggregate` 인트라데이 버킷 1회성 백필 (2026-08-02).
 *
 * ⚠️ 레포 `.env`의 DATABASE_URL은 **프로덕션 Supabase DB**다(P0).
 * 그래서 기본 동작은 **예행(dry-run)** 이고, 실제 쓰기는 `--apply`가 있을 때만 한다.
 * 오너 확인 없이 --apply를 실행하지 말 것.
 *
 *   set -a; source .env; set +a          # P7 Script Env Loading
 *   npx tsx scripts/backfill-intraday-buckets.ts            # 예행
 *   npx tsx scripts/backfill-intraday-buckets.ts --apply    # 실행(오너 확인 후)
 *   npx tsx scripts/backfill-intraday-buckets.ts --days 30  # 최근 N일만(기본 전체)
 *
 * ── 왜 백필이 필요한가 ───────────────────────────────────────────────────
 * 인트라데이 버킷은 **쓰기 시점**에만 계산된다(읽기 시 블롭 재독은 P7 금지). 그런데 크론은
 * `runSync('CHANGED')` 만 돌아 **변경피드에 잡힌 날짜 + 오늘**만 다시 쓴다 — 즉 이미 조용해진
 * 과거 날짜는 아무도 다시 쓰지 않아 영영 버킷 없이 남는다. 인트라데이 차트의 목적이
 * "캠페인 구간 전체에서 봉우리가 어디였나"이므로 과거가 비면 기능이 성립하지 않는다.
 *
 * ── 무엇을 하는가 ────────────────────────────────────────────────────────
 * 버킷 마커(`bv`)가 없는 행의 `orders` 블롭을 읽어 **쓰기 경로와 같은 함수**
 * (`computeSnapshotDailyAggregate`)로 집계를 다시 만들고 `dailyAggregate` **한 컬럼만**
 * 갱신한다. 주문 데이터(orders)·카운트 컬럼·isDirty·커서는 건드리지 않고 네이버 호출도
 * 하지 않는다.
 *
 * ⚠️ **이 스크립트가 이 레포에서 orders 블롭을 대량으로 읽는 유일한 정당한 경로다**
 * (P7 Snapshot Blob Egress Discipline). 그래서 ①1회성이고 ②예행이 먼저 읽을 바이트 수를
 * 보고하며 ③행 단위로 진행 상황을 남긴다. 상시 잡으로 만들지 말 것.
 *
 * ── 재실행 안전 ──────────────────────────────────────────────────────────
 * 멱등하다 — 이미 `bv` 가 있는 행은 건너뛴다. 중단 후 재실행해도 남은 행만 처리한다.
 *
 * ── ⚠️ 왜 재계산본을 그대로 쓰지 않는가 (2026-08-02) ──────────────────────
 * 귀속 우주(`loadAggregationCampaignSources`)는 `orderCampaign.isActive: true` 만 담는다 —
 * 즉 **이미 마감된 캠페인의 과거 스냅샷은 재계산하면 그 리프가 사라진다.** 그대로 쓰면
 * 멀쩡히 저장돼 있던 집계가 **파괴**된다(데모 DB 53행에서 실제로 재현했다).
 *
 * 초판은 이를 "재계산이 기존보다 주문키가 줄면 **행 전체**를 건너뛴다"로 막았는데, 그 대가가
 * 컸다 — 마감 캠페인 하나가 섞였다는 이유로 **같은 행의 활성 캠페인까지 영구히 버킷을 못
 * 받았다.** 실측: 한 활성 그룹에서 **주문이 가장 몰린 캠페인 초반 구간**이 이 이유로
 * 화면에 「기록 없음」 회색 밴드로 남았다.
 *
 * 그래서 이제 **리프 단위 순수 가산 이식**(`graftIntradayBuckets`)을 쓴다: 기존 집계의 리프는
 * 하나도 건드리지 않고, `orderKeys` 가 정확히 일치하는 리프에만 `buckets` 를 붙인다.
 * 계약과 금지사항(⛔ 우주 확장 금지 — P7)은 그 함수의 주석이 정본이다.
 */
import { getPrisma } from "../src/lib/prisma";
import {
  computeSnapshotDailyAggregate,
  graftIntradayBuckets,
  loadAggregationCampaignSources,
  parseSnapshotDailyAggregate,
  SNAPSHOT_INTRADAY_BUCKET_VERSION,
} from "../src/lib/order-converter/daily-aggregate";
import { serializeDailyAggregate } from "../src/repositories/naverOrderSnapshotRepository";
import { toDateKeyKst, type PulseOrderLike } from "../src/lib/mobile-pulse-data";

const prisma = getPrisma();

const APPLY = process.argv.includes("--apply");
/**
 * 예행 심화 — 블롭을 읽고 이식까지 **계산만** 해보고 쓰지 않는다(읽기 전용).
 *
 * 기본 예행은 egress 규율(P7) 때문에 블롭을 읽지 않는데, 그러면 "몇 행이 대상인가"만 알 뿐
 * **"이식이 실제로 성공하는가"** 를 알 수 없다. 그건 `--apply` 로 프로덕션에 쓴 뒤에야
 * 드러나는데, 그 순서로는 승인 판단의 근거가 없다. 이 모드가 그 근거를 만든다.
 */
const DEEP = process.argv.includes("--deep");

function parseDaysArg(): number | null {
  const i = process.argv.indexOf("--days");
  if (i === -1) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** DB 값(Postgres 객체 | sqlite 문자열) → 배열. 형식 방어적. */
function readOrdersBlob(raw: unknown): PulseOrderLike[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? (parsed as PulseOrderLike[]) : [];
}

/** 이 행이 이미 버킷을 갖고 있는가(멱등 판정). */
function hasBuckets(rawAggregate: unknown): boolean {
  const parsed = parseSnapshotDailyAggregate(rawAggregate);
  return parsed?.bv === SNAPSHOT_INTRADAY_BUCKET_VERSION;
}


async function main() {
  const days = parseDaysArg();
  // snapshotDate 는 Date 가 아니라 KST 날짜키 문자열("YYYY-MM-DD")이다 — ISO 형식이라
  // 사전식 비교가 곧 시간순 비교다(Date 로 비교하면 Prisma 가 타입 불일치로 넘어진다).
  const where = days
    ? { snapshotDate: { gte: toDateKeyKst(new Date(Date.now() - days * 24 * 60 * 60 * 1000)) } }
    : {};

  // 판정에 필요한 최소 컬럼만 먼저 읽는다 — 블롭은 실제 대상 행에서만 읽는다(egress).
  const meta = await prisma.naverOrderSnapshot.findMany({
    where,
    select: { snapshotDate: true, ordersCount: true, dailyAggregate: true },
    orderBy: { snapshotDate: "desc" },
  });

  const targets = meta.filter((row) => !hasBuckets(row.dailyAggregate));
  const already = meta.length - targets.length;

  console.log(`대상 창: ${days ? `최근 ${days}일` : "전체"}`);
  console.log(`스냅샷 행: ${meta.length} (버킷 보유 ${already} · 백필 대상 ${targets.length})`);

  if (targets.length === 0) {
    console.log("백필할 행이 없습니다 — 전부 버킷을 갖고 있습니다.");
    return;
  }

  console.log(
    `대상 행의 주문 라인 합계: ${targets.reduce((sum, r) => sum + (r.ordersCount ?? 0), 0)}건`,
  );

  if (!APPLY && !DEEP) {
    console.log(
      "\n예행(dry-run)입니다 — 블롭을 읽지도, 쓰지도 않았습니다." +
        "\n이식이 실제로 되는지 미리 보려면 --deep(읽기 전용)," +
        "\n실행하려면 --apply 를 붙이세요(오너 확인 후). 둘 다 위 대상 행의 orders 블롭을 읽습니다.",
    );
    for (const row of targets.slice(0, 10)) {
      console.log(`  - ${row.snapshotDate} (주문 ${row.ordersCount ?? 0}건)`);
    }
    if (targets.length > 10) console.log(`  … 외 ${targets.length - 10}건`);
    return;
  }

  // 캠페인 우주는 쓰기 경로와 동일해야 한다 — 다른 집합을 넘기면 귀속 판정이 갈라진다.
  const universe = await loadAggregationCampaignSources(prisma);
  const label = APPLY ? "실행" : "예행 심화(읽기 전용)";
  console.log(`\n[${label}] 귀속 캠페인 우주: ${universe.length}건`);

  let updated = 0;
  let skippedEmpty = 0;
  let skippedNoGraft = 0;
  let totalGrafted = 0;
  let totalMismatched = 0;
  let blobBytes = 0;

  for (const target of targets) {
    const dateLabel = target.snapshotDate;
    const row = await prisma.naverOrderSnapshot.findUnique({
      where: { snapshotDate: target.snapshotDate },
      select: { orders: true },
    });
    const orders = readOrdersBlob(row?.orders);
    blobBytes += JSON.stringify(row?.orders ?? null).length;

    if (orders.length === 0) {
      // 블롭이 비었으면 집계를 새로 쓸 근거가 없다 — 기존 값을 덮지 않는다(무음 파괴 금지).
      skippedEmpty += 1;
      console.log(`  - ${dateLabel}: orders 블롭이 비어 건너뜀(기존 집계 보존)`);
      continue;
    }

    const recomputed = computeSnapshotDailyAggregate(universe, orders);
    const previous = parseSnapshotDailyAggregate(target.dailyAggregate);

    // 기존 집계가 없는 행(레거시·{v:0})은 이식할 대상 자체가 없다 — 재계산본을 그대로 쓴다.
    // 이 행은 지금도 읽기에서 블롭 폴백을 타고 있으므로 집계를 잃을 것이 없다.
    if (!previous) {
      if (APPLY) {
        await prisma.naverOrderSnapshot.update({
          where: { snapshotDate: target.snapshotDate },
          data: { dailyAggregate: serializeDailyAggregate(recomputed) as never },
        });
      }
      updated += 1;
      console.log(`  - ${dateLabel}: 신규 집계 기록(기존 집계 없음, 주문 ${orders.length}라인)`);
      continue;
    }

    // 리프 단위 순수 가산 이식 — 마감 캠페인이 섞여 있어도 활성 캠페인은 버킷을 받는다.
    // (종전의 "행 전체 스킵"이 정확히 그 활성 캠페인을 영구히 굶겼다 — graftIntradayBuckets 주석.)
    const { merged, grafted, mismatched } = graftIntradayBuckets(previous, recomputed);
    if (grafted === 0) {
      skippedNoGraft += 1;
      console.log(
        `  - ${dateLabel}: 건너뜀 — 이식할 리프가 없다(귀속 불일치 ${mismatched}건). ` +
          "기존 집계를 그대로 보존한다.",
      );
      continue;
    }

    if (APPLY) {
      await prisma.naverOrderSnapshot.update({
        where: { snapshotDate: target.snapshotDate },
        data: { dailyAggregate: serializeDailyAggregate(merged) as never },
      });
    }
    updated += 1;
    totalGrafted += grafted;
    totalMismatched += mismatched;
    console.log(
      `  - ${dateLabel}: 버킷 이식 ${grafted}리프` +
        (mismatched > 0 ? ` (귀속 불일치로 보류 ${mismatched}리프)` : "") +
        ` · 주문 ${orders.length}라인`,
    );
  }

  console.log(
    `\n[${APPLY ? "실행 완료" : "예행 심화 결과 — 쓰지 않았다"}] ` +
      `${APPLY ? "갱신" : "갱신 예정"} ${updated}행(버킷 이식 ${totalGrafted}리프) · ` +
      `블롭 비어 건너뜀 ${skippedEmpty}행 · 이식 대상 없어 건너뜀 ${skippedNoGraft}행 · ` +
      `읽은 블롭 ${(blobBytes / 1024).toFixed(1)}KB`,
  );
  if (totalMismatched > 0) {
    console.log(
      `⚠️ 귀속 불일치로 버킷을 보류한 리프 ${totalMismatched}건 — 재계산 우주가 그 사이 달라진 ` +
        "리프다(마감·신설). 기존 수치는 보존됐고 그 리프만 인트라데이가 없다.",
    );
  }

  if (!APPLY) {
    console.log("\n쓰기는 하지 않았습니다 — 실제 반영은 --apply(오너 확인 후)입니다.");
    return;
  }

  // 사후 확인 — 남은 대상이 0이어야 정상(비어/이식대상 없어 건너뛴 행은 남는다).
  const after = await prisma.naverOrderSnapshot.findMany({
    where,
    select: { dailyAggregate: true },
  });
  const remaining = after.filter((r) => !hasBuckets(r.dailyAggregate)).length;
  console.log(
    `[확인] 버킷 없는 행: ${remaining} (건너뛴 ${skippedEmpty + skippedNoGraft}행과 일치해야 정상)`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-intraday-buckets] 실패:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
