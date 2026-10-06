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

// ─────────────────────────────────────────────────────────────────────────────
// 정산 기준액(셀러 수수료 기준액) 수동 입력 — 오너 확정 2026-10-06
//
// 실제 사례: 한 캠페인 매출 일부를 우리가 직접 팔아 그 몫에는 셀러 수수료가 붙지 않는다.
// 그래서 「판매대행비를 계산할 때 곱하는 금액」을 운영자가 직접 정할 수 있게 한다.
//
// 저장: `SalesCampaign.sellerFeeBasisOverride` — null = 자동, 숫자(0 포함) = 수동.
// 수기 물품대금 필드와 같은 「null 여부가 곧 모드」 패턴이다(별도 플래그 없음 — 0 이
// 「전량 자체 판매」라는 유효값이라 truthy 검사를 쓰면 안 된다).
//
// 규칙(이 파일이 유일한 정본 — writer·화면이 다시 적지 말 것):
//  R2 수동 기준액은 **입력한 그대로** 기준액이다(개인 셀러도 ÷1.1 하지 않는다).
//  R3 우선순위 = 수동 판매대행비(isManualSellerExpense) > 수동 기준액 > 자동.
//     수동 기준액이면 판매대행비 = round(기준액 × 셀러 수수료율 / 100),
//     개인 원천세 = round(판매대행비 × 3.3%)(`calcIndividualIncomeTax`).
//  R4 품목(CampaignDeal)마다 실효 셀러 수수료율(딜 요율 ?? 캠페인 요율)이 다르면 수동 기준액을
//     허용하지 않는다 — 기준액 하나에 곱할 요율이 하나로 정해지지 않기 때문이다.
// ─────────────────────────────────────────────────────────────────────────────

type RateLike = number | string | { toString(): string } | null | undefined;

function rateToNumber(value: RateLike): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

export const SELLER_FEE_BASIS_MIXED_RATE_MESSAGE =
  "품목마다 셀러 수수료율이 달라 정산 기준액을 직접 입력할 수 없습니다. 판매대행비를 수동으로 입력하세요.";

/** 수동 기준액 입력이 비었거나 숫자가 아니거나 음수일 때(저장 차단). */
export const SELLER_FEE_BASIS_INPUT_ERROR = "0 이상의 금액을 입력하세요";

/** 기준액이 저장된 뒤 품목 요율이 섞여 자격을 잃은 상태(화면 안내 문구 — 운영자 전용). */
export const SELLER_FEE_BASIS_STALE_MESSAGE =
  "품목별 수수료율이 달라져 이 기준액은 적용되지 않습니다. 자동으로 돌리거나 판매대행비를 수동 입력하세요.";

export type SellerFeeBasisEligibility =
  | { eligible: true; sellerRate: number }
  | { eligible: false; reason: string };

/**
 * 수동 기준액을 쓸 수 있는가 + 쓴다면 곱할 셀러 수수료율(R4). 서버(PATCH 거부)·writer·화면이
 * 이 함수 하나를 공유한다.
 *
 * - 품목 0개 → 캠페인 요율 하나 → 허용
 * - 품목 N개, 실효 요율(딜 요율 ?? 캠페인 요율)이 전부 같음 → 그 요율로 허용
 * - 실효 요율이 둘 이상 → 거부(사유 문구 포함)
 */
export function resolveSellerFeeBasisEligibility({
  deals,
  campaignSellerMarginRate,
}: {
  deals: ReadonlyArray<{ sellerMarginRate?: RateLike }> | null | undefined;
  campaignSellerMarginRate: RateLike;
}): SellerFeeBasisEligibility {
  const campaignRate = rateToNumber(campaignSellerMarginRate) ?? 0;
  const list = deals ?? [];
  if (list.length === 0) return { eligible: true, sellerRate: campaignRate };
  const rates = new Set(list.map((deal) => rateToNumber(deal.sellerMarginRate) ?? campaignRate));
  if (rates.size > 1) return { eligible: false, reason: SELLER_FEE_BASIS_MIXED_RATE_MESSAGE };
  return { eligible: true, sellerRate: [...rates][0] };
}

/** 수동 기준액 → 판매대행비(R3). 반올림은 `round` — 품목 루프·명세서와 같은 단위다. */
export function sellerFeeFromBasis(basis: number, sellerRate: number): number {
  return Math.round((basis * sellerRate) / 100);
}

export type SellerFeeSource = "MANUAL_SELLER_EXPENSE" | "BASIS_OVERRIDE" | "AUTO";

/**
 * 판매대행비·개인 원천세(3.3% 몫만) 확정 SSOT — 저장 writer 3곳(편집 PATCH · 주문 동기화 ·
 * 실매출 입력)과 표시 폴백이 전부 이 함수를 부른다.
 *
 * `autoSellerExpense`/`autoWithholdingSum` 은 호출부의 **자동** 계산값(품목 합계 또는 캠페인
 * 단위)이다 — 이 함수는 그 위에 수동 층(R3 우선순위)만 얹는다. 수동 기준액이 저장돼 있어도
 * 요율이 섞여 자격이 없으면(`overrideSellerRate == null`) 자동으로 내려간다(PATCH 가 그 상태를
 * 막지만, 이 함수는 방어적으로 「틀린 요율로 곱하지 않는다」를 택한다).
 */
