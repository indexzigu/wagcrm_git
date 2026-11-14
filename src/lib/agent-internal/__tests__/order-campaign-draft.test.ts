import { describe, expect, it, vi } from "vitest";
import {
  buildOrderCampaignDraft,
  inheritBrandCodes,
  pickOrderBrand,
  pickProduct,
  type OrderCampaignDraftDeps,
} from "../order-campaign-draft";

const item = (originNo: number, channelNo: number, name: string, statusType = "SALE") => ({
  originProductNo: originNo,
  channelProducts: [{ channelProductNo: channelNo, originProductNo: originNo, name, statusType }],
});

const PRODUCTS = [
  item(101, 201, "[샘플셀러 X 샘플브랜드] 비타민 세트"),
  item(102, 202, "[다른셀러 X 샘플브랜드] 비타민 세트 2차", "CLOSE"),
  item(103, 203, "[샘플셀러 X 샘플브랜드] 유산균"),
];

const DETAIL_WITH_OPTIONS = {
  smartstoreChannelProduct: { name: "[샘플셀러 X 샘플브랜드] 유산균" },
  originProduct: {
    salePrice: 30000,
    detailAttribute: {
      optionInfo: {
        optionCombinationGroupNames: { optionGroupName1: "구성" },
        optionCombinations: [
          { optionName1: "1박스", price: 0 },
          { optionName1: "2박스", price: 25000 },
        ],
      },
    },
  },
};

function deps(overrides: Partial<OrderCampaignDraftDeps> = {}): OrderCampaignDraftDeps {
  return {
    listProducts: vi.fn(async () => PRODUCTS),
    fetchChannelProduct: vi.fn(async () => DETAIL_WITH_OPTIONS),
    listOrderBrands: vi.fn(async () => [
      { slug: "sample-brand", displayName: "샘플거래처", toEmail: "to@example.com", ccEmail: null },
      { slug: "other", displayName: "다른거래처", toEmail: null, ccEmail: null },
    ]),
    findCampaignsByProductNos: vi.fn(async () => []),
    findLatestCodedCampaign: vi.fn(async () => null),
    findCodedRowsByOptionNames: vi.fn(async () => []),
    ...overrides,
  };
}

