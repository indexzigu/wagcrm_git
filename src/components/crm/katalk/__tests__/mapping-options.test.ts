import { describe, expect, it } from "vitest";
import { buildMappingOptions } from "../mapping-options";
import type { CampaignOption, PartnerOption, SellerOption } from "../types";

describe("buildMappingOptions — PARTNER/SELLER/CAMPAIGN 통합 검색 옵션", () => {
  const partners: PartnerOption[] = [
    { id: "p1", name: "테스트 파트너" },
    { id: "p2", name: "다른 거래처" },
  ];
  const sellers: SellerOption[] = [
    { id: "s1", name: "김철수", alias: "철수셀러" },
    { id: "s2", name: "이영희", alias: null },
  ];
  const campaigns: CampaignOption[] = [
    { id: "c1", campaignName: "여름 프로모션", dealName: "딜A", sellerName: "김철수", sellerId: "s1" },
    { id: "c2", campaignName: null, dealName: "딜B", sellerName: "이영희", sellerId: "s2" },
  ];

  it("세 목록을 하나의 옵션 배열로 합친다(PARTNER + SELLER + CAMPAIGN 순서)", () => {
    const options = buildMappingOptions(partners, sellers, campaigns);
    expect(options).toHaveLength(6);
    expect(options.filter((o) => o.kind === "PARTNER")).toHaveLength(2);
    expect(options.filter((o) => o.kind === "SELLER")).toHaveLength(2);
    expect(options.filter((o) => o.kind === "CAMPAIGN")).toHaveLength(2);
  });

  it("PARTNER 옵션의 compositeValue/label/searchableText가 올바르다", () => {
    const options = buildMappingOptions(partners, [], []);
    const opt = options.find((o) => o.entityId === "p1");
    expect(opt?.compositeValue).toBe("PARTNER:p1");
    expect(opt?.label).toContain("테스트 파트너");
    expect(opt?.searchableText).toContain("테스트 파트너");
  });

  it("SELLER 옵션은 alias를 우선 라벨로 쓰지만 name도 검색 가능하다", () => {
    const options = buildMappingOptions([], sellers, []);
    const opt = options.find((o) => o.entityId === "s1");
    expect(opt?.label).toContain("철수셀러");
    expect(opt?.searchableText).toContain("김철수");
  });

  it("alias가 없는 셀러는 name을 라벨로 쓴다", () => {
    const options = buildMappingOptions([], sellers, []);
    const opt = options.find((o) => o.entityId === "s2");
    expect(opt?.label).toContain("이영희");
  });

  it("CAMPAIGN 옵션은 campaignName이 있으면 그것을 라벨에 쓰고, campaignSellerId를 보존한다", () => {
    const options = buildMappingOptions([], [], campaigns);
    const opt = options.find((o) => o.entityId === "c1");
    expect(opt?.compositeValue).toBe("CAMPAIGN:c1");
    expect(opt?.label).toContain("여름 프로모션");
    expect(opt?.campaignSellerId).toBe("s1");
  });

  it("CAMPAIGN 옵션은 campaignName이 없으면 딜명·셀러명 조합을 라벨로 쓴다", () => {
    const options = buildMappingOptions([], [], campaigns);
    const opt = options.find((o) => o.entityId === "c2");
    expect(opt?.label).toContain("딜B");
    expect(opt?.label).toContain("이영희");
  });

  it("CAMPAIGN의 searchableText는 딜명/셀러명으로도 검색 가능하게 포함한다", () => {
    const options = buildMappingOptions([], [], campaigns);
    const opt = options.find((o) => o.entityId === "c1");
    expect(opt?.searchableText).toContain("딜A");
    expect(opt?.searchableText).toContain("김철수");
  });

  it("빈 목록 3개를 넘기면 빈 배열을 반환한다", () => {
    expect(buildMappingOptions([], [], [])).toEqual([]);
  });
});
