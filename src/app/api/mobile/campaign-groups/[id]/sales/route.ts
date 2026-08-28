import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getMobileCampaignGroupSales } from "@/lib/mobile-campaign-sales";

/**
 * GET /api/mobile/campaign-groups/[id]/sales — 모바일 그룹 캠페인 통합 매출현황.
 *
 * 읽기 전용: 그룹 구성 캠페인의 발주 캠페인 캐시/스냅샷만 읽고, 네이버 동기화나
 * 외부 fetch 를 트리거하지 않는다. 단일 캠페인 상세와 동일한 응답 계약을 유지한다.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;

  try {
    const detail = await getMobileCampaignGroupSales(id);
    if (!detail) {
      return NextResponse.json({ error: "Campaign group not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    console.error(`GET /api/mobile/campaign-groups/${id}/sales failed:`, error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to load campaign group sales" },
      { status: 500 },
    );
  }
}
