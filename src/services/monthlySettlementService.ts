/**
 * 월별 정산 줄(T-240) 쓰기·조회 SSOT.
 *
 * 규칙(판정은 `src/lib/monthly-settlement.ts`, 이전 매핑은 `monthly-settlement-backfill.ts`):
 * - 줄 쓰기는 거래처가 월정산일 때만 받는다. 끄면 줄은 **지우지 않고** 보관한다(비파괴) — 패널이
 *   숨고 완료 게이트·물품대금 롤업이 멈출 뿐이다.
 * - 줄을 바꾸면 같은 tx 에서 캠페인 `settlementGoodsCost` 를 Σ 물품대금으로 맞춘다. 그 필드는
 *   재무 카드·브랜드 정산 총액·공급사 지급 칸의 근거이고(손익 무관), 월별 합과 갈리면 오너가
 *   두 숫자 중 무엇으로 송금할지 모르게 된다.
 * - 공급가액·세액은 클라이언트 값을 받지 않고 수수료액에서 서버가 다시 나눈다(`vat.ts` 하나).
 * - 캠페인의 주문수량·거래액은 **어디서도 쓰지 않는다**(명세 금지 사항).
 */
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { toKstYmd } from "@/lib/date-utils";
import {
  attributeDailyStatsToMonths,
  buildMonthlyIncompleteMessage,
  isMonthlyCompletionBlocked,
  rollupMonthlyGoodsCost,
  sortMonthlyLines,
  splitMonthlyCommission,
  toKstYearMonth,
  type MonthlySettlementLine,
} from "@/lib/monthly-settlement";
import { buildMonthlyBackfillLine } from "@/lib/monthly-settlement-backfill";
import { parseCachedDailyStats } from "@/lib/cached-daily-stats";

type Db = Prisma.TransactionClient | ReturnType<typeof getPrisma>;
type DecimalLike = Prisma.Decimal | number | string | null | undefined;
type LineRow = Prisma.CampaignMonthlySettlementGetPayload<object>;

/** 쓰기 입력 — 날짜는 "YYYY-MM-DD", 금액은 number. 생략 = 무변경, null = 지움. */
export type MonthlyLineWriteInput = Partial<{
  yearMonth: string;
  periodStart: string | null;
  periodEnd: string | null;
  quantity: number | null;
  transactionAmount: number | null;
  commissionRate: number | null;
  commissionAmount: number | null;
  salesInvoiceIssuedAt: string | null;
  salesInvoiceNo: string | null;
  salesInvoiceItemName: string | null;
  purchaseInvoiceReceivedAt: string | null;
  goodsAmount: number | null;
  paymentAmount: number | null;
  paymentDueDate: string | null;
  paymentPaidAt: string | null;
  salesInvoiceCheckedAt: string | null;
  purchaseInvoiceCheckedAt: string | null;
  paymentScheduleCheckedAt: string | null;
  paymentCompletedCheckedAt: string | null;
  memo: string | null;
}>;

export class MonthlySettlementError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = "MonthlySettlementError";
  }
}

const NOT_MONTHLY_MESSAGE = "이 캠페인의 거래처는 월정산이 아닙니다. 거래처에서 월정산을 켜야 합니다.";

