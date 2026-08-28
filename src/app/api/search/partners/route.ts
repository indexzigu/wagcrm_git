import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { containsSearch } from "@/lib/prisma-search";

/**
 * GET /api/search/partners?q=keyword
 *
 * Searches partners by name (case-insensitive contains).
 * Returns up to 20 results.
 *
 * Requirements: 1.3, 9.6
 */
export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";
  const excludeIds = (searchParams.get("excludeIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const prisma = getPrisma();

  // When no query: return recent partners (최근 캠페인 진행 기준 우선)
  if (!query) {
    const recentCampaigns = await prisma.salesCampaign.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { deal: { select: { partnerId: true } } },
    });

    const partnerIds = new Set<string>();
    for (const c of recentCampaigns) {
      if (c.deal?.partnerId && !excludeIds.includes(c.deal.partnerId)) {
        partnerIds.add(c.deal.partnerId);
      }
      if (partnerIds.size >= 20) break;
    }

    if (partnerIds.size < 20) {
      const fallbackPartners = await prisma.partner.findMany({
        where: excludeIds.length > 0 ? { id: { notIn: excludeIds } } : undefined,
        orderBy: { createdAt: "desc" },
        take: 40,
        select: { id: true },
      });
      for (const p of fallbackPartners) {
        partnerIds.add(p.id);
        if (partnerIds.size >= 20) break;
      }
    }

    const partners = await prisma.partner.findMany({
      where: { id: { in: Array.from(partnerIds) } },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        companyRole: true,
        deals: {
          where: { parentDealId: null },
          select: { id: true, dealName: true },
          take: 3,
          orderBy: { createdAt: "desc" },
        },
      },
    });

    // 유지: partnerIds에 추가된 순서대로 정렬 (최근 캠페인 우선)
    const partnerMap = new Map(partners.map((p) => [p.id, p]));
    const sortedPartners = Array.from(partnerIds)
      .map((id) => partnerMap.get(id))
      .filter(Boolean);

    return NextResponse.json({ results: sortedPartners });
  }

  if (query.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const partners = await prisma.partner.findMany({
    where: {
      AND: [
        { name: containsSearch(query) },
        ...(excludeIds.length > 0 ? [{ id: { notIn: excludeIds } }] : []),
      ],
    },
    take: 20,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      companyRole: true,
      deals: {
        where: { parentDealId: null },
        select: { id: true, dealName: true },
        take: 3,
        orderBy: { createdAt: "desc" },
      },
    },
  });

  return NextResponse.json({ results: partners });
}
