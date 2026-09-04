import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { parseCandidateQuery } from "@/lib/campaign-group-candidate-query";
import { campaignGroupRepository } from "@/repositories/campaignGroupRepository";
import { toCampaignGroupRow } from "@/lib/campaign-group-row";

/**
 * GET /api/campaign-groups/suggest?sellerId&startDate&endDate&excludeCampaignId (블루프린트 §3, 경로 ⓑ).
 *
 * 반환은 **기존 그룹 후보**(동일 셀러 · 날짜 포락선 겹침) — 미그룹 캠페인이 아니다.
 * 포락선 겹침: 그룹 롤업 `startDate <= rangeEnd AND endDate >= rangeStart`.
 * 후보 없으면 빈 배열. 합류는 PATCH { addCampaignIds }로 수행(별도 백엔드 없음).
 */

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const parsed = parseCandidateQuery(request.nextUrl.searchParams);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const groups = await campaignGroupRepository.findSuggestions({
      sellerId: parsed.data.sellerId,
      rangeStart: new Date(parsed.data.startDate),
      rangeEnd: new Date(parsed.data.endDate),
      excludeCampaignId: parsed.data.excludeCampaignId,
    });
    return NextResponse.json({ groups: groups.map(toCampaignGroupRow) });
  } catch (error) {
    console.error("GET /api/campaign-groups/suggest failed:", error);
    return NextResponse.json({ error: "합류 후보 조회에 실패했습니다." }, { status: 500 });
  }
}
