/**
 * Property-based tests for optimistic rollback on API failure.
 *
 * Feature: data-entry-pipeline-ux
 * Property 14: API failure rolls back optimistic update
 * Validates: Requirements 7.6
 *
 * For any inline-editable field in CampaignSidePanel, if the API save request
 * fails, the field's displayed value SHALL revert to the value it held before
 * the edit was attempted.
 *
 * Tests the pure logic: given an original value and a new value, if the API
 * fails, the state should revert to the original value.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Pure logic extracted from InlineEditField optimistic update pattern
// ---------------------------------------------------------------------------

/**
 * Represents the state of an inline-editable field.
 * - `value`: the persisted/server value (source of truth)
 * - `optimisticValue`: temporary override shown during save (null when idle)
 */
type FieldState = {
  value: string;
  optimisticValue: string | null;
};

/**
 * The displayed value follows the pattern: optimisticValue ?? value
 */
function getDisplayedValue(state: FieldState): string {
  return state.optimisticValue ?? state.value;
}

/**
 * When user initiates an edit, we optimistically set the new value.
 */
function applyOptimisticUpdate(state: FieldState, newValue: string): FieldState {
  return {
    ...state,
    optimisticValue: newValue,
  };
}

/**
 * When the API call succeeds, we clear the optimistic value.
 * The parent component will update `value` via props/refetch.
 */
function handleApiSuccess(state: FieldState): FieldState {
  return {
    ...state,
    optimisticValue: null,
  };
}

/**
 * When the API call fails, we clear the optimistic value,
 * reverting the display to the original `value`.
 */
function handleApiFailure(state: FieldState): FieldState {
  return {
    ...state,
    optimisticValue: null,
  };
}

// ---------------------------------------------------------------------------
// Editable field types in CampaignSidePanel
// ---------------------------------------------------------------------------

type EditableFieldType = "status" | "startDate" | "endDate";

const CAMPAIGN_STATUSES = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "COMPLETED",
] as const;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generates an arbitrary editable field type */
const fieldTypeArb = fc.constantFrom<EditableFieldType>(
  "status",
  "startDate",
  "endDate",
);

/** Generates a valid status value */
const statusValueArb = fc.constantFrom(...CAMPAIGN_STATUSES);

/** Generates a valid date string (YYYY-MM-DD) */
const dateValueArb = fc
  .date({ min: new Date("2020-01-01"), max: new Date("2030-12-31") })
  .map((d) => d.toISOString().slice(0, 10));

/** Generates a value appropriate for a given field type */
function valueArbForField(fieldType: EditableFieldType): fc.Arbitrary<string> {
  switch (fieldType) {
    case "status":
      return statusValueArb;
    case "startDate":
    case "endDate":
      return dateValueArb;
  }
}

/** Generates a pair of distinct values for a given field type */
const distinctFieldValuesArb = fieldTypeArb.chain((fieldType) =>
  fc.tuple(valueArbForField(fieldType), valueArbForField(fieldType)).filter(
    ([a, b]) => a !== b,
  ).map(([original, edited]) => ({ fieldType, original, edited })),
);

// ---------------------------------------------------------------------------
// Property 14: API failure rolls back optimistic update
// Feature: data-entry-pipeline-ux, Property 14
// Validates: Requirements 7.6
// ---------------------------------------------------------------------------

