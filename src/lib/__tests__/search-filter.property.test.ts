/**
 * Property-based tests for search-filter utility.
 *
 * Feature: ux-fixes-and-field-editing
 * Property 3: Seller search filter correctness
 * Property 4: Deal search filter correctness
 *
 * Validates: Requirements 3.2, 11.2
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { filterBySearchText } from "../search-filter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Seller = { name: string; snsHandle: string };
type Deal = { dealName: string; partnerName: string };

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate non-empty strings that can include Korean characters */
const koreanCharArb = fc.constantFrom(
  "가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하",
  "김", "이", "박", "최", "정", "강", "조", "윤", "장", "임",
  "민", "수", "진", "영", "현", "지", "은", "서", "연", "우",
);

const koreanNameArb = fc.array(koreanCharArb, { minLength: 2, maxLength: 5 }).map((chars) => chars.join(""));

const snsHandleArb = fc.stringMatching(/^@[a-z][a-z0-9_]{2,14}$/);

const sellerArb: fc.Arbitrary<Seller> = fc.record({
  name: koreanNameArb,
  snsHandle: snsHandleArb,
});

const dealNameArb = fc.oneof(
  koreanNameArb,
  fc.string({ minLength: 2, maxLength: 30 }).filter((s) => s.trim().length > 0),
);

const dealArb: fc.Arbitrary<Deal> = fc.record({
  dealName: dealNameArb,
  partnerName: fc.oneof(koreanNameArb, fc.string({ minLength: 2, maxLength: 20 }).filter((s) => s.trim().length > 0)),
});

/** Generate a non-empty search string (trimmed) */
const searchTextArb = fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0);

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

const getSellerFields = (s: Seller): string[] => [s.name, s.snsHandle];
const getDealFields = (d: Deal): string[] => [d.dealName, d.partnerName];

/**
 * Reference implementation: checks if any field contains the search text
 * as a case-insensitive substring.
 */
function matchesSearch(fields: string[], searchText: string): boolean {
  const lower = searchText.trim().toLowerCase();
  if (lower === "") return true;
  return fields.some((field) => {
    if (field == null) return false;
    return field.toLowerCase().includes(lower);
  });
}

// ---------------------------------------------------------------------------
// Property 3: Seller search filter correctness
// Validates: Requirements 3.2
// ---------------------------------------------------------------------------

