import { describe, expect, it } from "vitest";
import { normalizeDealBrandName } from "../deal-display";

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
