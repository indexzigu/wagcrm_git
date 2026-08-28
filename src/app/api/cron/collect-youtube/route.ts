import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { collectYouTubeSubscribers } from "@/lib/collectors/youtube-collector";
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

    return NextResponse.json(result);
  } catch (error) {
    console.error("YouTube collection cron error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withSystemTaskStatus("collect-youtube", handler);
