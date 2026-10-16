import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { containsSearch, normalizedForms } from "@/lib/prisma-search";

/**
 * GET /api/search/campaigns
 *
 * Search campaigns by seller name or sales channel.
 * Supports excluding campaigns already linked to a specific deal.
 *
 * Query params:
 *   - q: search keyword (min 2 chars)
 *   - excludeDealId: exclude campaigns already linked to this deal
 *
 * Returns max 20 results.
 *
 * Requirements: 7.3, 7.4, 10.3
 */
export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";
  const excludeDealId = searchParams.get("excludeDealId")?.trim() || undefined;
  const excludeIds = (searchParams.get("excludeIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const prisma = getPrisma();

  const include = {
    seller: { select: { name: true, alias: true } },
    deal: { select: { id: true, dealName: true } },
  } as const;
  const toResult = (c: {
    id: string; salesChannel: string; status: string; startDate: Date; endDate: Date;
    seller: { name: string; alias: string | null }; deal: { id: string; dealName: string };
  }) => ({
    id: c.id,
    sellerName: c.seller.alias || c.seller.name,
    salesChannel: c.salesChannel,
    status: c.status,
    dealId: c.deal.id,
    dealName: c.deal.dealName,
    startDate: c.startDate.toISOString(),
    endDate: c.endDate.toISOString(),
  });

  // 빈 입력 = 최근 시작순 20건 — 다른 고르는 창(딜·거래처·셀러)과 같이 열자마자 목록이 보인다(2026-10-16).
  if (!query) {
    const recent = await prisma.salesCampaign.findMany({
      where: {
        AND: [
          ...(excludeDealId ? [{ dealId: { not: excludeDealId } }] : []),
          ...(excludeIds.length > 0 ? [{ id: { notIn: excludeIds } }] : []),
        ],
      },
      take: 20,
      include,
      orderBy: { startDate: "desc" },
    });
    return NextResponse.json({ results: recent.map(toResult) });
  }

  if (query.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const campaigns = await prisma.salesCampaign.findMany({
    where: {
      AND: [
        // Exclude campaigns already linked to the specified deal
        ...(excludeDealId ? [{ dealId: { not: excludeDealId } }] : []),
        ...(excludeIds.length > 0 ? [{ id: { notIn: excludeIds } }] : []),
        // Search by seller name or sales channel (case-insensitive)
        {
          OR: normalizedForms(query).flatMap((f) => [
            { seller: { name: containsSearch(f) } },
            { seller: { alias: containsSearch(f) } },
            { salesChannel: containsSearch(f) },
          ]),
        },
      ],
    },
    take: 20,
    include,
    orderBy: { startDate: "desc" },
  });

  return NextResponse.json({ results: campaigns.map(toResult) });
}
