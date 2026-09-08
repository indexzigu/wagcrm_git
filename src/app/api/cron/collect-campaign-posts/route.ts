import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { getPrisma } from "@/lib/prisma";
import { refreshCampaignWindowPosts } from "@/lib/campaign-posts-refresh";
import { declareTotalFailure } from "@/lib/cron-outcome";
import { verifyCronAuth } from "@/lib/cron-auth";

// 캠페인 수집창 셀러의 게시물(피드+릴스) 후보 일간 갱신 — 매일 1회(KST 00:00, capture-stories와
// 같은 GHA 발화에 함께 실림). 진행 캠페인 "콘텐츠 발행 확인"용(오너 2026-07-13): 셀러가 뭘
// 올렸는지 매일 자동으로 후보 피드에 잡혀야 한다. Tier0(Graph HTTP)만 사용 — 브라우저·Gemini·
// 유료 폴백 없음이라 서버에서 안정적. 셀러당 Graph 1콜, 수집창 셀러만이라 물량 소폭.
export const maxDuration = 300;

async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await refreshCampaignWindowPosts(getPrisma());

  // ⚠️ HTTP 200 이어도 시도한 셀러를 한 명도 갱신하지 못했으면 **실패로 선언**한다 — 선언이
  // 없으면 `withSystemTaskStatus` 가 SUCCESS 로 기록한다(`CronOutcomeBody` 계약).
  // 이 잡에는 그 형태의 실사고가 있다(2026-08-26, `campaign-posts-refresh.ts` 토큰 게이트
  // 주석): Tier0 토큰이 얹히지 않아 창 안 셀러를 한 명도 갱신 못 한 채 조기 반환했는데
  // 세 회차 모두 SUCCESS 였다.
  // 시도는 `activeSellers - skipped` 다 — 수집창에 셀러가 없으면(무비용 종료) 시도도 0이고,
  // 오늘 이미 갱신돼 건너뛴 셀러도 시도가 아니다. 둘 다 정상이다.
  const attempted = result.activeSellers - result.skipped;
  return NextResponse.json({
    ok: true,
    ...result,
    ...declareTotalFailure({
      attempted,
      succeeded: result.refreshed,
      unit: "명",
      what: "캠페인 셀러 게시물 갱신",
    }),
  });
}

export const GET = withSystemTaskStatus("collect-campaign-posts", handler);
