/**
 * Property-based tests for Campaign Creation Sheet required field validation.
 *
 * Feature: data-entry-pipeline-ux, Property 1: Required field validation blocks submission
 * **Validates: Requirements 1.7, 5.5**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Validation logic extracted from CampaignCreationSheet
// The component uses: `const isSubmitDisabled = saving || !dealId || !sellerId;`
// Required fields: dealId (딜) and sellerId (셀러)
// ---------------------------------------------------------------------------

/**
 * Determines whether the campaign creation submit button should be disabled.
 * Mirrors the logic in CampaignCreationSheet component.
 */
function isSubmitDisabled(formState: {
  dealId: string;
  sellerId: string;
  saving: boolean;
}): boolean {
  return formState.saving || !formState.dealId || !formState.sellerId;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generates a non-empty string (simulates a valid selected ID) */
const nonEmptyIdArb = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

/** Generates an empty-ish string (simulates an unselected required field) */
const emptyIdArb = fc.constant("");

/**
 * Generates form states where at least one required field is empty.
 * Required fields: dealId, sellerId
 * Cases:
 *   - dealId empty, sellerId valid
 *   - dealId valid, sellerId empty
 *   - both empty
 */
const formStateWithMissingRequiredFieldArb = fc.oneof(
  // Case 1: dealId empty, sellerId may be anything
  fc.record({
    dealId: emptyIdArb,
    sellerId: fc.oneof(emptyIdArb, nonEmptyIdArb),
    saving: fc.constant(false),
  }),
  // Case 2: sellerId empty, dealId may be anything
  fc.record({
    dealId: fc.oneof(emptyIdArb, nonEmptyIdArb),
    sellerId: emptyIdArb,
    saving: fc.constant(false),
  }),
  // Case 3: both empty
  fc.record({
    dealId: emptyIdArb,
    sellerId: emptyIdArb,
    saving: fc.constant(false),
  }),
);

/** Generates form states where all required fields are filled */
const formStateWithAllRequiredFieldsArb = fc.record({
  dealId: nonEmptyIdArb,
  sellerId: nonEmptyIdArb,
  saving: fc.constant(false),
});

// ---------------------------------------------------------------------------
// Property 1: Required field validation blocks submission
// Feature: data-entry-pipeline-ux, Property 1: Required field validation blocks submission
// Validates: Requirements 1.7, 5.5
// ---------------------------------------------------------------------------

describe("Property 1: Required field validation blocks submission", () => {
  /**
   * **Validates: Requirements 1.7, 5.5**
   *
   * For any form state where at least one required field (dealId or sellerId)
   * is empty, the submit button SHALL be disabled.
   */
  it("submit is disabled when at least one required field is empty", () => {
    fc.assert(
      fc.property(
        formStateWithMissingRequiredFieldArb,
        (formState) => {
          // The optional fields don't affect submit disabled state
          const disabled = isSubmitDisabled(formState);
          expect(disabled).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 1.7, 5.5**
   *
   * Conversely, when all required fields are filled and not saving,
   * the submit button SHALL be enabled.
   */
  it("submit is enabled when all required fields are filled and not saving", () => {
    fc.assert(
      fc.property(
        formStateWithAllRequiredFieldsArb,
        (formState) => {
          const disabled = isSubmitDisabled(formState);
          expect(disabled).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 1.7, 5.5**
   *
   * When saving is in progress, submit should always be disabled
   * regardless of field values.
   */
  it("submit is disabled while saving regardless of field values", () => {
    fc.assert(
      fc.property(
        fc.record({
          dealId: fc.oneof(emptyIdArb, nonEmptyIdArb),
          sellerId: fc.oneof(emptyIdArb, nonEmptyIdArb),
          saving: fc.constant(true),
        }),
        (formState) => {
          const disabled = isSubmitDisabled(formState);
          expect(disabled).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
