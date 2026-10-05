import { describe, expect, it } from "vitest";

import { calculateDerivedCampaignFinancials } from "../campaign-financials";

describe("calculateDerivedCampaignFinancials", () => {
  it("recalculates withholding tax and final operating profit from gross sales", () => {
    expect(
      calculateDerivedCampaignFinancials({
        actualSales: 800_000,
        operatingExpense: 10_000,
        miscExpense: 2_000,
        totalMarginRate: 30,
        sellerMarginRate: 10,
        sellerTaxType: "BUSINESS",
      }),
    ).toEqual({
      settlementSales: 240_000,
      sellerExpense: 80_000,
      taxExpense: 14_545,
      operatingProfit: 133_455,
    });
  });

  it("recalculates withholding tax and final operating profit for INDIVIDUAL tax type", () => {
    expect(
      calculateDerivedCampaignFinancials({
        actualSales: 800_000,
        operatingExpense: 10_000,
        miscExpense: 2_000,
        totalMarginRate: 30,
        sellerMarginRate: 10,
        sellerTaxType: "INDIVIDUAL",
      }),
    ).toEqual({
      settlementSales: 240_000,
      sellerExpense: 72_727,
      // 원천세 = 셀러 지급액 × 3.3% = round(72,727 × 0.033) = 2,400 (오너 확정 2026-10-05 — 지급액을
      // 다시 ÷1.1 하면 2,182 가 되던 종전 식은 틀렸다) + 수수료 부가세 round(240,000 − 240,000/1.1) = 21,818
      taxExpense: 24_218,
      operatingProfit: 131_055,
    });
  });
});
