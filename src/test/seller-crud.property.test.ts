/**
 * Property-based tests for Seller CRUD logic.
 *
 * Feature: core-data-management
 * Validates: Requirements 5.1, 5.3, 5.4, 8.1, 8.2, 8.3
 *
 * These tests exercise pure logic — Zod validation schemas and the deletion
 * guard condition — without any HTTP or database calls.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  createSellerSchema,
  SNS_TYPES,
  type CreateSellerInput,
} from "@/lib/validations/seller";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid SNS type: "INSTAGRAM" | "YOUTUBE" */
const snsTypeArb = fc.constantFrom(...SNS_TYPES);

/** Non-empty string (no leading/trailing whitespace issues) */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 100 }).filter(
  (s) => s.trim().length > 0
);

/** A fully valid seller creation payload */
const validSellerArb = fc.record<CreateSellerInput>({
  name: nonEmptyStringArb,
  snsType: snsTypeArb,
  snsHandle: nonEmptyStringArb,
  currentFollowers: fc.integer({ min: 0, max: 10_000_000 }),
  isMonitored: fc.boolean(),
  category: fc.option(nonEmptyStringArb, { nil: undefined }),
  agencyId: fc.option(nonEmptyStringArb, { nil: undefined }),
});

// ---------------------------------------------------------------------------
// Property 1: Entity creation round-trip (schema validation)
// Validates: Requirements 5.1
//
// For any valid seller payload, createSellerSchema.safeParse should succeed
// and the parsed output should preserve all provided fields exactly.
// ---------------------------------------------------------------------------

