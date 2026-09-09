import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { runSync } from "@/lib/order-converter/naver-order-sync";
import { sweepBuyerFingerprints } from "@/lib/cross-campaign-repurchase";
import { ORDER_SYNC_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";
import { verifyCronAuth } from "@/lib/cron-auth";
import { getPrisma } from "@/lib/prisma";
import { syncCampaignStatusesBySchedule } from "@/lib/campaign-status-sync";

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

    // 캠페인 기간 도달/만료 상태 자동 전이 (2026-09-09 오너 확정: 시작일 도달 ACTIVE, 종료 +1일 경과 CLOSED)
    try {
      const statusSyncResult = await syncCampaignStatusesBySchedule(getPrisma());
      if (statusSyncResult.expiredToClosedCount > 0 || statusSyncResult.startedToActiveCount > 0) {
        console.log(
          `[cron/naver-order-sync] campaign status auto-transition: expired->closed: ${statusSyncResult.expiredToClosedCount}, started->active: ${statusSyncResult.startedToActiveCount}`,
        );
      }
    } catch (err) {
      console.error("[cron/naver-order-sync] 캠페인 상태 자동 전이 실패(sync 자체는 정상, 다음 주기 재시도):", err);
    }

    // fire-and-forget: 알림 처리 실패/지연이 이 응답을 막지 않는다.

    // ⚠️ HTTP 200 이어도 동기화가 실패했으면 **실패로 선언**한다(`failed: true`).
    // `runSync` 는 실패를 throw 하지 않고 `SyncResult.error` 에 담아 돌려주므로, 결과를
    // 그대로 넘기면 `withSystemTaskStatus` 가 SUCCESS 로 기록한다(CronOutcomeBody 계약).
    // 실사고 2026-08-31~09-08: 아웃바운드 프록시가 막혀 9일간 매일 `{"error":"fetch failed"}`
    // 를 담은 채 SUCCESS 로 남았고, **마지막 SUCCESS 시각**을 보는 지연 감시(`status.sh`)에도
    // 안 잡혀 주문 동기화가 멈춘 것을 아무도 몰랐다.
    // ⚠️ 선언은 부수효과(지문 스위프·캐시 무효화) **뒤**에 둔다 — 부분 실패는 저장에 성공한
    // 날짜가 있고, 조기 반환하면 그 날짜들의 캐시가 낡은 채로 남는다.
    if (result.error) {
      console.error("[cron/naver-order-sync] 동기화 실패:", result.error);
      return NextResponse.json({ ...result, failed: true, failureReason: result.error });
    }

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
