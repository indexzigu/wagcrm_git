import { dealRepository } from "@/repositories/dealRepository";
import { normalizeDealBrandName, extractOptionLabel, formatOptionDealName, getDisplayDealName } from "@/lib/deal-display";
import { isValidTransition } from "@/lib/deal-status";
import { recordActivityCreate, recordActivityChange, recordActivityDelete, FIELD_LABELS, getCompareValue } from "@/lib/activity-log";
import { googleDriveProvider } from "@/lib/asset-storage";
import { getPrisma } from "@/lib/prisma";

// --- Helpers ---

type DealPartner = {
  name: string;
  type: string;
} | null;

type DealWithPartner = {
  brandName?: string | null;
  partner?: DealPartner;
};

function withNormalizedBrandName<T extends DealWithPartner>(deal: T): T {
  return {
    ...deal,
    brandName: normalizeDealBrandName(deal.brandName, deal.partner),
  };
}

function parseBaseMarginPolicy(value: string | null) {
  if (!value) {
    return { byChannel: {} };
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { byChannel: {} };
  }
}

function toNumber(value: { toString(): string } | number | null | undefined) {
  if (value == null) {
    return null;
  }
  return Number(value.toString());
}

function serializeDealResponse(
  deal: {
    id: string;
    dealName: string;
    brandName: string | null;
    partnerCompanyName: string | null;
    costPrice: { toString(): string };
    sellingPrice: { toString(): string };
    listPrice: { toString(): string } | null;
    floorPrice: { toString(): string } | null;
    supplyPrice: number | null;
    discountRate: { toString(): string } | null;
    totalCommissionRate: { toString(): string } | null;
    brokerageCommissionRate: { toString(): string } | null;
    sourcingMemo: string | null;
    candidateSellers: string | null;
    status: string;
    baseMarginPolicy: string | null;
    createdAt: Date;
    updatedAt: Date;
    partnerId: string | null;
    dealType: string;
    optionSortOrder: number;
    parentDealId: string | null;
    partner?: {
      id: string;
      name: string;
      type: string;
      businessNumber?: string | null;
      companyStatus?: string | null;
      companyRole?: string | null;
      ceoName?: string | null;
      address?: string | null;
      contactInfo?: string | null;
      representativeEmail?: string | null;
    } | null;
    campaigns?: Array<{
      id: string;
      status: string;
      salesChannel: string;
      startDate: Date;
      endDate: Date;
      actualSales: { toString(): string } | null;
      seller: { name: string; alias: string | null };
    }>;
    options?: Array<{
      id: string;
      dealName: string;
      unit: string | null;
      unitQuantity: number | null;
      supplementaryInfo: string | null;
      costPrice: { toString(): string };
      sellingPrice: { toString(): string };
      totalCommissionRate: { toString(): string } | null;
      dealType: string;
      optionSortOrder: number;
      parentDealId: string | null;
    }>;
  },
) {
  return {
    ...deal,
    brandName: normalizeDealBrandName(deal.brandName, deal.partner),
    costPrice: toNumber(deal.costPrice) ?? 0,
    sellingPrice: toNumber(deal.sellingPrice) ?? 0,
    listPrice: toNumber(deal.listPrice),
    floorPrice: toNumber(deal.floorPrice),
    supplyPrice: deal.supplyPrice,
    discountRate: toNumber(deal.discountRate),
    totalCommissionRate: toNumber(deal.totalCommissionRate),
    brokerageCommissionRate: toNumber(deal.brokerageCommissionRate),
    partnerName: deal.partner?.name ?? "거래처 없음",
    baseMarginPolicy: parseBaseMarginPolicy(deal.baseMarginPolicy),
    campaigns: (deal.campaigns ?? []).map((campaign) => ({
      id: campaign.id,
      sellerName: campaign.seller.alias || campaign.seller.name,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      status: campaign.status,
      salesChannel: campaign.salesChannel,
      actualSales: toNumber(campaign.actualSales),
    })),
    options: (deal.options ?? []).map((option) => ({
      id: option.id,
      dealName: option.dealName,
      unit: option.unit,
      unitQuantity: option.unitQuantity,
      supplementaryInfo: option.supplementaryInfo,
      costPrice: toNumber(option.costPrice) ?? 0,
      sellingPrice: toNumber(option.sellingPrice) ?? 0,
      totalCommissionRate: toNumber(option.totalCommissionRate),
      dealType: option.dealType,
      optionSortOrder: option.optionSortOrder,
      parentDealId: option.parentDealId,
    })),
  };
}

