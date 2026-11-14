/**
 * 판매캠페인 다음 회차 초안(`create_sales_campaign_round`, 2026-11-14). 고정하는 것:
 *  ① 이전 회차의 판매 조건·셀러·채널·마진·하위품목을 잇고, 기간·링크는 스토어 상품에서 읽는다
 *  ② 상품 지목이 없으면 이전 회차에 연결된 주문캠페인 상품을 쓰고, 그것도 없으면 PRODUCT_REQUIRED
 *  ③ 스토어 기간을 쓸 수 없거나(미등록·끝 없음) 이미 끝났으면 SALE_PERIOD_UNAVAILABLE — 날짜를 받아 오게 한다
 *  ④ 같은 기간 회차가 이미 있으면 ROUND_ALREADY_EXISTS, 상품명 일부가 여러 상품에 걸리면 PRODUCT_AMBIGUOUS
 *  ⑤ 예상 회차·이름은 시작일 순서(승인 때 recalculateCampaignRounds 와 같은 규칙)
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildSalesCampaignRoundDraft,
  expectedRoundNumber,
  parseStoreSalePeriod,
  statusForPeriod,
  type PreviousRound,
  type SalesCampaignRoundDraftDeps,
} from "../sales-campaign-round-draft";

const item = (originNo: number, channelNo: number, name: string, start?: string, end?: string, statusType = "SALE") => ({
  originProductNo: originNo,
  channelProducts: [
    { channelProductNo: channelNo, originProductNo: originNo, name, statusType, saleStartDate: start, saleEndDate: end },
  ],
});

const PRODUCTS = [
  item(101, 201, "[샘플셀러 X 샘플브랜드] 비타민 2차", "2026-12-01T00:00:00.000+09:00", "2026-12-07T23:59:00.000+09:00"),
  item(102, 202, "[샘플셀러 X 샘플브랜드] 비타민 1차", "2026-11-01T00:00:00.000+09:00", "2026-11-07T23:59:00.000+09:00", "CLOSE"),
  item(103, 203, "[샘플셀러 X 샘플브랜드] 유산균", "2026-12-01T00:00:00.000+09:00"),
];

const PREVIOUS: PreviousRound = {
  id: "camp-1",
  campaignName: "샘플딜 - 샘플셀러",
  dealId: "deal-1",
  sellerId: "seller-1",
  salesChannel: "OWN_MALL_NAVER",
  isManualMargin: true,
  totalMarginRate: 30,
  sellerMarginRate: 12,
  dealName: "샘플딜",
  sellerName: "샘플셀러",
  linkedProductId: "102",
  items: [{ dealId: "deal-1", dealName: "샘플딜", feeRate: 30, sellerMarginRate: 12, costPrice: 10000, sellingPrice: 29000 }],
};

function deps(overrides: Partial<SalesCampaignRoundDraftDeps> = {}): SalesCampaignRoundDraftDeps {
  return {
    loadPreviousRound: vi.fn(async () => PREVIOUS),
    listProducts: vi.fn(async () => PRODUCTS),
    listRounds: vi.fn(async () => [{ id: "camp-1", name: "샘플딜 - 샘플셀러", startDate: "2026-11-01", endDate: "2026-11-07" }]),
    findUnlinkedOrderCampaign: vi.fn(async () => null),
    today: () => "2026-11-14",
    ...overrides,
  };
}

describe("buildSalesCampaignRoundDraft", () => {
  it("이전 회차를 잇고 지목한 스토어 상품의 판매 기간·링크로 새 회차 초안을 만든다", async () => {
    const d = deps({ findUnlinkedOrderCampaign: vi.fn(async () => ({ id: "oc-2", name: "비타민 2차 주문" })) });
    const result = await buildSalesCampaignRoundDraft({ previousCampaignId: "camp-1", productQuery: "비타민 2차" }, d);
    if (!result.ok) throw new Error(result.message);
    expect(result.data).toMatchObject({
      dealId: "deal-1",
      sellerId: "seller-1",
      salesChannel: "OWN_MALL_NAVER",
      isManualMargin: true,
      totalMarginRate: 30,
      sellerMarginRate: 12,
      startDate: "2026-12-01",
      endDate: "2026-12-07",
      dateSource: "STORE",
      status: "PREPARATION",
      baseNaverLink: "https://smartstore.naver.com/ygrd/products/201",
      expectedRoundNumber: 2,
      expectedCampaignName: "샘플딜 - 샘플셀러 2차",
      linkOrderCampaign: { id: "oc-2", name: "비타민 2차 주문" },
      product: { productId: "101", channelProductNo: "201", source: "INPUT" },
    });
    expect(result.data.campaignItems).toEqual(PREVIOUS.items);
    expect(d.findUnlinkedOrderCampaign).toHaveBeenCalledWith(["101", "201"]);
  });

  it("상품 지목이 없으면 이전 회차에 연결된 상품을 쓴다 — 그 기간이 끝났으면 날짜를 받아 오게 한다", async () => {
    const ended = await buildSalesCampaignRoundDraft({ previousCampaignId: "camp-1" }, deps());
    expect(ended).toMatchObject({ ok: false, code: "SALE_PERIOD_UNAVAILABLE" });

    const withDates = await buildSalesCampaignRoundDraft(
      { previousCampaignId: "camp-1", startDate: "2026-12-10", endDate: "2026-12-16" },
      deps(),
    );
    if (!withDates.ok) throw new Error(withDates.message);
    expect(withDates.data).toMatchObject({
      startDate: "2026-12-10",
      endDate: "2026-12-16",
      dateSource: "INPUT",
      product: { productId: "102", source: "PREVIOUS_ROUND" },
    });
  });

  it("상품 지목도, 이전 회차 연결 상품도 없으면 PRODUCT_REQUIRED(네이버를 부르지 않는다)", async () => {
    const d = deps({ loadPreviousRound: vi.fn(async () => ({ ...PREVIOUS, linkedProductId: null })) });
    const result = await buildSalesCampaignRoundDraft({ previousCampaignId: "camp-1" }, d);
    expect(result).toMatchObject({ ok: false, code: "PRODUCT_REQUIRED" });
    expect(d.listProducts).not.toHaveBeenCalled();
  });

  it("이전 회차가 없으면 CAMPAIGN_NOT_FOUND", async () => {
    const result = await buildSalesCampaignRoundDraft(
      { previousCampaignId: "nope" },
      deps({ loadPreviousRound: vi.fn(async () => null) }),
    );
    expect(result).toMatchObject({ ok: false, code: "CAMPAIGN_NOT_FOUND" });
  });

  it("끝 없는 스토어 기간은 쓸 수 없다(SALE_PERIOD_UNAVAILABLE)", async () => {
    const result = await buildSalesCampaignRoundDraft({ previousCampaignId: "camp-1", productId: "103" }, deps());
    expect(result).toMatchObject({ ok: false, code: "SALE_PERIOD_UNAVAILABLE" });
  });

  it("상품명 일부가 여러 상품에 걸리면 후보를 돌려준다(고르지 않는다)", async () => {
    const result = await buildSalesCampaignRoundDraft({ previousCampaignId: "camp-1", productQuery: "비타민" }, deps());
    expect(result).toMatchObject({ ok: false, code: "PRODUCT_AMBIGUOUS" });
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("상품번호 101");
  });

  it("같은 기간의 회차가 이미 있으면 ROUND_ALREADY_EXISTS", async () => {
    const d = deps({
      listRounds: vi.fn(async () => [{ id: "camp-2", name: "샘플딜 - 샘플셀러 2차", startDate: "2026-12-01", endDate: "2026-12-07" }]),
    });
    const result = await buildSalesCampaignRoundDraft({ previousCampaignId: "camp-1", productId: "101" }, d);
    expect(result).toMatchObject({ ok: false, code: "ROUND_ALREADY_EXISTS" });
  });

  it("네이버 조회가 실패하면 STORE_FETCH_FAILED 로 보고한다(삼키지 않는다)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = deps({ listProducts: vi.fn(async () => Promise.reject(new Error("proxy 407"))) });
    const result = await buildSalesCampaignRoundDraft({ previousCampaignId: "camp-1", productId: "101" }, d);
    expect(result).toMatchObject({ ok: false, code: "STORE_FETCH_FAILED" });
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("proxy 407");
    spy.mockRestore();
  });
});

describe("보조 판정", () => {
  it("parseStoreSalePeriod 는 두 날짜가 있는 기간만 읽는다", () => {
    expect(parseStoreSalePeriod("2026.12.01 ~ 2026.12.07")).toEqual({ startDate: "2026-12-01", endDate: "2026-12-07" });
    expect(parseStoreSalePeriod("2026.12.01 ~ 계속")).toBeNull();
    expect(parseStoreSalePeriod("미등록")).toBeNull();
    expect(parseStoreSalePeriod("기간 미정")).toBeNull();
  });

  it("statusForPeriod — 시작 전 준비, 기간 안 판매 중, 지난 기간 종료", () => {
    expect(statusForPeriod("2026-12-01", "2026-12-07", "2026-11-14")).toBe("PREPARATION");
    expect(statusForPeriod("2026-11-10", "2026-11-20", "2026-11-14")).toBe("ACTIVE");
    expect(statusForPeriod("2026-11-01", "2026-11-07", "2026-11-14")).toBe("CLOSED");
  });

  it("expectedRoundNumber — 첫 캠페인이면 회차 없음, 아니면 시작일 순서(같은 날은 기존 회차 뒤)", () => {
    const r = (startDate: string) => ({ id: startDate, name: null, startDate, endDate: startDate });
    expect(expectedRoundNumber([], "2026-12-01")).toBeNull();
    expect(expectedRoundNumber([r("2026-11-01")], "2026-12-01")).toBe(2);
    expect(expectedRoundNumber([r("2026-11-01"), r("2026-12-20")], "2026-12-01")).toBe(2);
    expect(expectedRoundNumber([r("2026-12-01")], "2026-12-01")).toBe(2);
  });
});
