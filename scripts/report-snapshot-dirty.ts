/**
 * `NaverOrderSnapshot` dirty 분포·신선도 읽기 전용 리포트 (2026-07-30).
 *
 * ⚠️ 레포 `.env` 의 DATABASE_URL 은 **프로덕션 Supabase DB** 다(P0).
 * 이 스크립트는 **읽기 전용**이다 — 쓰기 경로가 없다.
 *
 *   set -a; source .env; set +a          # P7 Script Env Loading
 *   npx tsx scripts/report-snapshot-dirty.ts
 *
 * ── 무엇에 쓰나 ──────────────────────────────────────────────────────────
 * `isDirty` 는 "이 날짜를 FULL 로 다시 받아야 하나"를 묻는 플래그다. 무효화가 최근 30일을
 * 뭉뚱그려 찍던 시절 **48행 중 47행이 상시 true** 가 돼 관측 가치를 잃었고(P7 의
 * *Snapshot Dirty Invalidation*), 타깃 `markDirty(dateKeys)` 로 수리했다.
 *
 * **이 리포트의 판정 기준:** 발송처리·마감취소를 몇 번 한 뒤에도 dirty 가 **그 날짜 주변에만**
 * 머물면 수리가 성립한 것이다. 다시 창 전체로 번지면 무효화 경로에 놓친 곳이 있다.
 *
 * ℹ️ **`clear-stale-snapshot-dirty.ts` 의 예행(dry-run)과 겹친다** — 그쪽도 dirty 목록과
 * 경과시간을 찍는다. 이 스크립트가 따로 있는 이유는 ①정리 의도 없이 분포만 보고 싶을 때
 * ②`syncType` 분포와 `ordersCount` 총계까지 한 번에 보고 싶을 때다. 둘 중 하나만 쓰겠다면
 * 정리 스크립트의 예행으로 충분하다.
 */
import { getPrisma } from "../src/lib/prisma";

const prisma = getPrisma();

async function main() {
  const rows = await prisma.naverOrderSnapshot.findMany({
    select: {
      snapshotDate: true,
      isDirty: true,
      lastCallTime: true,
      syncType: true,
      ordersCount: true,
      newOrdersCount: true,
    },
    orderBy: { snapshotDate: "asc" },
  });

  if (rows.length === 0) {
    console.log("스냅샷 행이 없습니다.");
    return;
  }

  const now = Date.now();
  const dirty = rows.filter((r) => r.isDirty);
  const ageHours = (d: Date) => (now - new Date(d).getTime()) / 3.6e6;

  // syncType은 스키마상 nullable(String?)이라 null이 인덱스 타입으로 못 들어간다(TS2538).
  // String(null) === "null"이라 JS가 암묵적으로 하던 키 변환과 동일한 결과를 유지한다.
  const bySync: Record<string, number> = {};
  for (const r of rows) {
    const key = String(r.syncType);
    bySync[key] = (bySync[key] ?? 0) + 1;
  }

  console.log(`[분포] 전체 ${rows.length}행 · dirty ${dirty.length}행 · clean ${rows.length - dirty.length}행`);
  console.log(`[syncType] ${Object.entries(bySync).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  // syncType=FULL 이 오래 남아 있으면 그 날짜가 부트스트랩 이후 한 번도 재기록되지 않았다는 뜻이다
  // (크론은 CHANGED 만 돌고 runFullSync 는 부트스트랩 전용).
  console.log(
    `[신선도] 최신 ${Math.min(...rows.map((r) => ageHours(r.lastCallTime))).toFixed(1)}시간 전 · ` +
      `최고령 ${Math.max(...rows.map((r) => ageHours(r.lastCallTime))).toFixed(1)}시간 전`,
  );

  if (dirty.length > 0) {
    console.log(`\n[dirty 목록]`);
    for (const r of dirty) {
      console.log(`  - ${r.snapshotDate} (마지막 호출 ${ageHours(r.lastCallTime).toFixed(1)}시간 전 · syncType=${r.syncType})`);
    }
    console.log(
      `\n판정: dirty 가 **최근 며칠에 몰려 있으면 정상**(그 날짜에 실제 무효화 사건이 있었다는 뜻).` +
        `\n      창 전체(30일)로 번져 있으면 무효화 경로에 놓친 곳이 있다 — P7 *Snapshot Dirty Invalidation* 참조.`,
    );
  } else {
    console.log("\ndirty 행이 없습니다 — 무효화가 타깃으로 동작 중이라는 신호다.");
  }
}

main()
  .catch((err) => {
    console.error("[report-snapshot-dirty] 실패:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
