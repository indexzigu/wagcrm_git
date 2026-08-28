import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { campaignGroupRepository } from "@/repositories/campaignGroupRepository";
import { toCampaignGroupRow } from "@/lib/campaign-group-row";

/**
 * GET /api/campaign-groups/suggest?sellerId&startDate&endDate&excludeCampaignId (블루프린트 §3, 경로 ⓑ).
 *
 * 반환은 **기존 그룹 후보**(동일 셀러 · 날짜 포락선 겹침) — 미그룹 캠페인이 아니다.
 * 포락선 겹침: 그룹 롤업 `startDate <= rangeEnd AND endDate >= rangeStart`.
 * 후보 없으면 빈 배열. 합류는 PATCH { addCampaignIds }로 수행(별도 백엔드 없음).
 */

const suggestSchema = z.object({
  sellerId: z.string().min(1, "sellerId는 필수입니다."),
  startDate: z.string().date(),
  endDate: z.string().date(),
  excludeCampaignId: z.string().min(1).optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = request.nextUrl;
  const parsed = suggestSchema.safeParse({
    sellerId: searchParams.get("sellerId") ?? undefined,
    startDate: searchParams.get("startDate") ?? undefined,
    endDate: searchParams.get("endDate") ?? undefined,
    excludeCampaignId: searchParams.get("excludeCampaignId") ?? undefined,
  });
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
