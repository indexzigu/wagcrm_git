import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { analyzeDirtyDeals } from "@/lib/order-converter/voc-insight";
import { declareTotalFailure } from "@/lib/cron-outcome";
import { verifyCronAuth } from "@/lib/cron-auth";

export const maxDuration = 300;

// naver-settlement-sync/collect-qnas의 verifyCronAuth 패턴을 그대로 복제한다.
/**
 * VOC AI 인사이트 일일 생성 — dirty 딜(신규 VOC 임계 초과)만 분석한다(비용 불변식 I2).
 * SSOT: REVIEW_QNA_COLLECTION_PLAN.md §6. 응답에 토큰 실측·규모 신호(§6-5)를 담는다.
 */
async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await analyzeDirtyDeals();

    // ⚠️ HTTP 200 이어도 분석을 시도한 딜이 전량 실패했으면 **실패로 선언**한다 — 선언이
    // 없으면 `withSystemTaskStatus` 가 SUCCESS 로 기록한다(`CronOutcomeBody` 계약).
    // ⚠️ **dirty 딜이 없어 분석 0건인 날이 이 잡의 평상시 모습이다**(비용 불변식 I2 — dirty
    // 딜만 분석한다). "산출 0"으로 판정하면 거의 매일 빨강이 되므로 시도 전량 실패만 본다.
    return NextResponse.json({
      ok: true,
      ...result,
      ...declareTotalFailure({
        attempted: result.analyzed + result.failedCount,
        succeeded: result.analyzed,
        unit: "건",
        what: "VOC 인사이트 분석",
      }),
    });
  } catch (error) {
    console.error("[cron/analyze-voc] Unexpected error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withSystemTaskStatus("analyze-voc", handler);