describe("pickProduct", () => {
  it("상품번호(원상품·채널상품 둘 다)로 정확히 고른다", () => {
    const byOrigin = pickProduct(PRODUCTS, { productId: "103" });
    const byChannel = pickProduct(PRODUCTS, { productId: "203" });
    expect(byOrigin.ok && byOrigin.candidate.productId).toBe("103");
    expect(byChannel.ok && byChannel.candidate.channelProductNo).toBe("203");
  });

  it("채널이 여럿인 상품은 상품번호로 지목한 채널을 쓴다(첫 채널로 바꿔 치지 않는다)", () => {
    const multi = {
      originProductNo: 104,
      channelProducts: [
        { channelProductNo: 204, originProductNo: 104, name: "[샘플셀러 X 샘플브랜드] 오메가3", statusType: "SALE" },
        { channelProductNo: 304, originProductNo: 104, name: "[샘플셀러 X 샘플브랜드] 오메가3", statusType: "SALE" },
      ],
    };
    const second = pickProduct([...PRODUCTS, multi], { productId: "304" });
    expect(second.ok && second.candidate.channelProductNo).toBe("304");
    expect(second.ok && second.candidate.productId).toBe("104");
    const byOrigin = pickProduct([...PRODUCTS, multi], { productId: "104" });
    expect(byOrigin.ok && byOrigin.candidate.channelProductNo).toBe("204");
  });

  it("상품명 일부가 하나에만 걸리면 그 상품, 띄어쓰기·대소문자는 무시", () => {
    const result = pickProduct(PRODUCTS, { productQuery: "유 산균" });
    expect(result.ok && result.candidate.productId).toBe("103");
  });

  it("낱말로 나눈 질의는 순서와 사이 글자(머리의 X 등)에 상관없이 모든 낱말이 든 상품을 찾는다", () => {
    // 사람은 「셀러 브랜드」로 부르지만 상품명 머리는 「[셀러 X 브랜드]」 — 통째 부분일치로는 영영 못 찾는다.
    const bySellerBrand = pickProduct(PRODUCTS, { productQuery: "샘플셀러 샘플브랜드 유산균" });
    expect(bySellerBrand.ok && bySellerBrand.candidate.productId).toBe("103");
    const reordered = pickProduct(PRODUCTS, { productQuery: "유산균 샘플셀러" });
    expect(reordered.ok && reordered.candidate.productId).toBe("103");
  });

  it("낱말 하나라도 상품명에 없으면 걸지 않는다", () => {
    expect(pickProduct(PRODUCTS, { productQuery: "샘플셀러 오메가" })).toMatchObject({ ok: false, code: "PRODUCT_NOT_FOUND" });
  });

  it("여럿에 걸리면 고르지 않고 후보 이름·번호를 판매중 먼저 돌려준다", () => {
    const result = pickProduct(PRODUCTS, { productQuery: "비타민" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PRODUCT_AMBIGUOUS");
    expect(result.message).toContain("상품번호 101");
    expect(result.message).toContain("상품번호 102");
    expect(result.message.indexOf("101")).toBeLessThan(result.message.indexOf("102"));
    expect(result.message.length).toBeLessThanOrEqual(300);
  });

  it("상품명이 질의와 정확히 같은 후보가 하나면 그것을 고른다", () => {
    const result = pickProduct(PRODUCTS, { productQuery: "[샘플셀러 X 샘플브랜드] 비타민 세트" });
    expect(result.ok && result.candidate.productId).toBe("101");
  });

  it("없으면 PRODUCT_NOT_FOUND", () => {
    expect(pickProduct(PRODUCTS, { productQuery: "없는상품" })).toMatchObject({ ok: false, code: "PRODUCT_NOT_FOUND" });
    expect(pickProduct(PRODUCTS, { productId: "999" })).toMatchObject({ ok: false, code: "PRODUCT_NOT_FOUND" });
  });
});

describe("pickOrderBrand", () => {
  const brands = [
    { slug: "a-brand", displayName: "에이거래처", toEmail: null, ccEmail: null },
    { slug: "a-brand-2", displayName: "에이거래처2", toEmail: null, ccEmail: null },
  ];
  it("입력이 없으면 양식 없음, 정확히 같은 이름은 일부 겹침보다 우선", () => {
    expect(pickOrderBrand(brands, undefined)).toEqual({ ok: true, brand: null });
    expect(pickOrderBrand(brands, "에이거래처")).toMatchObject({ ok: true, brand: { slug: "a-brand" } });
    expect(pickOrderBrand(brands, "A-BRAND-2")).toMatchObject({ ok: true, brand: { slug: "a-brand-2" } });
  });
  it("일부만 겹치는 것이 여럿이거나 없으면 ORDER_BRAND_NOT_FOUND", () => {
    expect(pickOrderBrand(brands, "에이")).toMatchObject({ ok: false, code: "ORDER_BRAND_NOT_FOUND" });
    expect(pickOrderBrand(brands, "없는곳")).toMatchObject({ ok: false, code: "ORDER_BRAND_NOT_FOUND" });
  });
});

describe("buildOrderCampaignDraft", () => {
  it("상품 칸·스토어 옵션 줄·거래처 양식 메일·같은 상품 캠페인을 채운다", async () => {
    const d = deps({ findCampaignsByProductNos: vi.fn(async () => [{ id: "oc1", name: "지난 회차", isActive: false }]) });
    const result = await buildOrderCampaignDraft({ productQuery: "유산균", orderBrand: "샘플거래처" }, d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      productId: "103",
      channelProductNo: "203",
      name: "[샘플셀러 X 샘플브랜드] 유산균",
      sellerName: "샘플셀러",
      template: "sample-brand",
      templateName: "샘플거래처",
      toEmail: "to@example.com",
      ccEmail: null,
      productStatus: "SALE",
      sameProductCampaigns: [{ id: "oc1", name: "지난 회차", isActive: false }],
    });
    expect(result.data.mappings).toEqual([
      { productName: "[샘플셀러 X 샘플브랜드] 유산균", optionName: "구성: 1박스", price: 30000 },
      { productName: "[샘플셀러 X 샘플브랜드] 유산균", optionName: "구성: 2박스", price: 55000 },
    ]);
    expect(d.fetchChannelProduct).toHaveBeenCalledWith("203");
    expect(d.findCampaignsByProductNos).toHaveBeenCalledWith(["103", "203"]);
  });

  it("셀러 입력이 상품명보다 우선하고, 옵션 없는 상품은 상품명+할인가 한 줄", async () => {
    const d = deps({ fetchChannelProduct: vi.fn(async () => ({ originProduct: { name: "단품", salePrice: 12000 } })) });
    const result = await buildOrderCampaignDraft({ productId: "103", sellerName: "입력셀러" }, d);
    expect(result.ok && result.data.sellerName).toBe("입력셀러");
    expect(result.ok && result.data.mappings).toEqual([{ productName: "단품", optionName: "", price: 12000 }]);
    expect(result.ok && result.data.template).toBeNull();
  });

  it("상품명에 셀러 머리가 없고 입력도 없으면 SELLER_NAME_REQUIRED", async () => {
    const d = deps({ listProducts: vi.fn(async () => [item(300, 400, "머리 없는 상품")]) });
    expect(await buildOrderCampaignDraft({ productId: "300" }, d)).toMatchObject({ ok: false, code: "SELLER_NAME_REQUIRED" });
  });

  it("거래처를 못 찾으면 네이버를 부르지 않고 실패, 후보가 여럿이면 상세를 부르지 않는다", async () => {
    const d1 = deps();
    expect(await buildOrderCampaignDraft({ productQuery: "유산균", orderBrand: "없는곳" }, d1)).toMatchObject({
      ok: false,
      code: "ORDER_BRAND_NOT_FOUND",
    });
    expect(d1.listProducts).not.toHaveBeenCalled();
    const d2 = deps();
    expect(await buildOrderCampaignDraft({ productQuery: "비타민" }, d2)).toMatchObject({ ok: false, code: "PRODUCT_AMBIGUOUS" });
    expect(d2.fetchChannelProduct).not.toHaveBeenCalled();
  });

  it("네이버 조회가 던지면 STORE_FETCH_FAILED", async () => {
    const d = deps({ fetchChannelProduct: vi.fn(async () => { throw new Error("proxy 407"); }) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await buildOrderCampaignDraft({ productId: "103" }, d)).toMatchObject({ ok: false, code: "STORE_FETCH_FAILED" });
    spy.mockRestore();
  });

  it("거래처 양식·같은 상품 캠페인 DB 조회가 던지면 500 대신 STORE_FETCH_FAILED", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const brandFail = deps({ listOrderBrands: vi.fn(async () => { throw new Error("db down"); }) });
    expect(await buildOrderCampaignDraft({ productId: "103" }, brandFail)).toMatchObject({ ok: false, code: "STORE_FETCH_FAILED" });
    const sameFail = deps({ findCampaignsByProductNos: vi.fn(async () => { throw new Error("db down"); }) });
    expect(await buildOrderCampaignDraft({ productId: "103" }, sameFail)).toMatchObject({ ok: false, code: "STORE_FETCH_FAILED" });
    spy.mockRestore();
  });
});

describe("inheritBrandCodes — 지난 주문캠페인 상품코드 이어받기", () => {
  const rows = [
    { productName: "p", optionName: "구성: 1박스", price: 30000 },
    { productName: "p", optionName: "구성:  2박스 ", price: 55000 },
    { productName: "p", optionName: "구성: 3박스", price: 80000 },
  ];

  it("같은 상품의 지난 주문캠페인이 있으면 그 하나에서만, 옵션명 비교 키로 가져온다(가격은 그대로)", async () => {
    const d = deps({
      findLatestCodedCampaign: vi.fn(async () => ({
        id: "oc-prev",
        name: "지난 회차 주문",
        rows: [
          { optionName: "구성: 1박스", brandCode: "NT001" },
          { optionName: "구성: 2박스", brandCode: "NT002" },
        ],
      })),
    });
    const result = await inheritBrandCodes(rows, ["103", "203"], d);
    expect(d.findLatestCodedCampaign).toHaveBeenCalledWith(["103", "203"]);
    expect(d.findCodedRowsByOptionNames).not.toHaveBeenCalled();
    expect(result.rows).toEqual([
      { productName: "p", optionName: "구성: 1박스", price: 30000, brandCode: "NT001" },
      { productName: "p", optionName: "구성:  2박스 ", price: 55000, brandCode: "NT002" },
      { productName: "p", optionName: "구성: 3박스", price: 80000 },
    ]);
    expect(result.source).toEqual({
      kind: "SAME_PRODUCT",
      orderCampaignId: "oc-prev",
      orderCampaignName: "지난 회차 주문",
      inheritedRows: 2,
    });
  });

  it("같은 상품이 없으면 과거 전체에서 코드가 하나로 정해진 옵션만, 갈리면 비운다", async () => {
    const d = deps({
      findCodedRowsByOptionNames: vi.fn(async () => [
        { optionName: "구성: 1박스", brandCode: "NT001" },
        { optionName: "구성: 1박스", brandCode: "NT001" },
        { optionName: "구성: 3박스", brandCode: "NT003" },
        { optionName: "구성: 3박스", brandCode: "XX999" },
      ]),
    });
    const result = await inheritBrandCodes(rows, ["103"], d);
    expect(d.findCodedRowsByOptionNames).toHaveBeenCalledWith(["구성: 1박스", "구성:  2박스 ", "구성: 3박스"]);
    expect(result.rows.map((row) => row.brandCode)).toEqual(["NT001", undefined, undefined]);
    expect(result.source).toEqual({ kind: "SAME_OPTION", orderCampaignId: null, orderCampaignName: null, inheritedRows: 1 });
  });

  it("같은 상품 캠페인의 코드가 공백뿐·상한 초과면 없는 것으로 보고 다른 주문캠페인에서 찾는다", async () => {
    const d = deps({
      findLatestCodedCampaign: vi.fn(async () => ({
        id: "oc-prev",
        name: "지난 회차 주문",
        rows: [
          { optionName: "구성: 1박스", brandCode: "   " },
          { optionName: "구성: 3박스", brandCode: "X".repeat(33) },
        ],
      })),
      findCodedRowsByOptionNames: vi.fn(async () => [{ optionName: "구성: 1박스", brandCode: "NT001" }]),
    });
    const result = await inheritBrandCodes(rows, ["103"], d);
    expect(result.rows.map((row) => row.brandCode)).toEqual(["NT001", undefined, undefined]);
    expect(result.source).toMatchObject({ kind: "SAME_OPTION", inheritedRows: 1 });
  });

  it("붙은 줄이 없거나 옵션 없는 상품(빈 옵션명)이면 출처 없음 — 조회도 하지 않는다", async () => {
    const d = deps();
    expect((await inheritBrandCodes(rows, ["103"], d)).source).toBeNull();
    const single = deps();
    const result = await inheritBrandCodes([{ productName: "단품", optionName: "", price: 12000 }], ["103"], single);
    expect(result).toEqual({ rows: [{ productName: "단품", optionName: "", price: 12000 }], source: null });
    expect(single.findLatestCodedCampaign).not.toHaveBeenCalled();
  });

  it("초안에 이어받은 코드와 출처가 실리고, 코드 조회가 던지면 STORE_FETCH_FAILED", async () => {
    const d = deps({
      findLatestCodedCampaign: vi.fn(async () => ({ id: "oc-prev", name: "지난 회차 주문", rows: [{ optionName: "구성: 2박스", brandCode: "NT002" }] })),
    });
    const result = await buildOrderCampaignDraft({ productId: "103" }, d);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.mappings[1]).toMatchObject({ optionName: "구성: 2박스", brandCode: "NT002" });
    expect(result.data.mappings[0]).not.toHaveProperty("brandCode");
    expect(result.data.brandCodeSource).toMatchObject({ kind: "SAME_PRODUCT", inheritedRows: 1 });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fail = deps({ findLatestCodedCampaign: vi.fn(async () => { throw new Error("db down"); }) });
    const failed = await buildOrderCampaignDraft({ productId: "103" }, fail);
    expect(failed).toMatchObject({ ok: false, code: "STORE_FETCH_FAILED" });
    expect(!failed.ok && failed.message).toContain("상품코드 조회");
    spy.mockRestore();
  });
});
