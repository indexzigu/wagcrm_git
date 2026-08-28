import { describe, expect, it } from "vitest";

import {
  buildPnlReportModel,
  calculateEstimatedIncomeTax,
} from "@/lib/pnl-report";

describe("calculateEstimatedIncomeTax", () => {
  it("separates national income tax and local income tax at bracket boundaries", () => {
    const estimate = calculateEstimatedIncomeTax(50_000_000);

    expect(estimate.bracketLabel).toBe("14,000,000원 초과 50,000,000원 이하");
    expect(estimate.nationalIncomeTax).toBe(6_240_000);
    expect(estimate.localIncomeTax).toBe(624_000);
    expect(estimate.totalTax).toBe(6_864_000);
  });

  it("does not estimate tax for a loss", () => {
    expect(calculateEstimatedIncomeTax(-1_000_000)).toMatchObject({
      taxableIncome: 0,
      nationalIncomeTax: 0,
      localIncomeTax: 0,
      totalTax: 0,
    });
  });
});

describe("buildPnlReportModel", () => {
  it("calculates campaign operating profit from commission revenue and campaign costs", () => {
    const report = buildPnlReportModel(
      [
        {
          id: "campaign-1",
          startDate: new Date("2026-03-01T00:00:00.000Z"),
          endDate: new Date("2026-03-07T00:00:00.000Z"),
          salesChannel: "BRAND_MALL",
          actualSales: 10_000_000,
          totalMarginRate: 30,
          sellerMarginRate: 10,
          settlementSales: 3_000_000,
          sellerExpense: 1_000_000,
          taxExpense: 200_000,
          operatingExpense: 300_000,
          miscExpense: 100_000,
          campaignName: "테스트 캠페인",
          deal: {
            dealName: "테스트 딜",
            brandName: "테스트 브랜드",
            partner: { name: "테스트 거래처" },
          },
          seller: { name: "테스트 셀러" },
        },
      ],
      2026,
    );

    expect(report.totals.grossSales).toBe(10_000_000);
    expect(report.totals.commissionRevenue).toBe(3_000_000);
    expect(report.totals.totalCampaignCosts).toBe(1_600_000);
    expect(report.totals.preTaxOperatingProfit).toBe(1_400_000);
    expect(report.priorYearReference).toMatchObject({
      incomeYear: 2025,
      filingYear: 2026,
      taxableIncome: 22_465_725,
      finalDeterminedTax: 2_029_858,
    });
    expect(report.campaigns[0]).toMatchObject({
      campaignName: "테스트 캠페인",
      preTaxOperatingProfit: 1_400_000,
      missingCostFields: [],
    });
  });

  it("aggregates monthly rows and flags missing campaign cost fields", () => {
    const report = buildPnlReportModel(
      [
        {
          id: "campaign-1",
          startDate: new Date("2026-02-01T00:00:00.000Z"),
          endDate: new Date("2026-02-05T00:00:00.000Z"),
          salesChannel: "BRAND_MALL",
          actualSales: 5_000_000,
          totalMarginRate: 20,
          sellerMarginRate: 0,
          settlementSales: 1_000_000,
          sellerExpense: 100_000,
          taxExpense: 50_000,
          operatingExpense: 25_000,
          miscExpense: 25_000,
          deal: { dealName: "딜 A" },
          seller: { name: "셀러 A", alias: "별칭 A" },
        },
        {
          id: "campaign-2",
          startDate: new Date("2026-02-10T00:00:00.000Z"),
          endDate: new Date("2026-02-15T00:00:00.000Z"),
          salesChannel: "OWN_MALL_NAVER",
          actualSales: 3_000_000,
          totalMarginRate: 30,
          sellerMarginRate: 0,
          settlementSales: 900_000,
          deal: { dealName: "딜 B" },
          seller: { name: "셀러 B" },
        },
      ],
      2026,
    );

    expect(report.monthly).toHaveLength(1);
    expect(report.monthly[0]).toMatchObject({
      month: "2026-02",
      grossSales: 8_000_000,
      commissionRevenue: 1_900_000,
      preTaxOperatingProfit: 1_700_000,
      campaignCount: 2,
    });
    // 행별 `missingCostFields` 는 상세 시트("계산 근거")가 그대로 쓴다. 종전의 집계
    // 카운터(`totals.missingCostCampaignCount`)는 상단 경고 배지 전용이었고, 그 배지를
    // 걷어내면서 소비처가 0 이 되어 함께 지웠다.
    expect(report.campaigns.find((row) => row.id === "campaign-2")).toMatchObject({
      campaignName: "딜 B 셀러 B",
      missingCostFields: ["셀러 지급액", "공제세액", "운영비", "기타비용"],
    });
  });
});
