import { describe, expect, it } from "vitest";
import {
  formatDealContextLabel,
  getDealContextParts,
  getDealIdentityParts,
} from "../deal-display";

describe("formatDealContextLabel", () => {
  it("shows both brand and partner when they differ", () => {
    expect(
      formatDealContextLabel({
        brandName: "브랜드A",
        partnerName: "벤더A",
      }),
    ).toBe("브랜드A - 벤더A");
  });

  it("avoids duplicate labels when brand and partner names match", () => {
    expect(
      formatDealContextLabel({
        brandName: "CORINGCO",
        partnerName: "CORINGCO",
      }),
    ).toBe("CORINGCO");
  });

  it("falls back to partner label when brand is missing", () => {
    expect(
      formatDealContextLabel({
        brandName: null,
        partnerName: "거래처A",
      }),
    ).toBe("거래처A");
  });

  it("keeps the role label when only one context value exists", () => {
    expect(
      getDealContextParts({
        brandName: null,
        partnerName: "거래처A",
      }),
    ).toEqual([{ label: "거래처", value: "거래처A" }]);
  });

  it("builds deal identity parts with deal first", () => {
    expect(
      getDealIdentityParts({
        dealName: "테스트 딜",
        partnerName: "거래처A",
      }),
    ).toEqual([
      { label: "딜", value: "테스트 딜" },
      { label: "거래처", value: "거래처A" },
    ]);
  });
});
