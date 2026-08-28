/**
 * Property-based tests for the seller derived-segment filter.
 *
 * Feature: UX audit P0-3 (analysis coverage) — "미분석" segment + one-click analyze.
 * The logic under test is the single source of truth used by
 *   src/components/crm/sellers-management.tsx  (filteredSellers useMemo)
 * extracted into:
 *   src/lib/seller-segment.ts
 *
 * Contract being locked:
 *   - all         → every seller
 *   - active      → campaignCount > 0            (existing behavior, must not regress)
 *   - prospect    → campaignCount === 0          (existing behavior, must not regress)
 *   - unanalyzed  → aiComposite == null (null/undefined)   (new)
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { SellerSummary } from "@/lib/crm-types";
import {
  filterSellersBySegment,
  matchesSellerSegment,
  type SellerSegment,
} from "@/lib/seller-segment";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const idArb = fc.uuid();

const nonEmptyStringArb = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0);

/**
 * A minimal SellerSummary exercising the two fields the segment logic reads:
 * campaignCount (may be undefined) and aiComposite (may be null/undefined/number).
 */
const sellerArb = (id: string) =>
  fc.record({
    id: fc.constant(id),
    name: nonEmptyStringArb,
    snsType: fc.constantFrom("INSTAGRAM" as const, "YOUTUBE" as const, "X" as const),
    snsHandle: nonEmptyStringArb,
    currentFollowers: fc.integer({ min: 0, max: 10_000_000 }),
    // undefined models "field absent"; the predicate coalesces to 0.
    campaignCount: fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }),
    // null / undefined both mean "unanalyzed"; a number means analyzed.
    aiComposite: fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer({ min: 0, max: 100 })
    ),
  }) as fc.Arbitrary<SellerSummary>;

const sellersArb = fc
  .uniqueArray(idArb, { minLength: 0, maxLength: 25 })
  .chain((ids) =>
    fc.tuple(...ids.map((id) => sellerArb(id))).map((sellers) => sellers as SellerSummary[])
  );

const segmentArb = fc.constantFrom<SellerSegment>("all", "active", "prospect", "unanalyzed");

// ---------------------------------------------------------------------------
// Property 1: "all" is the identity filter (order + membership preserved)
// ---------------------------------------------------------------------------

describe("seller-segment: all returns every seller unchanged", () => {
  it("all preserves length, membership, and order", () => {
    fc.assert(
      fc.property(sellersArb, (sellers) => {
        const result = filterSellersBySegment(sellers, "all");
        expect(result).toHaveLength(sellers.length);
        expect(result.map((s) => s.id)).toEqual(sellers.map((s) => s.id));
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: active/prospect partition the list by campaignCount (existing contract)
// ---------------------------------------------------------------------------

describe("seller-segment: active and prospect partition by trade history", () => {
  it("active keeps exactly the sellers with campaignCount > 0", () => {
    fc.assert(
      fc.property(sellersArb, (sellers) => {
        const result = filterSellersBySegment(sellers, "active");
        for (const s of result) expect((s.campaignCount ?? 0) > 0).toBe(true);
        const expected = sellers.filter((s) => (s.campaignCount ?? 0) > 0).length;
        expect(result).toHaveLength(expected);
      }),
      { numRuns: 100 }
    );
  });

  it("prospect keeps exactly the sellers with campaignCount === 0 (incl. undefined)", () => {
    fc.assert(
      fc.property(sellersArb, (sellers) => {
        const result = filterSellersBySegment(sellers, "prospect");
        for (const s of result) expect((s.campaignCount ?? 0) === 0).toBe(true);
        const expected = sellers.filter((s) => (s.campaignCount ?? 0) === 0).length;
        expect(result).toHaveLength(expected);
      }),
      { numRuns: 100 }
    );
  });

  it("active and prospect are complementary and cover the whole list", () => {
    fc.assert(
      fc.property(sellersArb, (sellers) => {
        const active = filterSellersBySegment(sellers, "active");
        const prospect = filterSellersBySegment(sellers, "prospect");
        expect(active.length + prospect.length).toBe(sellers.length);
        const activeIds = new Set(active.map((s) => s.id));
        for (const s of prospect) expect(activeIds.has(s.id)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: unanalyzed selects exactly the sellers with no AI composite (new)
// ---------------------------------------------------------------------------

describe("seller-segment: unanalyzed selects sellers with aiComposite == null", () => {
  it("unanalyzed keeps exactly the sellers whose aiComposite is null/undefined", () => {
    fc.assert(
      fc.property(sellersArb, (sellers) => {
        const result = filterSellersBySegment(sellers, "unanalyzed");
        for (const s of result) expect(s.aiComposite == null).toBe(true);
        const expected = sellers.filter((s) => s.aiComposite == null).length;
        expect(result).toHaveLength(expected);
      }),
      { numRuns: 100 }
    );
  });

  it("a seller with a numeric aiComposite is never in the unanalyzed segment", () => {
    fc.assert(
      fc.property(sellersArb, (sellers) => {
        const result = filterSellersBySegment(sellers, "unanalyzed");
        const resultIds = new Set(result.map((s) => s.id));
        for (const s of sellers) {
          if (typeof s.aiComposite === "number") {
            expect(resultIds.has(s.id)).toBe(false);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: filter output is always a subset preserving relative order
// ---------------------------------------------------------------------------

describe("seller-segment: every segment yields an order-preserving subset", () => {
  it("result is a subsequence of the input for any segment", () => {
    fc.assert(
      fc.property(sellersArb, segmentArb, (sellers, segment) => {
        const result = filterSellersBySegment(sellers, segment);
        // Every result item matches the predicate...
        for (const s of result) expect(matchesSellerSegment(s, segment)).toBe(true);
        // ...and the result preserves input order (is a subsequence).
        const inputOrder = sellers.map((s) => s.id);
        const resultOrder = result.map((s) => s.id);
        let cursor = 0;
        for (const id of resultOrder) {
          const found = inputOrder.indexOf(id, cursor);
          expect(found).toBeGreaterThanOrEqual(cursor);
          cursor = found + 1;
        }
      }),
      { numRuns: 100 }
    );
  });
});