function toNumber(value: DecimalLike): number | null {
  if (value == null) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

function toYmd(value: Date | null): string | null {
  return value ? toKstYmd(value) : null;
}

export function toMonthlyLineDto(row: LineRow): MonthlySettlementLine {
  return {
    id: row.id,
    campaignId: row.campaignId,
    yearMonth: row.yearMonth,
    periodStart: toYmd(row.periodStart),
    periodEnd: toYmd(row.periodEnd),
    quantity: row.quantity,
    transactionAmount: toNumber(row.transactionAmount),
    commissionRate: toNumber(row.commissionRate),
    commissionAmount: toNumber(row.commissionAmount),
    supplyAmount: toNumber(row.supplyAmount),
    vat: toNumber(row.vat),
    salesInvoiceIssuedAt: toYmd(row.salesInvoiceIssuedAt),
    salesInvoiceNo: row.salesInvoiceNo,
    salesInvoiceItemName: row.salesInvoiceItemName,
    purchaseInvoiceReceivedAt: toYmd(row.purchaseInvoiceReceivedAt),
    goodsAmount: toNumber(row.goodsAmount),
    paymentAmount: toNumber(row.paymentAmount),
    paymentDueDate: toYmd(row.paymentDueDate),
    paymentPaidAt: toYmd(row.paymentPaidAt),
    salesInvoiceCheckedAt: toYmd(row.salesInvoiceCheckedAt),
    purchaseInvoiceCheckedAt: toYmd(row.purchaseInvoiceCheckedAt),
    paymentScheduleCheckedAt: toYmd(row.paymentScheduleCheckedAt),
    paymentCompletedCheckedAt: toYmd(row.paymentCompletedCheckedAt),
    memo: row.memo,
  };
}

const DATE_FIELDS = [
  "periodStart",
  "periodEnd",
  "salesInvoiceIssuedAt",
  "purchaseInvoiceReceivedAt",
  "paymentDueDate",
  "paymentPaidAt",
  "salesInvoiceCheckedAt",
  "purchaseInvoiceCheckedAt",
  "paymentScheduleCheckedAt",
  "paymentCompletedCheckedAt",
] as const;

const PASS_THROUGH_FIELDS = [
  "yearMonth",
  "quantity",
  "transactionAmount",
  "commissionRate",
  "commissionAmount",
  "salesInvoiceNo",
  "salesInvoiceItemName",
  "goodsAmount",
  "paymentAmount",
  "memo",
] as const;

/** 쓰기 입력 → Prisma data. 공급가액·세액은 수수료액이 실릴 때 서버가 다시 나눈다. */
function toLineData(input: MonthlyLineWriteInput): Prisma.CampaignMonthlySettlementUncheckedUpdateInput {
  const data: Prisma.CampaignMonthlySettlementUncheckedUpdateInput = {};
  for (const field of PASS_THROUGH_FIELDS) {
    if (input[field] !== undefined) Object.assign(data, { [field]: input[field] });
  }
  for (const field of DATE_FIELDS) {
    const value = input[field];
    if (value !== undefined) Object.assign(data, { [field]: value ? new Date(value) : null });
  }
  if (input.commissionAmount !== undefined) {
    const { supplyAmount, vat } = splitMonthlyCommission(input.commissionAmount);
    Object.assign(data, { supplyAmount, vat });
  }
  return data;
}

async function loadCampaignForMonthly(db: Db, campaignId: string) {
  return db.salesCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      actualSales: true,
      deal: { select: { partner: { select: { monthlySettlement: true } } } },
      orderCampaign: { select: { cachedDailyStats: true } },
    },
  });
}

/** 캠페인 `settlementGoodsCost` ← Σ 물품대금. 반드시 줄 쓰기와 같은 tx 에서 부른다. */
async function rollupCampaignGoodsCost(tx: Prisma.TransactionClient, campaignId: string) {
  const lines = await tx.campaignMonthlySettlement.findMany({
    where: { campaignId },
    select: { goodsAmount: true },
  });
  const goodsCost = rollupMonthlyGoodsCost(lines.map((l) => ({ goodsAmount: toNumber(l.goodsAmount) })));
  await tx.salesCampaign.update({
    where: { id: campaignId },
    data: { settlementGoodsCost: goodsCost },
  });
}

async function requireMonthlyCampaign(tx: Prisma.TransactionClient, campaignId: string) {
  const campaign = await loadCampaignForMonthly(tx, campaignId);
  if (!campaign) throw new MonthlySettlementError("캠페인을 찾을 수 없습니다.", 404);
  if (!campaign.deal.partner?.monthlySettlement) {
    throw new MonthlySettlementError(NOT_MONTHLY_MESSAGE, 409);
  }
  return campaign;
}

/** 귀속 기준이 주문일이라 캠페인 기간 밖의 달은 정의상 없다(resolveNextMonthToAdd 와 같은 경계). */
function assertMonthInCampaign(campaign: { startDate: Date; endDate: Date }, yearMonth: string) {
  if (yearMonth < toKstYearMonth(campaign.startDate) || yearMonth > toKstYearMonth(campaign.endDate)) {
    throw new MonthlySettlementError("캠페인 기간에 속하지 않는 달은 정산 줄로 둘 수 없습니다.", 409);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error != null && (error as { code?: string }).code === "P2002";
}

/** 같은 캠페인·같은 달 unique 충돌(P2002)을 오너가 읽을 409 로 바꾼다 — 생성·수정 공용. */
async function translateDuplicateMonth<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new MonthlySettlementError("그 달의 정산 줄이 이미 있습니다.", 409);
    }
    throw error;
  }
}

export type MonthlySettlementView = {
  enabled: boolean;
  lines: MonthlySettlementLine[];
  /** 주문일 기준 참고값(마감 시 저장된 일별 매출의 달별 합) — 마감 전이면 빈 객체. */
  orderDateReference: Record<string, { orders: number; revenue: number }>;
  campaignTransactionAmount: number | null;
};

