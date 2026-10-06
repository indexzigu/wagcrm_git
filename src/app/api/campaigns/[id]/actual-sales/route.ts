import { NextResponse } from "next/server";
import { z } from "zod";
import { recordCampaignActivity } from "@/lib/campaign-activity";
import { toCampaignRow } from "@/lib/campaign-row";
import { getPrisma } from "@/lib/prisma";
import { applySlideMargin, parseMarginPolicy } from "@/lib/margin";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import {
  calculateDerivedCampaignFinancials,
  resolveSellerFeeBasisEligibility,
} from "@/lib/campaign-financials";
import type { SalesChannel } from "@/lib/crm-types";

const actualSalesSchema = z.object({
  actualSales: z.coerce.number().nonnegative(),
});

type DecimalInput = { toString(): string } | number | null | undefined;

const toNullableNumber = (value: DecimalInput) => (value == null ? null : Number(value.toString()));

/**
 * 운영자가 수동으로 정한 값(수동 영업수익·판매대행비·제세공과금·정산 기준액)과 세무 유형을
 * 계산 입력으로 옮긴다. ⛔ 빼먹지 말 것 — 종전 이 라우트는 이 입력을 하나도 넘기지 않아
 * 실매출을 고칠 때마다 수동값을 전부 자동값으로 덮었다(세무 유형도 안 넘겨 사업자 셀러를
 * 개인으로 계산했다).
 */
function manualFinancialInputs(campaign: {
  isManualSettlementSales: boolean;
  isManualSellerExpense: boolean;
  isManualTaxExpense: boolean;
  settlementSales: DecimalInput;
  sellerExpense: DecimalInput;
  taxExpense: DecimalInput;
  sellerFeeBasisOverride: DecimalInput;
  sellerMarginRate: DecimalInput;
  sellerTaxType: string | null;
  seller: { agency: { businessNumber: string | null } | null } | null;
  campaignDeals: Array<{ sellerMarginRate: DecimalInput }>;
}, sellerMarginRate: number) {
  const eligibility = resolveSellerFeeBasisEligibility({
    deals: campaign.campaignDeals,
    campaignSellerMarginRate: sellerMarginRate,
  });
  return {
    sellerTaxType: campaign.sellerTaxType,
    sellerCompanyBusinessNumber: campaign.seller?.agency?.businessNumber ?? null,
    isManualSettlementSales: campaign.isManualSettlementSales,
    isManualSellerExpense: campaign.isManualSellerExpense,
    isManualTaxExpense: campaign.isManualTaxExpense,
    manualSettlementSales: toNullableNumber(campaign.settlementSales),
    manualSellerExpense: toNullableNumber(campaign.sellerExpense),
    manualTaxExpense: toNullableNumber(campaign.taxExpense),
    // 요율이 섞인 캠페인은 수동 기준액 자격이 없다 — 이 라우트는 캠페인 단일 요율로 계산하므로
    // 자격이 없으면 기준액을 넘기지 않는다(틀린 요율로 곱하지 않는다).
    sellerFeeBasisOverride: eligibility.eligible ? toNullableNumber(campaign.sellerFeeBasisOverride) : null,
  };
}

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
    include: {
      deal: true,
      seller: { include: { agency: true } },
      campaignDeals: { select: { sellerMarginRate: true } },
    },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (campaign.isManualMargin) {
    const sellerMarginRate = Number(campaign.sellerMarginRate?.toString() ?? 0);
    const derivedFinancials = calculateDerivedCampaignFinancials({
      actualSales: parsed.data.actualSales,
      operatingExpense: Number(campaign.operatingExpense?.toString() ?? 0),
      miscExpense: Number(campaign.miscExpense?.toString() ?? 0),
      totalMarginRate: Number(campaign.totalMarginRate?.toString() ?? 0),
      sellerMarginRate,
      ...manualFinancialInputs(campaign, sellerMarginRate),
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
    ...manualFinancialInputs(campaign, rate.sellerMarginRate),
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
