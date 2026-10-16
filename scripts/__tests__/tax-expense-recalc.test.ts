import { describe, expect, it } from "vitest";
import { planTaxExpenseRecalc, type TaxExpenseRecalcRow } from "../lib/tax-expense-recalc";

// 설계서 §1-2 가공 숫자(총거래액 10,000,000 · 총수수료율 30% · 셀러수수료율 20% · 비용 0).
const INDIVIDUAL_ROW: TaxExpenseRecalcRow = {
  id: "c-ind",
  isManualTaxExpense: false,
  sellerTaxType: "INDIVIDUAL",
  sellerCompanyBusinessNumber: null,
  dealCount: 0,
  settlementSales: 3_000_000,
  sellerExpense: 1_818_181,
  taxExpense: 332_727,
  operatingExpense: 0,
  miscExpense: 0,
  operatingProfit: 849_092,
};

describe("planTaxExpenseRecalc", () => {
  it("사업자 셀러는 건드리지 않는다(값이 이미 회계 영업이익과 같다)", () => {
    const plan = planTaxExpenseRecalc({
      ...INDIVIDUAL_ROW,
      sellerTaxType: "BUSINESS",
      sellerCompanyBusinessNumber: "123-45-67890",
    });
    expect(plan.kind).toBe("SKIP_BUSINESS");
  });

  it("수동 공제세액은 오너 입력값이라 건드리지 않는다", () => {
    expect(planTaxExpenseRecalc({ ...INDIVIDUAL_ROW, isManualTaxExpense: true }).kind).toBe("SKIP_MANUAL_TAX");
  });

  it("금액이 비어 있으면 건너뛴다", () => {
    expect(planTaxExpenseRecalc({ ...INDIVIDUAL_ROW, settlementSales: null }).kind).toBe("SKIP_MISSING");
  });

  it("개인 셀러 정상 행: 공제세액에서 원천세만 빠지고 영업이익이 그만큼 오른다", () => {
    expect(planTaxExpenseRecalc(INDIVIDUAL_ROW)).toEqual({
      kind: "APPLY",
      nextTaxExpense: 272_727,
      nextOperatingProfit: 909_092,
      delta: 60_000,
    });
  });

  it("세무 유형이 비어 있고 사업자번호도 없으면 개인으로 본다", () => {
    const plan = planTaxExpenseRecalc({ ...INDIVIDUAL_ROW, sellerTaxType: null });
    expect(plan.kind).toBe("APPLY");
  });

  it("수동 판매대행비 캠페인: 차이 = 수동 지급액 × 3.3%", () => {
    // 수동 지급액 70,000 → 원천세 2,310 · 수수료 부가세 round(300,000 − 300,000/1.1) = 27,273
    const plan = planTaxExpenseRecalc({
      ...INDIVIDUAL_ROW,
      settlementSales: 300_000,
      sellerExpense: 70_000,
      taxExpense: 2_310 + 27_273,
      operatingProfit: 300_000 - 70_000 - (2_310 + 27_273),
    });
    expect(plan).toMatchObject({ kind: "APPLY", nextTaxExpense: 27_273, delta: 2_310 });
  });

  it("품목 여러 개 캠페인은 품목별 반올림 차이(품목 수 원 이하)를 허용한다", () => {
    const plan = planTaxExpenseRecalc({
      ...INDIVIDUAL_ROW,
      dealCount: 3,
      taxExpense: 332_727 + 2,
      operatingProfit: 849_092 - 2,
    });
    expect(plan).toMatchObject({ kind: "APPLY", delta: 60_002 });
  });

  it("저장 공제세액이 예상(원천세 + 부가세)과 다르면 쓰지 않고 검토로 돌린다", () => {
    const plan = planTaxExpenseRecalc({ ...INDIVIDUAL_ROW, taxExpense: 300_000, operatingProfit: 881_819 });
    expect(plan.kind).toBe("REVIEW");
    expect(plan.reason).toContain("27,273");
    expect(plan.reason).toContain("60,000");
  });

  it("저장 영업이익이 저장 금액으로 다시 계산한 값과 다르면 검토로 돌린다(낡은 행)", () => {
    const plan = planTaxExpenseRecalc({ ...INDIVIDUAL_ROW, operatingProfit: 900_000 });
    expect(plan.kind).toBe("REVIEW");
  });
});
