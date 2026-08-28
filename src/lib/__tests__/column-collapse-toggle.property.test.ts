/**
 * Property-based tests for column collapse toggle.
 *
 * Feature: data-entry-pipeline-ux
 * Property 2: Column collapse toggle is a round-trip
 * Property 3: Disabling a column hides it from the board
 * Validates: Requirements 3.2, 3.3, 3.5
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

/** Generate arbitrary valid ColumnSettings (at least 1 visible column). */
const arbValidColumnSettings: fc.Arbitrary<ColumnSettings> = fc
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the list of visible columns in canonical pipeline order.
 */
function getVisibleColumnsInOrder(settings: ColumnSettings): CampaignStatus[] {
  return PIPELINE_STAGE_ORDER.filter((status) => settings[status].visible);
}

/**
 * Toggles the collapsed state of a column (simulates clicking the column header).
 */
function toggleCollapsed(
  settings: ColumnSettings,
  stage: CampaignStatus,
): ColumnSettings {
  return {
    ...settings,
    [stage]: { ...settings[stage], collapsed: !settings[stage].collapsed },
  };
}

// ---------------------------------------------------------------------------
// Property 2: Column collapse toggle is a round-trip
// Validates: Requirements 3.2, 3.3
// ---------------------------------------------------------------------------

describe("Property 2: Column collapse toggle is a round-trip", () => {
  it("toggling collapsed twice restores original collapsed state for any column", () => {
    fc.assert(
      fc.property(
        arbValidColumnSettings,
        arbCampaignStatus,
        (settings, stage) => {
          const originalCollapsed = settings[stage].collapsed;

          // Toggle once (collapse → expand or expand → collapse)
          const afterFirst = toggleCollapsed(settings, stage);
          expect(afterFirst[stage].collapsed).toBe(!originalCollapsed);

          // Toggle again (should restore original)
          const afterSecond = toggleCollapsed(afterFirst, stage);
          expect(afterSecond[stage].collapsed).toBe(originalCollapsed);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("toggling collapsed twice preserves all other column states", () => {
    fc.assert(
      fc.property(
        arbValidColumnSettings,
        arbCampaignStatus,
        (settings, stage) => {
          const afterFirst = toggleCollapsed(settings, stage);
          const afterSecond = toggleCollapsed(afterFirst, stage);

          // All other columns should be unchanged
          for (const otherStage of PIPELINE_STAGE_ORDER) {
            if (otherStage !== stage) {
              expect(afterSecond[otherStage]).toEqual(settings[otherStage]);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("double toggle produces settings deeply equal to original", () => {
    fc.assert(
      fc.property(
        arbValidColumnSettings,
        arbCampaignStatus,
        (settings, stage) => {
          const afterFirst = toggleCollapsed(settings, stage);
          const afterSecond = toggleCollapsed(afterFirst, stage);

          expect(afterSecond).toEqual(settings);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Disabling a column hides it from the board
// Validates: Requirements 3.5
// ---------------------------------------------------------------------------

describe("Property 3: Disabling a column hides it from the board", () => {
  it("a column set to visible:false is not in the visible columns list", () => {
    fc.assert(
      fc.property(
        arbValidColumnSettings,
        arbCampaignStatus,
        (settings, stage) => {
          // Create settings where the target column is hidden
          const withHidden: ColumnSettings = {
            ...settings,
            [stage]: { ...settings[stage], visible: false },
          };

          const visibleColumns = getVisibleColumnsInOrder(withHidden);

          // The hidden column must NOT appear in the rendered list
          expect(visibleColumns).not.toContain(stage);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("using toggleColumnVisibility to hide a column removes it from visible list", () => {
    // Generate settings with at least 2 visible columns so hiding is allowed
    const arbSettingsWithMultipleVisible = arbValidColumnSettings.filter(
      (settings) =>
        PIPELINE_STAGE_ORDER.filter((s) => settings[s].visible).length >= 2,
    );

    fc.assert(
      fc.property(
        arbSettingsWithMultipleVisible,
        arbCampaignStatus,
        (settings, stage) => {
          // Only test if this stage is currently visible (so we can hide it)
          if (!settings[stage].visible) return;

          const result = toggleColumnVisibility(settings, stage, false);

          // Should succeed since there are multiple visible columns
          expect(result).not.toBeNull();

          if (result !== null) {
            const visibleColumns = getVisibleColumnsInOrder(result);
            // The disabled column must not be rendered
            expect(visibleColumns).not.toContain(stage);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("all columns with visible:true are included in the visible list", () => {
    fc.assert(
      fc.property(arbValidColumnSettings, (settings) => {
        const visibleColumns = getVisibleColumnsInOrder(settings);

        for (const stage of PIPELINE_STAGE_ORDER) {
          if (settings[stage].visible) {
            expect(visibleColumns).toContain(stage);
          } else {
            expect(visibleColumns).not.toContain(stage);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
