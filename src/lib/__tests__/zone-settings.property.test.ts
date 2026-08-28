/**
 * Property-based tests for zone-settings.ts
 *
 * Feature: pipeline-zone-views
 *
 * Property 3: Invalid view preference defaults to VIEW_B
 * Validates: Requirements 1.5
 *
 * Property 5: At least one zone must remain expanded
 * Validates: Requirements 3.8
 *
 * Property 9: Filters apply consistently across view modes
 * Validates: Requirements 7.1, 7.2, 7.3
 *
 * Property 10: View switch preserves filter state round-trip
 * Validates: Requirements 7.6, 7.7
 *
 * Property 11: View preference persistence round-trip
 * Validates: Requirements 1.4
 *
 * Property 12: Zone collapse state persistence round-trip
 * Validates: Requirements 3.5
 *
 * Property 13: Zone collapse toggle is idempotent for expansion
 * Validates: Requirements 3.3, 3.4
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";

import { ZONE_ORDER, type PipelineZone } from "../zone-config";
import {
  isValidZoneViewMode,
  isValidZoneCollapseState,
  loadZoneViewMode,
  saveZoneViewMode,
  loadZoneCollapseState,
  saveZoneCollapseState,
  toggleZoneCollapse,
  DEFAULT_ZONE_COLLAPSE_STATE,
  type ZoneViewMode,
  type ZoneCollapseState,
} from "../zone-settings";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Arbitrary valid ZoneViewMode. */
const arbZoneViewMode: fc.Arbitrary<ZoneViewMode> = fc.constantFrom("VIEW_B", "VIEW_C");

/** Arbitrary PipelineZone. */
const arbPipelineZone: fc.Arbitrary<PipelineZone> = fc.constantFrom(...ZONE_ORDER);

/** Arbitrary valid ZoneCollapseState (at least one zone expanded). */
const arbZoneCollapseState: fc.Arbitrary<ZoneCollapseState> = fc
  .record({
    SALES: fc.boolean(),
    DEAL_EXECUTION: fc.boolean(),
    SETTLEMENT: fc.boolean(),
  })
  .filter((state) => {
    // At least one zone must be expanded (true)
    return Object.values(state).some((v) => v);
  }) as fc.Arbitrary<ZoneCollapseState>;

/** Arbitrary string that is NOT a valid ZoneViewMode. */
const arbInvalidViewMode: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 30 })
  .filter((s) => s !== "VIEW_B" && s !== "VIEW_C");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Property 3: Invalid view preference defaults to VIEW_B
// **Validates: Requirements 1.5**
// ---------------------------------------------------------------------------

