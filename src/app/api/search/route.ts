import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { containsSearch, normalizedForms } from "@/lib/prisma-search";

export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";

  if (query.length < 2) {
    return NextResponse.json({
      partners: [],
      sellers: [],
      deals: [],
      campaigns: [],
    });
  }

  const prisma = getPrisma();
  const forms = normalizedForms(query);

  const [partners, sellers, deals, campaigns] = await Promise.all([
    prisma.partner.findMany({
      where: { OR: forms.map((f) => ({ name: containsSearch(f) })) },
      take: 5,
      select: { id: true, name: true, type: true },
    }),
    prisma.seller.findMany({
      where: {
        OR: forms.flatMap((f) => [
          { name: containsSearch(f) },
          { alias: containsSearch(f) },
          { snsHandle: containsSearch(f) },
        ]),
      },
      take: 5,
      select: { id: true, name: true, alias: true, snsHandle: true, snsType: true },
    }),
    prisma.deal.findMany({
      where: { OR: forms.map((f) => ({ dealName: containsSearch(f) })) },
      take: 5,
      select: {
        id: true,
        dealName: true,
        status: true,
        brandName: true,
        partnerCompanyName: true,
        partner: { select: { name: true } },
      },
    }),
    prisma.salesCampaign.findMany({
      where: {
        OR: forms.flatMap((f) => [
          { deal: { dealName: containsSearch(f) } },
          { seller: { name: containsSearch(f) } },
          { seller: { alias: containsSearch(f) } },
        ]),
      },
      take: 5,
      select: {
        id: true,
        status: true,
        deal: {
          select: {
            dealName: true,
            brandName: true,
            partnerCompanyName: true,
            partner: { select: { name: true } },
          },
        },
        seller: { select: { name: true, alias: true } },
      },
    }),
  ]);

  return NextResponse.json({
    partners,
    sellers,
    deals: deals.map((d) => ({
      id: d.id,
      dealName: d.dealName,
      brandName: d.brandName,
      partnerName: d.partner?.name || d.partnerCompanyName,
      status: d.status,
    })),
    campaigns: campaigns.map((c) => ({
      id: c.id,
      dealName: c.deal.dealName,
      brandName: c.deal.brandName,
      partnerName: c.deal.partner?.name || c.deal.partnerCompanyName,
      sellerName: c.seller.alias || c.seller.name,
      status: c.status,
    })),
  });
}
