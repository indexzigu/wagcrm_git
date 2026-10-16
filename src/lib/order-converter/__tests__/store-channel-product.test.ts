/** 캠페인 productId → 스토어 채널상품 판정 SSOT(설정 창·봇 창구 공용). 정본 `../store-channel-product.ts`. */
import { describe, expect, it } from "vitest";
import { findCampaignChannelProduct } from "../store-channel-product";

const products = [
  { originProductNo: 111, channelProducts: [{ channelProductNo: 211, name: "상품 가" }] },
  { originProductNo: 112, channelProducts: [{ channelProductNo: 212, name: "상품 나" }] },
];

describe("findCampaignChannelProduct", () => {
  it("원상품번호(생성 창이 저장하는 값)로 찾는다", () => {
    expect(findCampaignChannelProduct(products, "112")).toEqual({
      channelProductNo: "212",
      originProductNo: "112",
      name: "상품 나",
    });
  });

  it("채널상품번호(옛 캠페인)로도 찾는다", () => {
    expect(findCampaignChannelProduct(products, "211")?.channelProductNo).toBe("211");
  });

  it("번호가 없거나 맞는 상품이 없으면 null — 상품명으로 추측하지 않는다", () => {
    expect(findCampaignChannelProduct(products, null)).toBeNull();
    expect(findCampaignChannelProduct(products, "  ")).toBeNull();
    expect(findCampaignChannelProduct(products, "999")).toBeNull();
  });

  it("모양이 이상한 원소는 건너뛴다", () => {
    expect(findCampaignChannelProduct([null, { channelProducts: "x" }, ...products], "211")?.name).toBe("상품 가");
  });
});
