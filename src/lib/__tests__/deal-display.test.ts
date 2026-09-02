import { describe, expect, it } from "vitest";
import { getDisplayDealName, normalizeDealBrandName } from "../deal-display";

describe("getDisplayDealName", () => {
  it("does not append quantity or supplementary info to an option name already composed", () => {
    expect(
      getDisplayDealName({
        dealName: "듀얼 올레올렛샷 - 2박스 (혼합 40포)",
        parentDealId: "parent-1",
        unit: "박스",
        unitQuantity: 2,
        supplementaryInfo: JSON.stringify({ supplementaryInfo: "혼합 40포" }),
      }),
    ).toBe("듀얼 올레올렛샷 - 2박스 (혼합 40포)");
  });

  it("appends quantity and supplementary info once for a base deal", () => {
    expect(
      getDisplayDealName({
        dealName: "듀얼 올레올렛샷",
        unit: "박스",
        unitQuantity: 2,
        supplementaryInfo: JSON.stringify({ supplementaryInfo: "혼합 40포" }),
      }),
    ).toBe("듀얼 올레올렛샷 - 2박스 (혼합 40포)");
  });
});

describe("normalizeDealBrandName", () => {
  it("keeps explicit brandName", () => {
    expect(
      normalizeDealBrandName("명시된 브랜드", { name: "거래처", type: "BRAND" }),
    ).toBe("명시된 브랜드");
  });

  it("falls back to partner name for brand partners", () => {
    expect(
      normalizeDealBrandName(null, { name: "브랜드 파트너", type: "BRAND" }),
    ).toBe("브랜드 파트너");
  });

  it("does not infer brandName for non-brand partners", () => {
    expect(
      normalizeDealBrandName(null, { name: "벤더 파트너", type: "VENDOR" }),
    ).toBeNull();
  });
});
