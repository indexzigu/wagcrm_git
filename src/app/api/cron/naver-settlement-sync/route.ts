import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import {
  runPlannedSettlementSync,
  runSettlementSync,
  recomputeClosedCampaignSettlements,
  syncPostCloseCancellations,
} from "@/lib/order-converter/naver-settlement-sync";
import { formatSettlementQueryPlan, loadSettlementQueryPlan } from "@/lib/order-converter/settlement-pending-dates";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import { verifyCronAuth } from "@/lib/cron-auth";

export const maxDuration = 300;

// collect-instagram/naver-order-sync의 verifyCronAuth 패턴을 그대로 복제한다.
/**
 * 네이버 정산 원장 일일 수집 + 마감 캠페인 결산 캐시 갱신.
 *
 * **기본 경로 = 대기 기반 계획**(2단계, 2026-09-10): `settlement-pending-dates` 가 DB 만 읽어
 * 부를 결제일을 정하고 `runPlannedSettlementSync` 가 **그 날짜만** 조회한다. 종전 고정 달력
 * (정산완료일 3일 + 결제일 21일 = 데이터 유무와 무관하게 하루 24콜)은 **백필 전용**으로 남았다.
 *
 * 쿼리 파라미터:
 * · ?settledDays=N&unsettledDays=M — **백필.** 둘 중 하나라도 주면 계획 대신 고정 달력으로
 *   넓게 훑는다(재확인 창보다 긴 크론 중단 구간을 메우는 유일한 경로). 예: `?settledDays=31&unsettledDays=31`.
 *   호출: `run-cron.sh 'naver-settlement-sync?settledDays=31&unsettledDays=31'`.
 * · ?includeLocked=1 — 이미 확정된(정산 락) 캠페인의 사후 취소를 강제로 재계산한다.
 *   호출: `run-cron.sh 'naver-settlement-sync?includeLocked=1'`(잡 이름이 URL 에 그대로
 *   이어 붙는다) 또는 수동 curl. ⛔ 레이더 실행 버튼은 쿼리를 안 붙여 이 레버를 못 쓴다.
 * · ?dryRun=1 — **네이버를 한 번도 부르지 않고** 이번 회차에 부를 날짜(계획)만 돌려준다.
 *   ⛔ 이 플래그로는 아무것도 쓰지 않는다 — 결산·사후취소·캐시 무효화·크론 상태 기록까지
 *   전부 건너뛴다. 호출: `run-cron.sh 'naver-settlement-sync?dryRun=1'`.
 */
async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    // 백필은 **명시적으로 요청했을 때만**이다 — 파라미터가 하나라도 있으면 고정 달력으로 훑는다.
    // 기본값(3/21)을 기본 경로에 쓰던 종전 동작으로 되돌리면 하루 24콜이 다시 나간다.
    const backfill = url.searchParams.has("settledDays") || url.searchParams.has("unsettledDays");
    const settledDays = Math.min(Math.max(Number(url.searchParams.get("settledDays")) || 3, 1), 62);
    const unsettledDays = Math.min(Math.max(Number(url.searchParams.get("unsettledDays")) || 21, 1), 62);

    // 정산이 시작된 캠페인은 **확정 계산을 한 번 마친 뒤로는** 건너뛴다(결과가 바뀔 수 없다).
    // 확정 여부는 `cachedPostCloseCancelFinalizedAt` 마커가 답하므로 0 으로 굳는 구멍이 없다 —
    // 이 옵션은 **그 위의 수동 레버**다(확정된 값이 틀렸다고 판단될 때 강제로 재계산한다).
    const includeLocked = url.searchParams.get("includeLocked") === "1";

    // 계획은 DB 만 읽는다(네이버 0회). 기본 경로에서는 이 계획이 곧 이번 회차에 부를 날짜이고,
    // 백필 경로에서도 로그·응답에 남겨 「계획이었다면 몇 콜이었나」를 비교할 수 있게 한다.
    const { plan, claimSourceUnavailableDates } = await loadSettlementQueryPlan();
    // 크론 형제들(`[cron/naver-order-sync] …`)과 같은 관용구. cron.log 는 잘릴 수 있어
    // 판정 정본은 아래 응답(=`SystemTaskLog.details`)이고 이 줄은 즉시 확인용이다.
    console.log(`[cron/naver-settlement-sync] plan ${formatSettlementQueryPlan(plan)}`);
    if (plan.counters.truncatedDates > 0) {
      // 상한에 눌린 계획은 조용히 넘기지 않는다 — 그 회차는 대상 날짜를 다 못 본 것이다.
      console.warn(
        `[cron/naver-settlement-sync] 계획이 상한에 걸려 ${plan.counters.truncatedDates}일이 잘렸다 — 남은 날짜는 다음 회차로 밀린다`,
      );
    }
    if (claimSourceUnavailableDates.length > 0) {
      console.warn(
        `[cron/naver-settlement-sync] claimSource 판독 불가 ${claimSourceUnavailableDates.length}일 — 그 날짜는 취소 재진입을 판정할 수 없다:`,
        claimSourceUnavailableDates.join(","),
      );
    }

    const sync = backfill
      ? { mode: "backfill" as const, settledDays, unsettledDays, ...(await runSettlementSync(settledDays, unsettledDays)) }
      : { mode: "planned" as const, ...(await runPlannedSettlementSync(plan)) };
    const recompute = await recomputeClosedCampaignSettlements();
    const cancellations = await syncPostCloseCancellations({ includeLocked });

    // 이벤트 기반 무효화(2026-07-10): 정산 원장/결산 갱신을 /settlement·대시보드·P&L에 즉시 반영.
    // 과거엔 hot TTL(60s)이 이 역할을 대신했다 — 이제 TTL은 보험이고 반영은 태그가 담당.
    revalidateCampaignCaches();

    return NextResponse.json({ ok: true, includeLocked, ...sync, plan, claimSourceUnavailableDates, recompute, cancellations });
  } catch (error) {
    console.error("[cron/naver-settlement-sync] Unexpected error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * 계획만 계산해 돌려준다 — **네이버 호출 0, 쓰기 0.**
 *
 * 🪤 이 경로가 `withSystemTaskStatus` **밖에** 있는 것이 핵심이다. 그 래퍼는 인증된 크론
 * 호출마다 `RUNNING` → `SUCCESS` 를 기록하므로, dry-run 을 그 안에서 처리하면 **실제
 * 동기화를 한 적이 없는데** 마지막 실행 시각이 갱신되고 직전 실패 기록이 덮인다 — 레이더가
 * 정상 실행으로 표시된다(교차 검증이 모킹 실행으로 DB 쓰기 3회를 확인했다).
 * ⛔ 편의를 이유로 이 분기를 핸들러 안으로 되돌리지 말 것.
 */
async function dryRunHandler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { plan, claimSourceUnavailableDates } = await loadSettlementQueryPlan();
    console.log(`[cron/naver-settlement-sync] dry-run plan ${formatSettlementQueryPlan(plan)}`);
    return NextResponse.json({ ok: true, dryRun: true, plan, claimSourceUnavailableDates });
  } catch (error) {
    console.error("[cron/naver-settlement-sync] dry-run 실패:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}

const trackedHandler = withSystemTaskStatus("naver-settlement-sync", handler);

export const GET = async (request: Request): Promise<Response> => {
  if (new URL(request.url).searchParams.get("dryRun") === "1") return dryRunHandler(request);
  return trackedHandler(request);
};
