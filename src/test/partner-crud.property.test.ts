/**
 * Property-based tests for Partner CRUD
 * Feature: core-data-management
 *
 * Tests Zod validation schemas and deletion guard logic directly (no HTTP).
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 4.1, 4.2, 4.3
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  createPartnerSchema,
  updatePartnerSchema,
  PARTNER_TYPES,
} from "@/lib/validations/partner";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string (trimmed length ≥ 1) */
const nonEmptyString = fc.string({ minLength: 1, maxLength: 100 }).filter(
  (s) => s.trim().length > 0,
);

/** One of the four valid partner types */
const partnerTypeArb = fc.constantFrom(...PARTNER_TYPES);

/** A fully valid createPartner payload */
const validCreatePayload = fc.record({
  name: nonEmptyString,
  type: partnerTypeArb,
  contactInfo: fc.option(nonEmptyString, { nil: undefined }),
  bankAccount: fc.option(nonEmptyString, { nil: undefined }),
  companyStatus: fc.option(nonEmptyString, { nil: undefined }),
  companyRole: fc.option(nonEmptyString, { nil: undefined }),
  notes: fc.option(nonEmptyString, { nil: undefined }),
  referredById: fc.option(nonEmptyString, { nil: undefined }),
  businessType: fc.option(nonEmptyString, { nil: undefined }),
  businessItem: fc.option(nonEmptyString, { nil: undefined }),
  representativeEmail: fc.option(nonEmptyString, { nil: undefined }),
});

// ---------------------------------------------------------------------------
// Property 1: Entity creation round-trip
// Feature: core-data-management, Property 1: Entity creation round-trip
//
// For any valid partner payload, createPartnerSchema.parse() should succeed
// and the parsed output should preserve all provided fields exactly.
//
// **Validates: Requirements 1.1, 1.2**
// ---------------------------------------------------------------------------

