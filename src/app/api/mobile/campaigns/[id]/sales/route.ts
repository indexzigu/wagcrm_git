import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getMobileCampaignSales } from "@/lib/mobile-campaign-sales";

/**
 * GET /api/mobile/campaigns/[id]/sales — 모바일 캠페인 상세 매출현황.
 *
 * 읽기 전용: 진행중 캠페인은 영속화된 NaverOrderSnapshot, 마감 캠페인은
 * OrderCampaign.cached* 컬럼만 읽는다. 네이버 동기화(runSync)·API fetch·after()
 * 백그라운드 작업을 일절 트리거하지 않는다(mobile-pulse-data 와 동일 게이트).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;

  try {
    const detail = await getMobileCampaignSales(id);
    if (!detail) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    console.error(`GET /api/mobile/campaigns/${id}/sales failed:`, error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to load campaign sales" },
      { status: 500 },
    );
  }
}
