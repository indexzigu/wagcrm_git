import { NextResponse } from "next/server";
import { recordCampaignActivity } from "@/lib/campaign-activity";
import { toCampaignRow } from "@/lib/campaign-row";
import { getPrisma } from "@/lib/prisma";
import { buildNaverTrackingLink } from "@/lib/tracking";
import type { SnsType } from "@/lib/crm-types";

type Context = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;
  const prisma = getPrisma();
  const source = await prisma.salesCampaign.findUnique({
    where: { id },
    include: { seller: true, deal: true },
  });
  if (!source) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const created = await prisma.salesCampaign.create({
    data: {
      dealId: source.dealId,
      sellerId: source.sellerId,
      startDate: source.startDate,
      endDate: source.endDate,
      salesChannel: source.salesChannel,
      baseNaverLink: source.baseNaverLink,
      generatedTrackingLink: "pending",
      actualSales: null,
      totalMarginRate: source.totalMarginRate,
      sellerMarginRate: source.sellerMarginRate,
      netMarginRate: source.netMarginRate,
      status: "PROPOSAL",
      isManualMargin: source.isManualMargin,
    },
  });

  const generatedTrackingLink = buildNaverTrackingLink({
    baseUrl: source.baseNaverLink,
    snsType: source.seller.snsType as SnsType,
    sellerId: source.sellerId,
    campaignId: created.id,
  });
  const duplicated = await prisma.salesCampaign.update({
    where: { id: created.id },
    data: { generatedTrackingLink },
    include: {
      deal: { include: { partner: true } },
      seller: {
        include: {
          agency: true,
          histories: { orderBy: { snapshotDate: "asc" }, take: 12 },
        },
      },
      activities: { orderBy: { createdAt: "desc" }, take: 12 },
    },
  });

  await recordCampaignActivity({
    campaignId: duplicated.id,
    action: "DUPLICATED",
    label: "Campaign duplicated",
    details: `source ${source.id}`,
  });

  const responseCampaign = await prisma.salesCampaign.findUniqueOrThrow({
    where: { id: duplicated.id },
    include: {
      deal: { include: { partner: true } },
      seller: {
        include: {
          agency: true,
          histories: { orderBy: { snapshotDate: "asc" }, take: 12 },
        },
      },
      activities: { orderBy: { createdAt: "desc" }, take: 12 },
    },
  });

  return NextResponse.json(toCampaignRow(responseCampaign), { status: 201 });
}
