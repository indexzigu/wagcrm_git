type DecimalLike = number | string | { toString(): string } | null | undefined;

export type IncomeTaxBracket = {
  min: number;
  max: number | null;
  rate: number;
  quickDeduction: number;
};

export type IncomeTaxRules = {
  id: string;
  label: string;
  incomeYear: number;
  filingYear: number;
  localIncomeTaxRate: number;
  sourceUrls: string[];
  brackets: IncomeTaxBracket[];
};

export const PERSONAL_BUSINESS_TAX_RULES_2026: IncomeTaxRules = {
  id: "KR_PERSONAL_BUSINESS_2026",
  label: "개인사업자 종합소득세 예상 기준",
  incomeYear: 2025,
  filingYear: 2026,
  localIncomeTaxRate: 0.1,
  sourceUrls: [
    "https://www.nts.go.kr/english/na/ntt/selectNttInfo.do?bbsId=30698&mi=10788&nttSn=1350804",
    "https://elaw.klri.re.kr/eng_service/main.do",
  ],
  brackets: [
    { min: 0, max: 14_000_000, rate: 0.06, quickDeduction: 0 },
    { min: 14_000_000, max: 50_000_000, rate: 0.15, quickDeduction: 1_260_000 },
    { min: 50_000_000, max: 88_000_000, rate: 0.24, quickDeduction: 5_760_000 },
    { min: 88_000_000, max: 150_000_000, rate: 0.35, quickDeduction: 15_440_000 },
    { min: 150_000_000, max: 300_000_000, rate: 0.38, quickDeduction: 19_940_000 },
    { min: 300_000_000, max: 500_000_000, rate: 0.4, quickDeduction: 25_940_000 },
    { min: 500_000_000, max: 1_000_000_000, rate: 0.42, quickDeduction: 35_940_000 },
    { min: 1_000_000_000, max: null, rate: 0.45, quickDeduction: 65_940_000 },
  ],
};

export type EstimatedIncomeTax = {
  taxableIncome: number;
  bracketLabel: string;
  nationalIncomeTax: number;
  localIncomeTax: number;
  totalTax: number;
  effectiveTaxRate: number;
};

export type PnlCampaignRecord = {
  id: string;
  startDate: Date;
  endDate: Date;
  actualSales: DecimalLike;
  totalMarginRate: DecimalLike;
  sellerMarginRate: DecimalLike;
  settlementSales?: DecimalLike;
  sellerExpense?: DecimalLike;
  taxExpense?: DecimalLike;
  operatingExpense?: DecimalLike;
  miscExpense?: DecimalLike;
  operatingProfit?: DecimalLike;
  campaignName?: string | null;
  roundNumber?: number | null;
  salesChannel: string;
  deal: {
    dealName: string;
    brandName?: string | null;
    partner?: {
      name: string;
    } | null;
  };
  seller: {
    name: string;
    alias?: string | null;
  };
};

export type PnlCampaignRow = {
  id: string;
  month: string;
  campaignName: string;
  dealName: string;
  sellerName: string;
  brandName: string | null;
  partnerName: string | null;
  salesChannel: string;
  startDate: string;
  endDate: string;
  grossSales: number;
  commissionRevenue: number;
  sellerPayout: number;
  deductedTax: number;
  operatingExpense: number;
  miscExpense: number;
  preTaxOperatingProfit: number;
  estimatedIncomeTax: number;
  estimatedLocalIncomeTax: number;
  estimatedTotalTax: number;
  afterTaxOperatingProfit: number;
  preTaxProfitRate: number;
  afterTaxProfitRate: number;
  missingCostFields: string[];
};

export type PnlMonthlyRow = {
  month: string;
  grossSales: number;
  commissionRevenue: number;
  totalCosts: number;
  preTaxOperatingProfit: number;
  estimatedTotalTax: number;
  afterTaxOperatingProfit: number;
  campaignCount: number;
};

export type PnlBridgeRow = {
  label: string;
  amount: number;
};

export type VatHalfYearReference = {
  periodLabel: string;
  taxableSales: number;
  payableVat: number;
};

export type PriorYearTaxReference = {
  incomeYear: number;
  filingYear: number;
  businessContext: string;
  totalIncome: number;
  deductions: number;
  taxableIncome: number;
  calculatedTax: number;
  finalDeterminedTax: number;
  effectiveTaxRate: number;
  vatHalfYears: VatHalfYearReference[];
  vatAnnualTaxableSales: number;
  firstHalfSalesRatio: number;
  secondHalfSalesRatio: number;
  firstHalfMonthlyAverage: number;
  secondHalfMonthlyAverage: number;
};

