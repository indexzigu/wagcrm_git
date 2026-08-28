/**
 * Property-based tests for y-axis-format.ts
 *
 * Feature: ux-fixes-and-field-editing
 * Property 5: Y-axis label formatting preserves magnitude
 * Validates: Requirements 9.1, 9.3
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { formatYAxisLabel, computeChartLeftMargin } from "../y-axis-format";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a formatted Y-axis label back to its numeric magnitude.
 * Handles: "0", comma-formatted numbers, "N만", "N,NNN만", "N억", "N.N억"
 */
function parseYAxisLabel(label: string): number {
  const isNegative = label.startsWith("-");
  const cleanLabel = isNegative ? label.slice(1) : label;
  let value: number;

  if (cleanLabel === "0") {
    return 0;
  } else if (cleanLabel.endsWith("억")) {
    const numStr = cleanLabel.slice(0, -1).replace(/,/g, "");
    value = parseFloat(numStr) * 100_000_000;
  } else if (cleanLabel.endsWith("만")) {
    const numStr = cleanLabel.slice(0, -1).replace(/,/g, "");
    value = parseFloat(numStr) * 10_000;
  } else {
    // Plain comma-formatted number
    value = parseFloat(cleanLabel.replace(/,/g, ""));
  }

  return isNegative ? -value : value;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for non-negative values in the sub-million range */
const subMillionArb = fc.integer({ min: 0, max: 999_999 });

/** Arbitrary for values in the 만 range (1,000,000 to 99,999,999) */
const manRangeArb = fc.integer({ min: 1_000_000, max: 99_999_999 });

/** Arbitrary for values in the 억 range (100,000,000+) */
const eokRangeArb = fc.integer({ min: 100_000_000, max: 10_000_000_000 });

/** Arbitrary for any non-negative integer */
const nonNegativeArb = fc.integer({ min: 0, max: 10_000_000_000 });

// ---------------------------------------------------------------------------
// Property 5: Y-axis label formatting preserves magnitude
// ---------------------------------------------------------------------------

describe("Property 5: Y-axis label formatting preserves magnitude", () => {
  it(
    "values ≥ 1,000,000 and < 100,000,000 use 만 abbreviation",
    () => {
      fc.assert(
        fc.property(manRangeArb, (value) => {
          const label = formatYAxisLabel(value);
          expect(label).toContain("만");
          expect(label).not.toContain("억");
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "values ≥ 100,000,000 use 억 abbreviation",
    () => {
      fc.assert(
        fc.property(eokRangeArb, (value) => {
          const label = formatYAxisLabel(value);
          expect(label).toContain("억");
          expect(label).not.toContain("만");
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "values < 1,000,000 do not use 만 or 억 abbreviation",
    () => {
      fc.assert(
        fc.property(subMillionArb, (value) => {
          const label = formatYAxisLabel(value);
          expect(label).not.toContain("만");
          expect(label).not.toContain("억");
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "formatted label preserves magnitude within rounding tolerance for 만 range",
    () => {
      fc.assert(
        fc.property(manRangeArb, (value) => {
          const label = formatYAxisLabel(value);
          const parsed = parseYAxisLabel(label);
          // 만 unit rounds to nearest 만 (10,000), so tolerance is 10,000
          const tolerance = 10_000;
          expect(Math.abs(parsed - value)).toBeLessThanOrEqual(tolerance);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "formatted label preserves magnitude within rounding tolerance for 억 range",
    () => {
      fc.assert(
        fc.property(eokRangeArb, (value) => {
          const label = formatYAxisLabel(value);
          const parsed = parseYAxisLabel(label);
          // 억 unit rounds to 1 decimal (0.1억 = 10,000,000), so tolerance is 10,000,000
          const tolerance = 10_000_000;
          expect(Math.abs(parsed - value)).toBeLessThanOrEqual(tolerance);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "formatted label exactly preserves sub-million values",
    () => {
      fc.assert(
        fc.property(subMillionArb, (value) => {
          const label = formatYAxisLabel(value);
          const parsed = parseYAxisLabel(label);
          expect(parsed).toBe(value);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "formatYAxisLabel always returns a non-empty string for any non-negative value",
    () => {
      fc.assert(
        fc.property(nonNegativeArb, (value) => {
          const label = formatYAxisLabel(value);
          expect(label.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "computeChartLeftMargin returns value between 40 and 80 for any non-negative input",
    () => {
      fc.assert(
        fc.property(nonNegativeArb, (value) => {
          const margin = computeChartLeftMargin(value);
          expect(margin).toBeGreaterThanOrEqual(40);
          expect(margin).toBeLessThanOrEqual(80);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "computeChartLeftMargin is monotonically non-decreasing with label length",
    () => {
      fc.assert(
        fc.property(nonNegativeArb, nonNegativeArb, (a, b) => {
          const labelA = formatYAxisLabel(a);
          const labelB = formatYAxisLabel(b);
          const marginA = computeChartLeftMargin(a);
          const marginB = computeChartLeftMargin(b);
          // If label B is longer, its margin should be >= margin A
          if (labelB.length > labelA.length) {
            expect(marginB).toBeGreaterThanOrEqual(marginA);
          }
          if (labelA.length > labelB.length) {
            expect(marginA).toBeGreaterThanOrEqual(marginB);
          }
        }),
        { numRuns: 100 },
      );
    },
  );
});
