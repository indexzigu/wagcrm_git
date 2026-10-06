// @vitest-environment jsdom
/**
 * Property-based tests for zone-settings.ts
 *
 * Feature: pipeline-zone-views
 *
 * Property 3: Invalid view preference defaults to VIEW_B
 * Validates: Requirements 1.5
 *
 * Property 9: Filters apply consistently across view modes
 * Validates: Requirements 7.1, 7.2, 7.3
 *
 * Property 10: View switch preserves filter state round-trip
 * Validates: Requirements 7.6, 7.7
 *
 * Property 11: View preference persistence round-trip
 * Validates: Requirements 1.4
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";

import {
  isValidZoneViewMode,
  loadZoneViewMode,
  saveZoneViewMode,
  type ZoneViewMode,
} from "../zone-settings";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Arbitrary valid ZoneViewMode. */
const arbZoneViewMode: fc.Arbitrary<ZoneViewMode> = fc.constantFrom("VIEW_B", "VIEW_C");

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
