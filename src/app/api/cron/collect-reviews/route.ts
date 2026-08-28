import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { runReviewSync } from "@/lib/order-converter/review-collect";
import { verifyCronAuth } from "@/lib/cron-auth";

export const maxDuration = 300;

// collect-qnas/naver-settlement-sync의 verifyCronAuth 패턴을 그대로 복제한다.
/**
 * 상품 리뷰 일일 수집(Phase 2b) — 공개 상품페이지 스크랩 → Drive 코퍼스 병합.
 * SSOT: REVIEW_QNA_COLLECTION_PLAN.md §2-B. 딜당 순차(코퍼스 단일 writer 계약 준수).
 *
 * ⚠️ Playwright 실행이라 Hobby 60s clamp에 걸린다 — runReviewSync가 실행 데드라인으로 중도
 * 이탈하고 잔여는 backlog로 다음 실행에 넘긴다(라운드로빈).
 */
async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runReviewSync();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[cron/collect-reviews] Unexpected error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withSystemTaskStatus("collect-reviews", handler);
