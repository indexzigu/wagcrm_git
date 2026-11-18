import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export class OutreachRepository {
  static async findMany<T extends Prisma.SalesTaskInclude>(params: {
    where?: Prisma.SalesTaskWhereInput;
    include?: T;
    orderBy?: Prisma.SalesTaskOrderByWithRelationInput[];
  }) {
    return getPrisma().salesTask.findMany({
      where: params.where,
      include: params.include,
      orderBy: params.orderBy,
    }) as Promise<Prisma.SalesTaskGetPayload<{ include: T }>[]>;
  }

  static async create<T extends Prisma.SalesTaskInclude>(
    data: Prisma.SalesTaskUncheckedCreateInput,
    include?: T
  ) {
    return getPrisma().salesTask.create({
      data,
      include,
    }) as Promise<Prisma.SalesTaskGetPayload<{ include: T }>>;
  }

  static async findLinkedCampaigns(campaignIds: string[]) {
    return getPrisma().salesCampaign.findMany({
      where: { id: { in: campaignIds } },
      select: {
        id: true,
        campaignName: true,
        deal: { select: { dealName: true } },
        seller: { select: { name: true, alias: true } },
      },
    });
  }

  static async findDealById(dealId: string) {
    return getPrisma().deal.findUnique({
      where: { id: dealId },
    });
  }

  static async findSellerById(sellerId: string) {
    return getPrisma().seller.findUnique({
      where: { id: sellerId },
    });
  }

  static async findExistingTask(dealId: string, sellerId: string) {
    return getPrisma().salesTask.findFirst({
      where: { dealId, sellerId },
      select: { id: true, status: true, linkedCampaignId: true },
    });
  }
}
