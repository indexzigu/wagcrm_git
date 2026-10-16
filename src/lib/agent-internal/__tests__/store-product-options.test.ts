/**
 * 봇 옵션 조회 창구 본체 — 실패 코드 갈래와 표 만들기(지금 매핑 값 붙이기). 정본 `../store-product-options.ts`.
 * 네이버·DB 는 주입한 가짜로 둔다(저장 경로 전체는 `apply-product-mappings.realdb.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => {
    throw new Error("이 테스트는 주입한 가짜만 써야 한다");
  },
}));
vi.mock("@/lib/order-converter/naver-commerce-client", () => ({ apiRequest: vi.fn() }));
vi.mock("@/lib/order-converter/naver-commerce-api", () => ({ searchNaverProducts: vi.fn() }));

const { getStoreProductOptions, buildStoreProductOptionsData, resetStoreOptionsCacheForTest } = await import(
  "../store-product-options"
);
type StoreOptionsDeps = import("../store-product-options").StoreOptionsDeps;

const CAMPAIGN = { id: "cmtestordercampaign000000001", name: "[샘플 공구] 테스트", productId: "111" };
const LIST = [{ originProductNo: 111, channelProducts: [{ channelProductNo: 211, name: "샘플 상품" }] }];

function detail(names: string[]) {
  return {
    smartstoreChannelProduct: { name: "샘플 상품" },
    originProduct: {
      salePrice: 10000,
      detailAttribute: {
        optionInfo: {
          optionCombinationGroupNames: { optionGroupName1: "구성" },
          optionCombinations: names.map((name) => ({ optionName1: name, price: 0 })),
        },
      },
    },
  };
}

function deps(over: Partial<StoreOptionsDeps> = {}): StoreOptionsDeps {
  return {
    listProducts: async () => LIST,
    fetchChannelProduct: async () => detail(["1박스", "2박스"]),
    findOrderCampaign: async () => CAMPAIGN,
    now: () => 0,
    ...over,
  };
}

beforeEach(() => {
  resetStoreOptionsCacheForTest();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getStoreProductOptions — 실패 갈래", () => {
  it("캠페인이 없으면 CAMPAIGN_NOT_FOUND", async () => {
    const result = await getStoreProductOptions("x", deps({ findOrderCampaign: async () => null }), async () => []);
    expect(result).toMatchObject({ ok: false, code: "CAMPAIGN_NOT_FOUND" });
  });

  it("상품이 연결되지 않았거나 목록에 없으면 NO_STORE_OPTIONS — 설정 창에서 연결하라고 안내한다", async () => {
    const noProduct = await getStoreProductOptions(
      CAMPAIGN.id,
      deps({ findOrderCampaign: async () => ({ ...CAMPAIGN, productId: null }) }),
      async () => [],
    );
    expect(noProduct).toMatchObject({ ok: false, code: "NO_STORE_OPTIONS" });
    expect(!noProduct.ok && noProduct.message).toContain("설정 창");

    const notListed = await getStoreProductOptions(CAMPAIGN.id, deps({ listProducts: async () => [] }), async () => []);
    expect(notListed).toMatchObject({ ok: false, code: "NO_STORE_OPTIONS" });
  });

  it("옵션 없는 상품은 NO_STORE_OPTIONS(봇이 빈 옵션명 줄을 만들지 않는다)", async () => {
    const result = await getStoreProductOptions(
      CAMPAIGN.id,
      deps({ fetchChannelProduct: async () => detail([]) }),
      async () => [],
    );
    expect(result).toMatchObject({ ok: false, code: "NO_STORE_OPTIONS" });
  });

  it("네이버 조회가 실패하면 STORE_FETCH_FAILED", async () => {
    const result = await getStoreProductOptions(
      CAMPAIGN.id,
      deps({
        fetchChannelProduct: async () => {
          throw new Error("boom");
        },
      }),
      async () => [],
    );
    expect(result).toMatchObject({ ok: false, code: "STORE_FETCH_FAILED" });
  });

  it("표가 결과 상한을 넘으면 잘라 주지 않고 OPTIONS_TOO_LARGE", async () => {
    const many = Array.from({ length: 200 }, (_, index) => `아주 긴 옵션 이름 ${index} `.repeat(4));
    const result = await getStoreProductOptions(
      CAMPAIGN.id,
      deps({ fetchChannelProduct: async () => detail(many) }),
      async () => [],
    );
    expect(result).toMatchObject({ ok: false, code: "OPTIONS_TOO_LARGE" });
  });
});

describe("buildStoreProductOptionsData — 지금 매핑 값 붙이기", () => {
  const snapshot = {
    orderCampaign: { id: CAMPAIGN.id, name: CAMPAIGN.name },
    productId: "111",
    channelProductNo: "211",
    productName: "샘플 상품",
    rows: [
      { productName: "샘플 상품", optionName: "구성: 1박스", brandCode: "", price: 10000 },
      { productName: "샘플 상품", optionName: "구성: 2박스", brandCode: "", price: 19000 },
      { productName: "샘플 상품", optionName: "구성: 3박스", brandCode: "", price: 27000 },
    ],
  };

  it("옵션명 비교 키로 지금 값을 붙이고, 두 줄 이상이면 값 대신 duplicateMappings, 스토어에 없는 매핑은 개수만", () => {
    const data = buildStoreProductOptionsData(snapshot, [
      { optionName: "구성:  1박스".normalize("NFD"), brandCode: "A-1", price: 10000 },
      { optionName: "구성: 2박스", brandCode: "B-1", price: 1 },
      { optionName: "구성: 2박스", brandCode: "B-2", price: 2 },
      { optionName: "샘플 1BOX", brandCode: "Z-9", price: 9 },
    ]);
    expect(data?.options).toEqual([
      { optionName: "구성: 1박스", price: 10000, currentBrandCode: "A-1", currentPrice: 10000, duplicateMappings: false },
      { optionName: "구성: 2박스", price: 19000, currentBrandCode: null, currentPrice: null, duplicateMappings: true },
      { optionName: "구성: 3박스", price: 27000, currentBrandCode: null, currentPrice: null, duplicateMappings: false },
    ]);
    expect(data?.mappingsNotInStore).toBe(1);
  });
});
