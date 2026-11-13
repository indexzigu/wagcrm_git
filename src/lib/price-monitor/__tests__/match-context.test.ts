import { describe, it, expect } from "vitest";
import {
  parseBrandAliases,
  formatBrandAliases,
  buildBrandIdentities,
  stripDerivedFields,
  isLabelAgreement,
  summarizeAccuracy,
} from "../match-context";

describe("brand aliases", () => {
  it("parses newline/comma separated names, trimming and de-duplicating", () => {
    expect(parseBrandAliases(" 뉴트리원\n뉴트리원 , NUTRIONE ,,")).toEqual(["뉴트리원", "NUTRIONE"]);
    expect(parseBrandAliases(null)).toEqual([]);
  });
  it("formats back to newline separated text and null when empty", () => {
    expect(formatBrandAliases(["뉴트리원", " ", "NUTRIONE"])).toBe("뉴트리원\nNUTRIONE");
    expect(formatBrandAliases([])).toBeNull();
  });
  it("identities = brand name + aliases", () => {
    expect(buildBrandIdentities("비비랩", "뉴트리원")).toEqual(["비비랩", "뉴트리원"]);
    expect(buildBrandIdentities(null, null)).toEqual([]);
  });
});

describe("stripDerivedFields", () => {
  it("drops previous scoring/outlier fields so a stored candidate can be re-evaluated", () => {
    const stored = {
      productName: "p", price: 1, totalPrice: 1, mall: "m", url: "u", channel: "kakao",
      matchScore: 90, brandMatch: "match", ownerLabel: null, extractedQuantity: 2, unitPrice: 1,
      excludeReason: "MATCH_TOO_LOW",
    };
    expect(stripDerivedFields(stored)).toEqual({ productName: "p", price: 1, totalPrice: 1, mall: "m", url: "u", channel: "kakao" });
  });
});

describe("accuracy", () => {
  it("agreement means the system already decided the way the owner did", () => {
    expect(isLabelAgreement("DIFFERENT", false)).toBe(true);
    expect(isLabelAgreement("DIFFERENT", true)).toBe(false);
    expect(isLabelAgreement("SAME", true)).toBe(true);
    expect(isLabelAgreement("SAME", false)).toBe(false);
  });
  it("summarizes counts", () => {
    expect(
      summarizeAccuracy([
        { label: "DIFFERENT", systemSaidSame: true },
        { label: "SAME", systemSaidSame: true },
        { label: "DIFFERENT", systemSaidSame: false },
      ]),
    ).toEqual({ total: 3, agreed: 2 });
  });
});