// --- Service ---

export class DealNotFoundError extends Error {
  constructor(message = "해당 딜을 찾을 수 없습니다") {
    super(message);
    this.name = "DealNotFoundError";
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(message = "허용되지 않는 상태 변경입니다") {
    super(message);
    this.name = "InvalidStatusTransitionError";
  }
}

export class DealDeletionBlockedError extends Error {
  constructor(message = "연결된 캠페인이 있어 삭제할 수 없습니다") {
    super(message);
    this.name = "DealDeletionBlockedError";
  }
}

export const dealService = {
  async getDealsList(params: {
    status?: string | null;
    partnerId?: string | null;
    dealType?: string | null;
    parentDealId?: string | null;
    sortBy?: string | null;
    sortDir?: "asc" | "desc" | null;
  }) {
    const { status, partnerId, dealType, parentDealId, sortBy, sortDir } = params;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (partnerId) where.partnerId = partnerId;

    if (parentDealId) {
      where.parentDealId = parentDealId;
    } else if (dealType) {
      where.dealType = dealType;
    } else {
      where.dealType = "MAIN";
    }

    const orderBy = sortBy
      ? { [sortBy]: sortDir || "asc" }
      : { updatedAt: "desc" as const };

    const deals = await dealRepository.findMany({
      where,
      orderBy,
      select: {
        id: true,
        dealName: true,
        brandName: true,
        partnerId: true,
        partner: {
          select: {
            id: true,
            name: true,
            type: true,
            businessNumber: true,
            ceoName: true,
            contactInfo: true,
            representativeEmail: true,
          },
        },
        costPrice: true,
        sellingPrice: true,
        candidateSellers: true,
        baseMarginPolicy: true,
        status: true,
        dealType: true,
        parentDealId: true,
        _count: {
          select: { campaigns: true, salesTasks: true },
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    return deals.map(withNormalizedBrandName);
  },

  async getDealDetail(id: string) {
    const deal = await dealRepository.findUnique({
      where: { id },
      include: {
        partner: {
          select: {
            id: true,
            name: true,
            type: true,
            businessNumber: true,
            companyStatus: true,
            companyRole: true,
            ceoName: true,
            address: true,
            contactInfo: true,
            representativeEmail: true,
          }
        },
        campaigns: {
          include: { seller: { select: { name: true, alias: true } } },
          orderBy: { startDate: "desc" },
        },
        options: {
          orderBy: [{ optionSortOrder: "asc" }, { createdAt: "asc" }],
        },
      },
    });

    if (!deal) {
      return null;
    }

    return serializeDealResponse(deal);
  },

  async createDeal(
    input: {
      dealName: string;
      brandName?: string | null;
      partnerId?: string | null;
      costPrice: number;
      sellingPrice: number;
      listPrice?: number | null;
      floorPrice?: number | null;
      brokerageCommissionRate?: number | null;
      totalCommissionRate?: number | null;
      dealType?: string | null;
      parentDealId?: string | null;
      optionSortOrder?: number | null;
      baseMarginPolicy?: Record<string, unknown>;
      unit?: string | null;
      unitQuantity?: number | null;
      supplementaryInfo?: string | null;
    },
    actor: string
  ) {
    const { baseMarginPolicy, ...rest } = input;
    let optionSortOrder = rest.optionSortOrder;
    let inheritedBrandName: string | null | undefined;
    let inheritedUnit: string | null | undefined;

    const isOptionWithParent = rest.dealType === "OPTION" && !!rest.parentDealId;
    const needsSiblingLookup = isOptionWithParent && optionSortOrder == null;
    const needsParentInheritance = isOptionWithParent && (rest.brandName == null || rest.unit == null);

    // Major 3: optionSortOrder용 형제 조회와 부모 상속용 조회는 서로 다른 대상(형제 딜들 vs
    // 부모 딜 자신)을 향한 독립 쿼리라 하나의 쿼리로 병합할 수 없다. 대신 Promise.all로
    // 병렬 실행해 순차 왕복(round-trip) 지연을 제거한다.
    const [lastSibling, parentDeal] = await Promise.all([
      needsSiblingLookup
        ? dealRepository.findFirst({
            where: {
              parentDealId: rest.parentDealId,
              dealType: "OPTION",
            },
            orderBy: [{ optionSortOrder: "desc" }, { createdAt: "desc" }],
            select: { optionSortOrder: true },
          })
        : Promise.resolve(null),
      // C2-1(근본 원인): dealType=OPTION && parentDealId가 있는데 brandName/unit이 입력에
      // 없으면 부모 딜에서 1회 상속한다. 부모 미존재/조회 실패 시에도 나머지 생성은 계속한다.
      needsParentInheritance
        ? dealRepository.findFirst({
            where: { id: rest.parentDealId! },
            select: { brandName: true, unit: true },
          })
        : Promise.resolve(null),
    ]);

    if (needsSiblingLookup) {
      optionSortOrder = (lastSibling?.optionSortOrder ?? -1) + 1;
    }

    if (needsParentInheritance) {
      inheritedBrandName = parentDeal?.brandName ?? null;
      inheritedUnit = parentDeal?.unit ?? null;
    }

    const deal = await dealRepository.create({
      data: {
        dealName: rest.dealName,
        brandName: rest.brandName ?? (isOptionWithParent ? inheritedBrandName ?? null : null),
        partnerId: rest.partnerId ?? null,
        costPrice: rest.costPrice,
        sellingPrice: rest.sellingPrice,
        listPrice: rest.listPrice ?? null,
        floorPrice: rest.floorPrice ?? null,
        brokerageCommissionRate: rest.brokerageCommissionRate ?? null,
        totalCommissionRate: rest.totalCommissionRate ?? null,
        dealType: rest.dealType ?? "MAIN",
        parentDealId: rest.parentDealId ?? null,
        optionSortOrder: optionSortOrder ?? 0,
        baseMarginPolicy: baseMarginPolicy ? JSON.stringify(baseMarginPolicy) : "{\"byChannel\":{}}",
        status: "SOURCING",
        unit: rest.unit ?? (isOptionWithParent ? inheritedUnit ?? null : null),
        unitQuantity: rest.unitQuantity ?? null,
        supplementaryInfo: rest.supplementaryInfo ?? null,
      },
      select: {
        id: true,
        dealName: true,
        brandName: true,
        partnerId: true,
        partner: {
          select: {
            name: true,
            type: true,
          },
        },
        costPrice: true,
        sellingPrice: true,
        baseMarginPolicy: true,
        status: true,
        _count: {
          select: { campaigns: true },
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    await recordActivityCreate("DEAL", deal.id, actor);

    // 구글 드라이브 폴더 비동기 생성 (실패해도 응답 흐름에 영향 없음)
    googleDriveProvider
      .createFolderForEntity({
        entityType: "DEAL",
        entityId: deal.id,
        entityName: deal.dealName,
        section: "ETC",
      })
      .catch((err) => {
        console.warn(`[deals:POST] Pre-creating Google Drive folder skipped:`, err);
      });

    return withNormalizedBrandName(deal);
  },

  async updateDeal(
    id: string,
    data: {
      dealName?: string;
      brandName?: string | null;
      partnerId?: string | null;
      costPrice?: number;
      sellingPrice?: number;
      listPrice?: number | null;
      floorPrice?: number | null;
      brokerageCommissionRate?: number | null;
      totalCommissionRate?: number | null;
      status?: string;
      baseMarginPolicy?: Record<string, unknown>;
      unit?: string | null;
      unitQuantity?: number | null;
      supplementaryInfo?: string | null;
    },
    actor: string
  ) {
    // Fetch current deal to compare changes
    const currentDeal = await dealRepository.findUnique({ 
      where: { id },
      include: { options: true }
    });
    if (!currentDeal) {
      throw new DealNotFoundError();
    }

    // Validate status transition if status is being changed
    if (data.status && data.status !== currentDeal.status) {
      const valid = isValidTransition(
        currentDeal.status as Parameters<typeof isValidTransition>[0],
        data.status as Parameters<typeof isValidTransition>[1],
      );
      if (!valid) {
        throw new InvalidStatusTransitionError();
      }
    }

    // Build update payload — stringify baseMarginPolicy for DB storage
    const updateData: Record<string, unknown> = { ...data };
    if (data.baseMarginPolicy) {
      updateData.baseMarginPolicy = JSON.stringify(data.baseMarginPolicy);
    }

    const updatedDeal = await dealRepository.update({
      where: { id },
      data: updateData as any,
      include: {
        partner: {
          select: {
            id: true,
            name: true,
            type: true,
            businessNumber: true,
            companyStatus: true,
            companyRole: true,
            ceoName: true,
            address: true,
            contactInfo: true,
            representativeEmail: true,
          }
        },
        campaigns: {
          include: { seller: { select: { name: true, alias: true } } },
          orderBy: { startDate: "desc" },
        },
        options: {
          orderBy: [{ optionSortOrder: "asc" }, { createdAt: "asc" }],
        },
      },
    });

    // Update child options if parent's name or unit changed
    const isNameChanged = data.dealName && data.dealName !== currentDeal.dealName;
    const isUnitChanged = ('unit' in data) && data.unit !== currentDeal.unit;

    if (currentDeal.options && currentDeal.options.length > 0 && (isNameChanged || isUnitChanged)) {
      const prisma = getPrisma();
      const newDealName = data.dealName !== undefined ? data.dealName : currentDeal.dealName;
      const newUnit = data.unit !== undefined ? data.unit : currentDeal.unit;

      for (const opt of currentDeal.options) {
        let newOptDealName = "";
        if (newUnit && opt.unitQuantity != null) {
          newOptDealName = getDisplayDealName({
            dealName: newDealName,
            unit: newUnit,
            unitQuantity: opt.unitQuantity,
            supplementaryInfo: opt.supplementaryInfo,
          });
        } else {
          const pureOptionLabel = extractOptionLabel(currentDeal.dealName, opt.dealName);
          newOptDealName = formatOptionDealName(newDealName, pureOptionLabel);
        }

        await prisma.deal.update({
          where: { id: opt.id },
          data: {
            dealName: newOptDealName,
            unit: newUnit,
          }
        });
      }

      // Refresh options in updatedDeal response
      const refreshedOptions = await prisma.deal.findMany({
        where: { parentDealId: id, dealType: "OPTION" },
        orderBy: [{ optionSortOrder: "asc" }, { createdAt: "asc" }]
      });
      updatedDeal.options = refreshedOptions;
    }

    // Record audit logs
    for (const key of Object.keys(data)) {
      const val = (data as Record<string, unknown>)[key];
      const curVal = (currentDeal as Record<string, unknown>)[key];
      if (getCompareValue(curVal) !== getCompareValue(val)) {
        const fieldLabel = FIELD_LABELS[key] || key;
        await recordActivityChange("DEAL", id, fieldLabel, curVal, val, actor);
      }
    }

    return serializeDealResponse(updatedDeal);
  },

  async deleteDeal(id: string, actor: string) {
    // Check if deal exists
    const deal = await dealRepository.findUnique({
      where: { id },
      include: { options: true },
    });
    if (!deal) {
      throw new DealNotFoundError();
    }

    const optionIds = deal.options?.map((o) => o.id) ?? [];
    const allIds = [deal.id, ...optionIds];

    // Check for linked campaigns (main and option deals)
    const prisma = getPrisma();
    const campaignCount = await prisma.salesCampaign.count({
      where: { dealId: { in: allIds } },
    });
    if (campaignCount > 0) {
      throw new DealDeletionBlockedError();
    }

    await recordActivityDelete("DEAL", id, actor);

    // Delete related records and deals in a transaction
    await prisma.$transaction(async (tx) => {
      // 1. Unlink from CampaignTemplate
      await tx.campaignTemplate.updateMany({
        where: { dealId: { in: allIds } },
        data: { dealId: null },
      });

      // 2. Delete CampaignDeal links
      await tx.campaignDeal.deleteMany({
        where: { dealId: { in: allIds } },
      });

      // 3. Delete Assets
      await tx.asset.deleteMany({
        where: { entityType: "DEAL", entityId: { in: allIds } },
      });

      // 4. Delete Comments
      await tx.comment.deleteMany({
        where: { entityType: "DEAL", entityId: { in: allIds } },
      });

      // 5. Delete SalesTask (Cascade might handle, but explicit is safer)
      await tx.salesTask.deleteMany({
        where: { dealId: { in: allIds } },
      });

      // 6. Delete SellerOutreach (Cascade might handle, but explicit is safer)
      await tx.sellerOutreach.deleteMany({
        where: { dealId: { in: allIds } },
      });

      // 7. Delete Option Deals
      if (optionIds.length > 0) {
        await tx.deal.deleteMany({
          where: { id: { in: optionIds } },
        });
      }

      // 8. Delete Main Deal
      await tx.deal.delete({
        where: { id: deal.id },
      });
    });

    return { ok: true };
  },
};
