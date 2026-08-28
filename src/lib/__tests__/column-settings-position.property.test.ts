/**
 * Property-based tests for column re-enable position.
 *
 * Feature: data-entry-pipeline-ux
 * Property 6: Re-enabled column position matches pipeline order
 * Validates: Requirements 3.8
 *
 * Tests that when a hidden column is re-enabled, the visible columns
 * maintain the canonical pipeline stage order (PROPOSAL → PREPARATION →
 * ACTIVE → CLOSED → SETTLEMENT_WAIT → COMPLETED).
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import {
  type ColumnSettings,
  type ColumnState,
  PIPELINE_STAGE_ORDER,
} from "../column-settings";
import type { CampaignStatus } from "../crm-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Given ColumnSettings, returns the visible columns in the order they appear
 * according to PIPELINE_STAGE_ORDER (canonical order).
 */
function getVisibleColumnsInOrder(settings: ColumnSettings): CampaignStatus[] {
  return PIPELINE_STAGE_ORDER.filter((status) => settings[status].visible);
}

/**
 * Checks that an array of CampaignStatus values is in canonical pipeline order.
 * i.e., for every pair (a, b) where a appears before b in the array,
 * a's index in PIPELINE_STAGE_ORDER is less than b's index.
 */
function isInCanonicalOrder(columns: CampaignStatus[]): boolean {
  for (let i = 0; i < columns.length - 1; i++) {
    const idxA = PIPELINE_STAGE_ORDER.indexOf(columns[i]);
    const idxB = PIPELINE_STAGE_ORDER.indexOf(columns[i + 1]);
    if (idxA >= idxB) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generates a valid ColumnState. */
const columnStateArb: fc.Arbitrary<ColumnState> = fc.record({
  collapsed: fc.boolean(),
  visible: fc.boolean(),
});

/**
 * Generates a ColumnSettings where at least one column is hidden and at least
 * one column is visible (so we can re-enable a hidden column).
 */
const columnSettingsWithHiddenArb: fc.Arbitrary<ColumnSettings> = fc
  .record({
    PROPOSAL: columnStateArb,
    PREPARATION: columnStateArb,
    ACTIVE: columnStateArb,
    CLOSED: columnStateArb,
    SETTLEMENT_WAIT: columnStateArb,
    SETTLEMENT_IN_PROGRESS: columnStateArb,
    COMPLETED: columnStateArb,
    DROPPED: columnStateArb,
  })
  .filter((settings) => {
    const visibleCount = PIPELINE_STAGE_ORDER.filter(
      (s) => settings[s].visible,
    ).length;
    const hiddenCount = PIPELINE_STAGE_ORDER.length - visibleCount;
    // Need at least 1 visible and at least 1 hidden
    return visibleCount >= 1 && hiddenCount >= 1;
  });

// ---------------------------------------------------------------------------
// Property 6: Re-enabled column position matches pipeline order
// Validates: Requirements 3.8
// ---------------------------------------------------------------------------

describe("Property 6: Re-enabled column position matches pipeline order", () => {
  it("re-enabling a hidden column preserves canonical pipeline stage order among visible columns", () => {
    fc.assert(
      fc.property(columnSettingsWithHiddenArb, (settings) => {
        // Find all hidden columns
        const hiddenColumns = PIPELINE_STAGE_ORDER.filter(
          (status) => !settings[status].visible,
        );

        // Pick one hidden column to re-enable (use the first for determinism)
        const columnToReEnable = hiddenColumns[0];

        // Re-enable the column
        const updatedSettings: ColumnSettings = {
          ...settings,
          [columnToReEnable]: {
            ...settings[columnToReEnable],
            visible: true,
          },
        };

        // Get visible columns after re-enabling
        const visibleAfter = getVisibleColumnsInOrder(updatedSettings);

        // Assert the re-enabled column is now visible
        expect(visibleAfter).toContain(columnToReEnable);

        // Assert all visible columns are in canonical pipeline order
        expect(isInCanonicalOrder(visibleAfter)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("re-enabling any hidden column always results in correct relative position", () => {
    fc.assert(
      fc.property(
        columnSettingsWithHiddenArb,
        fc.nat(),
        (settings, pickIndex) => {
          // Find all hidden columns
          const hiddenColumns = PIPELINE_STAGE_ORDER.filter(
            (status) => !settings[status].visible,
          );

          // Pick a random hidden column using the generated index
          const columnToReEnable =
            hiddenColumns[pickIndex % hiddenColumns.length];

          // Re-enable the column
          const updatedSettings: ColumnSettings = {
            ...settings,
            [columnToReEnable]: {
              ...settings[columnToReEnable],
              visible: true,
            },
          };

          // Get visible columns after re-enabling
          const visibleAfter = getVisibleColumnsInOrder(updatedSettings);

          // The re-enabled column's position in the visible list should match
          // its relative position in the canonical order
          const canonicalIndex = PIPELINE_STAGE_ORDER.indexOf(columnToReEnable);
          const positionInVisible = visibleAfter.indexOf(columnToReEnable);

          // All columns before it in the visible list should have a lower canonical index
          for (let i = 0; i < positionInVisible; i++) {
            const precedingCanonicalIndex = PIPELINE_STAGE_ORDER.indexOf(
              visibleAfter[i],
            );
            expect(precedingCanonicalIndex).toBeLessThan(canonicalIndex);
          }

          // All columns after it in the visible list should have a higher canonical index
          for (let i = positionInVisible + 1; i < visibleAfter.length; i++) {
            const followingCanonicalIndex = PIPELINE_STAGE_ORDER.indexOf(
              visibleAfter[i],
            );
            expect(followingCanonicalIndex).toBeGreaterThan(canonicalIndex);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
