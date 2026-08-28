/**
 * 과거 마감 캠페인의 10분 인트라데이 버킷(`OrderCampaign.cachedIntradayBuckets`) 소급 채움.
 *
 * 배경: 버킷은 이제 **마감 시점에 동결**된다(closed-campaign-cache SSOT). 동결 도입 이전에
 *   마감된 캠페인은 컬럼이 null 이라 읽기 경로가 "인트라데이 없음"으로 degrade 하고,
 *   캠페인 상세의 콘텐츠×주문 타임라인이 일별 해상도로만 그려진다. 이 스크립트가 그 공백을 메운다.
 *
 * ⛔ **네이버를 다시 조회하지 않는다 — 의도적 설계다.** `scripts/recalc-closed-campaign-cache.ts`
 *   와 admin recalc 라우트는 네이버를 재조회하는데, 판매기간이 오래 지나면 **조회창 만료로 빈
 *   결과**가 온다(그래서 두 경로 모두 `prevHadData && nextIsEmpty` 보존 가드를 달고 있다).
 *   여기서는 이미 영속된 `NaverOrderSnapshot.orders` 를 원천으로 쓴다 — 조회창과 무관하고,
 *   같은 `computeClosedCampaignCache`(SSOT)를 태우므로 마감 시 동결했을 값과 동일하다.
 *
 * **보존 가드는 구조적으로 성립한다:** 쓰기는 `cachedIntradayBuckets` **한 컬럼뿐**이고,
 *   계산 결과가 비면(원천 부재·창 밖) 아무것도 쓰지 않는다. 즉 기존 마감 기록(매출·수량·
 *   인사이트·일별)은 이 스크립트가 건드릴 수 있는 대상이 아니다. 그래도 dry-run 에서
 *   재계산 매출과 동결된 `cachedTotalRevenue` 를 나란히 찍는다 — 크게 어긋나면 그 캠페인의
 *   스냅샷 커버리지가 부족하다는 뜻이므로 적용 전에 사람이 판단한다.
 *
 * ⚠️ 스냅샷 보존 창(약 30일) 밖에서 마감된 캠페인은 원천이 없어 **소급이 불가능**하다.
 *   그 캠페인들은 계속 일별 해상도로 남는다(정직한 degrade — 없는 데이터를 지어내지 않는다).
 *
 * ⚠️ 이 스크립트는 `orders` 블롭을 읽는다(P7 Snapshot Blob Egress Discipline 의 예외).
 *   근거: ①1회성 운영 스크립트라 상시 read-path 가 아니다 ②날짜 단위로 dedup 해 창 전체가
 *   최대 스냅샷 행 수(실측 48행)만큼만 읽힌다 ③버킷은 주문 시각별 분해라 집계 컬럼
 *   (`dailyAggregate`)만으로는 마감 캐시와 같은 귀속 규칙을 재현할 수 없다.
 *
 * 사용(레포 .env 는 **프로덕션 DB** 다 — P0):
 *   set -a; source .env; set +a; npx tsx scripts/backfill-closed-intraday-buckets.ts            # dry-run(기본)
 *   set -a; source .env; set +a; npx tsx scripts/backfill-closed-intraday-buckets.ts --id=<id>  # 한 건만
 *   set -a; source .env; set +a; npx tsx scripts/backfill-closed-intraday-buckets.ts --all      # 이미 채워진 것도 재계산
 *   set -a; source .env; set +a; npx tsx scripts/backfill-closed-intraday-buckets.ts --apply    # 실제 DB 반영(오너 승인 사안)
 *   … --allow-drift                                                                            # 매출 드리프트 보류 해제
 */
