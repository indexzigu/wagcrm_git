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
const PARTNER_SEARCH_SELECT = {
  id: true,
  name: true,
  type: true,
  status: true,
  companyRole: true,
  createdAt: true,
  deals: {
    where: { parentDealId: null },
    select: { id: true, dealName: true },
    take: 3,
    orderBy: { createdAt: "desc" },
  },
} as const;

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

  // sort=created — 고르는 창(LinkSearchDialog)이 「최근 등록순」을 요청한다(오너 요청 2026-10-16).
  // 생략하면 종전대로 최근 캠페인 진행 거래처 우선.
  if (!query && searchParams.get("sort") === "created") {
    const partners = await prisma.partner.findMany({
      where: excludeIds.length > 0 ? { id: { notIn: excludeIds } } : undefined,
      orderBy: { createdAt: "desc" },
      take: 20,
      select: PARTNER_SEARCH_SELECT,
    });
    return NextResponse.json({ results: partners });
  }

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
      select: PARTNER_SEARCH_SELECT,
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
    select: PARTNER_SEARCH_SELECT,
  });

  return NextResponse.json({ results: partners });
}