export const monthlySettlementService = {
  async getView(campaignId: string): Promise<MonthlySettlementView | null> {
    const prisma = getPrisma();
    const campaign = await loadCampaignForMonthly(prisma, campaignId);
    if (!campaign) return null;
    const rows = await prisma.campaignMonthlySettlement.findMany({ where: { campaignId } });
    return {
      enabled: Boolean(campaign.deal.partner?.monthlySettlement),
      lines: sortMonthlyLines(rows.map(toMonthlyLineDto)),
      orderDateReference: attributeDailyStatsToMonths(
        parseCachedDailyStats(campaign.orderCampaign?.cachedDailyStats ?? null),
      ),
      campaignTransactionAmount: toNumber(campaign.actualSales),
    };
  },

  async createLine(campaignId: string, input: MonthlyLineWriteInput & { yearMonth: string }) {
    const prisma = getPrisma();
    return translateDuplicateMonth(() =>
      prisma.$transaction(async (tx) => {
        const campaign = await requireMonthlyCampaign(tx, campaignId);
        assertMonthInCampaign(campaign, input.yearMonth);
        const row = await tx.campaignMonthlySettlement.create({
          data: { ...(toLineData(input) as Prisma.CampaignMonthlySettlementUncheckedCreateInput), campaignId, yearMonth: input.yearMonth },
        });
        // 물품대금이 실릴 때만 롤업한다 — 빈 줄 추가가 캠페인의 기존(수기) 물품대금을 null 로 덮지 않게.
        if (input.goodsAmount !== undefined) await rollupCampaignGoodsCost(tx, campaignId);
        return toMonthlyLineDto(row);
      }),
    );
  },

  async updateLine(campaignId: string, lineId: string, input: MonthlyLineWriteInput) {
    const prisma = getPrisma();
    return translateDuplicateMonth(() =>
      prisma.$transaction(async (tx) => {
        const campaign = await requireMonthlyCampaign(tx, campaignId);
        if (input.yearMonth !== undefined) assertMonthInCampaign(campaign, input.yearMonth);
        // 소유 확인을 where 에 싣는다 — 남의 캠페인 줄 id 로는 아무것도 못 쓴다.
        const { count } = await tx.campaignMonthlySettlement.updateMany({
          where: { id: lineId, campaignId },
          data: toLineData(input) as Prisma.CampaignMonthlySettlementUncheckedUpdateManyInput,
        });
        if (count !== 1) throw new MonthlySettlementError("정산 줄을 찾을 수 없습니다.", 404);
        // 체크 칸만 바꾼 저장은 롤업하지 않는다 — 물품대금을 고친 저장만 캠페인 값을 다시 맞춘다
        // (끄고 켠 사이에 재무 카드에서 고친 값이 체크 하나로 덮이는 일을 막는다, 교차 검증 지적).
        if (input.goodsAmount !== undefined) await rollupCampaignGoodsCost(tx, campaignId);
        const row = await tx.campaignMonthlySettlement.findUniqueOrThrow({ where: { id: lineId } });
        return toMonthlyLineDto(row);
      }),
    );
  },

  async deleteLine(campaignId: string, lineId: string) {
    const prisma = getPrisma();
    await prisma.$transaction(async (tx) => {
      await requireMonthlyCampaign(tx, campaignId);
      const { count } = await tx.campaignMonthlySettlement.deleteMany({ where: { id: lineId, campaignId } });
      if (count !== 1) throw new MonthlySettlementError("정산 줄을 찾을 수 없습니다.", 404);
      await rollupCampaignGoodsCost(tx, campaignId);
    });
  },

  /** 월정산을 켜면 줄이 생길 기존 캠페인 수(확인 창 문구용 — 실제 생성과 같은 조건). */
  async countBackfillTargets(partnerId: string): Promise<number> {
    return getPrisma().salesCampaign.count({ where: backfillTargetWhere(partnerId) });
  },

  /**
   * 거래처 월정산 켜기/끄기. 켤 때 그 거래처의 기존 캠페인(드랍 제외) 중 줄이 없는 것에 1줄씩
   * 만든다 — 같은 tx 라 「켜졌는데 이전이 반만 됐다」는 상태가 없다. 끌 때는 플래그만 내린다.
   */
  async setPartnerMonthlySettlement(partnerId: string, enabled: boolean, now = new Date()) {
    const prisma = getPrisma();
    return prisma.$transaction(async (tx) => {
      const partner = await tx.partner.findUnique({ where: { id: partnerId }, select: { id: true } });
      if (!partner) throw new MonthlySettlementError("거래처를 찾을 수 없습니다.", 404);
      await tx.partner.update({ where: { id: partnerId }, data: { monthlySettlement: enabled } });
      if (!enabled) return { enabled, createdLines: 0 };

      const campaigns = await tx.salesCampaign.findMany({
        where: backfillTargetWhere(partnerId),
        include: { group: true },
      });
      const data = campaigns.map((campaign) => {
        // 그룹 소속이면 일정·계산서 날짜·지급 플래그의 정본은 그룹 스칼라다(CG-1).
        const owner = (campaign.groupId ? campaign.group : null) ?? campaign;
        const line = buildMonthlyBackfillLine(
          {
            startDate: campaign.startDate,
            endDate: campaign.endDate,
            salesChannel: campaign.salesChannel,
            quantity: campaign.quantity,
            actualSales: toNumber(campaign.actualSales),
            totalMarginRate: toNumber(campaign.totalMarginRate),
            settlementSales: toNumber(campaign.settlementSales),
            settlementGoodsCost: toNumber(campaign.settlementGoodsCost),
            supplierInvoiceIssuedAt: owner.supplierInvoiceIssuedAt,
            expectedDepositDate: owner.expectedDepositDate,
            depositReceivedAt: owner.depositReceivedAt,
            isDepositReceived: owner.isDepositReceived,
            expectedPayoutDate: owner.expectedPayoutDate,
            payoutCompletedAt: owner.payoutCompletedAt,
            isPayoutCompleted: owner.isPayoutCompleted,
            expectedSupplierPayoutDate: owner.expectedSupplierPayoutDate,
            supplierPayoutCompletedAt: owner.supplierPayoutCompletedAt,
            isSupplierPayoutCompleted: owner.isSupplierPayoutCompleted,
          },
          now,
        );
        return { ...line, campaignId: campaign.id };
      });
      if (data.length > 0) await tx.campaignMonthlySettlement.createMany({ data });
      // 롤업은 하지 않는다 — 줄 1개의 물품대금 = 원래 캠페인 값이라 Σ 가 이미 같다.
      return { enabled, createdLines: data.length };
    });
  },

  /**
   * 완료 게이트 — 이 캠페인을 지금 정산 완료로 바꾸면 안 되는가. 막히면 오너에게 보일 문구를 준다.
   * 월정산이 아닌 거래처면 언제나 통과(기존 동작 그대로).
   */
  async findCompletionBlocker(db: Db, campaignId: string): Promise<string | null> {
    const blocked = await this.findCompletionBlockers(db, [campaignId]);
    return blocked.get(campaignId) ?? null;
  },

  /**
   * 자동 전이 게이트 — 입금·지급 플래그가 부른 「정산 완료」 자동 전이를 월별 정산이 막으면 상태 전이만
   * 보류한다(플래그는 호출부가 그대로 저장). 자동 전이를 계산하는 세 경로(캠페인 PATCH · 정산 토글 ·
   * 어시스턴트 확정)가 이 한 함수를 지나야 「보류」의 모양이 갈라지지 않는다.
   * 반환: 실제로 쓸 다음 상태(보류면 undefined)와 오너에게 보일 보류 사유(없으면 null).
   * ⚠️ 조합 캠페인은 실캠페인 1개라 원본이 보류되면 형제 전파도 일어나지 않는다(그룹 전체 보류).
   */
  async gateAutoCompletion(
    db: Db,
    campaignId: string,
    previousStatus: string,
    autoStatus: string | null | undefined,
  ): Promise<{ status: string | undefined; blockedReason: string | null }> {
    if (autoStatus !== "COMPLETED" || previousStatus === "COMPLETED") {
      return { status: autoStatus ?? undefined, blockedReason: null };
    }
    const blockedReason = await this.findCompletionBlocker(db, campaignId);
    return { status: blockedReason ? undefined : autoStatus, blockedReason };
  },

  /** 여러 캠페인(조합 캠페인 형제) 판정 — 막힌 캠페인 id → 문구. */
  async findCompletionBlockers(db: Db, campaignIds: readonly string[]): Promise<Map<string, string>> {
    const blocked = new Map<string, string>();
    if (campaignIds.length === 0) return blocked;
    const campaigns = await db.salesCampaign.findMany({
      where: { id: { in: [...campaignIds] }, deal: { partner: { monthlySettlement: true } } },
      select: { id: true, monthlySettlements: true },
    });
    for (const campaign of campaigns) {
      const lines = campaign.monthlySettlements.map(toMonthlyLineDto);
      if (isMonthlyCompletionBlocked({ monthlySettlementEnabled: true, lines })) {
        blocked.set(campaign.id, buildMonthlyIncompleteMessage(lines));
      }
    }
    return blocked;
  },
};

function backfillTargetWhere(partnerId: string): Prisma.SalesCampaignWhereInput {
  return {
    deal: { partnerId },
    status: { not: "DROPPED" },
    monthlySettlements: { none: {} },
  };
}
