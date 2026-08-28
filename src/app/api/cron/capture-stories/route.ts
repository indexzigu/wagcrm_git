import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { getPrisma } from "@/lib/prisma";
import { captureActiveCampaignStories, declareStoryCaptureOutcome } from "@/lib/story-capture";
import { verifyCronAuth } from "@/lib/cron-auth";

// 셀러 스토리 스냅샷 수집 — 매일 1회(KST 00:00 자정). Vercel Hobby 플랜은 크론을 하루 1회로
// 제한하므로 12h(2회)는 불가 → 자정 1회로 그날 스토리를 잡는다(스토리 24h 수명, 심야는 게시
// 저조라 사각 최소). 더 촘촘히 필요하면 "지금 수집" 버튼·로컬 러너로 보완. 수집 대상은 "행사
// 수집창(시작 7일 전~마감 1일 후)" 캠페인의 인스타 셀러 전원 — 태그·멘션 무관 전량, 분류는 나중에.
export const maxDuration = 300;

async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await captureActiveCampaignStories(getPrisma());

  // 실질 실패 판정은 로컬 러너와 공유하는 SSOT 다(판정 근거는 그 함수 주석 참조).
  return NextResponse.json({ ok: true, ...result, ...declareStoryCaptureOutcome(result) });
}

export const GET = withSystemTaskStatus("capture-stories", handler);
