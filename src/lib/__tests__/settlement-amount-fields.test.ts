import { describe, expect, it } from "vitest";
import {
  formatSettlementAmountKrw,
  isSettlementAmountField,
  SETTLEMENT_AMOUNT_FIELD_LABELS,
} from "../settlement-amount-fields";

describe("settlement-amount-fields", () => {
  it("null(비어 있음)과 0원을 다른 글자로 적는다 — 물품대금 0 은 합산 이관 표시다", () => {
    expect(formatSettlementAmountKrw(null)).toBe("비어 있음");
    expect(formatSettlementAmountKrw(0)).toBe("0원");
    expect(formatSettlementAmountKrw(-3_000)).toBe("-3,000원");
    expect(formatSettlementAmountKrw(1_350_000)).toBe("1,350,000원");
  });

  it("고칠 수 있는 칸만 칸으로 인정한다(파생 칸·프로토타입 키는 아니다)", () => {
    for (const field of Object.keys(SETTLEMENT_AMOUNT_FIELD_LABELS)) {
      expect(isSettlementAmountField(field), field).toBe(true);
    }
    for (const value of ["operatingProfit", "toString", "constructor", "", null, 1]) {
      expect(isSettlementAmountField(value), String(value)).toBe(false);
    }
  });

  // 오너 확정 2026-10-16: taxExpense 는 부가세만 담는다 — 결재함·실행 요약도 재무 카드 칸 제목과 같다.
  it("공제세액 칸 이름은 재무 카드와 같은 「공제세액 · 부가세」 다", () => {
    expect(SETTLEMENT_AMOUNT_FIELD_LABELS.taxExpense).toBe("공제세액 · 부가세");
  });
});
