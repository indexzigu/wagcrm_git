/**
 * Property-based tests for Data Entry Pipeline UX.
 *
 * Feature: data-entry-pipeline-ux
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { render } from "@testing-library/react";
import { FloatingActionButton } from "@/components/crm/floating-action-button";
import {
  validateEndDateNotBeforeStart,
  validateTargetSales,
} from "@/components/crm/campaign-side-panel";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** All possible view modes in the pipeline workspace */
const VIEW_MODES = ["kanban", "table", "monthly"] as const;
type ViewMode = (typeof VIEW_MODES)[number];

const viewModeArb: fc.Arbitrary<ViewMode> = fc.constantFrom(...VIEW_MODES);

// ---------------------------------------------------------------------------
// Property 11: FAB visibility is exclusive to kanban view
// Feature: data-entry-pipeline-ux, Property 11: FAB visibility is exclusive to kanban view
// Validates: Requirements 6.4
// ---------------------------------------------------------------------------

describe("Property 11: FAB visibility is exclusive to kanban view", () => {
  /**
   * **Validates: Requirements 6.4**
   *
   * For any view mode (kanban, table, monthly), the Floating_Action_Button
   * SHALL be rendered if and only if the current view mode is "kanban".
   */
  it("FAB is rendered iff viewMode === 'kanban'", () => {
    fc.assert(
      fc.property(viewModeArb, (viewMode) => {
        const visible = viewMode === "kanban";
        const { container } = render(
          <FloatingActionButton onClick={() => {}} visible={visible} />,
        );

        const button = container.querySelector(
          'button[aria-label="새 캠페인 추가"]',
        );

        if (viewMode === "kanban") {
          expect(button).toBeInTheDocument();
        } else {
          expect(button).not.toBeInTheDocument();
        }
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 12: End date must not precede start date
// Feature: data-entry-pipeline-ux, Property 12: End date must not precede start date
// Validates: Requirements 7.3
// ---------------------------------------------------------------------------

/** Generate a date string in YYYY-MM-DD format */
const dateArb: fc.Arbitrary<string> = fc
  .record({
    year: fc.integer({ min: 2020, max: 2030 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }), // Use 28 to avoid invalid dates
  })
  .map(({ year, month, day }) => {
    const m = String(month).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    return `${year}-${m}-${d}`;
  });

/** Generate a pair of dates where end < start (invalid pair) */
const invalidDatePairArb: fc.Arbitrary<{ startDate: string; endDate: string }> = fc
  .tuple(dateArb, dateArb)
  .filter(([a, b]) => a !== b)
  .map(([a, b]) => {
    // Ensure endDate < startDate
    const [earlier, later] = a < b ? [a, b] : [b, a];
    return { startDate: later, endDate: earlier };
  });

describe("Property 12: End date must not precede start date", () => {
  /**
   * **Validates: Requirements 7.3**
   *
   * For any pair of dates where the proposed end date is strictly before
   * the start date, the CampaignSidePanel SHALL reject the change and
   * display a validation error.
   */
  it("rejects end date that precedes start date", () => {
    fc.assert(
      fc.property(invalidDatePairArb, ({ startDate, endDate }) => {
        const error = validateEndDateNotBeforeStart(endDate, startDate);
        expect(error).not.toBeNull();
        expect(error).toBe("마감일은 시작일 이후여야 합니다");
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * For any pair of dates where end >= start, validation should pass (return null).
   */
  it("accepts end date that is on or after start date", () => {
    const validDatePairArb: fc.Arbitrary<{ startDate: string; endDate: string }> = fc
      .tuple(dateArb, dateArb)
      .map(([a, b]) => {
        const [earlier, later] = a <= b ? [a, b] : [b, a];
        return { startDate: earlier, endDate: later };
      });

    fc.assert(
      fc.property(validDatePairArb, ({ startDate, endDate }) => {
        const error = validateEndDateNotBeforeStart(endDate, startDate);
        expect(error).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13: Target sales accepts valid range only
// Feature: data-entry-pipeline-ux, Property 13: Target sales accepts valid range only
// Validates: Requirements 7.4
// ---------------------------------------------------------------------------

describe("Property 13: Target sales accepts valid range only", () => {
  /**
   * **Validates: Requirements 7.4**
   *
   * For any integer value in the range [0, 9,999,999,999], the target sales
   * field SHALL accept it (validation returns null).
   */
  it("accepts values in range 0 to 9,999,999,999", () => {
    const validTargetSalesArb = fc.integer({ min: 0, max: 9_999_999_999 });

    fc.assert(
      fc.property(validTargetSalesArb, (value) => {
        const error = validateTargetSales(value);
        expect(error).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.4**
   *
   * For any integer value below 0, the target sales field SHALL reject it.
   */
  it("rejects negative values", () => {
    const negativeArb = fc.integer({ min: -1_000_000_000, max: -1 });

    fc.assert(
      fc.property(negativeArb, (value) => {
        const error = validateTargetSales(value);
        expect(error).not.toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.4**
   *
   * For any integer value above 9,999,999,999, the target sales field SHALL reject it.
   */
  it("rejects values above 9,999,999,999", () => {
    const tooLargeArb = fc.integer({ min: 10_000_000_000, max: 100_000_000_000 });

    fc.assert(
      fc.property(tooLargeArb, (value) => {
        const error = validateTargetSales(value);
        expect(error).not.toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
