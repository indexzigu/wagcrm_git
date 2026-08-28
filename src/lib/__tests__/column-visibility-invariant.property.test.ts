/**
 * Property-based tests for minimum one visible column invariant.
 *
 * Feature: data-entry-pipeline-ux
 * Property 4: Minimum one visible column invariant
 * Validates: Requirements 3.6
 *
 * For any ColumnSettings state where exactly one column has visible: true,
 * attempting to set that column to visible: false SHALL be rejected,
 * preserving at least one visible column at all times.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import type { CampaignStatus } from "../crm-types";
import {
  type ColumnSettings,
  type ColumnState,
  PIPELINE_STAGE_ORDER,
  toggleColumnVisibility,
} from "../column-settings";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a valid CampaignStatus from the pipeline stage order. */
const arbCampaignStatus: fc.Arbitrary<CampaignStatus> = fc.constantFrom(
  ...PIPELINE_STAGE_ORDER,
);

/** Generate a ColumnState (collapsed is arbitrary, visible is controlled separately). */
const arbColumnState = (visible: boolean): fc.Arbitrary<ColumnState> =>
  fc.record({
    collapsed: fc.boolean(),
    visible: fc.constant(visible),
  });

/**
 * Generate ColumnSettings with exactly one visible column.
 * Returns both the settings and the stage that is the sole visible column.
 */
const arbSettingsWithOneVisible: fc.Arbitrary<{
  settings: ColumnSettings;
  visibleStage: CampaignStatus;
}> = arbCampaignStatus.chain((visibleStage) => {
  const entries = PIPELINE_STAGE_ORDER.map((stage) => {
    const isVisible = stage === visibleStage;
    return arbColumnState(isVisible).map(
      (state) => [stage, state] as [CampaignStatus, ColumnState],
    );
  });

  return fc.tuple(...(entries as [fc.Arbitrary<[CampaignStatus, ColumnState]>, ...fc.Arbitrary<[CampaignStatus, ColumnState]>[]])).map(
    (pairs) => ({
      settings: Object.fromEntries(pairs) as unknown as ColumnSettings,
      visibleStage,
    }),
  );
});

// ---------------------------------------------------------------------------
// Property 4: Minimum one visible column invariant
// Validates: Requirements 3.6
// ---------------------------------------------------------------------------

describe("Property 4: Minimum one visible column invariant", () => {
  it("rejects hiding the last visible column", () => {
    fc.assert(
      fc.property(arbSettingsWithOneVisible, ({ settings, visibleStage }) => {
        // Attempt to hide the sole visible column
        const result = toggleColumnVisibility(settings, visibleStage, false);

        // The operation must be rejected (returns null)
        expect(result).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("allows hiding a column when more than one is visible", () => {
    // Generate settings with at least 2 visible columns
    const arbSettingsMultipleVisible = fc
      .tuple(
        fc.constantFrom(...PIPELINE_STAGE_ORDER),
        fc.constantFrom(...PIPELINE_STAGE_ORDER),
      )
      .filter(([a, b]) => a !== b)
      .chain(([stage1, stage2]) => {
        const entries = PIPELINE_STAGE_ORDER.map((stage) => {
          const isVisible = stage === stage1 || stage === stage2;
          return arbColumnState(isVisible).map(
            (state) => [stage, state] as [CampaignStatus, ColumnState],
          );
        });

        return fc
          .tuple(...(entries as [fc.Arbitrary<[CampaignStatus, ColumnState]>, ...fc.Arbitrary<[CampaignStatus, ColumnState]>[]])) 
          .map((pairs) => ({
            settings: Object.fromEntries(pairs) as unknown as ColumnSettings,
            stageToHide: stage1,
          }));
      });

    fc.assert(
      fc.property(arbSettingsMultipleVisible, ({ settings, stageToHide }) => {
        // Attempt to hide one of the visible columns (there are at least 2)
        const result = toggleColumnVisibility(settings, stageToHide, false);

        // The operation must succeed (returns new settings)
        expect(result).not.toBeNull();
        expect(result![stageToHide].visible).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("always preserves at least one visible column after any toggle operation", () => {
    // Generate arbitrary ColumnSettings (at least 1 visible to be valid)
    const arbValidSettings = fc
      .tuple(
        ...PIPELINE_STAGE_ORDER.map(() =>
          fc.record({ collapsed: fc.boolean(), visible: fc.boolean() }),
        ),
      )
      .filter((states) => states.some((s) => s.visible))
      .map((states) => {
        const settings = {} as Record<string, ColumnState>;
        PIPELINE_STAGE_ORDER.forEach((stage, i) => {
          settings[stage] = states[i];
        });
        return settings as unknown as ColumnSettings;
      });

    fc.assert(
      fc.property(
        arbValidSettings,
        arbCampaignStatus,
        (settings, stage) => {
          // Attempt to hide the column
          const result = toggleColumnVisibility(settings, stage, false);

          if (result !== null) {
            // If accepted, at least one column must still be visible
            const visibleCount = PIPELINE_STAGE_ORDER.filter(
              (s) => result[s].visible,
            ).length;
            expect(visibleCount).toBeGreaterThanOrEqual(1);
          }
          // If rejected (null), the original settings are unchanged (invariant preserved)
        },
      ),
      { numRuns: 100 },
    );
  });
});
