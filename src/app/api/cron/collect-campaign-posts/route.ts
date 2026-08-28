import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { getPrisma } from "@/lib/prisma";
import { refreshCampaignWindowPosts } from "@/lib/campaign-posts-refresh";
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
  // 수집창에 셀러가 없으면 Graph 호출 없이 무비용 종료(정상)
  return NextResponse.json({ ok: true, ...result });
}

export const GET = withSystemTaskStatus("collect-campaign-posts", handler);
