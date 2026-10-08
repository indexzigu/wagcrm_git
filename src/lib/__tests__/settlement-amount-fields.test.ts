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
});
