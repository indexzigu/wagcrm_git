import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { runSync } from "@/lib/order-converter/naver-order-sync";
import { sweepBuyerFingerprints } from "@/lib/cross-campaign-repurchase";
import { ORDER_SYNC_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";
import { verifyCronAuth } from "@/lib/cron-auth";

// collect-instagram/route.ts의 verifyCronAuth 패턴을 그대로 복제한다.
// 운영자-무관 안전망(현재 scheduled-crons.yml 기준 하루 1회, 0 22 * * * UTC). 아무도 주문관리
// 페이지를 열지 않는 동안의 배경 최신화·클레임 알림을 담당한다 — 페이지 열림 트리거 SWR
// (campaigns-handler)과 독립. 페이지를 볼 때의 near-real-time 갱신은 그 SWR이 처리한다.
async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSync("CHANGED");

    if ((result?.affectedDates ?? []).length > 0) {
      // 구매자 지문 영구 저장(2026-07-11): 변경된 날짜의 스냅샷 주문을 회차에 귀속시켜
      // CampaignBuyerFingerprint에 적재 — 스냅샷 30일 만료 후에도 회차간 재구매 대조 가능.
      // 무효화보다 먼저 실행해 재빌드되는 캐시가 새 지문을 반영하게 한다. 멱등이라 실패해도
      // 다음 크론(15분)이 같은 날짜를 재커버한다 — 실패는 기록하되 sync 응답은 막지 않는다.
      try {
        const sweep = await sweepBuyerFingerprints(result.affectedDates);
        if (sweep.inserted > 0) {
          console.log(`[cron/naver-order-sync] buyer fingerprints +${sweep.inserted} (campaigns ${sweep.campaigns}, days ${sweep.snapshotDays})`);
        }
      } catch (err) {
        console.error("[cron/naver-order-sync] 구매자 지문 스위프 실패(sync 자체는 정상, 다음 주기 재시도):", err);
      }

      // 이벤트 기반 무효화(2026-07-10): 주문 스냅샷이 실제로 바뀐 날에만 포털 재구매/이력·
      // 파이프라인·정산 캐시를 깬다. 변경 없으면 캐시 유지(ISR Writes 절약).
      revalidateCrmTags(ORDER_SYNC_INVALIDATION_TAGS);
    }

    // fire-and-forget: 알림 처리 실패/지연이 이 응답을 막지 않는다.

    return NextResponse.json(result);
  } catch (error) {
    console.error("[cron/naver-order-sync] Unexpected error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withSystemTaskStatus("naver-order-sync", handler);
