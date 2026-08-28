/**
 * Property-based tests for follower count formatting.
 *
 * Feature: partner-seller-ux-revamp, Property 12: 팔로워 수 포맷팅
 * Validates: Requirements 14.1, 14.5, 14.6
 *
 * For any 0 이상의 정수 팔로워 수에 대해:
 * - 10,000 이상이면 "X.Y만" 형식(소수점 1자리 반올림)
 * - 10,000 미만이면 천 단위 콤마 형식의 정수
 * - 0이면 "0"
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { formatFollowerCount } from "../partner-seller-display";

// ---------------------------------------------------------------------------
// Property 12: 팔로워 수 포맷팅
// Validates: Requirements 14.1, 14.5, 14.6
// ---------------------------------------------------------------------------

describe("Feature: partner-seller-ux-revamp, Property 12: 팔로워 수 포맷팅", () => {
  it("returns '0' when count is 0", () => {
    expect(formatFollowerCount(0)).toBe("0");
  });

  it("formats counts >= 10,000 as 'X.Y만' with 1 decimal place (rounded)", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1000000 }).filter((n) => n >= 10000),
        (count) => {
          const result = formatFollowerCount(count);

          // Must end with "만"
          expect(result.endsWith("만")).toBe(true);

          // Extract numeric part
          const numericPart = result.slice(0, -1);
          const parsed = parseFloat(numericPart);
          expect(Number.isNaN(parsed)).toBe(false);

          // Must have exactly 1 decimal place
          expect(numericPart).toMatch(/^\d+\.\d$/);

          // Value should equal count / 10000 rounded to 1 decimal
          const expected = (count / 10000).toFixed(1);
          expect(numericPart).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("formats counts 1-9999 as comma-separated integers", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        (count) => {
          const result = formatFollowerCount(count);

          // Should not contain "만"
          expect(result.includes("만")).toBe(false);

          // Should be a valid comma-formatted integer
          // Remove commas and parse
          const withoutCommas = result.replace(/,/g, "");
          const parsed = parseInt(withoutCommas, 10);
          expect(parsed).toBe(count);

          // Verify comma placement for thousands
          if (count >= 1000) {
            expect(result).toMatch(/^\d{1,3}(,\d{3})*$/);
          } else {
            // No commas needed for < 1000
            expect(result).toBe(String(count));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("always returns a non-empty string for any non-negative integer", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1000000 }),
        (count) => {
          const result = formatFollowerCount(count);
          expect(result.length).toBeGreaterThan(0);
          expect(typeof result).toBe("string");
        },
      ),
      { numRuns: 100 },
    );
  });
});