export type PnlReportData = {
  year: number;
  taxRules: IncomeTaxRules;
  taxEstimate: EstimatedIncomeTax;
  priorYearReference: PriorYearTaxReference;
  totals: {
    grossSales: number;
    commissionRevenue: number;
    sellerPayout: number;
    deductedTax: number;
    operatingExpense: number;
    miscExpense: number;
    totalCampaignCosts: number;
    preTaxOperatingProfit: number;
    estimatedIncomeTax: number;
    estimatedLocalIncomeTax: number;
    estimatedTotalTax: number;
    afterTaxOperatingProfit: number;
    campaignCount: number;
  };
  bridge: PnlBridgeRow[];
  monthly: PnlMonthlyRow[];
  campaigns: PnlCampaignRow[];
};

const PRIOR_YEAR_FILED_REFERENCE_2025: PriorYearTaxReference = {
  incomeYear: 2025,
  filingYear: 2026,
  businessContext: "2025년 상반기 영업활동 비중이 낮았던 실제 신고 기준",
  totalIncome: 23_965_725,
  deductions: 1_500_000,
  taxableIncome: 22_465_725,
  calculatedTax: 2_109_858,
  finalDeterminedTax: 2_029_858,
  effectiveTaxRate: 2_029_858 / 22_465_725 * 100,
  vatHalfYears: [
    {
      periodLabel: "2025 상반기",
      taxableSales: 25_781_618,
      payableVat: 1_224_671,
    },
    {
      periodLabel: "2025 하반기",
      taxableSales: 122_606_294,
      payableVat: 161_458,
    },
  ],
  vatAnnualTaxableSales: 148_387_912,
  firstHalfSalesRatio: 25_781_618 / 148_387_912 * 100,
  secondHalfSalesRatio: 122_606_294 / 148_387_912 * 100,
  firstHalfMonthlyAverage: 25_781_618 / 6,
  secondHalfMonthlyAverage: 122_606_294 / 6,
};

function numberFromDecimal(value: DecimalLike): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  return Number(value.toString()) || 0;
}

function hasDecimalValue(value: DecimalLike): boolean {
  return value != null && value.toString() !== "";
}

function roundCurrency(value: number): number {
  return Math.round(value);
}

function formatBracketLabel(bracket: IncomeTaxBracket): string {
  if (bracket.max == null) return `${bracket.min.toLocaleString()}원 초과`;
  if (bracket.min === 0) return `${bracket.max.toLocaleString()}원 이하`;
  return `${bracket.min.toLocaleString()}원 초과 ${bracket.max.toLocaleString()}원 이하`;
}

/**
 * Estimates personal-business income tax from CRM operating profit only.
 * This is a management reserve estimate, not a filing-grade tax calculation.
 */
export function calculateEstimatedIncomeTax(
  taxableIncome: number,
  rules: IncomeTaxRules = PERSONAL_BUSINESS_TAX_RULES_2026,
): EstimatedIncomeTax {
  const normalizedIncome = Math.max(0, roundCurrency(taxableIncome));
  const bracket =
    rules.brackets.find(
      (candidate) =>
        normalizedIncome > candidate.min &&
        (candidate.max == null || normalizedIncome <= candidate.max),
    ) ?? rules.brackets[0];
  const nationalIncomeTax = Math.max(
    0,
    roundCurrency(normalizedIncome * bracket.rate - bracket.quickDeduction),
  );
  const localIncomeTax = roundCurrency(nationalIncomeTax * rules.localIncomeTaxRate);
  const totalTax = nationalIncomeTax + localIncomeTax;

  return {
    taxableIncome: normalizedIncome,
    bracketLabel: formatBracketLabel(bracket),
    nationalIncomeTax,
    localIncomeTax,
    totalTax,
    effectiveTaxRate: normalizedIncome > 0 ? (totalTax / normalizedIncome) * 100 : 0,
  };
}

function getCampaignDisplayName(campaign: PnlCampaignRecord): string {
  const storedName = campaign.campaignName?.trim();
  if (storedName) return storedName;

  const sellerName = campaign.seller.alias || campaign.seller.name;
  const round = campaign.roundNumber ? `${campaign.roundNumber}차` : null;
  return [campaign.deal.dealName, sellerName, round].filter(Boolean).join(" ");
}

function getMissingCostFields(campaign: PnlCampaignRecord): string[] {
  const fields: Array<[string, DecimalLike]> = [
    ["셀러 지급액", campaign.sellerExpense],
    ["공제세액", campaign.taxExpense],
    ["운영비", campaign.operatingExpense],
    ["기타비용", campaign.miscExpense],
  ];

  return fields
    .filter(([, value]) => !hasDecimalValue(value))
    .map(([label]) => label);
}