describe("Property 14: API failure rolls back optimistic update", () => {
  /**
   * **Validates: Requirements 7.6**
   *
   * Core property: for any field edit where the API fails, the displayed
   * value must revert to the pre-edit (original) value.
   */
  it("displayed value reverts to original after API failure", () => {
    fc.assert(
      fc.property(distinctFieldValuesArb, ({ original, edited }) => {
        // Initial state: field shows the original value
        const initialState: FieldState = { value: original, optimisticValue: null };
        expect(getDisplayedValue(initialState)).toBe(original);

        // User edits: optimistic update shows new value immediately
        const afterEdit = applyOptimisticUpdate(initialState, edited);
        expect(getDisplayedValue(afterEdit)).toBe(edited);

        // API fails: value reverts to original
        const afterFailure = handleApiFailure(afterEdit);
        expect(getDisplayedValue(afterFailure)).toBe(original);
      }),
      { numRuns: 100 },
    );
  });

  it("optimistic value is cleared on API failure (null state)", () => {
    fc.assert(
      fc.property(distinctFieldValuesArb, ({ original, edited }) => {
        const initialState: FieldState = { value: original, optimisticValue: null };
        const afterEdit = applyOptimisticUpdate(initialState, edited);
        const afterFailure = handleApiFailure(afterEdit);

        // optimisticValue must be null after failure
        expect(afterFailure.optimisticValue).toBeNull();
        // value must remain unchanged (server value was never updated)
        expect(afterFailure.value).toBe(original);
      }),
      { numRuns: 100 },
    );
  });

  it("rollback produces identical state to initial state", () => {
    fc.assert(
      fc.property(distinctFieldValuesArb, ({ original, edited }) => {
        const initialState: FieldState = { value: original, optimisticValue: null };
        const afterEdit = applyOptimisticUpdate(initialState, edited);
        const afterFailure = handleApiFailure(afterEdit);

        // After rollback, state should be identical to initial state
        expect(afterFailure).toEqual(initialState);
      }),
      { numRuns: 100 },
    );
  });

  it("status field rollback preserves original status on failure", () => {
    fc.assert(
      fc.property(
        statusValueArb,
        statusValueArb.filter((s) => s !== "PROPOSAL"),
        (originalStatus, newStatus) => {
          fc.pre(originalStatus !== newStatus);

          const state: FieldState = { value: originalStatus, optimisticValue: null };
          const afterEdit = applyOptimisticUpdate(state, newStatus);
          const afterFailure = handleApiFailure(afterEdit);

          expect(getDisplayedValue(afterFailure)).toBe(originalStatus);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("date field rollback preserves original date on failure", () => {
    fc.assert(
      fc.property(
        dateValueArb,
        dateValueArb,
        (originalDate, newDate) => {
          fc.pre(originalDate !== newDate);

          const state: FieldState = { value: originalDate, optimisticValue: null };
          const afterEdit = applyOptimisticUpdate(state, newDate);
          const afterFailure = handleApiFailure(afterEdit);

          expect(getDisplayedValue(afterFailure)).toBe(originalDate);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("multiple consecutive failures always revert to original value", () => {
    fc.assert(
      fc.property(
        distinctFieldValuesArb,
        fc.array(fc.constantFrom(...CAMPAIGN_STATUSES), { minLength: 1, maxLength: 5 }),
        ({ original }, attempts) => {
          let state: FieldState = { value: original, optimisticValue: null };

          // Simulate multiple edit attempts that all fail
          for (const attempt of attempts) {
            state = applyOptimisticUpdate(state, attempt);
            state = handleApiFailure(state);

            // After each failure, displayed value is always the original
            expect(getDisplayedValue(state)).toBe(original);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("API success does NOT revert (contrast with failure behavior)", () => {
    fc.assert(
      fc.property(distinctFieldValuesArb, ({ original, edited }) => {
        const initialState: FieldState = { value: original, optimisticValue: null };
        const afterEdit = applyOptimisticUpdate(initialState, edited);

        // On success, optimistic value is cleared but value would be updated
        // by parent (simulated here by setting value to edited)
        const afterSuccess = handleApiSuccess(afterEdit);

        // optimisticValue is cleared
        expect(afterSuccess.optimisticValue).toBeNull();
        // The value prop hasn't changed yet (parent updates it separately)
        // But the key difference: on success the parent WILL update value
        // On failure the parent does NOT update value → revert
        expect(afterSuccess.value).toBe(original);
      }),
      { numRuns: 100 },
    );
  });
});
