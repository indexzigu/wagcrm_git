import { NextResponse } from "next/server";
import { z } from "zod";
import { recordCampaignActivity } from "@/lib/campaign-activity";
import { toCampaignRow } from "@/lib/campaign-row";
import { getPrisma } from "@/lib/prisma";
import { applySlideMargin, parseMarginPolicy } from "@/lib/margin";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import { calculateDerivedCampaignFinancials } from "@/lib/campaign-financials";
import type { SalesChannel } from "@/lib/crm-types";

const actualSalesSchema = z.object({
  actualSales: z.coerce.number().nonnegative(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const parsed = actualSalesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const prisma = getPrisma();
  const campaign = await prisma.salesCampaign.findUnique({
    where: { id },
    include: { deal: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (campaign.isManualMargin) {
    const derivedFinancials = calculateDerivedCampaignFinancials({
      actualSales: parsed.data.actualSales,
      operatingExpense: Number(campaign.operatingExpense?.toString() ?? 0),
      miscExpense: Number(campaign.miscExpense?.toString() ?? 0),
      totalMarginRate: Number(campaign.totalMarginRate?.toString() ?? 0),
      sellerMarginRate: Number(campaign.sellerMarginRate?.toString() ?? 0),
    });
    const updated = await prisma.salesCampaign.update({
      where: { id },
      data: {
        actualSales: parsed.data.actualSales,
        ...derivedFinancials,
      },
      include: {
        deal: { include: { partner: true } },
        campaignDeals: { include: { deal: true } },
        seller: {
          include: {
            agency: true,
            histories: { orderBy: { snapshotDate: "asc" }, take: 12 },
          },
        },
        activities: { orderBy: { createdAt: "desc" }, take: 12 },
        notes: { orderBy: { createdAt: "desc" } },
        checklistItems: { orderBy: [{ status: "asc" }, { sortOrder: "asc" }] },
        group: true,
      },
    });
    await recordCampaignActivity({
      campaignId: updated.id,
      action: "ACTUAL_SALES_UPDATED",
      label: "Actual sales updated",
      details: `manual margin · ${parsed.data.actualSales.toLocaleString()}`,
    });
    const refreshed = await prisma.salesCampaign.findUniqueOrThrow({
      where: { id: updated.id },
      include: {
        deal: { include: { partner: true } },
        campaignDeals: { include: { deal: true } },
        seller: {
          include: {
            agency: true,
            histories: { orderBy: { snapshotDate: "asc" }, take: 12 },
          },
        },
        activities: { orderBy: { createdAt: "desc" }, take: 12 },
        notes: { orderBy: { createdAt: "desc" } },
        checklistItems: { orderBy: [{ status: "asc" }, { sortOrder: "asc" }] },
        group: true,
      },
    });
    revalidateCampaignCaches();
    return NextResponse.json(toCampaignRow(refreshed));
  }

  const rate = applySlideMargin(
    parseMarginPolicy(campaign.deal.baseMarginPolicy),
    campaign.salesChannel as SalesChannel,
    parsed.data.actualSales,
  );
  const derivedFinancials = calculateDerivedCampaignFinancials({
    actualSales: parsed.data.actualSales,
    operatingExpense: Number(campaign.operatingExpense?.toString() ?? 0),
    miscExpense: Number(campaign.miscExpense?.toString() ?? 0),
    totalMarginRate: rate.totalMarginRate,
    sellerMarginRate: rate.sellerMarginRate,
  });

  const updated = await prisma.salesCampaign.update({
    where: { id },
    data: {
      actualSales: parsed.data.actualSales,
      totalMarginRate: rate.totalMarginRate,
      sellerMarginRate: rate.sellerMarginRate,
      netMarginRate: rate.netMarginRate,
      ...derivedFinancials,
    },
    include: {
      deal: { include: { partner: true } },
      campaignDeals: { include: { deal: true } },
      seller: {
        include: {
          agency: true,
          histories: { orderBy: { snapshotDate: "asc" }, take: 12 },
        },
      },
      activities: { orderBy: { createdAt: "desc" }, take: 12 },
      notes: { orderBy: { createdAt: "desc" } },
      checklistItems: { orderBy: [{ status: "asc" }, { sortOrder: "asc" }] },
      group: true,
    },
  });
  await recordCampaignActivity({
    campaignId: updated.id,
    action: "ACTUAL_SALES_UPDATED",
    label: "Actual sales updated",
    details: `${parsed.data.actualSales.toLocaleString()} · auto margin recalculated`,
  });
  const refreshed = await prisma.salesCampaign.findUniqueOrThrow({
    where: { id: updated.id },
    include: {
      deal: { include: { partner: true } },
      campaignDeals: { include: { deal: true } },
      seller: {
        include: {
          agency: true,
          histories: { orderBy: { snapshotDate: "asc" }, take: 12 },
        },
      },
      activities: { orderBy: { createdAt: "desc" }, take: 12 },
      notes: { orderBy: { createdAt: "desc" } },
      checklistItems: { orderBy: [{ status: "asc" }, { sortOrder: "asc" }] },
      group: true,
    },
  });
  revalidateCampaignCaches();
  return NextResponse.json(toCampaignRow(refreshed));
}
