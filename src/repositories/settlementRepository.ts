import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export class SettlementRepository {
  static async findChecklistByCampaignId<T extends Prisma.SettlementChecklistInclude>(
    campaignId: string,
    include?: T
  ) {
    return getPrisma().settlementChecklist.findUnique({
      where: { campaignId },
      include,
    }) as Promise<Prisma.SettlementChecklistGetPayload<{ include: T }> | null>;
  }

  static async upsertChecklist<T extends Prisma.SettlementChecklistInclude>(
    campaignId: string,
    defaultItems: string[],
    include?: T
  ) {
    return getPrisma().settlementChecklist.upsert({
      where: { campaignId },
      update: {},
      create: {
        campaignId,
        items: {
          create: defaultItems.map((label, sortOrder) => ({
            label,
            sortOrder,
          })),
        },
      },
      include,
    }) as Promise<Prisma.SettlementChecklistGetPayload<{ include: T }>>;
  }

  static async findChecklistItemById<T extends Prisma.SettlementChecklistItemInclude>(
    itemId: string,
    include?: T
  ) {
    return getPrisma().settlementChecklistItem.findUnique({
      where: { id: itemId },
      include,
    }) as Promise<Prisma.SettlementChecklistItemGetPayload<{ include: T }> | null>;
  }

  static async updateChecklistItem<T extends Prisma.SettlementChecklistItemInclude>(
    itemId: string,
    data: Prisma.SettlementChecklistItemUpdateInput,
    include?: T
  ) {
    return getPrisma().settlementChecklistItem.update({
      where: { id: itemId },
      data,
      include,
    }) as Promise<Prisma.SettlementChecklistItemGetPayload<{ include: T }>>;
  }

  static async findParentChecklistWithItems(checklistId: string) {
    return getPrisma().settlementChecklist.findUnique({
      where: { id: checklistId },
      include: {
        items: true,
        campaign: true,
      },
    });
  }

  static async updateCampaignStatus(campaignId: string, status: string) {
    return getPrisma().salesCampaign.update({
      where: { id: campaignId },
      data: { status },
    });
  }

  static async createChecklistItem<T extends Prisma.SettlementChecklistItemInclude>(
    data: Prisma.SettlementChecklistItemUncheckedCreateInput,
    include?: T
  ) {
    return getPrisma().settlementChecklistItem.create({
      data,
      include,
    }) as Promise<Prisma.SettlementChecklistItemGetPayload<{ include: T }>>;
  }

  static async findCampaignsForReport<T extends Prisma.SalesCampaignInclude>(params: {
    where?: Prisma.SalesCampaignWhereInput;
    include?: T;
    orderBy?: Prisma.SalesCampaignOrderByWithRelationInput[];
  }) {
    return getPrisma().salesCampaign.findMany({
      where: params.where,
      include: params.include,
      orderBy: params.orderBy,
    }) as Promise<Prisma.SalesCampaignGetPayload<{ include: T }>[]>;
  }
}
