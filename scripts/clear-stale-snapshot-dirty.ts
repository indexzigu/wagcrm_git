/**
 * `NaverOrderSnapshot.isDirty` 일회성 정리 (2026-07-30).
 *
 * ⚠️ 레포 `.env`의 DATABASE_URL은 **프로덕션 Supabase DB**다(P0).
 * 그래서 기본 동작은 **예행(dry-run)** 이고, 실제 쓰기는 `--apply`가 있을 때만 한다.
 * 오너 확인 없이 --apply를 실행하지 말 것.
 *
 *   set -a; source .env; set +a          # P7 Script Env Loading
 *   npx tsx scripts/clear-stale-snapshot-dirty.ts            # 예행
 *   npx tsx scripts/clear-stale-snapshot-dirty.ts --apply    # 실행(오너 확인 후)
 *
 * ── 왜 일회성 정리가 필요한가 ────────────────────────────────────────────
 * 무효화(`markAllDirty()`)가 최근 30일 전체를 dirty로 찍었는데, dirty를 지우는 주체는
 * "그 날짜의 upsert" 하나뿐이고 크론은 CHANGED만 돌아 **변경피드에 잡힌 날짜만** upsert한다.
 * 조용한 과거 날짜의 dirty는 지울 사람이 없어 단조 증가했다(실측 48행 중 47행 true).
 *
 * 무효화 경로를 타깃 `markDirty(dateKeys)`로 고쳐도 **이미 찍힌 행은 저절로 풀리지 않는다** —
 * 스냅샷 행을 지우는 코드가 레포에 없어 자연 만료 경로도 없기 때문이다. 그래서 구조 수정과
 * 짝을 이루는 1회 정리가 필요하다.
 *
 * ── 무엇을 지우고 무엇을 남기는가 ────────────────────────────────────────
 * **남긴다(=계속 dirty):** 오늘·어제 날짜. 이 둘은 실제로 변동 중이고, `isSnapshotStale`이
 * 어차피 당일 1분·신규주문 5분 TTL로 재조회를 태우므로 dirty를 지워봐야 의미가 없다.
 * 발주 조회 생략 게이트(`order-fetch-window`)도 같은 이유로 오늘·어제를 생략 대상에서 뺀다.
 *
 * **지운다:** 그보다 이른 날짜의 dirty. 이 행들의 dirty는 "이 날짜가 재조회가 필요하다"는
 * 관측이 아니라 **30일 뭉뚱그리기의 잔재**다. 지운 뒤에도 데이터 정확성은 떨어지지 않는다 —
 * `isSnapshotStale`의 나이 기반 규칙(14일 이상 72시간, 그 외 24시간)이 그대로 남아 재조회를
 * 태우고, 변경피드가 실제 변경을 계속 반영한다.
 *
 * ⚠️ 이 스크립트는 **관측 플래그만** 바꾼다. 주문 데이터(orders 블롭·카운트 컬럼)는
 * 건드리지 않고 네이버 호출도 하지 않는다.
 */
import { getPrisma } from "../src/lib/prisma";

const prisma = getPrisma();

const APPLY = process.argv.includes("--apply");

/** KST YYYY-MM-DD (naver-order-sync 의 toDateKeyKst 와 동형). */
function toDateKeyKst(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dt = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dt}`;
}

async function main() {
  const now = new Date();
  const todayKey = toDateKeyKst(now);
  const yesterdayKey = toDateKeyKst(new Date(now.getTime() - 24 * 60 * 60 * 1000));

  const rows = await prisma.naverOrderSnapshot.findMany({
    select: { snapshotDate: true, isDirty: true, lastCallTime: true, syncType: true },
    orderBy: { snapshotDate: "asc" },
  });

  const dirty = rows.filter((r) => r.isDirty);
  const targets = dirty.filter(
    (r) => r.snapshotDate !== todayKey && r.snapshotDate !== yesterdayKey,
  );
  const held = dirty.filter((r) => !targets.includes(r));

  console.log(`[스냅샷] 전체 ${rows.length}행 · dirty ${dirty.length}행`);
  console.log(`[유지] 오늘·어제 dirty ${held.length}행: ${held.map((r) => r.snapshotDate).join(", ") || "(없음)"}`);
  console.log(`[대상] 정리할 dirty ${targets.length}행`);
  for (const r of targets) {
    const ageHours = ((now.getTime() - new Date(r.lastCallTime).getTime()) / 3.6e6).toFixed(1);
    console.log(`  - ${r.snapshotDate} (마지막 호출 ${ageHours}시간 전 · syncType=${r.syncType})`);
  }

  if (targets.length === 0) {
    console.log("\n정리할 행이 없습니다.");
    return;
  }

  if (!APPLY) {
    console.log("\n예행(dry-run)입니다 — 아무것도 쓰지 않았습니다. 실행하려면 --apply 를 붙이세요(오너 확인 후).");
    return;
  }

  const result = await prisma.naverOrderSnapshot.updateMany({
    where: { snapshotDate: { in: targets.map((r) => r.snapshotDate) }, isDirty: true },
    data: { isDirty: false },
  });
  console.log(`\n[실행] isDirty=false 로 갱신한 행: ${result.count}`);

  const after = await prisma.naverOrderSnapshot.count({ where: { isDirty: true } });
  console.log(`[확인] 남은 dirty 행: ${after} (오늘·어제만 남아야 정상)`);
}

main()
  .catch((err) => {
    console.error("[clear-stale-snapshot-dirty] 실패:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
