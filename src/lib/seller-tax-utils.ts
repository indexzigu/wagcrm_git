/**
 * 셀러의 세무 유형 판별 및 관련 계산을 처리하는 유틸리티
 */

export function isIndividualSeller(params: {
  sellerTaxType?: string | null;
  sellerCompanyBusinessNumber?: string | null;
}): boolean {
  if (params.sellerTaxType === "INDIVIDUAL") return true;
  if (params.sellerTaxType === "BUSINESS") return false;
  // 명시적 구분이 없는 경우 사업자번호 존재 여부로 판별
  return !params.sellerCompanyBusinessNumber;
}

export function getSellerPayoutBase(actualSales: number, isIndividual: boolean): number {
  if (actualSales == null) return 0;
  return isIndividual ? Math.round(actualSales / 1.1) : actualSales;
}

export function calcIndividualIncomeTax(preTaxPayout: number): number {
  return Math.round(preTaxPayout * 0.033);
}

export function calcBusinessVatBreakdown(payout: number): { supply: number; vat: number } {
  const supply = Math.round(payout / 1.1);
  return { supply, vat: payout - supply };
}

export type IndividualWithholdingInput = {
  /** 명세서와 동일한 딜 집합(`getStatementDeals`)을 넘길 것 — 딜 선택이 갈리면 금액이 갈린다. */
  deals: Array<{ actualSales: number; sellerMarginRate?: number | string | null }>;
  /** 딜에 개별 수수료율이 없을 때 폴백되는 캠페인 수수료율 (명세서와 동일한 ?? 체인) */
  campaignSellerMarginRate?: number | string | null;
  /** 저장된 판매대행비 수동 조정값 — 있으면 딜 합산을 통째로 대체한다 (명세서 동작) */
  savedSellerExpense?: number | null;
};

/**
 * 개인(원천징수) 셀러의 캠페인 단위 지급·원천세 계산 SSOT.
 *
 * 정산 명세서(`settlement-statement.ts`)의 인라인 계산을 추출한 것으로, 원천징수
 * 신고 리포트가 같은 함수를 재사용한다 — **명세서에 찍힌 원천세와 신고 금액이
 * 1원도 어긋나면 안 되기 때문**에 두 곳이 각자 계산하지 않는다.
 *
 * 규칙(명세서와 동일):
 * - 딜별 지급액 = round(공급가(부가세 제외) × 수수료율), 원천세 = 딜별 3.3% 합산
 * - `savedSellerExpense` 가 있으면 지급 총액을 그 값으로 **대체**하고 세액도 그
 *   값 기준으로 다시 계산한다(딜별 합산과 반올림 단위가 달라질 수 있는 것까지가 계약)
 */
export function computeIndividualWithholding(input: IndividualWithholdingInput): {
  preTaxPayout: number;
  withholdingTax: number;
  postTaxPayout: number;
} {
  let preTaxPayout = 0;
  let withholdingTax = 0;

  for (const deal of input.deals) {
    const sellerRate = Number(deal.sellerMarginRate ?? input.campaignSellerMarginRate ?? 0);
    const sellerBase = getSellerPayoutBase(deal.actualSales, true);
    const dealPreTax = Math.round((sellerBase * sellerRate) / 100);
    preTaxPayout += dealPreTax;
    withholdingTax += calcIndividualIncomeTax(dealPreTax);
  }

  if (input.savedSellerExpense != null) {
    preTaxPayout = input.savedSellerExpense;
    withholdingTax = calcIndividualIncomeTax(input.savedSellerExpense);
  }

  return { preTaxPayout, withholdingTax, postTaxPayout: preTaxPayout - withholdingTax };
}
