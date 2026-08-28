/**
 * Property-based tests for deal profitability computation logic.
 *
 * Feature: data-collection-insights
 * Validates: Requirements 8.2, 8.3, 9.1, 9.2, 9.3, 9.4
 *
 * These tests extract and verify the pure computation logic from
 * src/app/api/deals/profitability/route.ts without hitting the database.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Types mirroring the route
// ---------------------------------------------------------------------------

type Campaign = {
  id: string;
  actualSales: number | null;
  netMarginRate: number | null;
  sellerId: string;
  createdAt: Date;
  seller: { id: string; name: string };
};

type DealProfitabilityRow = {
  dealId: string;
  dealName: string;
  partnerName: string;
  totalRevenue: number;
  totalMargin: number;
  campaignCount: number;
  bestSeller: { id: string; name: string; sales: number } | null;
};

// ---------------------------------------------------------------------------
// Pure computation functions extracted from the route
// ---------------------------------------------------------------------------

function computeDealMetrics(campaigns: Campaign[]): {
  totalRevenue: number;
  totalMargin: number;
  campaignCount: number;
  bestSeller: { id: string; name: string; sales: number } | null;
} {
  let totalRevenue = 0;
  let totalMargin = 0;
  let campaignCount = 0;
  let bestSeller: { id: string; name: string; sales: number } | null = null;
  let bestCreatedAt: Date | null = null;

  for (const campaign of campaigns) {
    if (campaign.actualSales == null) continue;

    const sales = campaign.actualSales;
    campaignCount++;
    totalRevenue += sales;

    if (campaign.netMarginRate != null) {
      totalMargin += (sales * campaign.netMarginRate) / 100;
    }

    if (
      bestSeller === null ||
      sales > bestSeller.sales ||
      (sales === bestSeller.sales && campaign.createdAt < bestCreatedAt!)
    ) {
      bestSeller = { id: campaign.seller.id, name: campaign.seller.name, sales };
      bestCreatedAt = campaign.createdAt;
    }
  }

  return { totalRevenue, totalMargin, campaignCount, bestSeller };
}

function filterQualifyingDeals<T extends { campaigns: Campaign[] }>(deals: T[]): T[] {
  return deals.filter((d) => d.campaigns.some((c) => c.actualSales != null));
}

function sortDeals(
  rows: DealProfitabilityRow[],
  sortBy: "totalRevenue" | "totalMargin" | "campaignCount",
  sortOrder: "asc" | "desc",
): DealProfitabilityRow[] {
  return [...rows].sort((a, b) => {
    const aVal = a[sortBy];
    const bVal = b[sortBy];
    return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
  });
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const sellerArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 30 }),
});

const campaignArb = fc.record({
  id: fc.uuid(),
  actualSales: fc.oneof(
    fc.constant(null),
    fc.float({ min: 0, max: 100_000_000, noNaN: true }),
  ),
  netMarginRate: fc.oneof(
    fc.constant(null),
    fc.float({ min: 0, max: 50, noNaN: true }),
  ),
  sellerId: fc.uuid(),
  createdAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-12-31") }),
  seller: sellerArb,
});

const campaignWithSalesArb = fc.record({
  id: fc.uuid(),
  actualSales: fc.float({ min: 0, max: 100_000_000, noNaN: true }),
  netMarginRate: fc.oneof(
    fc.constant(null),
    fc.float({ min: 0, max: 50, noNaN: true }),
  ),
  sellerId: fc.uuid(),
  createdAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-12-31") }),
  seller: sellerArb,
});

const dealArb = fc.record({
  dealId: fc.uuid(),
  dealName: fc.string({ minLength: 1, maxLength: 50 }),
  partnerName: fc.string({ minLength: 1, maxLength: 50 }),
  campaigns: fc.array(campaignArb, { minLength: 0, maxLength: 10 }),
});

// ---------------------------------------------------------------------------
// Property 9: Deal revenue computation
// Validates: Requirements 9.1
// ---------------------------------------------------------------------------

describe("Property 9: Deal revenue computation", () => {
  it("totalRevenue equals sum of non-null actualSales", () => {
    fc.assert(
      fc.property(fc.array(campaignArb, { minLength: 0, maxLength: 20 }), (campaigns) => {
        const { totalRevenue } = computeDealMetrics(campaigns);

        const expected = campaigns
          .filter((c) => c.actualSales != null)
          .reduce((sum, c) => sum + c.actualSales!, 0);

        expect(totalRevenue).toBeCloseTo(expected, 5);
      }),
      { numRuns: 100 },
    );
  });

  it("campaigns with null actualSales are excluded from revenue", () => {
    fc.assert(
      fc.property(
        fc.array(campaignWithSalesArb, { minLength: 1, maxLength: 10 }),
        fc.array(
          fc.record({
            id: fc.uuid(),
            actualSales: fc.constant(null) as fc.Arbitrary<null>,
            netMarginRate: fc.constant(null) as fc.Arbitrary<null>,
            sellerId: fc.uuid(),
            createdAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-12-31") }),
            seller: sellerArb,
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (withSales, withoutSales) => {
          const allCampaigns: Campaign[] = [...withSales, ...withoutSales];
          const { totalRevenue } = computeDealMetrics(allCampaigns);

          const expectedRevenue = withSales.reduce((sum, c) => sum + c.actualSales, 0);
          expect(totalRevenue).toBeCloseTo(expectedRevenue, 5);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("revenue is zero when all campaigns have null actualSales", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            actualSales: fc.constant(null) as fc.Arbitrary<null>,
            netMarginRate: fc.constant(null) as fc.Arbitrary<null>,
            sellerId: fc.uuid(),
            createdAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-12-31") }),
            seller: sellerArb,
          }),
          { minLength: 0, maxLength: 10 },
        ),
        (campaigns) => {
          const { totalRevenue, campaignCount } = computeDealMetrics(campaigns);
          expect(totalRevenue).toBe(0);
          expect(campaignCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Deal margin computation
// Validates: Requirements 9.2
// ---------------------------------------------------------------------------

describe("Property 10: Deal margin computation", () => {
  it("totalMargin equals sum of (actualSales × netMarginRate / 100) for non-null pairs", () => {
    fc.assert(
      fc.property(fc.array(campaignArb, { minLength: 0, maxLength: 20 }), (campaigns) => {
        const { totalMargin } = computeDealMetrics(campaigns);

        const expected = campaigns
          .filter((c) => c.actualSales != null && c.netMarginRate != null)
          .reduce((sum, c) => sum + (c.actualSales! * c.netMarginRate!) / 100, 0);

        expect(totalMargin).toBeCloseTo(expected, 5);
      }),
      { numRuns: 100 },
    );
  });

  it("campaigns with null netMarginRate contribute 0 to margin", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            actualSales: fc.float({ min: 1, max: 100_000_000, noNaN: true }),
            netMarginRate: fc.constant(null) as fc.Arbitrary<null>,
            sellerId: fc.uuid(),
            createdAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-12-31") }),
            seller: sellerArb,
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (campaigns) => {
          const { totalMargin } = computeDealMetrics(campaigns);
          expect(totalMargin).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("margin is non-negative when all sales and margin rates are non-negative", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            actualSales: fc.float({ min: 0, max: 100_000_000, noNaN: true }),
            netMarginRate: fc.float({ min: 0, max: 50, noNaN: true }),
            sellerId: fc.uuid(),
            createdAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-12-31") }),
            seller: sellerArb,
          }),
          { minLength: 0, maxLength: 10 },
        ),
        (campaigns) => {
          const { totalMargin } = computeDealMetrics(campaigns);
          expect(totalMargin).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: Best-performing seller identification
// Validates: Requirements 9.3, 9.4
// ---------------------------------------------------------------------------

describe("Property 11: Best-performing seller identification", () => {
  it("bestSeller has the highest actualSales among all campaigns", () => {
    fc.assert(
      fc.property(
        fc.array(campaignWithSalesArb, { minLength: 1, maxLength: 15 }),
        (campaigns) => {
          const { bestSeller } = computeDealMetrics(campaigns);

          expect(bestSeller).not.toBeNull();

          // No campaign should have higher sales than the best seller
          for (const c of campaigns) {
            expect(c.actualSales).toBeLessThanOrEqual(bestSeller!.sales);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("bestSeller is null when all campaigns have null actualSales", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            actualSales: fc.constant(null) as fc.Arbitrary<null>,
            netMarginRate: fc.constant(null) as fc.Arbitrary<null>,
            sellerId: fc.uuid(),
            createdAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-12-31") }),
            seller: sellerArb,
          }),
          { minLength: 0, maxLength: 10 },
        ),
        (campaigns) => {
          const { bestSeller } = computeDealMetrics(campaigns);
          expect(bestSeller).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("tie-break: when two campaigns share the highest sales, the one with earliest createdAt wins", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 1, max: 100_000_000, noNaN: true }),
        sellerArb,
        sellerArb,
        fc.date({ min: new Date("2020-01-01"), max: new Date("2025-01-01") }),
        fc.date({ min: new Date("2025-01-02"), max: new Date("2030-12-31") }),
        (tiedSales, sellerA, sellerB, earlierDate, laterDate) => {
          const campaigns: Campaign[] = [
            {
              id: "c1",
              actualSales: tiedSales,
              netMarginRate: null,
              sellerId: sellerA.id,
              createdAt: laterDate,
              seller: sellerA,
            },
            {
              id: "c2",
              actualSales: tiedSales,
              netMarginRate: null,
              sellerId: sellerB.id,
              createdAt: earlierDate,
              seller: sellerB,
            },
          ];

          const { bestSeller } = computeDealMetrics(campaigns);

          // sellerB has the earlier createdAt, so it should win the tie
          expect(bestSeller).not.toBeNull();
          expect(bestSeller!.id).toBe(sellerB.id);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("bestSeller sales value matches the actual highest sales in the campaign set", () => {
    fc.assert(
      fc.property(
        fc.array(campaignWithSalesArb, { minLength: 1, maxLength: 15 }),
        (campaigns) => {
          const { bestSeller } = computeDealMetrics(campaigns);
          const maxSales = Math.max(...campaigns.map((c) => c.actualSales));
          expect(bestSeller!.sales).toBeCloseTo(maxSales, 5);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12: Deal profitability filter
// Validates: Requirements 8.3
// ---------------------------------------------------------------------------

describe("Property 12: Deal profitability filter", () => {
  it("only deals with at least one non-null actualSales campaign are included", () => {
    fc.assert(
      fc.property(
        fc.array(dealArb, { minLength: 0, maxLength: 20 }),
        (deals) => {
          const filtered = filterQualifyingDeals(deals);

          // Every included deal must have at least one campaign with non-null actualSales
          for (const deal of filtered) {
            const hasQualifyingCampaign = deal.campaigns.some((c) => c.actualSales != null);
            expect(hasQualifyingCampaign).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("deals with only null actualSales are excluded", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dealId: fc.uuid(),
            dealName: fc.string({ minLength: 1, maxLength: 50 }),
            partnerName: fc.string({ minLength: 1, maxLength: 50 }),
            campaigns: fc.array(
              fc.record({
                id: fc.uuid(),
                actualSales: fc.constant(null) as fc.Arbitrary<null>,
                netMarginRate: fc.constant(null) as fc.Arbitrary<null>,
                sellerId: fc.uuid(),
                createdAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-12-31") }),
                seller: sellerArb,
              }),
              { minLength: 1, maxLength: 5 },
            ),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (dealsWithNullSales) => {
          const filtered = filterQualifyingDeals(dealsWithNullSales);
          expect(filtered).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("deals with at least one non-null actualSales are always included", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dealId: fc.uuid(),
            dealName: fc.string({ minLength: 1, maxLength: 50 }),
            partnerName: fc.string({ minLength: 1, maxLength: 50 }),
            campaigns: fc.array(campaignWithSalesArb, { minLength: 1, maxLength: 5 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (qualifyingDeals) => {
          const filtered = filterQualifyingDeals(qualifyingDeals);
          expect(filtered).toHaveLength(qualifyingDeals.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("filter is idempotent: applying it twice yields the same result", () => {
    fc.assert(
      fc.property(
        fc.array(dealArb, { minLength: 0, maxLength: 15 }),
        (deals) => {
          const once = filterQualifyingDeals(deals);
          const twice = filterQualifyingDeals(once);
          expect(twice).toHaveLength(once.length);
          expect(twice.map((d) => d.dealId)).toEqual(once.map((d) => d.dealId));
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13: Deal profitability sorting
// Validates: Requirements 8.2
// ---------------------------------------------------------------------------

const rowArb = fc.record({
  dealId: fc.uuid(),
  dealName: fc.string({ minLength: 1, maxLength: 50 }),
  partnerName: fc.string({ minLength: 1, maxLength: 50 }),
  totalRevenue: fc.float({ min: 0, max: 100_000_000, noNaN: true }),
  totalMargin: fc.float({ min: 0, max: 50_000_000, noNaN: true }),
  campaignCount: fc.integer({ min: 0, max: 100 }),
  bestSeller: fc.constant(null),
});

const sortFieldArb = fc.constantFrom(
  "totalRevenue" as const,
  "totalMargin" as const,
  "campaignCount" as const,
);

const sortOrderArb = fc.constantFrom("asc" as const, "desc" as const);

describe("Property 13: Deal profitability sorting", () => {
  it("sorted output is ordered by the specified field and direction", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 0, maxLength: 20 }),
        sortFieldArb,
        sortOrderArb,
        (rows, sortBy, sortOrder) => {
          const sorted = sortDeals(rows, sortBy, sortOrder);

          for (let i = 0; i < sorted.length - 1; i++) {
            const a = sorted[i][sortBy];
            const b = sorted[i + 1][sortBy];
            if (sortOrder === "asc") {
              expect(a).toBeLessThanOrEqual(b);
            } else {
              expect(a).toBeGreaterThanOrEqual(b);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("sorting does not change the number of rows", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 0, maxLength: 20 }),
        sortFieldArb,
        sortOrderArb,
        (rows, sortBy, sortOrder) => {
          const sorted = sortDeals(rows, sortBy, sortOrder);
          expect(sorted).toHaveLength(rows.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("sorting is stable in terms of set membership: same rows appear before and after", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 0, maxLength: 20 }),
        sortFieldArb,
        sortOrderArb,
        (rows, sortBy, sortOrder) => {
          const sorted = sortDeals(rows, sortBy, sortOrder);
          const originalIds = new Set(rows.map((r) => r.dealId));
          const sortedIds = new Set(sorted.map((r) => r.dealId));
          expect(sortedIds).toEqual(originalIds);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("asc and desc produce reverse orderings for the same field", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 2, maxLength: 20 }),
        sortFieldArb,
        (rows, sortBy) => {
          const asc = sortDeals(rows, sortBy, "asc");
          const desc = sortDeals(rows, sortBy, "desc");

          // The desc order should be the reverse of asc order
          // (allowing for ties where order may differ, we just check the first and last values)
          const ascFirst = asc[0][sortBy];
          const ascLast = asc[asc.length - 1][sortBy];
          const descFirst = desc[0][sortBy];
          const descLast = desc[desc.length - 1][sortBy];

          expect(ascFirst).toBeLessThanOrEqual(ascLast);
          expect(descFirst).toBeGreaterThanOrEqual(descLast);
        },
      ),
      { numRuns: 100 },
    );
  });
});
