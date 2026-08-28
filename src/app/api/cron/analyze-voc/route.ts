import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { analyzeDirtyDeals } from "@/lib/order-converter/voc-insight";
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
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[cron/analyze-voc] Unexpected error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withSystemTaskStatus("analyze-voc", handler);
