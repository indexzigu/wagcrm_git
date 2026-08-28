import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

type OutreachTaskAsset = {
  id: string;
  driveShortcutId?: string | null;
  driveParentFolderId?: string | null;
};

export class OutreachRepository {
  private static isSqliteRuntime() {
    return typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.startsWith("file:");
  }

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

  static async findById<T extends Prisma.SalesTaskInclude>(id: string, include?: T) {
    return getPrisma().salesTask.findUnique({
      where: { id },
      include,
    }) as Promise<Prisma.SalesTaskGetPayload<{ include: T }> | null>;
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

  static async update<T extends Prisma.SalesTaskInclude>(
    id: string,
    data: Prisma.SalesTaskUpdateInput,
    include?: T
  ) {
    return getPrisma().salesTask.update({
      where: { id },
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

  static async findDealOptions(parentDealId: string) {
    return getPrisma().deal.findMany({
      where: { parentDealId },
    });
  }

  static async findStorageIntegration(provider: string) {
    return getPrisma().storageIntegration.findUnique({
      where: { provider },
    });
  }

  static async findTaskAssets(taskId: string) {
    if (this.isSqliteRuntime()) {
      return getPrisma().asset.findMany({
        where: { entityType: "OUTREACH", entityId: taskId, archivedAt: null },
        select: { id: true },
      }) as Promise<OutreachTaskAsset[]>;
    }

    return getPrisma().asset.findMany({
      where: { entityType: "OUTREACH", entityId: taskId, archivedAt: null },
      select: { id: true, driveShortcutId: true, driveParentFolderId: true },
    }) as Promise<OutreachTaskAsset[]>;
  }

  static async updateManyAssets(ids: string[], data: Prisma.AssetUpdateManyMutationInput) {
    return getPrisma().asset.updateMany({
      where: { id: { in: ids } },
      data,
    });
  }
}