function buildBaseCampaignRows(campaigns: PnlCampaignRecord[]): PnlCampaignRow[] {
  return campaigns.map((campaign) => {
    const grossSales = roundCurrency(numberFromDecimal(campaign.actualSales));
    const totalMarginRate = numberFromDecimal(campaign.totalMarginRate);
    const commissionRevenue = roundCurrency(
      hasDecimalValue(campaign.settlementSales)
        ? numberFromDecimal(campaign.settlementSales)
        : (grossSales * totalMarginRate) / 100,
    );
    const sellerPayout = roundCurrency(numberFromDecimal(campaign.sellerExpense));
    const deductedTax = roundCurrency(numberFromDecimal(campaign.taxExpense));
    const operatingExpense = roundCurrency(numberFromDecimal(campaign.operatingExpense));
    const miscExpense = roundCurrency(numberFromDecimal(campaign.miscExpense));
    const calculatedPreTaxProfit =
      commissionRevenue - sellerPayout - deductedTax - operatingExpense - miscExpense;
    const preTaxOperatingProfit = roundCurrency(
      hasDecimalValue(campaign.operatingProfit)
        ? numberFromDecimal(campaign.operatingProfit)
        : calculatedPreTaxProfit,
    );
    const month = `${campaign.startDate.getFullYear()}-${String(
      campaign.startDate.getMonth() + 1,
    ).padStart(2, "0")}`;

    return {
      id: campaign.id,
      month,
      campaignName: getCampaignDisplayName(campaign),
      dealName: campaign.deal.dealName,
      sellerName: campaign.seller.alias || campaign.seller.name,
      brandName: campaign.deal.brandName ?? null,
      partnerName: campaign.deal.partner?.name ?? null,
      salesChannel: campaign.salesChannel,
      startDate: campaign.startDate.toISOString().split("T")[0],
      endDate: campaign.endDate.toISOString().split("T")[0],
      grossSales,
      commissionRevenue,
      sellerPayout,
      deductedTax,
      operatingExpense,
      miscExpense,
      preTaxOperatingProfit,
      estimatedIncomeTax: 0,
      estimatedLocalIncomeTax: 0,
      estimatedTotalTax: 0,
      afterTaxOperatingProfit: preTaxOperatingProfit,
      preTaxProfitRate:
        grossSales > 0 ? (preTaxOperatingProfit / grossSales) * 100 : 0,
      afterTaxProfitRate:
        grossSales > 0 ? (preTaxOperatingProfit / grossSales) * 100 : 0,
      missingCostFields: getMissingCostFields(campaign),
    };
  });
}

