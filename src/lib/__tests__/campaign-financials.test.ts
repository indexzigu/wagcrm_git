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
      taxExpense: 24_000,
      operatingProfit: 131_273,
    });
  });
});
