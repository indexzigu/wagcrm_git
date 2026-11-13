import { describe, expect, it } from "vitest";
import { buildOrderCampaignCreateData, deriveOrderCampaignFieldsFromProduct } from "../order-campaign-create";

const product = (channel: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  originProductNo: 9001,
  channelProducts: [{ channelProductNo: 7001, originProductNo: 9001, ...channel }],
  ...extra,
});

describe("deriveOrderCampaignFieldsFromProduct — 등록 창과 봇 기안이 같은 칸을 만든다", () => {
  it("상품명 머리 [셀러 X 브랜드] 에서 셀러를, 원상품번호를 productId 로", () => {
    const fields = deriveOrderCampaignFieldsFromProduct(
      product({
        name: "[샘플셀러 X 샘플브랜드] 샘플 상품",
        statusType: "SALE",
        saleStartDate: "2026-11-20T00:00:00.000+09:00",
        saleEndDate: "2026-11-26T23:59:00.000+09:00",
        wholeCategoryName: "식품>건강식품>비타민",
        representativeImage: { url: "https://example.com/a.jpg" },
      }),
    );
    expect(fields).toEqual({
      name: "[샘플셀러 X 샘플브랜드] 샘플 상품",
      sellerName: "샘플셀러",
      thumbnailUrl: "https://example.com/a.jpg",
      category: "비타민",
      productStatus: "SALE",
      salePeriod: "2026.11.20 ~ 2026.11.26",
      productId: "9001",
    });
  });

  it("대기 상품의 14일 합성 기간은 「미등록」, 시작일만 있으면 「~ 계속」, 없으면 「기간 미정」", () => {
    const wait = deriveOrderCampaignFieldsFromProduct(
      product({ name: "x", statusType: "WAIT", saleStartDate: "2026-11-01T00:00:00Z", saleEndDate: "2026-11-15T00:00:00Z" }),
    );
    const open = deriveOrderCampaignFieldsFromProduct(product({ name: "x", saleStartDate: "2026-11-01T00:00:00Z" }));
    const none = deriveOrderCampaignFieldsFromProduct(product({ name: "x" }));
    expect([wait.salePeriod, open.salePeriod, none.salePeriod]).toEqual(["미등록", "2026.11.01 ~ 계속", "기간 미정"]);
    expect(none.productStatus).toBe("WAIT");
    expect(none.sellerName).toBe("");
  });
});

describe("buildOrderCampaignCreateData — 등록 라우트와 승인 실행이 같은 저장 칸을 만든다", () => {
  it("빈 값은 null, 가격은 숫자, 매핑은 상품명 순으로", () => {
    const data = buildOrderCampaignCreateData({
      name: "n",
      sellerName: "s",
      template: "",
      productId: "9001",
      mappings: [
        { productName: "나", optionName: "o2", brandCode: "", price: "1000" },
        { productName: "가", optionName: "o1", price: 500 },
      ],
    });
    expect(data).toMatchObject({ name: "n", sellerName: "s", template: null, toEmail: null, productId: "9001", startDate: null });
    expect(data.mappings).toEqual({
      create: [
        { productName: "가", optionName: "o1", brandCode: "", price: 500 },
        { productName: "나", optionName: "o2", brandCode: "", price: 1000 },
      ],
    });
  });

  it("매핑이 없으면 mappings 칸 자체를 싣지 않는다", () => {
    expect("mappings" in buildOrderCampaignCreateData({ name: "n", sellerName: "s", mappings: [] })).toBe(false);
  });
});
