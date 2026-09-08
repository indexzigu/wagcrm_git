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
    // ⚠️ 시도는 `monitoredCount - skippedCount` 이지 `successCount + failedCount` 가 아니다 —
    // 쿼터 소진·키 미설정처럼 **단계가 통째로 막히면 두 카운터가 모두 0**이라, 그것으로 재면
    // 이 잡이 죽은 날과 "감시 셀러가 없는 날"이 구분되지 않는다.
    // 감시 셀러가 0명이거나 전원 멱등 스킵이면 시도도 0이라 정상이다.
    // ⚠️ 성공에 `dispatchedCount` 를 더한다 — Apify 경로는 **발주에 성공해도** 적립을 웹훅에
    // 넘기므로 `successCount` 가 0인 채로 정상 종료한다. 빼면 정상 발주가 매번 빨강이 된다.
    return NextResponse.json({
      ...result,
      ...declareTotalFailure({
        attempted: result.monitoredCount - result.skippedCount,
        succeeded: result.successCount + result.dispatchedCount,
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
