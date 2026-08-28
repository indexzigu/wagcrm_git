import { getPrisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export const campaignRepository = {
  findMany<T extends Prisma.SalesCampaignFindManyArgs>(args: Prisma.SelectSubset<T, Prisma.SalesCampaignFindManyArgs>) {
    return getPrisma().salesCampaign.findMany<T>(args);
  },

  async findByIdOrThrow(id: string) {
    return getPrisma().salesCampaign.findUniqueOrThrow({
      where: { id },
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
      },
    });
  },

  async createWithDeals(
    campaignData: Prisma.SalesCampaignUncheckedCreateInput,
    campaignDeals: Omit<Prisma.CampaignDealUncheckedCreateInput, "campaignId">[]
  ) {
    return getPrisma().$transaction(async (tx) => {
      const createdCampaign = await tx.salesCampaign.create({
        data: campaignData,
      });

      for (const cd of campaignDeals) {
        await tx.campaignDeal.create({
          data: {
            ...cd,
            campaignId: createdCampaign.id,
          },
        });
      }

      return createdCampaign;
    });
  },

  async update(id: string, data: Prisma.SalesCampaignUpdateInput) {
    return getPrisma().salesCampaign.update({
      where: { id },
      data,
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
        checklistItems: { orderBy: [{ status: "asc" }, { sortOrder: "asc" }] },
      },
    });
  },

  async findById(id: string) {
    return getPrisma().salesCampaign.findUnique({
      where: { id },
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
      },
    });
  },

  async delete(id: string) {
    const prisma = getPrisma();
    return prisma.$transaction([
      prisma.trackingAttribution.updateMany({
        where: { campaignId: id },
        data: { campaignId: null },
      }),
      prisma.asset.updateMany({
        where: { campaignId: id },
        data: { campaignId: null },
      }),
      prisma.salesCampaign.delete({ where: { id } }),
    ]);
  },
};
