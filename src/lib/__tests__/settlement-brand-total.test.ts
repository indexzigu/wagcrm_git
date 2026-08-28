/**
 * 거래처(브랜드사) 정산 총액 SSOT 계약.
 *
 * 이 판정은 원래 재무 카드 안에 손으로 박혀 있었고, 정산 목록의 선택 바가 같은 금액을
 * 합산하게 되면서 lib 으로 올라왔다. 그래서 이 파일이 고정하는 것은 두 가지다 —
 * ① 방향은 채널이 아니라 **부호**가 정한다(부가 항목이 채널 기본 방향을 뒤집는다)
 * ② 물품대금 3-상태(`null` 미입력 · `0` 합산 이관 · 양수 관측값)가 접히지 않는다.
 */
import { describe, expect, it } from "vitest";
import { resolveBrandSettlementTotal } from "../settlement-brand-total";

describe("resolveBrandSettlementTotal", () => {
  it("우리몰은 물품대금을 지급하는 쪽이다 — 음수로 나온다", () => {
    const result = resolveBrandSettlementTotal({
      salesChannel: "OWN_MALL",
      actualSales: 1_000_000,
      settlementSales: 300_000,
    });
    // 공식 폴백: 1,000,000 − 300,000 = 700,000 을 지급한다.
    expect(result.amount).toBe(-700_000);
    expect(result.weReceive).toBe(false);
    expect(result.isEstimated).toBe(true);
  });

  it("브랜드몰은 영업수익을 받는 쪽이다 — 양수로 나오고 추정이 아니다", () => {
    const result = resolveBrandSettlementTotal({
      salesChannel: "BRAND_MALL",
      actualSales: 1_000_000,
      settlementSales: 300_000,
    });
    expect(result.amount).toBe(300_000);
    expect(result.weReceive).toBe(true);
    expect(result.isEstimated).toBe(false);
  });

  it("수기 물품대금은 공식보다 우선한다 — 관측값이 있으면 추정하지 않는다", () => {
    const result = resolveBrandSettlementTotal({
      salesChannel: "OWN_MALL",
      actualSales: 1_000_000,
      settlementSales: 300_000,
      settlementGoodsCost: 500_000,
    });
    expect(result.amount).toBe(-500_000);
    expect(result.isEstimated).toBe(false);
  });

  it("수기 물품대금 0 은 「합산 이관」이지 「금액 0원」이 아니다 — 기여값 0 이면서 추정도 아니다", () => {
    const result = resolveBrandSettlementTotal({
      salesChannel: "OWN_MALL",
      actualSales: 1_000_000,
      settlementSales: 300_000,
      settlementGoodsCost: 0,
    });
    expect(result.amount).toBe(0);
    expect(result.isEstimated).toBe(false);
  });

  it("부가 항목이 채널 기본 방향을 뒤집을 수 있다 — 방향은 부호가 정한다", () => {
    // 우리몰(기본은 지급)인데 브랜드사에 청구할 광고비가 물품대금보다 크다.
    const result = resolveBrandSettlementTotal({
      salesChannel: "OWN_MALL",
      actualSales: 1_000_000,
      settlementSales: 300_000,
      settlementGoodsCost: 200_000,
      settlementItems: [
        { invoiceMode: "SALES_ISSUE", counterparty: "BRAND", amount: 500_000 },
      ],
    });
    expect(result.amount).toBe(300_000);
    expect(result.weReceive).toBe(true);
  });

  it("총액이 0 이면 부호가 없으므로 채널이 정한 기본 방향을 쓴다", () => {
    const ownMall = resolveBrandSettlementTotal({
      salesChannel: "OWN_MALL",
      actualSales: 0,
      settlementSales: 0,
    });
    expect(ownMall.amount).toBe(0);
    expect(ownMall.weReceive).toBe(false);

    const brandMall = resolveBrandSettlementTotal({
      salesChannel: "BRAND_MALL",
      actualSales: 0,
      settlementSales: 0,
    });
    expect(brandMall.amount).toBe(0);
    expect(brandMall.weReceive).toBe(true);
  });

  it("공식이 음수가 되는 입력은 지급 0 으로 클램프한다 — 「브랜드사가 물품대금을 준다」가 아니다", () => {
    const result = resolveBrandSettlementTotal({
      salesChannel: "OWN_MALL",
      actualSales: 100_000,
      settlementSales: 300_000,
    });
    expect(result.amount).toBe(0);
  });
});
