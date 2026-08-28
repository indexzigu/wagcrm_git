import { describe, expect, it } from "vitest";
import { resolveGoodsCost, sumGroupManualGoodsCost } from "../goods-cost";
import { computeBaseAmountForBasis } from "../tax-filing-board";
import { buildExpectedReceivables } from "../tax-invoice-mail/expected-receivables";

describe("resolveGoodsCost — 3-상태는 서로 다른 뜻이다", () => {
  it("미입력(null)은 공식으로 추정한다", () => {
    expect(resolveGoodsCost({ manualGoodsCost: null, actualSales: 11_000_000, settlementSales: 2_200_000 })).toEqual({
      kind: "FORMULA",
      amount: 8_800_000,
    });
  });

  it("0 은 금액이 아니라 「합산 이관」 상태다", () => {
    expect(resolveGoodsCost({ manualGoodsCost: 0, actualSales: 11_000_000, settlementSales: 2_200_000 })).toEqual({
      kind: "CONSOLIDATED",
    });
  });

  it("양수 수기값은 공식을 이긴다 — 관측이 있으면 추정은 쓰지 않는다", () => {
    expect(resolveGoodsCost({ manualGoodsCost: 7_150_000, actualSales: 11_000_000, settlementSales: 2_200_000 })).toEqual({
      kind: "MANUAL",
      amount: 7_150_000,
    });
  });

  it("공식의 피연산자가 없으면 0 이 아니라 모름(null)이다", () => {
    // settlementSales 를 0 으로 치면 actualSales 전액이 물품대금인 척 통과한다 —
    // 오너가 그 숫자로 공급사 계산서를 대사하게 되는 조용한 오답.
    expect(resolveGoodsCost({ manualGoodsCost: null, actualSales: 11_000_000, settlementSales: null })).toEqual({
      kind: "FORMULA",
      amount: null,
    });
  });
});

describe("sumGroupManualGoodsCost — 부분 합산 금지", () => {
  it("전원 입력이면 합산한다", () => {
    expect(sumGroupManualGoodsCost([{ settlementGoodsCost: 100 }, { settlementGoodsCost: 200 }])).toBe(300);
  });

  it("한 명이라도 미입력이면 그룹 전체가 공식 폴백(null)이다", () => {
    expect(sumGroupManualGoodsCost([{ settlementGoodsCost: 100 }, { settlementGoodsCost: null }])).toBeNull();
  });

  it("전원 0(합산 이관)이면 합도 0 — CONSOLIDATED 로 판정된다", () => {
    expect(sumGroupManualGoodsCost([{ settlementGoodsCost: 0 }, { settlementGoodsCost: 0 }])).toBe(0);
  });
});

describe("이중 기준 해소 — 보드와 수취 엔진이 같은 원금을 낸다", () => {
  const base = { actualSales: 11_000_000, settlementSales: 2_200_000 };

  /** 수취 엔진이 그 캠페인에 기대하는 물품대금 금액(SUPPLIER_GOODS 슬롯). */
  function engineGoodsAmount(manual: number | null) {
    const rows = buildExpectedReceivables({
      campaignId: "c1",
      campaignLabel: "c1",
      salesChannel: "OWN_MALL",
      actualSales: base.actualSales,
      settlementSales: base.settlementSales,
      sellerExpense: 1_000_000,
      manualGoodsCost: manual,
      sellerBusinessNumber: "1234567890",
      sellerTaxType: "BUSINESS",
      sellerLabel: "s",
      partnerBusinessNumber: "0987654321",
      partnerLabel: "p",
      supplierInvoiceIssuedAt: null,
      sellerInvoiceIssuedAt: null,
    });
    return rows.find((row) => row.slot === "SUPPLIER_GOODS")?.expectedTotalAmount ?? null;
  }

  it("미입력 — 양쪽 다 공식값", () => {
    const board = computeBaseAmountForBasis("SALES_MINUS_SETTLEMENT", {
      ...base,
      sellerExpense: 1_000_000,
      settlementGoodsCost: null,
    });
    expect(board.baseAmount).toBe(8_800_000);
    expect(engineGoodsAmount(null)).toBe(8_800_000);
  });

  it("양수 수기값 — 양쪽 다 그 금액(종전엔 보드만 공식이라 갈렸다)", () => {
    const board = computeBaseAmountForBasis("SALES_MINUS_SETTLEMENT", {
      ...base,
      sellerExpense: 1_000_000,
      settlementGoodsCost: 7_150_000,
    });
    expect(board.baseAmount).toBe(7_150_000);
    expect(board.blockingReasons).toEqual([]);
    expect(engineGoodsAmount(7_150_000)).toBe(7_150_000);
  });

  it("0(합산 이관) — 보드는 행을 남기되 선택 불가로 막고, 엔진은 기대 건을 만들지 않는다", () => {
    const board = computeBaseAmountForBasis("SALES_MINUS_SETTLEMENT", {
      ...base,
      sellerExpense: 1_000_000,
      settlementGoodsCost: 0,
    });
    // 숨기면 오너가 "이번 달 끝났다"고 오판한다 — 보이되 못 고르는 상태가 정답.
    expect(board.baseAmount).toBe(0);
    expect(board.blockingReasons.length).toBeGreaterThan(0);
    expect(engineGoodsAmount(0)).toBeNull();
  });
});
