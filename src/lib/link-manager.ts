import { generateCampaignName } from "./campaign-name";
import { getPrisma } from "./prisma";

export type LinkResult<T> = {
  data: T;
  /** Non-null when activity log recording failed (main operation still succeeded) */
  logWarning: string | null;
};

/**
 * Links a deal to a partner by updating Deal.partnerId.
 *
 * Requirements: 5.4, 11.1
 */
export async function linkDealToPartner(
  dealId: string,
  newPartnerId: string,
  actor: string = "SYSTEM",
): Promise<LinkResult<{ id: string; dealName: string; partnerId: string | null; partner: { id: string; name: string } | null }>> {
  void actor;
  const prisma = getPrisma();

  // Main operation: update the FK
  const updatedDeal = await prisma.deal.update({
    where: { id: dealId },
    data: { partnerId: newPartnerId },
    include: { partner: { select: { id: true, name: true } } },
  });

  return {
    data: {
      id: updatedDeal.id,
      dealName: updatedDeal.dealName,
      partnerId: updatedDeal.partnerId,
      partner: updatedDeal.partner,
    },
    logWarning: null,
  };
}

/**
 * Links a campaign to a deal by updating SalesCampaign.dealId.
 *
 * Requirements: 7.5, 11.2
 */
export async function linkCampaignToDeal(
  campaignId: string,
  newDealId: string,
  actor: string = "SYSTEM",
): Promise<LinkResult<{ id: string; dealId: string; campaignName: string | null; deal: { id: string; dealName: string } }>> {
  void actor;
  const prisma = getPrisma();

  // Main operation: update the FK
  const updatedCampaign = await prisma.salesCampaign.update({
    where: { id: campaignId },
    data: { dealId: newDealId },
    include: {
      deal: { select: { id: true, dealName: true } },
      seller: { select: { name: true, alias: true } },
    },
  });

  // Regenerate campaign name after deal change (Requirement 8.2)
  const dealName = updatedCampaign.deal?.dealName ?? null;
  const sellerName = updatedCampaign.seller?.alias || updatedCampaign.seller?.name || null;
  const roundNumber = updatedCampaign.roundNumber ?? null;
  const newCampaignName = generateCampaignName(dealName, sellerName, roundNumber);

  if (newCampaignName !== updatedCampaign.campaignName) {
    await prisma.salesCampaign.update({
      where: { id: campaignId },
      data: { campaignName: newCampaignName },
    });
  }

  return {
    data: {
      id: updatedCampaign.id,
      dealId: updatedCampaign.dealId,
      campaignName: newCampaignName,
      deal: updatedCampaign.deal,
    },
    logWarning: null,
  };
}

/**
 * Changes a deal's partner link from one partner to another.
 *
 * Requirements: 5.6, 9.7, 11.3
 */
export async function changeDealPartner(
  dealId: string,
  newPartnerId: string,
  actor: string = "SYSTEM",
): Promise<LinkResult<{ id: string; dealName: string; partnerId: string | null; partner: { id: string; name: string } | null }>> {
  void actor;
  const prisma = getPrisma();

  // Main operation: update the FK
  const updatedDeal = await prisma.deal.update({
    where: { id: dealId },
    data: { partnerId: newPartnerId },
    include: { partner: { select: { id: true, name: true } } },
  });

  return {
    data: {
      id: updatedDeal.id,
      dealName: updatedDeal.dealName,
      partnerId: updatedDeal.partnerId,
      partner: updatedDeal.partner,
    },
    logWarning: null,
  };
}

/**
 * Changes a campaign's deal link from one deal to another.
 *
 * Requirements: 8.4, 11.4
 */
export async function changeCampaignDeal(
  campaignId: string,
  newDealId: string,
  actor: string = "SYSTEM",
): Promise<LinkResult<{ id: string; dealId: string; campaignName: string | null; deal: { id: string; dealName: string } }>> {
  void actor;
  const prisma = getPrisma();

  // Main operation: update the FK
  const updatedCampaign = await prisma.salesCampaign.update({
    where: { id: campaignId },
    data: { dealId: newDealId },
    include: {
      deal: { select: { id: true, dealName: true } },
      seller: { select: { name: true, alias: true } },
    },
  });

  // Regenerate campaign name after deal change (Requirement 8.2)
  const dealName = updatedCampaign.deal?.dealName ?? null;
  const sellerName = updatedCampaign.seller?.alias || updatedCampaign.seller?.name || null;
  const roundNumber = updatedCampaign.roundNumber ?? null;
  const newCampaignName = generateCampaignName(dealName, sellerName, roundNumber);

  if (newCampaignName !== updatedCampaign.campaignName) {
    await prisma.salesCampaign.update({
      where: { id: campaignId },
      data: { campaignName: newCampaignName },
    });
  }

  return {
    data: {
      id: updatedCampaign.id,
      dealId: updatedCampaign.dealId,
      campaignName: newCampaignName,
      deal: updatedCampaign.deal,
    },
    logWarning: null,
  };
}

/**
 * Unlinks a deal from its partner by setting Deal.partnerId to null.
 */
export async function unlinkDealFromPartner(
  dealId: string,
  actor: string = "SYSTEM",
): Promise<LinkResult<{ id: string; dealName: string; partnerId: null }>> {
  void actor;
  const prisma = getPrisma();

  const updatedDeal = await prisma.deal.update({
    where: { id: dealId },
    data: { partnerId: null },
  });

  return {
    data: {
      id: updatedDeal.id,
      dealName: updatedDeal.dealName,
      partnerId: null,
    },
    logWarning: null,
  };
}

