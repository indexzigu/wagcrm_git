import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { CampaignRow, CampaignStatus, SalesChannel, SnsType } from "../crm-types";
import {
  rankDealsByProfit,
  rankSellersByProfit,
  rankPartnersByProfit,
} from "../top-performance";

// === Shared arbitraries ===

const campaignStatusArb = fc.constantFrom<CampaignStatus>(
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "COMPLETED",
);

const salesChannelArb = fc.constantFrom<SalesChannel>(
  "OWN_MALL",
  "OWN_MALL_NAVER",
  "OWN_MALL_KAKAO",
  "SELLER_MALL",
  "BRAND_MALL",
);

const snsTypeArb = fc.constantFrom<SnsType>("INSTAGRAM", "YOUTUBE", "X");

const isoDateArb = fc
  .date({
    min: new Date("2023-01-01T00:00:00.000Z"),
    max: new Date("2027-12-31T00:00:00.000Z"),
  })
  .map((d) => d.toISOString().slice(0, 10));

/**
 * Generate a minimal CampaignRow with the fields relevant to top-performance logic.
 */
const campaignRowArb = fc
  .record({
    id: fc.uuid(),
    dealId: fc.uuid(),
    sellerId: fc.uuid(),
    dealName: fc.string({ minLength: 1, maxLength: 30 }),
    partnerName: fc.string({ minLength: 1, maxLength: 30 }),
    sellerName: fc.string({ minLength: 1, maxLength: 30 }),
    snsHandle: fc.string({ minLength: 1, maxLength: 20 }),
    snsType: snsTypeArb,
    startDate: isoDateArb,
    endDate: isoDateArb,
    salesChannel: salesChannelArb,
    status: campaignStatusArb,
    actualSales: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 10_000_000 })),
    totalMarginRate: fc.integer({ min: 0, max: 100 }),
    sellerMarginRate: fc.integer({ min: 0, max: 50 }),
    netMarginRate: fc.integer({ min: 0, max: 100 }),
  })
  .map((r) => ({
    ...r,
    campaignName: `${r.dealName} ${r.sellerName}`,
    salesCode: null,
    baseNaverLink: "",
    generatedTrackingLink: "",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: new Date().toISOString(),
    followerHistory: [],
    activityHistory: [],
    notes: [],
  })) as fc.Arbitrary<CampaignRow>;

const referenceDateArb = fc.date({
  min: new Date("2024-01-01T00:00:00.000Z"),
  max: new Date("2027-12-31T00:00:00.000Z"),
});

// ============================================================
// Property 7: Top performance ranking is sorted and bounded
// Feature: ux-fixes-and-field-editing, Property 7: Top performance ranking is sorted and bounded
// Validates: Requirements 13.2, 13.3, 13.4, 13.5
// ============================================================

