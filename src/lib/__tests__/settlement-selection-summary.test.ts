import { describe, expect, it } from "vitest";
import { sumSettlementSelection, toCompletedSelectionInput } from "../settlement-selection-summary";

type Input = Parameters<typeof sumSettlementSelection>[0][number];

const row = (overrides: Partial<Input>): Input => ({
  actualSales: null,
  settlementSales: null,
  sellerExpense: null,
  operatingProfit: null,
  ...overrides,
});

describe("sumSettlementSelection", () => {
  it("선택된 캠페인들의 4개 지표를 각각 합산한다", () => {
    const result = sumSettlementSelection([
      row({
        actualSales: 1_000_000,
        settlementSales: 200_000,
        sellerExpense: 120_000,
        operatingProfit: 80_000,
      }),
      row({
        actualSales: 500_000,
        settlementSales: 100_000,
        sellerExpense: 60_000,
        operatingProfit: 40_000,
      }),
    ]);

    expect(result).toEqual({
      actualSales: 1_500_000,
      settlementSales: 300_000,
      sellerExpense: 180_000,
      operatingProfit: 120_000,
    });
  });

  it("미입력(null·undefined)은 0으로 취급해 합산을 깨뜨리지 않는다", () => {
    const result = sumSettlementSelection([
      row({ actualSales: 300_000, operatingProfit: -50_000 }),
      row({}),
    ]);

    expect(result).toEqual({
      actualSales: 300_000,
      settlementSales: 0,
      sellerExpense: 0,
      operatingProfit: -50_000,
    });
  });

  it("빈 선택은 전부 0을 돌려준다", () => {
    expect(sumSettlementSelection([])).toEqual({
      actualSales: 0,
      settlementSales: 0,
      sellerExpense: 0,
      operatingProfit: 0,
    });
  });
});

describe("toCompletedSelectionInput", () => {
  it("영업수익·판매대행비는 완료 표가 실제로 렌더하는 리포트 파생값을 쓴다", () => {
    const input = toCompletedSelectionInput(
      { actualSales: 1_000_000, operatingProfit: 80_000 },
      { totalMarginAmount: 200_000, sellerPayoutAmount: 120_000 },
    );

    expect(input).toEqual({
      actualSales: 1_000_000,
      settlementSales: 200_000,
      sellerExpense: 120_000,
      operatingProfit: 80_000,
    });
  });

  it("리포트 행이 없으면 화면의 '-' 와 같게 null 로 둔다", () => {
    const input = toCompletedSelectionInput({ actualSales: 500_000, operatingProfit: null }, null);

    expect(input).toEqual({
      actualSales: 500_000,
      settlementSales: null,
      sellerExpense: null,
      operatingProfit: null,
    });
    // 합산에서는 null 이 0 기여라, 화면의 "-" 와 의미가 어긋나지 않는다.
    expect(sumSettlementSelection([input])).toEqual({
      actualSales: 500_000,
      settlementSales: 0,
      sellerExpense: 0,
      operatingProfit: 0,
    });
  });
});
