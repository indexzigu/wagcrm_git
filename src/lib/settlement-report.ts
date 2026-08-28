import { resolveCampaignMoneySlots, type CampaignMoneySlot } from "./tax-filing-board";

export const SETTLEMENT_REPORT_STATUSES = [
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
] as const;

export type SettlementReportStatus =
  (typeof SETTLEMENT_REPORT_STATUSES)[number];

export type SettlementReportStatusFilter =
  | SettlementReportStatus
  | "ALL";

type DecimalLike = number | string | { toString(): string } | null | undefined;

type SettlementCampaignRecord = {
  id: string;
  status: string;
  /** 일정 문자열의 칸 구성 판정 입력 — 슬롯 SSOT `resolveCampaignMoneySlots`. */
  salesChannel?: string | null;
  updatedAt: Date;
  startDate: Date;
  endDate: Date;
  actualSales: DecimalLike;
  totalMarginRate: DecimalLike;
  sellerMarginRate: DecimalLike;
  /** 저장된 영업수익(총 수수료) — 수동 오버라이드·품목별 차등 요율이 반영된 정본. */
  settlementSales?: DecimalLike | null;
  /** 저장된 판매대행비(셀러 정산금) — 개인 셀러의 VAT 제외 기준까지 반영된 정본. */
  sellerExpense?: DecimalLike | null;
  deal: {
    dealName: string;
    brandName?: string | null;
  };
  seller: {
    name: string;
    alias?: string | null;
  };
  sellerTaxType?: string | null;
  sellerCompanyBusinessNumber?: string | null;
  operatingExpense?: DecimalLike | null;
  taxExpense?: DecimalLike | null;
  miscExpense?: DecimalLike | null;
  operatingProfit?: DecimalLike;
  rawSchedule?: string | null;
  expectedDepositDate?: Date | string | null;
  expectedPayoutDate?: Date | string | null;
  expectedSupplierPayoutDate?: Date | string | null;
  // CG-2: 그룹 캠페인은 공유 일정이 CampaignGroup 소유 — group이 조회에 포함되면 그룹 값이 우선.
  group?: {
    expectedDepositDate?: Date | string | null;
    expectedPayoutDate?: Date | string | null;
    expectedSupplierPayoutDate?: Date | string | null;
  } | null;
};

export type SettlementReportCampaign = {
  id: string;
  status: SettlementReportStatus;
  dealName: string;
  brandName: string | null;
  sellerName: string;
  startDate: string;
  endDate: string;
  actualSales: number;
  totalMarginRate: number;
  sellerMarginRate: number;
  totalMarginAmount: number;
  netMarginAmount: number;
  sellerPayoutAmount: number;
  settlementUpdatedAt: string;
  operatingExpense: number;
  taxExpense: number;
  miscExpense: number;
  operatingProfit: number;
  schedule: string;
};

export type SettlementReportData = {
  month: string;
  summary: {
    totalRevenue: number;
    totalMargin: number;
    totalSellerPayouts: number;
    campaignCount: number;
  };
  campaigns: SettlementReportCampaign[];
};

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * 저장 컬럼이 "값을 갖고 있는가" 판정 — `pnl-report.ts` 와 같은 규약.
 * ⚠️ `0` 은 값이 **있는** 것이다(매출 0 인 캠페인의 영업수익 0). 빈 문자열만 미입력으로
 * 본다 — `Number("")` 은 0 이라, 이 가드가 없으면 미입력이 조용히 0 으로 굳는다.
 */
function hasDecimalValue(value: DecimalLike): boolean {
  return value != null && value.toString() !== "";
}

function numberFromDecimal(value: DecimalLike): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return Number(value.toString());
}

export function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function isValidMonthString(month: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  const [, monthStr] = month.split("-");
  const monthNumber = Number(monthStr);
  return monthNumber >= 1 && monthNumber <= 12;
}

export function getMonthDateRange(month: string) {
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const monthNumber = Number(monthStr);
  return {
    firstDay: new Date(year, monthNumber - 1, 1),
    lastDay: new Date(year, monthNumber, 0, 23, 59, 59, 999),
  };
}

export function formatSettlementMonth(month: string): string {
  const [year, monthStr] = month.split("-");
  return `${year}년 ${Number(monthStr)}월`;
}

