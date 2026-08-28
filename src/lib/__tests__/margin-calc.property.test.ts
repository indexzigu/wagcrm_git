/**
 * Property-based tests for margin-calc net margin rate computation.
 *
 * Feature: ux-fixes-and-field-editing
 * Property 6: Net margin rate auto-calculation
 * Validates: Requirements 10.4
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeNetMarginRate } from "../margin-calc";

// ---------------------------------------------------------------------------
// Property 6: Net margin rate auto-calculation
// Validates: Requirements 10.4
// ---------------------------------------------------------------------------

describe("Property 6: Net margin rate auto-calculation", () => {
  /**
   * **Validates: Requirements 10.4**
   *
   * For any totalMarginRate and sellerMarginRate (both numbers),
   * computeNetMarginRate(totalMarginRate, sellerMarginRate) SHALL equal
   * totalMarginRate - sellerMarginRate.
   */
  it("computeNetMarginRate equals totalMarginRate - sellerMarginRate for any numbers", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
        (totalMarginRate, sellerMarginRate) => {
          const result = computeNetMarginRate(totalMarginRate, sellerMarginRate);
          const expected = totalMarginRate - sellerMarginRate;
          expect(result).toBeCloseTo(expected, 10);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 10.4**
   *
   * When sellerMarginRate is 0, the net margin rate SHALL equal totalMarginRate.
   */
  it("net margin rate equals totalMarginRate when sellerMarginRate is 0", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
        (totalMarginRate) => {
          const result = computeNetMarginRate(totalMarginRate, 0);
          expect(result).toBeCloseTo(totalMarginRate, 10);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 10.4**
   *
   * When totalMarginRate equals sellerMarginRate, the net margin rate SHALL be 0.
   */
  it("net margin rate is 0 when totalMarginRate equals sellerMarginRate", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
        (rate) => {
          const result = computeNetMarginRate(rate, rate);
          expect(result).toBeCloseTo(0, 10);
        }
      ),
      { numRuns: 100 }
    );
  });
});