describe("Property 1: Entity creation round-trip — schema preserves all fields", () => {
  it("valid partner data passes schema and all fields are preserved", () => {
    fc.assert(
      fc.property(validCreatePayload, (payload) => {
        const result = createPartnerSchema.safeParse(payload);

        // Must succeed
        expect(result.success).toBe(true);
        if (!result.success) return;

        const data = result.data;

        // Required fields must match exactly
        expect(data.name).toBe(payload.name);
        expect(data.type).toBe(payload.type);

        // Optional fields: if provided they must be preserved
        if (payload.contactInfo !== undefined) {
          expect(data.contactInfo).toBe(payload.contactInfo);
        }
        if (payload.bankAccount !== undefined) {
          expect(data.bankAccount).toBe(payload.bankAccount);
        }
        if (payload.companyStatus !== undefined) {
          expect(data.companyStatus).toBe(payload.companyStatus);
        }
        if (payload.companyRole !== undefined) {
          expect(data.companyRole).toBe(payload.companyRole);
        }
        if (payload.notes !== undefined) {
          expect(data.notes).toBe(payload.notes);
        }
        if (payload.referredById !== undefined) {
          expect(data.referredById).toBe(payload.referredById);
        }
        if (payload.businessType !== undefined) {
          expect(data.businessType).toBe(payload.businessType);
        }
        if (payload.businessItem !== undefined) {
          expect(data.businessItem).toBe(payload.businessItem);
        }
        if (payload.representativeEmail !== undefined) {
          expect(data.representativeEmail).toBe(payload.representativeEmail);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("type field only accepts the four valid enum values", () => {
    fc.assert(
      fc.property(partnerTypeArb, (type) => {
        const result = createPartnerSchema.safeParse({ name: "Test Partner", type });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(PARTNER_TYPES).toContain(result.data.type);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Required field validation rejects incomplete data
// Feature: core-data-management, Property 2: Required field validation
//
// For any payload missing `name` or `type`, createPartnerSchema.safeParse()
// must return success=false. No record should be created.
//
// **Validates: Requirements 1.3**
// ---------------------------------------------------------------------------

describe("Property 2: Required field validation rejects incomplete data", () => {
  it("rejects payload with missing name", () => {
    fc.assert(
      fc.property(partnerTypeArb, (type) => {
        // name is absent
        const result = createPartnerSchema.safeParse({ type });
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects payload with empty name string (length 0)", () => {
    // The schema uses z.string().min(1) — only the empty string "" is rejected.
    // Whitespace-only strings like " " have length ≥ 1 and are accepted by Zod.
    fc.assert(
      fc.property(partnerTypeArb, (type) => {
        const result = createPartnerSchema.safeParse({ name: "", type });
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects payload with missing type", () => {
    fc.assert(
      fc.property(nonEmptyString, (name) => {
        // type is absent
        const result = createPartnerSchema.safeParse({ name });
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects payload with invalid type value", () => {
    // Generate strings that are not valid partner types
    const invalidType = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => !(PARTNER_TYPES as readonly string[]).includes(s));

    fc.assert(
      fc.property(nonEmptyString, invalidType, (name, type) => {
        const result = createPartnerSchema.safeParse({ name, type });
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects payload with both name and type missing", () => {
    fc.assert(
      fc.property(
        fc.record({
          contactInfo: fc.option(nonEmptyString, { nil: undefined }),
          bankAccount: fc.option(nonEmptyString, { nil: undefined }),
        }),
        (partial) => {
          const result = createPartnerSchema.safeParse(partial);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Deletion guard
// Feature: core-data-management, Property 4: Deletion guard
//
// Models the deletion guard logic from src/app/api/partners/[id]/route.ts:
//   - partner._count.deals > 0  → 409 (cannot delete)
//   - partner._count.deals === 0 → allowed (200/ok)
//
// **Validates: Requirements 4.1, 4.2, 4.3**
// ---------------------------------------------------------------------------

/**
 * Pure function that mirrors the deletion guard logic in the DELETE handler.
 * Returns { allowed: true } or { allowed: false, status: 409, error: string }.
 */
function deletionGuard(dealCount: number): { allowed: true } | { allowed: false; status: 409; error: string } {
  if (dealCount > 0) {
    return {
      allowed: false,
      status: 409,
      error: "연결된 딜이 있어 삭제할 수 없습니다",
    };
  }
  return { allowed: true };
}

describe("Property 4: Deletion guard", () => {
  it("partner with one or more linked deals cannot be deleted (returns 409)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (dealCount) => {
        const result = deletionGuard(dealCount);
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
          expect(result.status).toBe(409);
          expect(result.error).toBeTruthy();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("partner with zero linked deals can be deleted", () => {
    const result = deletionGuard(0);
    expect(result.allowed).toBe(true);
  });

  it("deletion guard is monotone: more deals never makes deletion more permissive", () => {
    // If dealCount=N is blocked, dealCount=N+k must also be blocked for any k≥0
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        (base, extra) => {
          const resultBase = deletionGuard(base);
          const resultMore = deletionGuard(base + extra);
          // Both must be blocked
          expect(resultBase.allowed).toBe(false);
          expect(resultMore.allowed).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("only dealCount=0 allows deletion", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1000 }), (dealCount) => {
        const result = deletionGuard(dealCount);
        if (dealCount === 0) {
          expect(result.allowed).toBe(true);
        } else {
          expect(result.allowed).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Bonus: updatePartnerSchema — partial updates preserve type safety
// ---------------------------------------------------------------------------

describe("updatePartnerSchema — partial updates", () => {
  it("accepts any subset of valid fields", () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            name: fc.option(nonEmptyString, { nil: undefined }),
            type: fc.option(partnerTypeArb, { nil: undefined }),
            contactInfo: fc.option(nonEmptyString, { nil: undefined }),
            bankAccount: fc.option(nonEmptyString, { nil: undefined }),
            businessType: fc.option(nonEmptyString, { nil: undefined }),
            businessItem: fc.option(nonEmptyString, { nil: undefined }),
            representativeEmail: fc.option(nonEmptyString, { nil: undefined }),
          },
          { requiredKeys: [] },
        ),
        (partial) => {
          const result = updatePartnerSchema.safeParse(partial);
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects name update to empty string (length 0)", () => {
    // updatePartnerSchema uses z.string().min(1).optional() — only "" is rejected.
    const result = updatePartnerSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });
});