describe("Property 7: Top performance ranking is sorted and bounded", () => {
  describe("rankDealsByProfit", () => {
    it("results are sorted by netMargin descending", () => {
      fc.assert(
        fc.property(
          fc.array(campaignRowArb, { minLength: 0, maxLength: 50 }),
          referenceDateArb,
          (campaigns, refDate) => {
            const results = rankDealsByProfit(campaigns, refDate);
            for (let i = 1; i < results.length; i++) {
              expect(results[i - 1].netMargin).toBeGreaterThanOrEqual(results[i].netMargin);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("results are limited to at most 5 items", () => {
      fc.assert(
        fc.property(
          fc.array(campaignRowArb, { minLength: 0, maxLength: 50 }),
          referenceDateArb,
          (campaigns, refDate) => {
            const results = rankDealsByProfit(campaigns, refDate);
            expect(results.length).toBeLessThanOrEqual(5);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("only includes data from COMPLETED campaigns with endDate within last 3 months", () => {
      fc.assert(
        fc.property(
          fc.array(campaignRowArb, { minLength: 0, maxLength: 50 }),
          referenceDateArb,
          (campaigns, refDate) => {
            const results = rankDealsByProfit(campaigns, refDate);

            // If there are results, verify they come from valid campaigns
            const threeMonthsAgo = new Date(refDate);
            threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

            // Get the set of dealIds that should be eligible
            const eligibleDealIds = new Set(
              campaigns
                .filter((c) => {
                  if (c.status !== "COMPLETED") return false;
                  if (!c.endDate) return false;
                  const end = new Date(c.endDate);
                  return end >= threeMonthsAgo && end <= refDate;
                })
                .map((c) => c.dealId),
            );

            for (const item of results) {
              expect(eligibleDealIds.has(item.id)).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("rankSellersByProfit", () => {
    it("results are sorted by netMargin descending", () => {
      fc.assert(
        fc.property(
          fc.array(campaignRowArb, { minLength: 0, maxLength: 50 }),
          referenceDateArb,
          (campaigns, refDate) => {
            const results = rankSellersByProfit(campaigns, refDate);
            for (let i = 1; i < results.length; i++) {
              expect(results[i - 1].netMargin).toBeGreaterThanOrEqual(results[i].netMargin);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("results are limited to at most 5 items", () => {
      fc.assert(
        fc.property(
          fc.array(campaignRowArb, { minLength: 0, maxLength: 50 }),
          referenceDateArb,
          (campaigns, refDate) => {
            const results = rankSellersByProfit(campaigns, refDate);
            expect(results.length).toBeLessThanOrEqual(5);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("only includes data from COMPLETED campaigns with endDate within last 3 months", () => {
      fc.assert(
        fc.property(
          fc.array(campaignRowArb, { minLength: 0, maxLength: 50 }),
          referenceDateArb,
          (campaigns, refDate) => {
            const results = rankSellersByProfit(campaigns, refDate);

            const threeMonthsAgo = new Date(refDate);
            threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

            const eligibleSellerIds = new Set(
              campaigns
                .filter((c) => {
                  if (c.status !== "COMPLETED") return false;
                  if (!c.endDate) return false;
                  const end = new Date(c.endDate);
                  return end >= threeMonthsAgo && end <= refDate;
                })
                .map((c) => c.sellerId),
            );

            for (const item of results) {
              expect(eligibleSellerIds.has(item.id)).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("rankPartnersByProfit", () => {
    it("results are sorted by netMargin descending", () => {
      fc.assert(
        fc.property(
          fc.array(campaignRowArb, { minLength: 0, maxLength: 50 }),
          referenceDateArb,
          (campaigns, refDate) => {
            const results = rankPartnersByProfit(campaigns, refDate);
            for (let i = 1; i < results.length; i++) {
              expect(results[i - 1].netMargin).toBeGreaterThanOrEqual(results[i].netMargin);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("results are limited to at most 5 items", () => {
      fc.assert(
        fc.property(
          fc.array(campaignRowArb, { minLength: 0, maxLength: 50 }),
          referenceDateArb,
          (campaigns, refDate) => {
            const results = rankPartnersByProfit(campaigns, refDate);
            expect(results.length).toBeLessThanOrEqual(5);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("only includes data from COMPLETED campaigns with endDate within last 3 months", () => {
      fc.assert(
        fc.property(
          fc.array(campaignRowArb, { minLength: 0, maxLength: 50 }),
          referenceDateArb,
          (campaigns, refDate) => {
            const results = rankPartnersByProfit(campaigns, refDate);

            const threeMonthsAgo = new Date(refDate);
            threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

            const eligiblePartnerNames = new Set(
              campaigns
                .filter((c) => {
                  if (c.status !== "COMPLETED") return false;
                  if (!c.endDate) return false;
                  const end = new Date(c.endDate);
                  return end >= threeMonthsAgo && end <= refDate;
                })
                .map((c) => c.partnerName),
            );

            for (const item of results) {
              expect(eligiblePartnerNames.has(item.id)).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
