/**
 * 개인 셀러 캠페인 공제세액 재계산 판정(순수 함수 — DB 없이 테스트한다).
 *
 * 배경(오너 확정 2026-10-16): 저장 `taxExpense` 가 개인 셀러 캠페인에서 「원천세 3.3% + 수수료매출
 * 부가세」였다. 원천세는 셀러지급액 안에 이미 든 셀러 몫이라 영업이익에서 두 번 빠졌다. 산식은
 * `computeVatExpense` 로 고쳤고(writer 3곳), 이미 저장된 값은 이 판정으로 다시 계산한다.
 *
 * 판정 분류:
 *   - SKIP_BUSINESS   사업자 셀러 — 값이 이미 회계 영업이익과 같다(설계서 §1-2).
 *   - SKIP_MANUAL_TAX 수동 공제세액 — 오너가 입력한 값이라 자동으로 바꾸지 않는다.
 *   - SKIP_MISSING    금액이 비어 있어 계산할 수 없다.
 *   - APPLY           저장값 − 새 값 = 원천세(허용 오차 안)이고 저장 영업이익도 저장 금액과 맞는다.
 *   - REVIEW          위 검산이 안 맞는 행 — ⛔ 쓰지 않는다. 사유에 두 숫자를 적어 오너가 본다.
 *
 * 허용 오차 = 품목 수(원). 품목이 있는 캠페인은 writer 가 원천세를 **품목마다** 반올림해 더했으므로
 * 합계에 한 번 건 `calcIndividualIncomeTax(sellerExpense)` 와 품목 수 원 이내로 갈린다. 품목이 없으면 0.
 *
 * 설계 정본: docs/private/specs/2026-10-16-settlement-tax-split-design.md §5-2
 */
import { computeOperatingProfit, computeVatExpense } from "../../src/lib/campaign-financials";
import { calcIndividualIncomeTax, isIndividualSeller } from "../../src/lib/seller-tax-utils";

export type TaxExpenseRecalcRow = {
  id: string;
  isManualTaxExpense: boolean;
  sellerTaxType: string | null;
  sellerCompanyBusinessNumber: string | null;
  /** 품목(`CampaignDeal`) 수 — 반올림 허용 오차. */
  dealCount: number;
  settlementSales: number | null;
  sellerExpense: number | null;
  taxExpense: number | null;
  operatingExpense: number | null;
  miscExpense: number | null;
  operatingProfit: number | null;
};

export type TaxExpenseRecalcKind = "SKIP_BUSINESS" | "SKIP_MANUAL_TAX" | "SKIP_MISSING" | "APPLY" | "REVIEW";

export type TaxExpenseRecalcPlan = {
  kind: TaxExpenseRecalcKind;
  nextTaxExpense?: number;
  nextOperatingProfit?: number;
  delta?: number;
  reason?: string;
};

const krw = (value: number) => value.toLocaleString("ko-KR");

export function planTaxExpenseRecalc(row: TaxExpenseRecalcRow): TaxExpenseRecalcPlan {
  const isIndividual = isIndividualSeller({
    sellerTaxType: row.sellerTaxType,
    sellerCompanyBusinessNumber: row.sellerCompanyBusinessNumber,
  });
  if (!isIndividual) return { kind: "SKIP_BUSINESS" };
  if (row.isManualTaxExpense) return { kind: "SKIP_MANUAL_TAX" };

  const { settlementSales, sellerExpense, taxExpense, operatingProfit } = row;
  if (settlementSales == null || sellerExpense == null || taxExpense == null || operatingProfit == null) {
    return { kind: "SKIP_MISSING" };
  }
  const operatingExpense = row.operatingExpense ?? 0;
  const miscExpense = row.miscExpense ?? 0;

  const nextTaxExpense = computeVatExpense({ isIndividual: true, settlementSales, sellerExpense });
  const nextOperatingProfit = computeOperatingProfit({
    settlementSales,
    sellerExpense,
    taxExpense: nextTaxExpense,
    operatingExpense,
    miscExpense,
  });
  const delta = taxExpense - nextTaxExpense;
  const expectedWithholding = calcIndividualIncomeTax(sellerExpense);
  const tolerance = Math.max(0, row.dealCount);

  if (Math.abs(delta - expectedWithholding) > tolerance) {
    return {
      kind: "REVIEW",
      nextTaxExpense,
      nextOperatingProfit,
      delta,
      reason: `저장 공제세액 − 새 공제세액 = ${krw(delta)}원인데 원천세는 ${krw(expectedWithholding)}원이다`,
    };
  }
  const storedRecomputed = computeOperatingProfit({
    settlementSales,
    sellerExpense,
    taxExpense,
    operatingExpense,
    miscExpense,
  });
  if (storedRecomputed !== operatingProfit) {
    return {
      kind: "REVIEW",
      nextTaxExpense,
      nextOperatingProfit,
      delta,
      reason: `저장 영업이익 ${krw(operatingProfit)}원이 저장 금액으로 다시 계산한 ${krw(storedRecomputed)}원과 다르다`,
    };
  }
  return { kind: "APPLY", nextTaxExpense, nextOperatingProfit, delta };
}
