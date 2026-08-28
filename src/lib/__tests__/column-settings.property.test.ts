// @vitest-environment jsdom
/**
 * Property-based tests for ColumnSettings localStorage utilities.
 *
 * Feature: data-entry-pipeline-ux
 * Property 5: Column visibility localStorage round-trip
 * Validates: Requirements 3.7
 *
 * For any valid ColumnSettings object, serializing it to localStorage via
 * saveColumnSettings() and deserializing it back via loadColumnSettings()
 * produces an equivalent ColumnSettings object.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";

import {
  loadColumnSettings,
  saveColumnSettings,
  PIPELINE_STAGE_ORDER,
  type ColumnSettings,
  type ColumnState,
} from "../column-settings";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generates an arbitrary ColumnState (collapsed + visible booleans). */
const columnStateArb: fc.Arbitrary<ColumnState> = fc.record({
  collapsed: fc.boolean(),
  visible: fc.boolean(),
});

/** Generates an arbitrary valid ColumnSettings object with all pipeline stages. */
const columnSettingsArb: fc.Arbitrary<ColumnSettings> = fc
  .tuple(...PIPELINE_STAGE_ORDER.map(() => columnStateArb))
  .map((states) => {
    const settings = {} as Record<string, ColumnState>;
    PIPELINE_STAGE_ORDER.forEach((status, i) => {
      settings[status] = states[i];
    });
    return settings as ColumnSettings;
  });

// ---------------------------------------------------------------------------
// Property 5: Column visibility localStorage round-trip
// Validates: Requirements 3.7
// ---------------------------------------------------------------------------

describe("Property 5: Column visibility localStorage round-trip", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("saveColumnSettings then loadColumnSettings produces equivalent ColumnSettings", () => {
    fc.assert(
      fc.property(columnSettingsArb, (settings) => {
        saveColumnSettings(settings);
        const loaded = loadColumnSettings();

        for (const status of PIPELINE_STAGE_ORDER) {
          expect(loaded[status].collapsed).toBe(settings[status].collapsed);
          expect(loaded[status].visible).toBe(settings[status].visible);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("round-trip preserves deep equality for any valid ColumnSettings", () => {
    fc.assert(
      fc.property(columnSettingsArb, (settings) => {
        saveColumnSettings(settings);
        const loaded = loadColumnSettings();

        expect(loaded).toEqual(settings);
      }),
      { numRuns: 100 },
    );
  });
});
