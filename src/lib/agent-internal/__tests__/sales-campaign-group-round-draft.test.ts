/**
 * 판매캠페인 그룹 다음 회차 초안(`create_sales_campaign_group_round`, 2026-11-14). 고정하는 것:
 *  ① 지난 그룹의 캠페인마다 판매 조건·채널·마진·하위품목을 잇고, 기간·링크는 스토어 상품 하나에서 읽어 모두에 쓴다
 *  ② 지난 회차 캠페인 지목이 없으면 「같은 상품번호의 주문캠페인에 연결된 가장 최근 그룹」을 지난 그룹으로 찾는다
 *  ③ 그룹이 아닌 캠페인을 지목하거나 그룹을 못 찾으면 PREVIOUS_GROUP_NOT_FOUND
 *  ④ 연결할 주문캠페인은 같은 상품의 가장 최근 것 — 붙은 캠페인은 otherLinkedCampaigns 로 보여 주고, 그중 이전 그룹 캠페인이 있으면 연결하지 않는다
 *  ⑤ 어느 캠페인이든 같은 기간 회차가 이미 있으면 ROUND_ALREADY_EXISTS
 *  ⑥ 상품 목록 조회는 기안 1건당 최대 1회(Fixie 요청 수 — 그룹 멤버 수와 무관)
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildSalesCampaignGroupRoundDraft,
  type PreviousGroup,
  type SalesCampaignGroupRoundDraftDeps,
} from "../sales-campaign-group-round-draft";
import type { PreviousRound } from "../sales-campaign-round-draft";

const item = (originNo: number, channelNo: number, name: string, start?: string, end?: string, statusType = "SALE") => ({
  originProductNo: originNo,
  channelProducts: [
    { channelProductNo: channelNo, originProductNo: originNo, name, statusType, saleStartDate: start, saleEndDate: end },
  ],
});

const PRODUCTS = [
  item(101, 201, "[샘플셀러 X 샘플브랜드] 조합 2차", "2026-12-01T00:00:00.000+09:00", "2026-12-07T23:59:00.000+09:00"),
  item(102, 202, "[샘플셀러 X 샘플브랜드] 조합 1차", "2026-11-01T00:00:00.000+09:00", "2026-11-07T23:59:00.000+09:00", "CLOSE"),
];

const member = (id: string, dealId: string, dealName: string, overrides: Partial<PreviousRound> = {}): PreviousRound => ({
  id,
  campaignName: `${dealName} - 샘플셀러`,
  dealId,
  sellerId: "seller-1",
  salesChannel: "OWN_MALL_NAVER",
  isManualMargin: false,
  totalMarginRate: 0,
  sellerMarginRate: 0,
  dealName,
  sellerName: "샘플셀러",
  linkedProductId: "101",
  items: [{ dealId, dealName, feeRate: 30, sellerMarginRate: 12, costPrice: 10000, sellingPrice: 29000 }],
  ...overrides,
});

const GROUP: PreviousGroup = {
  id: "group-1",
  name: "[샘플셀러] 딜A 외 1건",
  members: [member("camp-a", "deal-a", "딜A"), member("camp-b", "deal-b", "딜B", { isManualMargin: true, totalMarginRate: 25, sellerMarginRate: 10 })],
};

function deps(overrides: Partial<SalesCampaignGroupRoundDraftDeps> = {}): SalesCampaignGroupRoundDraftDeps {
  return {
    findGroupIdOfCampaign: vi.fn(async () => "group-1"),
    findLatestGroupIdByProduct: vi.fn(async () => "group-1"),
    loadGroup: vi.fn(async () => GROUP),
    listProducts: vi.fn(async () => PRODUCTS),
    listRounds: vi.fn(async (dealId: string) => [
      { id: `${dealId}-1`, name: null, startDate: "2026-11-01", endDate: "2026-11-07" },
    ]),
    findOrderCampaign: vi.fn(async () => ({ id: "oc-2", name: "조합 2차 주문" })),
    listLinkedCampaigns: vi.fn(async () => [
      { id: "placeholder", name: "딜A - 샘플셀러 2차", startDate: "2026-11-30", endDate: "2026-12-06" },
    ]),
    isAnyLinked: vi.fn(async () => false),
    today: () => "2026-11-14",
    ...overrides,
  };
}

describe("buildSalesCampaignGroupRoundDraft", () => {
  it("상품만 지목하면 그 상품을 썼던 지난 그룹을 찾아 캠페인마다 잇는다", async () => {
    const d = deps();
    const result = await buildSalesCampaignGroupRoundDraft({ productQuery: "조합 2차" }, d);
    if (!result.ok) throw new Error(result.message);
    expect(d.findLatestGroupIdByProduct).toHaveBeenCalledWith(["101", "201"]);
    expect(d.findGroupIdOfCampaign).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      previousGroupId: "group-1",
      sellerId: "seller-1",
      sellerName: "샘플셀러",
      startDate: "2026-12-01",
      endDate: "2026-12-07",
      dateSource: "STORE",
      status: "PREPARATION",
      baseNaverLink: "https://smartstore.naver.com/ygrd/products/201",
      product: { productId: "101", channelProductNo: "201", source: "INPUT" },
      linkOrderCampaign: { id: "oc-2", name: "조합 2차 주문" },
      otherLinkedCampaigns: [{ id: "placeholder" }],
    });
    expect(result.data.members).toEqual([
      expect.objectContaining({
        previousCampaignId: "camp-a",
        dealId: "deal-a",
        isManualMargin: false,
        expectedRoundNumber: 2,
        expectedCampaignName: "딜A - 샘플셀러 2차",
      }),
      expect.objectContaining({
        previousCampaignId: "camp-b",
        dealId: "deal-b",
        isManualMargin: true,
        totalMarginRate: 25,
        sellerMarginRate: 10,
        expectedCampaignName: "딜B - 샘플셀러 2차",
      }),
    ]);
    expect(d.listProducts).toHaveBeenCalledTimes(1);
  });

  it("지난 회차 캠페인을 지목하면 그 그룹을 쓰고, 상품이 없으면 지난 그룹에 연결된 상품을 쓴다", async () => {
    const d = deps({ listProducts: vi.fn(async () => [item(101, 201, "조합", "2026-12-01T00:00:00.000+09:00", "2026-12-07T23:59:00.000+09:00")]) });
    const result = await buildSalesCampaignGroupRoundDraft({ previousCampaignId: "camp-b" }, d);
    if (!result.ok) throw new Error(result.message);
    expect(d.findGroupIdOfCampaign).toHaveBeenCalledWith("camp-b");
    expect(d.findLatestGroupIdByProduct).not.toHaveBeenCalled();
    expect(result.data.product).toMatchObject({ productId: "101", source: "PREVIOUS_ROUND" });
    expect(d.listProducts).toHaveBeenCalledTimes(1);
  });

  it("그룹이 아닌 캠페인을 지목하면 PREVIOUS_GROUP_NOT_FOUND(단건 기안을 안내)", async () => {
    const result = await buildSalesCampaignGroupRoundDraft(
      { previousCampaignId: "solo" },
      deps({ findGroupIdOfCampaign: vi.fn(async () => null) }),
    );
    expect(result).toMatchObject({ ok: false, code: "PREVIOUS_GROUP_NOT_FOUND" });
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("create_sales_campaign_round");
  });

  it("지목한 캠페인이 없으면 CAMPAIGN_NOT_FOUND", async () => {
    const result = await buildSalesCampaignGroupRoundDraft(
      { previousCampaignId: "nope" },
      deps({ findGroupIdOfCampaign: vi.fn(async () => undefined) }),
    );
    expect(result).toMatchObject({ ok: false, code: "CAMPAIGN_NOT_FOUND" });
  });

  it("그 상품을 썼던 그룹이 없으면 PREVIOUS_GROUP_NOT_FOUND", async () => {
    const result = await buildSalesCampaignGroupRoundDraft(
      { productId: "101" },
      deps({ findLatestGroupIdByProduct: vi.fn(async () => null) }),
    );
    expect(result).toMatchObject({ ok: false, code: "PREVIOUS_GROUP_NOT_FOUND" });
  });

  it("어느 캠페인이든 같은 기간 회차가 이미 있으면 ROUND_ALREADY_EXISTS", async () => {
    const d = deps({
      listRounds: vi.fn(async (dealId: string) =>
        dealId === "deal-b" ? [{ id: "dup", name: "딜B - 샘플셀러 2차", startDate: "2026-12-01", endDate: "2026-12-07" }] : [],
      ),
    });
    const result = await buildSalesCampaignGroupRoundDraft({ productId: "101" }, d);
    expect(result).toMatchObject({ ok: false, code: "ROUND_ALREADY_EXISTS" });
  });

  it("상품 지목이 여러 상품에 걸리면 후보를 돌려준다(그룹을 찾지 않는다)", async () => {
    const d = deps();
    const result = await buildSalesCampaignGroupRoundDraft({ productQuery: "조합" }, d);
    expect(result).toMatchObject({ ok: false, code: "PRODUCT_AMBIGUOUS" });
    expect(d.findLatestGroupIdByProduct).not.toHaveBeenCalled();
  });

  it("가장 최근 주문캠페인에 이전 그룹 캠페인이 붙어 있으면 연결하지 않고, 붙은 캠페인은 보여 준다", async () => {
    const d = deps({
      listLinkedCampaigns: vi.fn(async () => [
        { id: "camp-b", name: "딜B - 샘플셀러", startDate: "2026-11-01", endDate: "2026-11-07" },
      ]),
      isAnyLinked: vi.fn(async () => true),
    });
    const result = await buildSalesCampaignGroupRoundDraft({ productId: "101" }, d);
    if (!result.ok) throw new Error(result.message);
    expect(d.findOrderCampaign).toHaveBeenCalledWith(["101", "201"]);
    expect(d.isAnyLinked).toHaveBeenCalledWith("oc-2", ["camp-a", "camp-b"]);
    expect(result.data.linkOrderCampaign).toBeNull();
    expect(result.data.otherLinkedCampaigns).toEqual([expect.objectContaining({ id: "camp-b" })]);
  });

  it("이전 그룹이 아닌 캠페인만 붙어 있으면 연결하고 붙은 캠페인을 보여 준다", async () => {
    const d = deps();
    const result = await buildSalesCampaignGroupRoundDraft({ productId: "101" }, d);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.linkOrderCampaign).toEqual({ id: "oc-2", name: "조합 2차 주문" });
    expect(result.data.otherLinkedCampaigns).toEqual([expect.objectContaining({ id: "placeholder" })]);
  });

  it("지난 그룹에 같은 판매 조건 캠페인이 둘이면 잇지 않는다", async () => {
    const d = deps({ loadGroup: vi.fn(async () => ({ ...GROUP, members: [GROUP.members[0], { ...GROUP.members[1], dealId: "deal-a" }] })) });
    const result = await buildSalesCampaignGroupRoundDraft({ productId: "101" }, d);
    expect(result).toMatchObject({ ok: false, code: "OPTIONS_TOO_LARGE" });
  });

  it("주문캠페인이 없으면 연결 없음, 붙은 캠페인 목록도 비운다", async () => {
    const d = deps({ findOrderCampaign: vi.fn(async () => null) });
    const result = await buildSalesCampaignGroupRoundDraft({ productId: "101" }, d);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.linkOrderCampaign).toBeNull();
    expect(result.data.otherLinkedCampaigns).toEqual([]);
    expect(d.listLinkedCampaigns).not.toHaveBeenCalled();
  });

  it("네이버 조회가 실패하면 STORE_FETCH_FAILED 로 보고한다(삼키지 않는다)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = deps({ listProducts: vi.fn(async () => Promise.reject(new Error("proxy 407"))) });
    const result = await buildSalesCampaignGroupRoundDraft({ productId: "101" }, d);
    expect(result).toMatchObject({ ok: false, code: "STORE_FETCH_FAILED" });
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("proxy 407");
    spy.mockRestore();
  });
});