export function resolveSellerFee({
  autoSellerExpense,
  autoWithholdingSum,
  sellerFeeBasisOverride,
  overrideSellerRate,
  isManualSellerExpense,
  manualSellerExpense,
}: {
  autoSellerExpense: number;
  autoWithholdingSum: number;
  sellerFeeBasisOverride: number | null | undefined;
  overrideSellerRate: number | null;
  isManualSellerExpense: boolean;
  manualSellerExpense: number | null | undefined;
}): { sellerExpense: number; individualWithholding: number; source: SellerFeeSource } {
  if (isManualSellerExpense && manualSellerExpense != null) {
    return {
      sellerExpense: manualSellerExpense,
      individualWithholding: calcIndividualIncomeTax(manualSellerExpense),
      source: "MANUAL_SELLER_EXPENSE",
    };
  }
  if (sellerFeeBasisOverride != null && overrideSellerRate != null) {
    const sellerExpense = sellerFeeFromBasis(sellerFeeBasisOverride, overrideSellerRate);
    return {
      sellerExpense,
      individualWithholding: calcIndividualIncomeTax(sellerExpense),
      source: "BASIS_OVERRIDE",
    };
  }
  return { sellerExpense: autoSellerExpense, individualWithholding: autoWithholdingSum, source: "AUTO" };
}

/**
 * **실제로 적용되는** 수동 정산 기준액 — 저장값이 있어도 요율 자격이 없으면(품목 요율이 섞임)
 * null 이다. writer(`resolveSellerFee` 의 자동 강등)와 같은 판정을 표시·셀러 대면 표면이 그대로
 * 쓰게 하는 단일 입구다 — 「명세서는 기준액을 찍는데 지급액은 자동」 같은 표면 간 불일치를 막는다.
 */
export function resolveEffectiveSellerFeeBasis({
  sellerFeeBasisOverride,
  deals,
  campaignSellerMarginRate,
}: {
  sellerFeeBasisOverride: RateLike;
  deals: ReadonlyArray<{ sellerMarginRate?: RateLike }> | null | undefined;
  campaignSellerMarginRate: RateLike;
}): { basis: number; sellerRate: number } | null {
  const basis = rateToNumber(sellerFeeBasisOverride);
  if (basis == null) return null;
  const eligibility = resolveSellerFeeBasisEligibility({ deals, campaignSellerMarginRate });
  return eligibility.eligible ? { basis, sellerRate: eligibility.sellerRate } : null;
}

/**
 * 표시 전용 판매대행비 — 저장값이 없거나 화면이 실시간으로 다시 계산하는 자리(칸반 합계·
 * 정산 폴백)가 쓴다. 수동 기준액 캠페인이면 기준액 × 단일 요율, 아니면 `autoFee()` 그대로
 * (호출부의 기존 자동 식을 바이트 그대로 보존한다).
 */
export function resolveDisplaySellerFee({
  sellerFeeBasisOverride,
  deals,
  campaignSellerMarginRate,
  autoFee,
}: {
  sellerFeeBasisOverride: number | null | undefined;
  deals: ReadonlyArray<{ sellerMarginRate?: RateLike }> | null | undefined;
  campaignSellerMarginRate: RateLike;
  autoFee: () => number;
}): number {
  const effective = resolveEffectiveSellerFeeBasis({ sellerFeeBasisOverride, deals, campaignSellerMarginRate });
  return effective ? sellerFeeFromBasis(effective.basis, effective.sellerRate) : autoFee();
}

/**
 * 캠페인 단위 금액을 품목 행에 나눈다(표·내보내기의 행 합 = 캠페인 값). 가중치(보통 품목
 * 매출) 비례 + 최대 잔여 배분 — 합이 정확히 `total` 이 된다. 가중치 합이 0 이면 첫 행에 전부.
 */
export function allocateByWeight(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((sum, w) => sum + Math.max(w, 0), 0);
  if (weightSum <= 0) return weights.map((_, index) => (index === 0 ? total : 0));
  const raw = weights.map((w) => (total * Math.max(w, 0)) / weightSum);
  const floored = raw.map((value) => Math.floor(value));
  let remainder = total - floored.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; remainder > 0 && i < order.length; i += 1, remainder -= 1) {
    floored[order[i].index] += 1;
  }
  return floored;
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
  sellerFeeBasisOverride,
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
  /**
   * 수동 정산 기준액(null·미지정 = 자동). 캠페인 단위 계산이라 곱하는 요율은 캠페인
   * `sellerMarginRate` 하나다 — 품목이 있는 캠페인은 writer 의 품목 루프가
   * `resolveSellerFee` 로 이 결과를 다시 확정한다.
   */
  sellerFeeBasisOverride?: number | null;
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
    
  const { sellerExpense } = resolveSellerFee({
    autoSellerExpense,
    autoWithholdingSum: calcIndividualIncomeTax(autoSellerExpense),
    sellerFeeBasisOverride,
    overrideSellerRate: sellerMarginRate,
    isManualSellerExpense,
    manualSellerExpense,
  });

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