export function getPreviousMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(year, monthNumber - 2, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function getNextMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(year, monthNumber, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function parseSettlementStatusFilter(
  statusFilter: string | null,
): SettlementReportStatus[] {
  if (!statusFilter || statusFilter === "ALL") {
    return [...SETTLEMENT_REPORT_STATUSES];
  }
  if (
    SETTLEMENT_REPORT_STATUSES.includes(
      statusFilter as SettlementReportStatus,
    )
  ) {
    return [statusFilter as SettlementReportStatus];
  }
  return [...SETTLEMENT_REPORT_STATUSES];
}

/**
 * 일정 문자열 — **칸 구성은 채널이 정한다**(`resolveCampaignMoneySlots`).
 *
 * ⛔ 종전 `입금 && 지급` AND 조건으로 되돌리지 말 것. 그 식은 ①자사몰(입금 칸 없음)에서
 * 항상 빈 문자열이 되고 ②한쪽만 입력된 건도 통째로 버려서, 「일정이 아직 없다」와
 * 「한쪽만 정해졌다」가 같은 모양이 됐다. 지금은 값이 있는 칸만 줄로 낸다.
 * 자사몰은 두 칸이 모두 「지급」이라 상대를 병기해야 어느 줄인지 읽힌다.
 */
function buildScheduleText(
  salesChannel: string,
  dates: Partial<Record<CampaignMoneySlot["expectedField"], Date | string | null | undefined>>,
): string {
  return resolveCampaignMoneySlots(salesChannel)
    .map((slot) => {
      const value = dates[slot.expectedField];
      if (!value) return null;
      return `${slot.counterpartLabel} ${slot.verb}: ${new Date(value).toISOString().split("T")[0]}`;
    })
    .filter((line): line is string => line != null)
    .join("\\n");
}

export function buildSettlementReportModel(
  campaigns: SettlementCampaignRecord[],
  month: string,
): SettlementReportData {
  let totalRevenue = 0;
  let totalMargin = 0;
  let totalSellerPayouts = 0;

  const campaignBreakdown = campaigns.map((campaign) => {
    // CG-2 dual-read: group이 조회에 포함돼 있으면(그룹 캠페인) 그룹 일정이 정본 —
    // 그룹 값이 null이어도 캠페인 잔존값으로 폴백하지 않는다(stale 방지).
    const expectedDepositDate =
      campaign.group?.expectedDepositDate === undefined
        ? campaign.expectedDepositDate
        : campaign.group.expectedDepositDate;
    const expectedPayoutDate =
      campaign.group?.expectedPayoutDate === undefined
        ? campaign.expectedPayoutDate
        : campaign.group.expectedPayoutDate;
    const expectedSupplierPayoutDate =
      campaign.group?.expectedSupplierPayoutDate === undefined
        ? campaign.expectedSupplierPayoutDate
        : campaign.group.expectedSupplierPayoutDate;
    const actualSales = numberFromDecimal(campaign.actualSales);
    const totalMarginRate = numberFromDecimal(campaign.totalMarginRate);
    const sellerMarginRate = numberFromDecimal(campaign.sellerMarginRate);
    // 영업수익(settlementSales)·판매대행비(sellerExpense)는 **저장 컬럼이 정본**이다 —
    // `calculateDerivedCampaignFinancials` 가 저장 시점에 영속시키고, 「정산 진행 중」 표·
    // 셀러 명세서·세무 보드가 전부 그 컬럼을 읽는다(오너 승인 설계
    // `2026-08-07-settlement-money-separation-design.md` §1-2·§1-3).
    // ⛔ 요율로 다시 계산하지 말 것: 그러면 ①수동 오버라이드(`isManualSettlementSales`)
    // ②품목별 차등 수수료율(campaignDeals) ③개인 셀러의 VAT 제외 기준(sellerBase =
    // actualSales/1.1)이 전부 무시돼, **같은 캠페인이 「진행 중」 표와 「완료」 표에서 다른
    // 금액으로 보인다.** 실제로 오너가 정산완료 건의 영업수익을 고쳐도 목록에 반영되지
    // 않는 결함이었다(T-022).
    // 컬럼이 비어 있는 캠페인(actualSales 미입력 등 저장 파생이 한 번도 돌지 않은 건)만
    // 종전 요율 식으로 폴백한다.
    const totalMarginAmount = hasDecimalValue(campaign.settlementSales)
      ? numberFromDecimal(campaign.settlementSales)
      : (actualSales * totalMarginRate) / 100;
    const sellerPayoutAmount = hasDecimalValue(campaign.sellerExpense)
      ? numberFromDecimal(campaign.sellerExpense)
      : (actualSales * sellerMarginRate) / 100;
    // 순마진 = 영업수익 − 판매대행비. 폴백 경로에서는 종전 식
    // (actualSales × (총요율 − 셀러요율) / 100)과 항등이라 값이 바뀌지 않는다.
    const netMarginAmount = totalMarginAmount - sellerPayoutAmount;

    totalRevenue += actualSales;
    totalMargin += netMarginAmount;
    totalSellerPayouts += sellerPayoutAmount;

    return {
      id: campaign.id,
      status: campaign.status as SettlementReportStatus,
      dealName: campaign.deal.dealName,
      brandName: campaign.deal.brandName ?? null,
      sellerName: campaign.seller.name,
      startDate: campaign.startDate.toISOString().split("T")[0],
      endDate: campaign.endDate.toISOString().split("T")[0],
      actualSales,
      totalMarginRate,
      sellerMarginRate,
      totalMarginAmount: roundCurrency(totalMarginAmount),
      netMarginAmount: roundCurrency(netMarginAmount),
      sellerPayoutAmount: roundCurrency(sellerPayoutAmount),
      settlementUpdatedAt: campaign.updatedAt.toISOString(),
      operatingExpense: numberFromDecimal(campaign.operatingExpense),
      taxExpense: numberFromDecimal(campaign.taxExpense),
      miscExpense: numberFromDecimal(campaign.miscExpense),
      operatingProfit: numberFromDecimal(campaign.operatingProfit),
      schedule: campaign.rawSchedule
        ? campaign.rawSchedule
        : buildScheduleText(campaign.salesChannel ?? "", {
            expectedDepositDate,
            expectedPayoutDate,
            expectedSupplierPayoutDate,
          }),
    };
  });

  return {
    month,
    summary: {
      totalRevenue: roundCurrency(totalRevenue),
      totalMargin: roundCurrency(totalMargin),
      totalSellerPayouts: roundCurrency(totalSellerPayouts),
      campaignCount: campaigns.length,
    },
    campaigns: campaignBreakdown,
  };
}
