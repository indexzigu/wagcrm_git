/**
 * Property-based tests for last contact date formatting.
 *
 * Feature: partner-seller-ux-revamp, Property 3: 최근 컨택 날짜 포맷
 * Validates: Requirements 4.4
 *
 * For any 유효한 날짜(Date) 값에 대해, 거래처 목록의 "최근 컨택" 컬럼 포맷 함수는
 * "YYYY-MM-DD" 형식의 문자열을 반환해야 한다.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { formatLastContact } from "../partner-seller-display";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Generates realistic dates for CRM "최근 컨택" usage.
 * Constrained to years 1970-2100 which covers all practical CRM contact dates.
 * The YYYY-MM-DD format requires 4-digit years with proper local-time handling.
 */
const realisticDateArb = fc.date({
  min: new Date("1970-01-01T00:00:00.000Z"),
  max: new Date("2100-12-31T23:59:59.999Z"),
});

// ---------------------------------------------------------------------------
// Property 3: 최근 컨택 날짜 포맷
// Validates: Requirements 4.4
// ---------------------------------------------------------------------------

describe("Feature: partner-seller-ux-revamp, Property 3: 최근 컨택 날짜 포맷", () => {
  it("임의 Date에 대해 YYYY-MM-DD 형식의 문자열을 반환한다", () => {
    fc.assert(
      fc.property(realisticDateArb, (date) => {
        const result = formatLastContact(date);

        // Must match YYYY-MM-DD pattern exactly
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }),
      { numRuns: 100 },
    );
  });

  it("반환된 연도는 Date의 getFullYear()와 일치한다", () => {
    fc.assert(
      fc.property(realisticDateArb, (date) => {
        const result = formatLastContact(date);
        const [yearStr] = result.split("-");
        expect(parseInt(yearStr, 10)).toBe(date.getFullYear());
      }),
      { numRuns: 100 },
    );
  });

  it("반환된 월은 Date의 getMonth()+1과 일치하며 2자리로 패딩된다", () => {
    fc.assert(
      fc.property(realisticDateArb, (date) => {
        const result = formatLastContact(date);
        const parts = result.split("-");
        const monthStr = parts[1];

        // Always 2 digits
        expect(monthStr).toHaveLength(2);

        // Value matches
        const expectedMonth = date.getMonth() + 1;
        expect(parseInt(monthStr, 10)).toBe(expectedMonth);
      }),
      { numRuns: 100 },
    );
  });

  it("반환된 일은 Date의 getDate()와 일치하며 2자리로 패딩된다", () => {
    fc.assert(
      fc.property(realisticDateArb, (date) => {
        const result = formatLastContact(date);
        const parts = result.split("-");
        const dayStr = parts[2];

        // Always 2 digits
        expect(dayStr).toHaveLength(2);

        // Value matches
        expect(parseInt(dayStr, 10)).toBe(date.getDate());
      }),
      { numRuns: 100 },
    );
  });

  it("반환 문자열의 길이는 항상 10자이다 (YYYY-MM-DD)", () => {
    fc.assert(
      fc.property(realisticDateArb, (date) => {
        const result = formatLastContact(date);
        expect(result).toHaveLength(10);
      }),
      { numRuns: 100 },
    );
  });
});
