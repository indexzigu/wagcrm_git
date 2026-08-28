import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { runQnaSync } from "@/lib/order-converter/naver-qna-sync";
import { verifyCronAuth } from "@/lib/cron-auth";

export const maxDuration = 300;

// naver-settlement-sync/naver-order-sync의 verifyCronAuth 패턴을 그대로 복제한다.
/**
 * 상품 문의(VOC) 일일 수집 — 상품문의 + 고객문의. SSOT: REVIEW_QNA_COLLECTION_PLAN.md.
 * 쿼리 파라미터(수동 백필용): ?lookbackDays=31 (기본 3).
 */
async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const lookbackDays = Math.min(Math.max(Number(url.searchParams.get("lookbackDays")) || 3, 1), 31);

    const result = await runQnaSync(lookbackDays);

    return NextResponse.json({ ok: true, lookbackDays, ...result });
  } catch (error) {
    console.error("[cron/collect-qnas] Unexpected error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withSystemTaskStatus("collect-qnas", handler);
