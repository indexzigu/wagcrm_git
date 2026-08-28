/**
 * Unit tests for search-filter utility.
 *
 * Feature: ux-fixes-and-field-editing
 * Validates: Requirements 3.2, 11.2
 */

import { describe, it, expect } from "vitest";
import { filterBySearchText } from "../search-filter";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

type Seller = { name: string; snsHandle: string };
type Deal = { dealName: string; partnerName: string };

const sellers: Seller[] = [
  { name: "김민수", snsHandle: "@minsu_kim" },
  { name: "이하나", snsHandle: "@hana_lee" },
  { name: "박지영", snsHandle: "@jiyoung_park" },
  { name: "최수진", snsHandle: "@sujin_choi" },
  { name: "John Smith", snsHandle: "@john_smith" },
];

const getSellerFields = (s: Seller): string[] => [s.name, s.snsHandle];

const deals: Deal[] = [
  { dealName: "코링코 글로우 앰플", partnerName: "코링코" },
  { dealName: "비타민C 세럼", partnerName: "더마랩" },
  { dealName: "Premium Moisturizer", partnerName: "SkinCare Co" },
];

const getDealFields = (d: Deal): string[] => [d.dealName, d.partnerName];

// ---------------------------------------------------------------------------
// Basic filtering
// ---------------------------------------------------------------------------

describe("filterBySearchText", () => {
  it("returns all items when search text is empty", () => {
    expect(filterBySearchText(sellers, "", getSellerFields)).toEqual(sellers);
  });

  it("returns all items when search text is whitespace only", () => {
    expect(filterBySearchText(sellers, "   ", getSellerFields)).toEqual(sellers);
  });

  it("filters by partial match on name (Korean)", () => {
    const result = filterBySearchText(sellers, "민수", getSellerFields);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("김민수");
  });

  it("filters by partial match on snsHandle", () => {
    const result = filterBySearchText(sellers, "hana", getSellerFields);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("이하나");
  });

  it("is case-insensitive for English text", () => {
    const result = filterBySearchText(sellers, "JOHN", getSellerFields);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("John Smith");
  });

  it("matches across any searchable field", () => {
    // Search by snsHandle should find the seller
    const result = filterBySearchText(sellers, "@sujin", getSellerFields);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("최수진");
  });

  it("returns empty array when no match found", () => {
    const result = filterBySearchText(sellers, "없는이름", getSellerFields);
    expect(result).toHaveLength(0);
  });

  it("handles single Korean character (IME composition start)", () => {
    // "김" should match "김민수"
    const result = filterBySearchText(sellers, "김", getSellerFields);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("김민수");
  });

  it("matches a standalone lead consonant via choseong search", () => {
    // "ㅎ" is an all-consonant query, so it now matches any name whose choseong
    // run contains ㅎ — here 이하나 (초성 ㅇㅎㄴ). This intentionally supersedes
    // the old literal-substring behavior where "ㅎ" matched nothing.
    const result = filterBySearchText(sellers, "ㅎ", getSellerFields);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("이하나");
  });

  it("filters deals by dealName", () => {
    const result = filterBySearchText(deals, "글로우", getDealFields);
    expect(result).toHaveLength(1);
    expect(result[0].dealName).toBe("코링코 글로우 앰플");
  });

  it("filters deals by partnerName", () => {
    const result = filterBySearchText(deals, "더마", getDealFields);
    expect(result).toHaveLength(1);
    expect(result[0].partnerName).toBe("더마랩");
  });

  it("is case-insensitive for deal search", () => {
    const result = filterBySearchText(deals, "premium", getDealFields);
    expect(result).toHaveLength(1);
    expect(result[0].dealName).toBe("Premium Moisturizer");
  });

  it("handles null/undefined fields gracefully", () => {
    type ItemWithNullable = { name: string | null; tag: string | undefined };
    const items: ItemWithNullable[] = [
      { name: null, tag: "hello" },
      { name: "world", tag: undefined },
    ];
    const getFields = (item: ItemWithNullable): string[] => [
      item.name as string,
      item.tag as string,
    ];

    // Should not throw, and should match "hello" in the first item's tag
    const result = filterBySearchText(items, "hello", getFields);
    expect(result).toHaveLength(1);
    expect(result[0].tag).toBe("hello");
  });

  it("trims search text before matching", () => {
    const result = filterBySearchText(sellers, "  민수  ", getSellerFields);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("김민수");
  });

  it("returns empty array when items array is empty", () => {
    const result = filterBySearchText([], "test", getSellerFields);
    expect(result).toHaveLength(0);
  });

  it("does not mutate the original array", () => {
    const original = [...sellers];
    filterBySearchText(sellers, "김", getSellerFields);
    expect(sellers).toEqual(original);
  });

  // -------------------------------------------------------------------------
  // Choseong (초성) search — all-consonant queries match against the choseong
  // run of each field, e.g. "ㄱㅁ" → 김민수.
  // -------------------------------------------------------------------------

  it("matches a full choseong query (ㄱㅁ → 김민수)", () => {
    const result = filterBySearchText(sellers, "ㄱㅁ", getSellerFields);
    expect(result.map((s) => s.name)).toEqual(["김민수"]);
  });

  it("matches an interior choseong run (ㅁㅅ → 김민수)", () => {
    const result = filterBySearchText(sellers, "ㅁㅅ", getSellerFields);
    expect(result.map((s) => s.name)).toEqual(["김민수"]);
  });

  it("ignores spaces within a choseong query (ㄱ ㅁ → 김민수)", () => {
    const result = filterBySearchText(sellers, "ㄱ ㅁ", getSellerFields);
    expect(result.map((s) => s.name)).toEqual(["김민수"]);
  });

  it("returns nothing for a choseong run no name has (ㅋㅋ)", () => {
    const result = filterBySearchText(sellers, "ㅋㅋ", getSellerFields);
    expect(result).toHaveLength(0);
  });

  it("does not treat a vowel jamo as a choseong query (falls back to substring)", () => {
    // "ㅏ" is a vowel, not a lead consonant → substring mode, matches nothing.
    const result = filterBySearchText(sellers, "ㅏ", getSellerFields);
    expect(result).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Unicode normalization (NFC/NFD) — Hangul in either form matches the other.
  // -------------------------------------------------------------------------

  it("matches a decomposed (NFD) query against composed (NFC) data", () => {
    const nfdQuery = "김민수".normalize("NFD");
    expect(nfdQuery).not.toBe("김민수"); // sanity: forms are not byte-equal
    const result = filterBySearchText(sellers, nfdQuery, getSellerFields);
    expect(result.map((s) => s.name)).toEqual(["김민수"]);
  });

  it("matches a composed (NFC) query against decomposed (NFD) data", () => {
    const decomposed = [{ name: "하나".normalize("NFD"), snsHandle: "@x" }];
    const result = filterBySearchText(decomposed, "하나", (s) => [
      s.name,
      s.snsHandle,
    ]);
    expect(result).toHaveLength(1);
  });
});
