import { describe, expect, it } from "vitest";
import {
  buildSourceKey,
  extractInstagramHandle,
  extractRelationTitles,
  hashPayload,
  normalizeKey,
  parseCurrency,
  parseDate,
  parseFollowerCount,
  parsePercent,
  toNullableString,
} from "../lib/notion-import/normalize";

describe("notion import normalization", () => {
  it("normalizes strings and keys", () => {
    expect(toNullableString("  빅픽처코퍼레이션  ")).toBe("빅픽처코퍼레이션");
    expect(normalizeKey(" 빅픽처 코퍼레이션 ")).toBe("빅픽처코퍼레이션".toLowerCase());
  });

  it("parses currency-like values", () => {
    expect(parseCurrency("12,900")).toBe(12900);
    expect(parseCurrency("0")).toBe(0);
    expect(parseCurrency("")).toBeNull();
  });

  it("parses percent values from both percent and decimal notation", () => {
    expect(parsePercent("20%")).toBe(20);
    expect(parsePercent("0.32")).toBe(32);
    expect(parsePercent("2500%")).toBe(2500);
  });

  it("parses follower counts in man-unit notation", () => {
    expect(parseFollowerCount("41.1")).toBe(411000);
    expect(parseFollowerCount("41.1만")).toBe(411000);
    expect(parseFollowerCount("3.8만")).toBe(38000);
  });

  it("parses slash and Korean date formats", () => {
    expect(parseDate("2025/03/17")).toBe("2025-03-17");
    expect(parseDate("2025년 6월 13일 오후 6:41")).toBe("2025-06-13");
  });

  it("extracts notion relation titles", () => {
    expect(
      extractRelationTitles(
        "가온 (https://www.notion.so/a), 별하샵 (https://www.notion.so/b)",
      ),
    ).toEqual(["가온", "별하샵"]);
  });

  it("extracts instagram handles", () => {
    expect(extractInstagramHandle("https://www.instagram.com/some_seller/")).toBe("some_seller");
    expect(extractInstagramHandle("")).toBeNull();
  });

  it("builds stable source keys and hashes", () => {
    expect(buildSourceKey("deals", ["빅픽처코퍼레이션", "복숭아"])).toBe(
      "deals:빅픽처코퍼레이션::복숭아",
    );
    expect(hashPayload({ a: 1 })).toHaveLength(64);
  });
});
