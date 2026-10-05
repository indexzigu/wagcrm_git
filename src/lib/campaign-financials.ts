import { computeRevenue } from "./revenue-calc";
import { calcIndividualIncomeTax, isIndividualSeller } from "./seller-tax-utils";

export type DerivedCampaignFinancials = {
  settlementSales: number;
  sellerExpense: number;
  taxExpense: number;
  operatingProfit: number;
};

/**
 * 저장 `SalesCampaign.operatingProfit` 산식의 SSOT — **영업수익(수수료 수익) 기준**
 * (오너 확정 2026-10-05).
 *
 *   operatingProfit = settlementSales − sellerExpense − taxExpense − operatingExpense − miscExpense
 *
 * ⛔ 피감수를 총매출(`actualSales`)로 바꾸지 말 것 — 주문 동기화 writer
 * (`mapping-service.recalculateSalesCampaignTotals`)가 그렇게 써서, 물품대금이
 * 우리 돈이 아닌 캠페인의 손익이 (총매출 − 영업수익)만큼 부풀어 저장됐다.
 * ⛔ 이 뺄셈을 호출부에서 다시 적지 말 것 — writer 3곳(편집 PATCH · 주문 동기화 ·
 * 실매출 입력)과 표시 폴백이 전부 이 함수를 부른다. 재구현·총매출 기준 회귀는
 * `operating-profit-basis.contract.test.ts` 가 소스 전수 스캔(AST)으로 막는다.
 *
 * ℹ️ 각 항(`settlementSales`·`sellerExpense`·`taxExpense`)을 **어떻게 구하는가**는
 * 이 함수의 소관이 아니다(writer 마다 다르며 별도 미결 사안).
 */
export function computeOperatingProfit({
  settlementSales,
  sellerExpense,
  taxExpense,
  operatingExpense,
  miscExpense,
}: {
  settlementSales: number;
  sellerExpense: number;
  taxExpense: number;
  operatingExpense: number;
  miscExpense: number;
}): number {
  return settlementSales - sellerExpense - taxExpense - operatingExpense - miscExpense;
}

/**
 * Recalculates campaign financial totals from gross sales and commission rates.
 * The current settlement workspace treats withholding/deducted tax as 10% of
 * net commission, then subtracts campaign costs from commission revenue.
 */
/**
 * 개인 셀러 원천세(3.3%) — **실제 셀러 지급액**에 건다(오너 확정 2026-10-05).
 * 지급액을 수동으로 덮어쓴 캠페인(예: 같은 캠페인에서 우리가 별도로 판 매출이 섞여 셀러 몫만 지급)은
 * 품목별 자동 지급액이 아니라 그 수동 지급액이 원천세의 근거다 — 자동 합계를 쓰면 실제 공제액과 갈린다.
 */
export function resolveIndividualWithholding({
  isManualSellerExpense,
  sellerExpense,
  autoWithholdingSum,
}: {
  isManualSellerExpense: boolean;
  sellerExpense: number;
  autoWithholdingSum: number;
}): number {
  return isManualSellerExpense ? calcIndividualIncomeTax(sellerExpense) : autoWithholdingSum;
}

export function calculateDerivedCampaignFinancials({
  actualSales,
  operatingExpense,
  miscExpense,
  totalMarginRate,
  sellerMarginRate,
  sellerTaxType,
  sellerCompanyBusinessNumber,
  isManualSettlementSales = false,
  isManualSellerExpense = false,
  isManualTaxExpense = false,
  manualSettlementSales,
  manualSellerExpense,
  manualTaxExpense,
}: {
  actualSales: number;
  operatingExpense: number;
  miscExpense: number;
  totalMarginRate: number;
  sellerMarginRate: number;
  sellerTaxType?: string | null;
  sellerCompanyBusinessNumber?: string | null;
  isManualSettlementSales?: boolean;
  isManualSellerExpense?: boolean;
  isManualTaxExpense?: boolean;
  manualSettlementSales?: number | null;
  manualSellerExpense?: number | null;
  manualTaxExpense?: number | null;
}): DerivedCampaignFinancials {
  const isIndividual = isIndividualSeller({
    sellerTaxType,
    sellerCompanyBusinessNumber,
  });

  const calculated = computeRevenue(
    actualSales,
    0,
    totalMarginRate,
    sellerMarginRate,
    isIndividual,
  );
  
  const autoSettlementSales = calculated?.netRevenue ?? 0;
  const autoSellerExpense = calculated?.sellerCommission ?? 0;
  
  const settlementSales = isManualSettlementSales && manualSettlementSales != null
    ? manualSettlementSales
    : autoSettlementSales;
    
  const sellerExpense = isManualSellerExpense && manualSellerExpense != null
    ? manualSellerExpense
    : autoSellerExpense;

  const netCommission = settlementSales - sellerExpense;
  
  const autoTaxExpense = isIndividual
    // 원천세 = 셀러 지급액(부가세 제외 매출 × 수수료율) × 3.3% — 오너 확정 2026-10-05. 지급액을 다시 ÷1.1 하지 않는다.
    ? calcIndividualIncomeTax(sellerExpense) + Math.round(settlementSales - (settlementSales / 1.1))
    : Math.round(netCommission - (netCommission / 1.1));
    
  const taxExpense = isManualTaxExpense && manualTaxExpense != null
    ? manualTaxExpense
    : autoTaxExpense;

  const operatingProfit = computeOperatingProfit({
    settlementSales,
    sellerExpense,
    taxExpense,
    operatingExpense,
    miscExpense,
  });

  return {
    settlementSales,
    sellerExpense,
    taxExpense,
    operatingProfit,
  };
}