import { getPrisma } from "../src/lib/prisma";
import { orderFulfillmentRepository } from "../src/repositories/orderFulfillmentRepository";
import {
  computeClosedCampaignCache,
  parseFrozenIntradayBuckets,
  resolveClosedCampaignPeriod,
} from "../src/lib/order-converter/closed-campaign-cache";
import { toDateKeyKst } from "../src/lib/mobile-pulse-data";

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 캠페인 창의 KST 날짜키를 열거한다(창 시작 ~ min(창 종료, 오늘)).
 *
 * ⛔ **`now − N일` 하한을 두지 않는다.** 처음엔 `enumerateSnapshotDateKeys`(동기화용)를 재사용했는데,
 * 그 함수는 스냅샷 **쓰기** 창(`SNAPSHOT_WINDOW_DAYS=30`)으로 클리핑한다 — 6월에 마감된 캠페인 4건이
 * 통째로 "창 0일"로 스킵됐다. `NaverOrderSnapshot` 행을 지우는 코드는 레포에 없으므로 그 날짜의 원천은
 * **여전히 DB에 있다**: 30일은 "무엇을 쓰는가"의 상한이지 "무엇이 존재하는가"가 아니다.
 * (PR #248 이 읽기 경로에서 고친 것과 **정확히 같은 결함**이다 — 소급 스크립트에서 재발했다.)
 * 존재하지 않는 날짜는 조회가 알아서 0행을 돌려주므로 하한 없이 열거해도 안전하다.
 */
function enumerateCampaignDateKeys(startMs: number, endMs: number): string[] {
  if (!Number.isFinite(startMs)) return [];
  const to = Math.min(endMs, Date.now());
  if (to < startMs) return [];
  // KST 자정 정렬 후 하루씩 전진(UTC 자정=KST 09:00 에서 전진하면 청크가 두 날짜에 걸친다).
  const firstKstMidnightUtcMs =
    Math.floor((startMs + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
  const keys: string[] = [];
  for (let t = firstKstMidnightUtcMs; t <= to; t += DAY_MS) {
    keys.push(toDateKeyKst(new Date(t)));
    // 폭주 가드 — 종료 미정('~ 계속')이 먼 미래로 파싱되는 경우 대비. 도메인 규칙이 아니다.
    if (keys.length >= 400) break;
  }
  return keys;
}

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALL = args.includes("--all"); // 이미 값이 있는 캠페인도 재계산
const idArg = args.find((a) => a.startsWith("--id="))?.slice("--id=".length) ?? "";
const nameArg = args.find((a) => a.startsWith("--name="))?.slice("--name=".length) ?? "";
const limitArg = Number(args.find((a) => a.startsWith("--limit="))?.slice("--limit=".length) ?? "0");
// 재계산 매출이 동결 매출과 이만큼(%) 넘게 어긋나면 보류한다 — `recalc-closed-campaign-cache.ts`
// 의 `--allow-zero` 와 같은 관례(의심스러우면 쓰지 않는다). --allow-drift 로 명시 해제한다.
const ALLOW_DRIFT = args.includes("--allow-drift");
const DRIFT_TOLERANCE_PCT = 10;

const won = (n: number | null | undefined) => (n ?? 0).toLocaleString();

function safeParseOrders(raw: unknown): any[] {
  const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  return Array.isArray(parsed) ? parsed : [];
}

async function main() {
  const prisma = getPrisma();
  console.log(`\n=== 마감 캠페인 인트라데이 버킷 소급 (${APPLY ? "APPLY — DB 반영" : "DRY-RUN — 쓰기 없음"}) ===`);

  let campaigns = await prisma.orderCampaign.findMany({
    where: { isActive: false },
    include: { mappings: true },
    orderBy: { updatedAt: "desc" },
  });
  if (idArg) campaigns = campaigns.filter((c: any) => c.id === idArg);
  if (nameArg) campaigns = campaigns.filter((c: any) => (c.name || "").includes(nameArg));
  if (!ALL) {
    campaigns = campaigns.filter((c: any) => parseFrozenIntradayBuckets(c.cachedIntradayBuckets) === null);
  }
  if (limitArg > 0) campaigns = campaigns.slice(0, limitArg);

  console.log(`  대상 마감 캠페인: ${campaigns.length}건${ALL ? " (--all: 기존 값도 재계산)" : " (버킷 없는 건만)"}\n`);
  if (campaigns.length === 0) { await (prisma as any).$disconnect?.(); return; }

  // 교차 귀속 가드용 peer — 필터와 무관하게 전 캠페인(recalc 스크립트와 동일한 이유:
  // 대상만 넘기면 한 건씩 돌릴 때와 전량 돌릴 때 결과가 갈린다).
  const peerCampaigns = await prisma.orderCampaign.findMany({
    select: { id: true, name: true, startDate: true, endDate: true, salePeriod: true },
  });

  // 창 → 스냅샷 날짜키. 캠페인 간 dedup 해 블롭을 날짜당 한 번만 읽는다.
  const nowMs = Date.now();
  const windows = new Map<string, { start: Date; end: Date | null; dateKeys: string[] }>();
  const allDateKeys = new Set<string>();
  for (const camp of campaigns as any[]) {
    const { start, end } = resolveClosedCampaignPeriod(camp);
    if (!start) { console.log(`  ⏭  "${camp.name}" — 판매기간(start) 불명, 스킵`); continue; }
    const dateKeys = enumerateCampaignDateKeys(start.getTime(), end ? end.getTime() : nowMs);
    windows.set(camp.id, { start, end, dateKeys });
    for (const key of dateKeys) allDateKeys.add(key);
  }
  if (allDateKeys.size === 0) {
    console.log("  스냅샷 보존 창 안에 겹치는 날짜가 없다 — 소급 가능한 원천이 없다.");
    await (prisma as any).$disconnect?.();
    return;
  }

  console.log(`  스냅샷 조회 대상 날짜: ${allDateKeys.size}일 (orders 블롭 — 1회성 읽기)\n`);
  const snapshots = await prisma.naverOrderSnapshot.findMany({
    where: { snapshotDate: { in: [...allDateKeys] } },
    select: { snapshotDate: true, orders: true },
  });
  const ordersByDate = new Map<string, any[]>(
    snapshots.map((row: any) => [row.snapshotDate, safeParseOrders(row.orders)]),
  );
  const missingDates = [...allDateKeys].filter((key) => !ordersByDate.has(key)).sort();
  if (missingDates.length > 0) {
    // 삼키지 않는다(P0) — "그 날 주문이 0"과 "스냅샷 행이 없다"는 다른 사실이다.
    console.log(`  ⚠️  스냅샷 행 없음 ${missingDates.length}일: ${missingDates.join(",")}\n`);
  }

  let filled = 0, empty = 0, applied = 0, skipped = 0;

  for (const camp of campaigns as any[]) {
    const window = windows.get(camp.id);
    if (!window) { skipped++; continue; }

    const orders = window.dateKeys.flatMap((key) => ordersByDate.get(key) ?? []);
    if (orders.length === 0) {
      console.log(`  ⏭  "${camp.name}" — 창(${window.dateKeys.length}일)에 스냅샷 주문 0건, 스킵`);
      skipped++; continue;
    }

    let poRequestedSet = new Set<string>();
    try {
      poRequestedSet = await orderFulfillmentRepository.getPoRequestedSet(
        orders.map((o: any) => o?.productOrderId).filter(Boolean),
      );
    } catch { /* 빈 집합 폴백 — 버킷은 poRequested 와 무관하므로 영향 없음 */ }

    const next = computeClosedCampaignCache(
      camp,
      orders,
      poRequestedSet,
      { start: window.start, end: window.end },
      peerCampaigns,
    );

    const frozen = parseFrozenIntradayBuckets(next.cachedIntradayBuckets);
    const dayCount = frozen ? Object.keys(frozen.days).length : 0;
    const pointCount = frozen
      ? Object.values(frozen.days).reduce((sum, buckets) => sum + Object.keys(buckets).length, 0)
      : 0;

    if (dayCount === 0) {
      // 계산 결과가 비면 쓰지 않는다 — 위 「보존 가드」. 원천 부재를 0으로 굳히지 않는다.
      console.log(`  ⏭  "${camp.name}" — 귀속 주문 0건(스냅샷 ${orders.length}행 중), 쓰지 않음`);
      empty++; continue;
    }

    // 대조: 스냅샷 재계산 매출 vs 마감 시 동결된 매출. 크게 어긋나면 스냅샷 커버리지가 부족하다.
    const storedRevenue = camp.cachedTotalRevenue ?? 0;
    const ratio = storedRevenue > 0 ? Math.round((next.cachedTotalRevenue / storedRevenue) * 100) : null;
    console.log(`  🔧 "${camp.name}"  버킷 ${dayCount}일 · ${pointCount}칸`);
    console.log(`       재계산 매출 ${won(next.cachedTotalRevenue)} vs 동결 매출 ${won(storedRevenue)}${ratio === null ? "" : ` (${ratio}%)`}`);
    const drifted = ratio !== null && (ratio < 100 - DRIFT_TOLERANCE_PCT || ratio > 100 + DRIFT_TOLERANCE_PCT);
    if (drifted) {
      console.log(`       ⚠️  ${DRIFT_TOLERANCE_PCT}% 넘게 어긋난다. 원인 후보 2가지 —`);
      console.log(`           ① 스냅샷 커버리지 부족(그 날짜 행이 없거나 절단됨)`);
      console.log(`           ② **같은 링크 순차 전환에서 창이 겹침**(P7 Same-Link Campaign Handover) — 그 구간 주문은`);
      console.log(`              셀러를 가릴 신호가 없어 교차 귀속 가드가 마감 시점과 다르게 배분할 수 있다. 짝이 되는`);
      console.log(`              캠페인의 비율이 반대 방향으로 어긋나 있으면(합계는 비슷) 이쪽이다 — 커버리지 문제가 아니다.`);
    }

    if (drifted && !ALLOW_DRIFT) {
      console.log(`       ⏭  드리프트 게이트로 보류 — 강제하려면 --allow-drift (recalc 스크립트의 --allow-zero 와 같은 관례).`);
      skipped++; continue;
    }

    filled++;
    if (APPLY) {
      // ⚠️ 쓰는 컬럼은 이것 하나뿐이다. 다른 마감 캐시를 함께 덮지 않는다.
      await prisma.orderCampaign.update({
        where: { id: camp.id },
        data: { cachedIntradayBuckets: next.cachedIntradayBuckets } as any,
      });
      applied++;
      console.log(`       ✅ DB 반영됨`);
    }
  }

  console.log(`\n=== 요약 ===`);
  console.log(`  채울 수 있음: ${filled}건 · 원천 없음(쓰지 않음): ${empty}건 · 스킵: ${skipped}건`);
  if (APPLY) console.log(`  DB 반영: ${applied}건`);
  else console.log(`  (dry-run — 반영하려면 --apply. 프로덕션 DB 쓰기이므로 오너 승인 사안이다.)`);

  await (prisma as any).$disconnect?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
