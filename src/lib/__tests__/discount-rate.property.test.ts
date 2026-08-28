/**
 * Property-based tests for discount-rate computation.
 *
 * Feature: ux-fixes-and-field-editing
 * Property 2: Discount rate computation correctness
 * Validates: Requirements 2.6, 2.7
 *
 * Tests that computeDiscountRate returns (listPrice - sellingPrice) / listPrice × 100,
 * rounded to 1 decimal, and returns null when listPrice is null, zero, or ≤ 0.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { computeDiscountRate } from "../discount-rate";

// ---------------------------------------------------------------------------
// Property 2: Discount rate computation correctness
// Validates: Requirements 2.6, 2.7
// ---------------------------------------------------------------------------

describe("Property 2: Discount rate computation correctness", () => {
  it("computes (listPrice - sellingPrice) / listPrice × 100 rounded to 1 decimal for valid inputs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        (listPrice, sellingPrice) => {
          const result = computeDiscountRate(listPrice, sellingPrice);
          const expected = Math.round(((listPrice - sellingPrice) / listPrice) * 1000) / 10;

          expect(result).toBeCloseTo(expected, 5);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns null when listPrice is null", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        (sellingPrice) => {
          const result = computeDiscountRate(null, sellingPrice);
          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns null when listPrice is zero", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        (sellingPrice) => {
          const result = computeDiscountRate(0, sellingPrice);
          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns null when listPrice is negative (≤ 0)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: -1 }),
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        (listPrice, sellingPrice) => {
          const result = computeDiscountRate(listPrice, sellingPrice);
          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns null when sellingPrice is null", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        (listPrice) => {
          const result = computeDiscountRate(listPrice, null);
          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns null when sellingPrice is undefined", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        (listPrice) => {
          const result = computeDiscountRate(listPrice, undefined);
          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("result is always a finite number for valid inputs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        (listPrice, sellingPrice) => {
          const result = computeDiscountRate(listPrice, sellingPrice);
          expect(result).not.toBeNull();
          expect(Number.isNaN(result)).toBe(false);
          expect(Number.isFinite(result)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