function buildMonthlyRows(campaigns: PnlCampaignRow[]): PnlMonthlyRow[] {
  const monthly = new Map<string, PnlMonthlyRow>();

  for (const campaign of campaigns) {
    if (!monthly.has(campaign.month)) {
      monthly.set(campaign.month, {
        month: campaign.month,
        grossSales: 0,
        commissionRevenue: 0,
        totalCosts: 0,
        preTaxOperatingProfit: 0,
        estimatedTotalTax: 0,
        afterTaxOperatingProfit: 0,
        campaignCount: 0,
      });
    }

    const row = monthly.get(campaign.month)!;
    row.grossSales += campaign.grossSales;
    row.commissionRevenue += campaign.commissionRevenue;
    row.totalCosts +=
      campaign.sellerPayout +
      campaign.deductedTax +
      campaign.operatingExpense +
      campaign.miscExpense;
    row.preTaxOperatingProfit += campaign.preTaxOperatingProfit;
    row.estimatedTotalTax += campaign.estimatedTotalTax;
    row.afterTaxOperatingProfit += campaign.afterTaxOperatingProfit;
    row.campaignCount += 1;
  }

  return Array.from(monthly.values())
    .map((row) => ({
      ...row,
      grossSales: roundCurrency(row.grossSales),
      commissionRevenue: roundCurrency(row.commissionRevenue),
      totalCosts: roundCurrency(row.totalCosts),
      preTaxOperatingProfit: roundCurrency(row.preTaxOperatingProfit),
      estimatedTotalTax: roundCurrency(row.estimatedTotalTax),
      afterTaxOperatingProfit: roundCurrency(row.afterTaxOperatingProfit),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Builds the annual P&L report view model from settled campaign data.
 * The model is intended for operating-profit visibility and tax reserve planning,
 * not for replacing a formal income statement or tax return.
 */
export function buildPnlReportModel(
  campaigns: PnlCampaignRecord[],
  year: number,
  taxRules: IncomeTaxRules = PERSONAL_BUSINESS_TAX_RULES_2026,
): PnlReportData {
  const baseRows = buildBaseCampaignRows(campaigns);
  const preTaxOperatingProfit = roundCurrency(
    baseRows.reduce((sum, row) => sum + row.preTaxOperatingProfit, 0),
  );
  const taxEstimate = calculateEstimatedIncomeTax(preTaxOperatingProfit, taxRules);
  const positiveProfitTotal = baseRows.reduce(
    (sum, row) => sum + Math.max(0, row.preTaxOperatingProfit),
    0,
  );

  const campaignRows = baseRows
    .map((row) => {
      const taxShare =
        positiveProfitTotal > 0
          ? Math.max(0, row.preTaxOperatingProfit) / positiveProfitTotal
          : 0;
      const estimatedIncomeTax = roundCurrency(taxEstimate.nationalIncomeTax * taxShare);
      const estimatedLocalIncomeTax = roundCurrency(taxEstimate.localIncomeTax * taxShare);
      const estimatedTotalTax = estimatedIncomeTax + estimatedLocalIncomeTax;
      const afterTaxOperatingProfit = row.preTaxOperatingProfit - estimatedTotalTax;

      return {
        ...row,
        estimatedIncomeTax,
        estimatedLocalIncomeTax,
        estimatedTotalTax,
        afterTaxOperatingProfit,
        afterTaxProfitRate:
          row.grossSales > 0
            ? (afterTaxOperatingProfit / row.grossSales) * 100
            : 0,
      };
    })
    .sort((a, b) => b.preTaxOperatingProfit - a.preTaxOperatingProfit);

  const totals = campaignRows.reduce(
    (acc, row) => ({
      grossSales: acc.grossSales + row.grossSales,
      commissionRevenue: acc.commissionRevenue + row.commissionRevenue,
      sellerPayout: acc.sellerPayout + row.sellerPayout,
      deductedTax: acc.deductedTax + row.deductedTax,
      operatingExpense: acc.operatingExpense + row.operatingExpense,
      miscExpense: acc.miscExpense + row.miscExpense,
      preTaxOperatingProfit: acc.preTaxOperatingProfit + row.preTaxOperatingProfit,
      estimatedIncomeTax: acc.estimatedIncomeTax + row.estimatedIncomeTax,
      estimatedLocalIncomeTax: acc.estimatedLocalIncomeTax + row.estimatedLocalIncomeTax,
      estimatedTotalTax: acc.estimatedTotalTax + row.estimatedTotalTax,
      afterTaxOperatingProfit: acc.afterTaxOperatingProfit + row.afterTaxOperatingProfit,
      campaignCount: acc.campaignCount + 1,
    }),
    {
      grossSales: 0,
      commissionRevenue: 0,
      sellerPayout: 0,
      deductedTax: 0,
      operatingExpense: 0,
      miscExpense: 0,
      preTaxOperatingProfit: 0,
      estimatedIncomeTax: 0,
      estimatedLocalIncomeTax: 0,
      estimatedTotalTax: 0,
      afterTaxOperatingProfit: 0,
      campaignCount: 0,
    },
  );

  const roundedTotals = {
    ...totals,
    grossSales: roundCurrency(totals.grossSales),
    commissionRevenue: roundCurrency(totals.commissionRevenue),
    sellerPayout: roundCurrency(totals.sellerPayout),
    deductedTax: roundCurrency(totals.deductedTax),
    operatingExpense: roundCurrency(totals.operatingExpense),
    miscExpense: roundCurrency(totals.miscExpense),
    totalCampaignCosts: roundCurrency(
      totals.sellerPayout +
        totals.deductedTax +
        totals.operatingExpense +
        totals.miscExpense,
    ),
    preTaxOperatingProfit: roundCurrency(totals.preTaxOperatingProfit),
    estimatedIncomeTax: roundCurrency(totals.estimatedIncomeTax),
    estimatedLocalIncomeTax: roundCurrency(totals.estimatedLocalIncomeTax),
    estimatedTotalTax: roundCurrency(totals.estimatedTotalTax),
    afterTaxOperatingProfit: roundCurrency(totals.afterTaxOperatingProfit),
  };

  return {
    year,
    taxRules,
    taxEstimate,
    priorYearReference: PRIOR_YEAR_FILED_REFERENCE_2025,
    totals: roundedTotals,
    bridge: [
      { label: "총 상품매출", amount: roundedTotals.grossSales },
      { label: "수수료 매출", amount: roundedTotals.commissionRevenue },
      { label: "셀러 지급", amount: -roundedTotals.sellerPayout },
      { label: "공제세액", amount: -roundedTotals.deductedTax },
      {
        label: "운영/기타비용",
        amount: -(roundedTotals.operatingExpense + roundedTotals.miscExpense),
      },
      { label: "세전 이익", amount: roundedTotals.preTaxOperatingProfit },
      { label: "예상 세금", amount: -roundedTotals.estimatedTotalTax },
      { label: "세후 이익", amount: roundedTotals.afterTaxOperatingProfit },
    ],
    monthly: buildMonthlyRows(campaignRows),
    campaigns: campaignRows,
  };
}
