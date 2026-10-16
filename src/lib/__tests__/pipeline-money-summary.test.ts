import { describe, expect, it } from "vitest";
import {
  summarizePipelineMoney,
  type PipelineMoneyRow,
} from "../pipeline-money-summary";

function row(over: Partial<PipelineMoneyRow>): PipelineMoneyRow {
  return {
    status: "SALES_IN_PROGRESS",
    actualSales: 1_000_000,
    settlementSales: null,
    sellerExpense: null,
    totalMarginRate: 30,
    sellerMarginRate: 20,
    sellerFeeBasisOverride: null,
    campaignDeals: [],
    ...over,
  } as PipelineMoneyRow;
}

describe("summarizePipelineMoney", () => {
  it("저장값이 있는 행은 요율이 달라도 저장값을 합한다(수동 덮어쓰기 포함)", () => {
    const s = summarizePipelineMoney([
      row({ settlementSales: 250_000, sellerExpense: 100_000 }),
      // 수동 덮어쓰기: 요율(30%)로는 300,000 이지만 저장값은 270,000
      row({ actualSales: 1_000_000, settlementSales: 270_000, sellerExpense: 90_000 }),
    ]);
    expect(s).toEqual({
      grossMerchandise: 2_000_000,
      commissionRevenue: 520_000,
      sellerPayout: 190_000,
      grossProfit: 330_000,
    });
  });

  it("저장값이 null 인 행은 요율 폴백으로 계산한다", () => {
    const s = summarizePipelineMoney([row({ actualSales: 2_000_000 })]);
    expect(s).toEqual({
      grossMerchandise: 2_000_000,
      commissionRevenue: 600_000,
      sellerPayout: 400_000,
      grossProfit: 200_000,
    });
  });

  it("제외 상태 3종은 0 기여", () => {
    const s = summarizePipelineMoney([
      row({ status: "DROPPED", settlementSales: 1, sellerExpense: 1 }),
      row({ status: "SETTLEMENT_IN_PROGRESS" }),
      row({ status: "COMPLETED" }),
    ]);
    expect(s).toEqual({
      grossMerchandise: 0,
      commissionRevenue: 0,
      sellerPayout: 0,
      grossProfit: 0,
    });
  });

  it("폴백 합계가 소수 원이면 원 단위로 반올림한다", () => {
    const s = summarizePipelineMoney([
      row({ actualSales: 1_111_111, totalMarginRate: 30, sellerMarginRate: 20 }),
    ]);
    for (const v of Object.values(s)) expect(Number.isInteger(v)).toBe(true);
    expect(s.commissionRevenue).toBe(333_333);
  });
});
