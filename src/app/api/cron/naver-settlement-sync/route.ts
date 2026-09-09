import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { runSettlementSync, recomputeClosedCampaignSettlements, syncPostCloseCancellations } from "@/lib/order-converter/naver-settlement-sync";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import { verifyCronAuth } from "@/lib/cron-auth";

export const maxDuration = 300;

// collect-instagram/naver-order-sync의 verifyCronAuth 패턴을 그대로 복제한다.
/**
 * 네이버 정산 원장 일일 수집 + 마감 캠페인 결산 캐시 갱신.
 * 쿼리 파라미터(수동 백필용): ?settledDays=31&unsettledDays=31 (기본 3/21)
 * · ?includeLocked=1 — 정산이 시작된 캠페인의 사후 취소를 강제로 재계산한다.
 *   호출: `run-cron.sh 'naver-settlement-sync?includeLocked=1'`(잡 이름이 URL 에 그대로
 *   이어 붙는다) 또는 수동 curl. ⛔ 레이더 실행 버튼은 쿼리를 안 붙여 이 레버를 못 쓴다.
 */
async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const settledDays = Math.min(Math.max(Number(url.searchParams.get("settledDays")) || 3, 1), 62);
    const unsettledDays = Math.min(Math.max(Number(url.searchParams.get("unsettledDays")) || 21, 1), 62);

    // 정산이 시작된 캠페인은 기본적으로 건너뛴다(결과가 바뀔 수 없다). 0 으로 굳는 구멍은
    // 그쪽 코드가 스스로 닫으므로(값이 아직 0 이면 건너뛰지 않는다) 이 옵션은 **그 위의
    // 수동 레버**다 — 값이 0 이 아닌데 틀린 경우에 강제로 재계산한다.
    const includeLocked = url.searchParams.get("includeLocked") === "1";

    const sync = await runSettlementSync(settledDays, unsettledDays);
    const recompute = await recomputeClosedCampaignSettlements();
    const cancellations = await syncPostCloseCancellations({ includeLocked });

    // 이벤트 기반 무효화(2026-07-10): 정산 원장/결산 갱신을 /settlement·대시보드·P&L에 즉시 반영.
    // 과거엔 hot TTL(60s)이 이 역할을 대신했다 — 이제 TTL은 보험이고 반영은 태그가 담당.
    revalidateCampaignCaches();

    return NextResponse.json({ ok: true, settledDays, unsettledDays, includeLocked, ...sync, recompute, cancellations });
  } catch (error) {
    console.error("[cron/naver-settlement-sync] Unexpected error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withSystemTaskStatus("naver-settlement-sync", handler);
