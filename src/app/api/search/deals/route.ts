import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { normalizeDealBrandName } from "@/lib/deal-display";
import { containsSearch } from "@/lib/prisma-search";

/**
 * GET /api/search/deals
 *
 * Search deals by dealName or brandName with case-insensitive matching.
 * Supports excluding deals already linked to a specific partner.
 *
 * Query params:
 *   - q: search keyword (required, min 2 chars)
 *   - excludePartnerId: exclude deals already linked to this partner
 *   - status: filter by deal status (additive — 미전달 시 기존 동작 그대로)
 *
 * Returns: { results: Array<{ id, dealName, brandName, status, partnerId, partnerName }> }
 *
 * Requirements: 5.3, 10.3
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q")?.trim() ?? "";
  const excludePartnerId = searchParams.get("excludePartnerId");
  const status = searchParams.get("status")?.trim() || null;
  const excludeIds = (searchParams.get("excludeIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  try {
    const prisma = getPrisma();

    // When no query: return recent deals (최근 등록순)
    if (!q) {
      const where: Record<string, unknown> = {
        dealType: "MAIN",
      };
      if (status) {
        where.status = status;
      }
      if (excludePartnerId) {
        where.NOT = { partnerId: excludePartnerId };
      }
      if (excludeIds.length > 0) {
        where.id = { notIn: excludeIds };
      }

      const deals = await prisma.deal.findMany({
        where: Object.keys(where).length > 0 ? where : undefined,
        take: 20,
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          dealName: true,
          brandName: true,
          status: true,
          partnerId: true,
          partner: {
            select: { name: true, type: true },
          },
        },
      });

      const results = deals.map((deal) => ({
        id: deal.id,
        dealName: deal.dealName,
        brandName: normalizeDealBrandName(deal.brandName, deal.partner) ?? undefined,
        status: deal.status,
        partnerId: deal.partnerId,
        partnerName: deal.partner?.name ?? "거래처 없음",
      }));

      return NextResponse.json({ results });
    }

    // Return empty results for queries shorter than 2 characters
    if (q.length < 2) {
      return NextResponse.json({ results: [] });
    }

    // Build where clause
    const where: Record<string, unknown> = {
      dealType: "MAIN",
      OR: [
        { dealName: containsSearch(q) },
        { brandName: containsSearch(q) },
      ],
    };

    if (status) {
      where.status = status;
    }

    // Exclude deals already linked to the specified partner
    if (excludePartnerId) {
      where.NOT = { partnerId: excludePartnerId };
    }
    if (excludeIds.length > 0) {
      where.id = { notIn: excludeIds };
    }

    const deals = await prisma.deal.findMany({
      where,
      take: 20,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        dealName: true,
        brandName: true,
        status: true,
        partnerId: true,
        partner: {
          select: { name: true, type: true },
        },
      },
    });

    const results = deals.map((deal) => ({
      id: deal.id,
      dealName: deal.dealName,
      brandName: normalizeDealBrandName(deal.brandName, deal.partner) ?? undefined,
      status: deal.status,
      partnerId: deal.partnerId,
      partnerName: deal.partner?.name ?? "거래처 없음",
    }));

    return NextResponse.json({ results });
  } catch (error) {
    console.error("[/api/search/deals] Search failed:", error);
    return NextResponse.json(
      { error: "검색에 실패했습니다." },
      { status: 500 },
    );
  }
}
