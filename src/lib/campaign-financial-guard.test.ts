import { describe, expect, it } from "vitest";
import { buildFinancialExpectation, findFinancialConflicts } from "./campaign-financial-guard";

// 낙관적 동시성 판정 함수 — 클라이언트(화면 행)와 서버(DB Decimal)가 같은 값을 같다고 봐야 거짓 409 가 없다.
// 금액은 전부 가공이다(P0).

const ITEM = { invoiceMode: "SALES_ISSUE", counterparty: "BRAND", amount: 50_000, note: "광고비" };

describe("buildFinancialExpectation — 이번에 쓰는 필드만 기대값으로 싣는다", () => {
  it("패치에 있는 가드 필드만, 화면 행의 값으로", () => {
    const expectation = buildFinancialExpectation(
      { operatingExpense: 0, miscExpense: 7, sellerFeeBasisOverride: null, settlementItems: [ITEM] },
      { operatingExpense: 30_000, sellerFeeBasisOverride: 9_000_000, netMarginRate: 12 },
    );
    expect(expectation).toEqual({ fields: { operatingExpense: 0, sellerFeeBasisOverride: null } });
  });

  it("부가 항목을 바꿀 때만 화면이 본 목록을 싣는다", () => {
    const expectation = buildFinancialExpectation({ settlementItems: [ITEM] }, { settlementItems: [] });
    expect(expectation).toEqual({ settlementItems: [ITEM] });
  });

  it("가드 필드를 하나도 안 쓰면 undefined — 대조 없음", () => {
    expect(buildFinancialExpectation({ operatingExpense: 0 }, { netMarginRate: 3 })).toBeUndefined();
  });
});

describe("findFinancialConflicts — 서버 대조", () => {
  it("Decimal 문자열·객체와 숫자는 같은 값이면 같다", () => {
    const decimalLike = { toString: () => "9600000.00" };
    expect(
      findFinancialConflicts(
        { sellerFeeBasisOverride: decimalLike, operatingExpense: "0", settlementItems: [{ ...ITEM, amount: "50000" }] },
        { fields: { sellerFeeBasisOverride: 9_600_000, operatingExpense: 0 }, settlementItems: [ITEM] },
      ),
    ).toEqual([]);
  });

  it("null(미입력)과 0(유효값)은 다르다 — 상품원가·기준액에서 두 상태는 뜻이 다르다", () => {
    expect(
      findFinancialConflicts({ settlementGoodsCost: "0" }, { fields: { settlementGoodsCost: null } }),
    ).toEqual(["settlementGoodsCost"]);
  });

  it("부가 항목 수·순서·금액·비고가 하나라도 다르면 settlementItems 하나로 보고한다", () => {
    const expectation = { settlementItems: [ITEM] };
    expect(findFinancialConflicts({ settlementItems: [ITEM, ITEM] }, expectation)).toEqual(["settlementItems"]);
    expect(findFinancialConflicts({ settlementItems: [{ ...ITEM, note: "다른 비고" }] }, expectation)).toEqual([
      "settlementItems",
    ]);
    expect(findFinancialConflicts({ settlementItems: [] }, expectation)).toEqual(["settlementItems"]);
  });

  it("화면 행 변환처럼 알 수 없는 방식·대상 행은 양쪽에서 똑같이 뺀다", () => {
    const unknown = { invoiceMode: "LEGACY", counterparty: "BRAND", amount: 1, note: null };
    expect(findFinancialConflicts({ settlementItems: [ITEM, unknown] }, { settlementItems: [ITEM] })).toEqual([]);
  });

  it("쓰지 않는 필드가 바뀐 것은 충돌이 아니다", () => {
    expect(
      findFinancialConflicts({ operatingExpense: "0", miscExpense: "999" }, { fields: { operatingExpense: 0 } }),
    ).toEqual([]);
  });
});

describe("품목 목록 대조 — 매출 품목 표는 목록을 통째로 교체한다", () => {
  const PRICES = { feeRate: 30, sellerMarginRate: 10, costPrice: 7_000, sellingPrice: 10_000 };
  const DEAL_A = { dealId: "d-a", quantity: 3, actualSales: 90_000, ...PRICES };
  const DEAL_B = { dealId: "d-b", quantity: 1, actualSales: 20_000, ...PRICES, sellerMarginRate: null };

  it("품목을 보낼 때만 화면이 본 품목(저장이 덮어쓰는 값 전부)을 dealId 순으로 싣는다", () => {
    const expectation = buildFinancialExpectation(
      { campaignDeals: [{ ...DEAL_B, dealName: "B" } as typeof DEAL_B, DEAL_A] },
      { campaignDeals: [] },
    );
    expect(expectation).toEqual({ campaignDeals: [DEAL_A, DEAL_B] });
  });

  it("순서가 달라도 같은 품목이면 통과, Decimal 문자열도 같은 값으로 본다", () => {
    expect(
      findFinancialConflicts(
        { campaignDeals: [{ ...DEAL_B, actualSales: "20000" }, DEAL_A] },
        { campaignDeals: [DEAL_A, DEAL_B] },
      ),
    ).toEqual([]);
  });

  it("그사이 수량이 바뀌었거나 품목이 추가됐으면 campaignDeals 하나로 보고한다", () => {
    const expectation = { campaignDeals: [DEAL_A] };
    expect(findFinancialConflicts({ campaignDeals: [{ ...DEAL_A, quantity: 4 }] }, expectation)).toEqual([
      "campaignDeals",
    ]);
    expect(findFinancialConflicts({ campaignDeals: [DEAL_A, DEAL_B] }, expectation)).toEqual(["campaignDeals"]);
    expect(findFinancialConflicts({ campaignDeals: [{ ...DEAL_A, feeRate: 25 }] }, expectation)).toEqual([
      "campaignDeals",
    ]);
  });
});