describe("Property 3: Seller search filter correctness", () => {
  it("every returned seller has at least one field containing the search text (case-insensitive)", () => {
    fc.assert(
      fc.property(
        fc.array(sellerArb, { minLength: 0, maxLength: 20 }),
        searchTextArb,
        (sellers, searchText) => {
          const results = filterBySearchText(sellers, searchText, getSellerFields);

          for (const seller of results) {
            const fields = getSellerFields(seller);
            expect(matchesSearch(fields, searchText)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("no excluded seller has any field containing the search text (completeness)", () => {
    fc.assert(
      fc.property(
        fc.array(sellerArb, { minLength: 0, maxLength: 20 }),
        searchTextArb,
        (sellers, searchText) => {
          const results = filterBySearchText(sellers, searchText, getSellerFields);
          const resultSet = new Set(results);

          for (const seller of sellers) {
            if (!resultSet.has(seller)) {
              const fields = getSellerFields(seller);
              expect(matchesSearch(fields, searchText)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("filter is case-insensitive: searching uppercase or lowercase yields same results", () => {
    fc.assert(
      fc.property(
        fc.array(sellerArb, { minLength: 0, maxLength: 15 }),
        searchTextArb,
        (sellers, searchText) => {
          const upper = filterBySearchText(sellers, searchText.toUpperCase(), getSellerFields);
          const lower = filterBySearchText(sellers, searchText.toLowerCase(), getSellerFields);

          expect(upper.length).toBe(lower.length);
          expect(upper).toEqual(lower);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("empty search text returns all sellers unchanged", () => {
    fc.assert(
      fc.property(
        fc.array(sellerArb, { minLength: 0, maxLength: 20 }),
        (sellers) => {
          const results = filterBySearchText(sellers, "", getSellerFields);
          expect(results).toEqual(sellers);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("result preserves original order (subset of input in same order)", () => {
    fc.assert(
      fc.property(
        fc.array(sellerArb, { minLength: 0, maxLength: 20 }),
        searchTextArb,
        (sellers, searchText) => {
          const results = filterBySearchText(sellers, searchText, getSellerFields);

          // Verify results appear in same relative order as input
          let lastIndex = -1;
          for (const result of results) {
            const idx = sellers.indexOf(result);
            expect(idx).toBeGreaterThan(lastIndex);
            lastIndex = idx;
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Korean IME partial syllables do not crash and produce valid results", () => {
    const koreanPartialArb = fc.constantFrom("ㄱ", "ㄴ", "ㄷ", "ㄹ", "ㅁ", "ㅂ", "ㅅ", "ㅇ", "ㅈ", "ㅎ", "가", "나", "하");

    fc.assert(
      fc.property(
        fc.array(sellerArb, { minLength: 0, maxLength: 15 }),
        koreanPartialArb,
        (sellers, partialChar) => {
          // Should not throw and should return a valid array
          const results = filterBySearchText(sellers, partialChar, getSellerFields);
          expect(Array.isArray(results)).toBe(true);
          expect(results.length).toBeLessThanOrEqual(sellers.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Deal search filter correctness
// Validates: Requirements 11.2
// ---------------------------------------------------------------------------

describe("Property 4: Deal search filter correctness", () => {
  it("every returned deal has at least one field containing the search text (case-insensitive)", () => {
    fc.assert(
      fc.property(
        fc.array(dealArb, { minLength: 0, maxLength: 20 }),
        searchTextArb,
        (deals, searchText) => {
          const results = filterBySearchText(deals, searchText, getDealFields);

          for (const deal of results) {
            const fields = getDealFields(deal);
            expect(matchesSearch(fields, searchText)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("no excluded deal has any field containing the search text (completeness)", () => {
    fc.assert(
      fc.property(
        fc.array(dealArb, { minLength: 0, maxLength: 20 }),
        searchTextArb,
        (deals, searchText) => {
          const results = filterBySearchText(deals, searchText, getDealFields);
          const resultSet = new Set(results);

          for (const deal of deals) {
            if (!resultSet.has(deal)) {
              const fields = getDealFields(deal);
              expect(matchesSearch(fields, searchText)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("filter is case-insensitive: searching uppercase or lowercase yields same results", () => {
    fc.assert(
      fc.property(
        fc.array(dealArb, { minLength: 0, maxLength: 15 }),
        searchTextArb,
        (deals, searchText) => {
          const upper = filterBySearchText(deals, searchText.toUpperCase(), getDealFields);
          const lower = filterBySearchText(deals, searchText.toLowerCase(), getDealFields);

          expect(upper.length).toBe(lower.length);
          expect(upper).toEqual(lower);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("empty search text returns all deals unchanged", () => {
    fc.assert(
      fc.property(
        fc.array(dealArb, { minLength: 0, maxLength: 20 }),
        (deals) => {
          const results = filterBySearchText(deals, "", getDealFields);
          expect(results).toEqual(deals);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("result preserves original order (subset of input in same order)", () => {
    fc.assert(
      fc.property(
        fc.array(dealArb, { minLength: 0, maxLength: 20 }),
        searchTextArb,
        (deals, searchText) => {
          const results = filterBySearchText(deals, searchText, getDealFields);

          // Verify results appear in same relative order as input
          let lastIndex = -1;
          for (const result of results) {
            const idx = deals.indexOf(result);
            expect(idx).toBeGreaterThan(lastIndex);
            lastIndex = idx;
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Korean IME partial syllables do not crash and produce valid results", () => {
    const koreanPartialArb = fc.constantFrom("ㄱ", "ㄴ", "ㄷ", "ㄹ", "ㅁ", "ㅂ", "ㅅ", "ㅇ", "ㅈ", "ㅎ", "코", "비", "프");

    fc.assert(
      fc.property(
        fc.array(dealArb, { minLength: 0, maxLength: 15 }),
        koreanPartialArb,
        (deals, partialChar) => {
          // Should not throw and should return a valid array
          const results = filterBySearchText(deals, partialChar, getDealFields);
          expect(Array.isArray(results)).toBe(true);
          expect(results.length).toBeLessThanOrEqual(deals.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("filtering with a substring known to be in a field always includes that item", () => {
    fc.assert(
      fc.property(
        dealArb,
        fc.array(dealArb, { minLength: 0, maxLength: 10 }),
        (targetDeal, otherDeals) => {
          // Pick a substring from the target deal's dealName
          const name = targetDeal.dealName;
          if (name.length < 1) return; // skip degenerate case

          const startIdx = 0;
          const endIdx = Math.min(name.length, Math.max(1, Math.floor(name.length / 2)));
          const substring = name.slice(startIdx, endIdx);

          if (substring.trim().length === 0) return; // skip whitespace-only substrings

          const allDeals = [targetDeal, ...otherDeals];
          const results = filterBySearchText(allDeals, substring, getDealFields);

          // The target deal must be in the results
          expect(results).toContain(targetDeal);
        },
      ),
      { numRuns: 100 },
    );
  });
});