describe("Property 3: Invalid view preference defaults to VIEW_B", () => {
  it("isValidZoneViewMode returns false for any string that is not VIEW_B or VIEW_C", () => {
    fc.assert(
      fc.property(arbInvalidViewMode, (value) => {
        expect(isValidZoneViewMode(value)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("isValidZoneViewMode returns false for non-string types", () => {
    const arbNonString = fc.oneof(
      fc.integer(),
      fc.constant(null),
      fc.constant(undefined),
      fc.boolean(),
      fc.array(fc.string()),
      fc.dictionary(fc.string(), fc.string()),
    );

    fc.assert(
      fc.property(arbNonString, (value) => {
        expect(isValidZoneViewMode(value)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("loadZoneViewMode returns VIEW_B when localStorage contains invalid value", () => {
    fc.assert(
      fc.property(arbInvalidViewMode, (invalidValue) => {
        localStorage.setItem("wag-crm:zone-view-mode", invalidValue);
        expect(loadZoneViewMode()).toBe("VIEW_B");
      }),
      { numRuns: 100 },
    );
  });

  it("loadZoneViewMode returns VIEW_B when localStorage key is missing", () => {
    localStorage.removeItem("wag-crm:zone-view-mode");
    expect(loadZoneViewMode()).toBe("VIEW_B");
  });
});

// ---------------------------------------------------------------------------
// Property 5: At least one zone must remain expanded
// **Validates: Requirements 3.8**
// ---------------------------------------------------------------------------

describe("Property 5: At least one zone must remain expanded", () => {
  it("toggleZoneCollapse blocks collapsing the last expanded zone", () => {
    fc.assert(
      fc.property(arbPipelineZone, (singleExpandedZone) => {
        // Create a state where only one zone is expanded
        const state: ZoneCollapseState = {
          SALES: false,
          DEAL_EXECUTION: false,
          SETTLEMENT: false,
        };
        state[singleExpandedZone] = true;

        // Trying to collapse the only expanded zone should return the same state
        const result = toggleZoneCollapse(state, singleExpandedZone);
        expect(result).toEqual(state);
      }),
      { numRuns: 100 },
    );
  });

  it("toggleZoneCollapse always produces a state with at least one expanded zone", () => {
    fc.assert(
      fc.property(arbZoneCollapseState, arbPipelineZone, (state, zone) => {
        const result = toggleZoneCollapse(state, zone);
        const expandedCount = ZONE_ORDER.filter((z) => result[z]).length;
        expect(expandedCount).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });

  it("toggleZoneCollapse allows collapsing when multiple zones are expanded", () => {
    fc.assert(
      fc.property(
        arbZoneCollapseState,
        arbPipelineZone,
        (state, zone) => {
          const expandedCount = ZONE_ORDER.filter((z) => state[z]).length;
          // Only test when zone is expanded and there are multiple expanded zones
          fc.pre(state[zone] === true && expandedCount > 1);

          const result = toggleZoneCollapse(state, zone);
          // The zone should now be collapsed
          expect(result[zone]).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Filters apply consistently across view modes
// **Validates: Requirements 7.1, 7.2, 7.3**
// ---------------------------------------------------------------------------

describe("Property 9: Filters apply consistently across view modes", () => {
  /**
   * This property validates that the zone-settings module does not interfere
   * with filter state. The view mode is independent of filter application —
   * filters are applied at a higher level. We verify that loading/saving
   * view mode does not corrupt or affect other localStorage keys.
   */
  it("saving view mode does not affect other localStorage keys", () => {
    fc.assert(
      fc.property(
        arbZoneViewMode,
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (viewMode, filterKey, filterValue) => {
          // Simulate a filter stored in localStorage
          const fullKey = `wag-crm:filter-${filterKey}`;
          localStorage.setItem(fullKey, filterValue);

          // Save view mode
          saveZoneViewMode(viewMode);

          // Filter value should be unchanged
          expect(localStorage.getItem(fullKey)).toBe(filterValue);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("saving zone collapse state does not affect other localStorage keys", () => {
    fc.assert(
      fc.property(
        arbZoneCollapseState,
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (collapseState, filterKey, filterValue) => {
          const fullKey = `wag-crm:filter-${filterKey}`;
          localStorage.setItem(fullKey, filterValue);

          saveZoneCollapseState(collapseState);

          expect(localStorage.getItem(fullKey)).toBe(filterValue);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: View switch preserves filter state round-trip
// **Validates: Requirements 7.6, 7.7**
// ---------------------------------------------------------------------------

describe("Property 10: View switch preserves filter state round-trip", () => {
  it("switching from VIEW_B to VIEW_C and back preserves all localStorage filter keys", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            key: fc.string({ minLength: 1, maxLength: 20 }),
            value: fc.string({ minLength: 1, maxLength: 50 }),
          }),
          {
            minLength: 1,
            maxLength: 10,
            selector: (entry) => entry.key,
          },
        ),
        (filters) => {
          // Set up filter state
          const filterEntries = filters.map((f) => ({
            key: `wag-crm:filter-${f.key}`,
            value: f.value,
          }));
          for (const entry of filterEntries) {
            localStorage.setItem(entry.key, entry.value);
          }

          // Switch VIEW_B → VIEW_C → VIEW_B
          saveZoneViewMode("VIEW_B");
          saveZoneViewMode("VIEW_C");
          saveZoneViewMode("VIEW_B");

          // All filter values should be preserved
          for (const entry of filterEntries) {
            expect(localStorage.getItem(entry.key)).toBe(entry.value);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("view mode round-trip preserves the final mode value", () => {
    fc.assert(
      fc.property(arbZoneViewMode, arbZoneViewMode, (first, second) => {
        saveZoneViewMode(first);
        saveZoneViewMode(second);
        expect(loadZoneViewMode()).toBe(second);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: View preference persistence round-trip
// **Validates: Requirements 1.4**
// ---------------------------------------------------------------------------

describe("Property 11: View preference persistence round-trip", () => {
  it("saveZoneViewMode followed by loadZoneViewMode returns the same value", () => {
    fc.assert(
      fc.property(arbZoneViewMode, (mode) => {
        saveZoneViewMode(mode);
        expect(loadZoneViewMode()).toBe(mode);
      }),
      { numRuns: 100 },
    );
  });

  it("isValidZoneViewMode returns true for all valid ZoneViewMode values", () => {
    fc.assert(
      fc.property(arbZoneViewMode, (mode) => {
        expect(isValidZoneViewMode(mode)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12: Zone collapse state persistence round-trip
// **Validates: Requirements 3.5**
// ---------------------------------------------------------------------------

describe("Property 12: Zone collapse state persistence round-trip", () => {
  it("saveZoneCollapseState followed by loadZoneCollapseState returns equivalent state", () => {
    fc.assert(
      fc.property(arbZoneCollapseState, (state) => {
        saveZoneCollapseState(state);
        const loaded = loadZoneCollapseState();
        expect(loaded).toEqual(state);
      }),
      { numRuns: 100 },
    );
  });

  it("isValidZoneCollapseState returns true for any valid ZoneCollapseState", () => {
    // Valid states include those with all zones collapsed (validation doesn't enforce expansion)
    const arbAnyCollapseState = fc.record({
      SALES: fc.boolean(),
      DEAL_EXECUTION: fc.boolean(),
      SETTLEMENT: fc.boolean(),
    });

    fc.assert(
      fc.property(arbAnyCollapseState, (state) => {
        expect(isValidZoneCollapseState(state)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("isValidZoneCollapseState returns false for invalid structures", () => {
    const arbInvalidState = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant("string"),
      fc.constant(42),
      fc.constant([]),
      fc.constant({ SALES: true }), // missing keys
      fc.constant({ SALES: "yes", DEAL_EXECUTION: true, SETTLEMENT: false }), // wrong type
    );

    fc.assert(
      fc.property(arbInvalidState, (value) => {
        expect(isValidZoneCollapseState(value)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("loadZoneCollapseState returns default when localStorage contains invalid JSON", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => {
          try {
            JSON.parse(s);
            return false; // valid JSON, skip
          } catch {
            return true; // invalid JSON, keep
          }
        }),
        (invalidJson) => {
          localStorage.setItem("wag-crm:zone-collapse-state", invalidJson);
          expect(loadZoneCollapseState()).toEqual(DEFAULT_ZONE_COLLAPSE_STATE);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13: Zone collapse toggle is idempotent for expansion
// **Validates: Requirements 3.3, 3.4**
// ---------------------------------------------------------------------------

describe("Property 13: Zone collapse toggle is idempotent for expansion", () => {
  it("toggling a collapsed zone expands it", () => {
    fc.assert(
      fc.property(arbZoneCollapseState, arbPipelineZone, (state, zone) => {
        // Only test when zone is currently collapsed
        fc.pre(state[zone] === false);

        const result = toggleZoneCollapse(state, zone);
        expect(result[zone]).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("toggling an expanded zone collapses it (unless last expanded)", () => {
    fc.assert(
      fc.property(arbZoneCollapseState, arbPipelineZone, (state, zone) => {
        fc.pre(state[zone] === true);

        const expandedCount = ZONE_ORDER.filter((z) => state[z]).length;
        const result = toggleZoneCollapse(state, zone);

        if (expandedCount > 1) {
          // Should collapse
          expect(result[zone]).toBe(false);
        } else {
          // Should block (last expanded)
          expect(result[zone]).toBe(true);
          expect(result).toEqual(state);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("expanding an already-expanded zone via double toggle returns to expanded (round-trip)", () => {
    fc.assert(
      fc.property(arbZoneCollapseState, arbPipelineZone, (state, zone) => {
        // Only test when zone is collapsed (so first toggle expands it)
        fc.pre(state[zone] === false);

        // First toggle: expand
        const afterExpand = toggleZoneCollapse(state, zone);
        expect(afterExpand[zone]).toBe(true);

        // Second toggle: collapse (only if not last expanded)
        const expandedAfterFirst = ZONE_ORDER.filter((z) => afterExpand[z]).length;
        const afterSecondToggle = toggleZoneCollapse(afterExpand, zone);

        if (expandedAfterFirst > 1) {
          // Should collapse back
          expect(afterSecondToggle[zone]).toBe(false);
        } else {
          // Blocked — stays expanded
          expect(afterSecondToggle[zone]).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("toggle does not affect other zones", () => {
    fc.assert(
      fc.property(arbZoneCollapseState, arbPipelineZone, (state, zone) => {
        const result = toggleZoneCollapse(state, zone);

        // Other zones should remain unchanged
        for (const otherZone of ZONE_ORDER) {
          if (otherZone !== zone) {
            expect(result[otherZone]).toBe(state[otherZone]);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
