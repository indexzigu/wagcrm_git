import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { runSettlementSync, recomputeClosedCampaignSettlements, syncPostCloseCancellations } from "@/lib/order-converter/naver-settlement-sync";
import { formatSettlementQueryPlan, loadSettlementQueryPlan } from "@/lib/order-converter/settlement-pending-dates";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import { verifyCronAuth } from "@/lib/cron-auth";

export const maxDuration = 300;

// collect-instagram/naver-order-sync의 verifyCronAuth 패턴을 그대로 복제한다.
/**
 * 네이버 정산 원장 일일 수집 + 마감 캠페인 결산 캐시 갱신.
 * 쿼리 파라미터(수동 백필용): ?settledDays=31&unsettledDays=31 (기본 3/21)
 * · ?includeLocked=1 — 이미 확정된(정산 락) 캠페인의 사후 취소를 강제로 재계산한다.
 *   호출: `run-cron.sh 'naver-settlement-sync?includeLocked=1'`(잡 이름이 URL 에 그대로
 *   이어 붙는다) 또는 수동 curl. ⛔ 레이더 실행 버튼은 쿼리를 안 붙여 이 레버를 못 쓴다.
 * · ?dryRun=1 — **네이버를 한 번도 부르지 않고** 「대기 기반 조회 계획」만 돌려준다
 *   (`settlement-pending-dates`). 재설계 1단계의 계측 레버다: 지금의 고정 달력(3+21일 =
 *   하루 24콜)과 계획의 `estimatedCalls` 를 하루 나란히 놓고 대조한 뒤 2단계에서 전환한다.
 *   ⛔ 이 플래그로는 아무것도 쓰지 않는다 — 결산·사후취소·캐시 무효화까지 전부 건너뛴다.
 *   호출: `run-cron.sh 'naver-settlement-sync?dryRun=1'`.
 */
async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const settledDays = Math.min(Math.max(Number(url.searchParams.get("settledDays")) || 3, 1), 62);
    const unsettledDays = Math.min(Math.max(Number(url.searchParams.get("unsettledDays")) || 21, 1), 62);
    const dryRun = url.searchParams.get("dryRun") === "1";

    // 정산이 시작된 캠페인은 **확정 계산을 한 번 마친 뒤로는** 건너뛴다(결과가 바뀔 수 없다).
    // 확정 여부는 `cachedPostCloseCancelFinalizedAt` 마커가 답하므로 0 으로 굳는 구멍이 없다 —
    // 이 옵션은 **그 위의 수동 레버**다(확정된 값이 틀렸다고 판단될 때 강제로 재계산한다).
    const includeLocked = url.searchParams.get("includeLocked") === "1";

    // 계획은 DB 만 읽으므로 dry-run 이 아닐 때도 매 회차 계산해 로그·응답에 남긴다 —
    // 전환(2단계) 전에 "새 규칙이었다면 몇 콜이었나"를 실운영에서 매일 쌓기 위한 계측이다.
    const { plan, claimSourceUnavailableDates } = await loadSettlementQueryPlan();
    // 크론 형제들(`[cron/naver-order-sync] …`)과 같은 관용구. cron.log 는 잘릴 수 있어
    // 판정 정본은 아래 응답(=`SystemTaskLog.details`)이고 이 줄은 즉시 확인용이다.
    console.log(`[cron/naver-settlement-sync] plan ${formatSettlementQueryPlan(plan)}`);
    if (claimSourceUnavailableDates.length > 0) {
      console.warn(
        `[cron/naver-settlement-sync] claimSource 판독 불가 ${claimSourceUnavailableDates.length}일 — 그 날짜는 취소 재진입을 판정할 수 없다:`,
        claimSourceUnavailableDates.join(","),
      );
    }

    if (dryRun) {
      return NextResponse.json({ ok: true, dryRun: true, plan, claimSourceUnavailableDates });
    }

    const sync = await runSettlementSync(settledDays, unsettledDays);
    const recompute = await recomputeClosedCampaignSettlements();
    const cancellations = await syncPostCloseCancellations({ includeLocked });

    // 이벤트 기반 무효화(2026-07-10): 정산 원장/결산 갱신을 /settlement·대시보드·P&L에 즉시 반영.
    // 과거엔 hot TTL(60s)이 이 역할을 대신했다 — 이제 TTL은 보험이고 반영은 태그가 담당.
    revalidateCampaignCaches();

    return NextResponse.json({ ok: true, settledDays, unsettledDays, includeLocked, plan, claimSourceUnavailableDates, ...sync, recompute, cancellations });
  } catch (error) {
    console.error("[cron/naver-settlement-sync] Unexpected error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withSystemTaskStatus("naver-settlement-sync", handler);
