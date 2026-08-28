import { NextResponse } from "next/server";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { buildNaverTrackingLink } from "@/lib/tracking";
import type { SnsType } from "@/lib/crm-types";

const duplicateCampaignSchema = z.object({
  sourceCampaignId: z.string().min(1),
  sellerId: z.string().min(1),
});

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = duplicateCampaignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const prisma = getPrisma();

  // Fetch the source campaign
  const sourceCampaign = await prisma.salesCampaign.findUnique({
    where: { id: parsed.data.sourceCampaignId },
    include: { seller: true },
  });

  if (!sourceCampaign) {
    return NextResponse.json(
      { error: "해당 캠페인을 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  // Validate that sellerId is different from source campaign's sellerId
  if (parsed.data.sellerId === sourceCampaign.sellerId) {
    return NextResponse.json(
      { error: "복제 대상 셀러는 원본 캠페인의 셀러와 달라야 합니다" },
      { status: 400 },
    );
  }

  // Verify the target seller exists
  const targetSeller = await prisma.seller.findUnique({
    where: { id: parsed.data.sellerId },
  });

  if (!targetSeller) {
    return NextResponse.json(
      { error: "해당 셀러를 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  // Create the duplicated campaign with copied fields
  const newCampaign = await prisma.salesCampaign.create({
    data: {
      dealId: sourceCampaign.dealId,
      sellerId: parsed.data.sellerId,
      startDate: sourceCampaign.startDate,
      endDate: sourceCampaign.endDate,
      salesChannel: sourceCampaign.salesChannel,
      baseNaverLink: sourceCampaign.baseNaverLink,
      generatedTrackingLink: "pending",
      totalMarginRate: sourceCampaign.totalMarginRate,
      sellerMarginRate: sourceCampaign.sellerMarginRate,
      netMarginRate: sourceCampaign.netMarginRate,
      isManualMargin: sourceCampaign.isManualMargin,
      status: "PROPOSAL",
    },
  });

  // Generate a new unique tracking link using the new campaign ID
  const generatedTrackingLink = buildNaverTrackingLink({
    baseUrl: sourceCampaign.baseNaverLink,
    snsType: targetSeller.snsType as SnsType,
    sellerId: targetSeller.id,
    campaignId: newCampaign.id,
  });

  // Update the campaign with the generated tracking link
  const updatedCampaign = await prisma.salesCampaign.update({
    where: { id: newCampaign.id },
    data: { generatedTrackingLink },
    include: {
      deal: { include: { partner: true } },
      seller: true,
    },
  });

  return NextResponse.json(updatedCampaign, { status: 201 });
}