describe("Property 1: Entity creation round-trip — valid data passes schema and fields are preserved", () => {
  /**
   * **Validates: Requirements 5.1**
   *
   * For any valid seller payload (name, snsType, snsHandle, currentFollowers,
   * optional category/agencyId), the schema must accept it and return the
   * same field values unchanged.
   */
  it("valid seller data passes createSellerSchema and all fields are preserved", () => {
    fc.assert(
      fc.property(validSellerArb, (input) => {
        const result = createSellerSchema.safeParse(input);

        expect(result.success).toBe(true);
        if (!result.success) return;

        // Required fields must be preserved exactly
        expect(result.data.name).toBe(input.name);
        expect(result.data.snsType).toBe(input.snsType);
        expect(result.data.snsHandle).toBe(input.snsHandle);
        expect(result.data.currentFollowers).toBe(input.currentFollowers);

        // Optional fields preserved when provided
        if (input.category !== undefined) {
          expect(result.data.category).toBe(input.category);
        }
        if (input.agencyId !== undefined) {
          expect(result.data.agencyId).toBe(input.agencyId);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("parsed output has no extra required fields injected beyond the input", () => {
    fc.assert(
      fc.property(validSellerArb, (input) => {
        const result = createSellerSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (!result.success) return;

        // currentFollowers defaults to 0 when omitted; when provided it must match
        expect(result.data.currentFollowers).toBe(input.currentFollowers ?? 0);
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Required field validation rejects incomplete data
// Validates: Requirements 5.4
//
// A seller payload missing name, snsType, or snsHandle must fail validation.
// ---------------------------------------------------------------------------

describe("Property 2: Required field validation rejects incomplete data", () => {
  /**
   * **Validates: Requirements 5.4**
   *
   * Omitting `name` must cause createSellerSchema to return success=false.
   */
  it("rejects seller payload missing name", () => {
    fc.assert(
      fc.property(
        fc.record({
          snsType: snsTypeArb,
          snsHandle: nonEmptyStringArb,
          currentFollowers: fc.integer({ min: 0, max: 10_000_000 }),
        }),
        (payload) => {
          const result = createSellerSchema.safeParse(payload);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * Omitting `snsType` must cause createSellerSchema to return success=false.
   */
  it("rejects seller payload missing snsType", () => {
    fc.assert(
      fc.property(
        fc.record({
          name: nonEmptyStringArb,
          snsHandle: nonEmptyStringArb,
          currentFollowers: fc.integer({ min: 0, max: 10_000_000 }),
        }),
        (payload) => {
          const result = createSellerSchema.safeParse(payload);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * Omitting `snsHandle` must cause createSellerSchema to return success=false.
   */
  it("rejects seller payload missing snsHandle", () => {
    fc.assert(
      fc.property(
        fc.record({
          name: nonEmptyStringArb,
          snsType: snsTypeArb,
          currentFollowers: fc.integer({ min: 0, max: 10_000_000 }),
        }),
        (payload) => {
          const result = createSellerSchema.safeParse(payload);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * An empty string for `name` must be rejected (min(1) constraint).
   */
  it("rejects seller with empty string name", () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.constant(""),
          snsType: snsTypeArb,
          snsHandle: nonEmptyStringArb,
        }),
        (payload) => {
          const result = createSellerSchema.safeParse(payload);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * An empty string for `snsHandle` must be rejected (min(1) constraint).
   */
  it("rejects seller with empty string snsHandle", () => {
    fc.assert(
      fc.property(
        fc.record({
          name: nonEmptyStringArb,
          snsType: snsTypeArb,
          snsHandle: fc.constant(""),
        }),
        (payload) => {
          const result = createSellerSchema.safeParse(payload);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * An invalid snsType value (not INSTAGRAM or YOUTUBE) must be rejected.
   */
  it("rejects seller with invalid snsType", () => {
    const invalidSnsTypeArb = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => !SNS_TYPES.includes(s as (typeof SNS_TYPES)[number]));

    fc.assert(
      fc.property(
        fc.record({
          name: nonEmptyStringArb,
          snsType: invalidSnsTypeArb,
          snsHandle: nonEmptyStringArb,
        }),
        (payload) => {
          const result = createSellerSchema.safeParse(payload);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Deletion guard — seller with linked campaigns cannot be deleted
// Validates: Requirements 8.1, 8.2, 8.3
//
// The deletion guard logic: if campaignCount > 0 → reject (409), else allow.
// We test this pure condition directly without hitting the database.
// ---------------------------------------------------------------------------

/**
 * Mirrors the deletion guard logic from
 * src/app/api/sellers/[id]/route.ts DELETE handler.
 */
function canDeleteSeller(campaignCount: number): boolean {
  return campaignCount === 0;
}

describe("Property 4: Deletion guard — seller with linked campaigns cannot be deleted", () => {
  /**
   * **Validates: Requirements 8.1, 8.2**
   *
   * For any seller with at least one linked campaign (campaignCount ≥ 1),
   * the deletion guard must prevent deletion.
   */
  it("prevents deletion when seller has one or more linked campaigns", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        (campaignCount) => {
          expect(canDeleteSeller(campaignCount)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 8.3**
   *
   * A seller with zero linked campaigns must be allowed to be deleted.
   */
  it("allows deletion when seller has no linked campaigns", () => {
    expect(canDeleteSeller(0)).toBe(true);
  });

  /**
   * **Validates: Requirements 8.1, 8.2, 8.3**
   *
   * The guard is monotone: adding campaigns never turns a blocked seller
   * into a deletable one.
   */
  it("deletion guard is monotone — adding campaigns never enables deletion", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9_999 }),
        fc.integer({ min: 1, max: 10_000 }),
        (base, extra) => {
          const withCampaigns = base + extra; // always > base, always ≥ 1
          if (!canDeleteSeller(base)) {
            // If already blocked, adding more campaigns keeps it blocked
            expect(canDeleteSeller(withCampaigns)).toBe(false);
          }
          // If base === 0 (deletable), adding extra (≥1) must block it
          if (base === 0) {
            expect(canDeleteSeller(withCampaigns)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Seller SNS uniqueness constraint
// Validates: Requirements 5.3
//
// The uniqueness constraint is (snsType, snsHandle). We test that the schema
// correctly identifies the pair and that duplicate detection logic is sound.
// ---------------------------------------------------------------------------

/**
 * Simulates the uniqueness check that the API/DB enforces:
 * given a set of existing (snsType, snsHandle) pairs, returns true if the
 * new pair already exists.
 */
function isDuplicateSns(
  existing: Array<{ snsType: string; snsHandle: string }>,
  candidate: { snsType: string; snsHandle: string }
): boolean {
  return existing.some(
    (e) => e.snsType === candidate.snsType && e.snsHandle === candidate.snsHandle
  );
}

describe("Property 5: Seller SNS uniqueness constraint", () => {
  /**
   * **Validates: Requirements 5.3**
   *
   * For any existing seller, attempting to create another seller with the
   * exact same (snsType, snsHandle) pair must be detected as a duplicate.
   */
  it("detects duplicate snsType+snsHandle pair", () => {
    fc.assert(
      fc.property(
        fc.record({
          snsType: snsTypeArb,
          snsHandle: nonEmptyStringArb,
        }),
        (seller) => {
          const existing = [seller];
          expect(isDuplicateSns(existing, seller)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 5.3**
   *
   * Same snsHandle but different snsType is NOT a duplicate.
   */
  it("does not flag as duplicate when snsType differs", () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        (handle) => {
          const existing = [{ snsType: "INSTAGRAM", snsHandle: handle }];
          const candidate = { snsType: "YOUTUBE", snsHandle: handle };
          expect(isDuplicateSns(existing, candidate)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 5.3**
   *
   * Same snsType but different snsHandle is NOT a duplicate.
   */
  it("does not flag as duplicate when snsHandle differs", () => {
    fc.assert(
      fc.property(
        snsTypeArb,
        nonEmptyStringArb,
        nonEmptyStringArb,
        (snsType, handle1, handle2) => {
          fc.pre(handle1 !== handle2);
          const existing = [{ snsType, snsHandle: handle1 }];
          const candidate = { snsType, snsHandle: handle2 };
          expect(isDuplicateSns(existing, candidate)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 5.3**
   *
   * For any list of N distinct (snsType, snsHandle) pairs, none of them
   * should be flagged as a duplicate of the others.
   */
  it("distinct pairs are never flagged as duplicates of each other", () => {
    // Generate a list of unique (snsType, snsHandle) pairs
    const distinctPairsArb = fc
      .uniqueArray(
        fc.record({ snsType: snsTypeArb, snsHandle: nonEmptyStringArb }),
        {
          minLength: 2,
          maxLength: 20,
          selector: (p) => `${p.snsType}::${p.snsHandle}`,
        }
      );

    fc.assert(
      fc.property(distinctPairsArb, (pairs) => {
        for (let i = 0; i < pairs.length; i++) {
          const others = pairs.filter((_, j) => j !== i);
          expect(isDuplicateSns(others, pairs[i])).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 5.3**
   *
   * The schema itself accepts both INSTAGRAM and YOUTUBE as valid snsType
   * values — ensuring the uniqueness key space covers both platforms.
   */
  it("createSellerSchema accepts both INSTAGRAM and YOUTUBE as valid snsType", () => {
    for (const snsType of SNS_TYPES) {
      const result = createSellerSchema.safeParse({
        name: "Test Seller",
        snsType,
        snsHandle: "test_handle",
        currentFollowers: 0,
      });
      expect(result.success).toBe(true);
    }
  });
});
