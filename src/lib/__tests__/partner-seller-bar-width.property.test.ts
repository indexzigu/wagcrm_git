/**
 * Property-based tests for follower bar width calculation.
 *
 * Feature: partner-seller-ux-revamp
 * Property 13: 팔로워 막대그래프 너비 계산
 * Validates: Requirements 14.2, 14.3, 14.4, 14.6
 *
 * For any 0 이상의 정수 팔로워 수에 대해, 막대 너비는 (팔로워 수 ÷ 300,000) × 100%로 계산하되,
 * 팔로워 수가 1 이상이면 최소 1%, 300,000 초과이면 최대 100%, 0이면 0%여야 한다.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { calculateBarWidth } from "../partner-seller-display";

// ---------------------------------------------------------------------------
// Feature: partner-seller-ux-revamp, Property 13: 팔로워 막대그래프 너비 계산
// Validates: Requirements 14.2, 14.3, 14.4, 14.6
// ---------------------------------------------------------------------------

describe("Feature: partner-seller-ux-revamp, Property 13: 팔로워 막대그래프 너비 계산", () => {
  it("returns 0% when count is 0", () => {
    /**
     * **Validates: Requirements 14.6**
     * 팔로워 수가 0이면 막대그래프 너비를 0%로 표시한다.
     */
    expect(calculateBarWidth(0)).toBe(0);
  });

  it("returns minimum 1% for any count >= 1 and <= 3000 (where raw calculation < 1%)", () => {
    /**
     * **Validates: Requirements 14.3**
     * 팔로워 수가 1 이상일 때 최소 너비를 1%로 설정한다.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2999 }),
        (count) => {
          const result = calculateBarWidth(count);
          // Raw calculation would be < 1%, so minimum 1% should apply
          expect(result).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("calculates width as (count / 300000) * 100 clamped between 1 and 100 for any positive count", () => {
    /**
     * **Validates: Requirements 14.2, 14.3, 14.4**
     * 막대 너비는 (팔로워 수 ÷ 300,000) × 100% 비율로 계산하되,
     * 최소 1%, 최대 100%로 클램핑한다.
     */
    fc.assert(
      fc.property(
        fc.nat({ max: 1000000 }).filter((n) => n >= 1),
        (count) => {
          const result = calculateBarWidth(count);
          const rawWidth = (count / 300000) * 100;
          const expected = Math.max(1, Math.min(100, rawWidth));
          expect(result).toBeCloseTo(expected, 5);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("caps at 100% for any count exceeding 300,000", () => {
    /**
     * **Validates: Requirements 14.4**
     * 팔로워 수가 300,000을 초과하면 막대그래프를 최대 너비(100%)로 표시한다.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 300001, max: 1000000 }),
        (count) => {
          const result = calculateBarWidth(count);
          expect(result).toBe(100);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("result is always between 0 and 100 inclusive for any non-negative count", () => {
    /**
     * **Validates: Requirements 14.2, 14.3, 14.4, 14.6**
     * 결과는 항상 0% 이상 100% 이하의 범위 내에 있어야 한다.
     */
    fc.assert(
      fc.property(
        fc.nat({ max: 1000000 }),
        (count) => {
          const result = calculateBarWidth(count);
          expect(result).toBeGreaterThanOrEqual(0);
          expect(result).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns exactly 100% for count equal to 300,000", () => {
    /**
     * **Validates: Requirements 14.2**
     * 300,000 팔로워 기준 100%로 설정한다.
     */
    expect(calculateBarWidth(300000)).toBe(100);
  });
});
