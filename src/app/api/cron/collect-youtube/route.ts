import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { collectYouTubeSubscribers } from "@/lib/collectors/youtube-collector";
import { declareTotalFailure } from "@/lib/cron-outcome";
import { SELLER_METRICS_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";
import { verifyCronAuth } from "@/lib/cron-auth";

async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const host = request.headers.get("host") || "localhost:3000";
    const protocol = host.includes("localhost") ? "http" : "https";
    const baseUrl = `${protocol}://${host}`;

    const apiKey = process.env.YOUTUBE_API_KEY || "";
    const result = await collectYouTubeSubscribers({ apiKey, baseUrl });

    // 이벤트 기반 무효화(2026-07-10): 구독자 수 갱신을 셀러 목록/상세·대시보드에 즉시 반영.
    revalidateCrmTags(SELLER_METRICS_INVALIDATION_TAGS);

    // ⚠️ HTTP 200 이어도 시도한 셀러가 전원 실패했으면 **실패로 선언**한다 — 선언이 없으면
    // `withSystemTaskStatus` 가 SUCCESS 로 기록한다(`CronOutcomeBody` 계약).
    // 감시 셀러가 0명이면 시도도 0이라 정상이다(대상 없음을 빨강으로 만들지 않는다).
    return NextResponse.json({
      ...result,
      ...declareTotalFailure({
        attempted: result.successCount + result.failedCount,
        succeeded: result.successCount,
        unit: "명",
        what: "유튜브 구독자 수집",
      }),
    });
  } catch (error) {
    console.error("YouTube collection cron error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withSystemTaskStatus("collect-youtube", handler);
