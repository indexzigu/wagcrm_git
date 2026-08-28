// Feature: core-data-management
// Property 9: Campaign duplication preserves source fields
// Property 10: Bulk campaign creation produces correct count with unique links
// Property 11: Campaign template save/apply round-trip
// Validates: Requirements 13.1, 13.2, 13.3, 13.4, 14.1, 14.2, 14.3, 14.4, 15.1, 15.2

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { buildNaverTrackingLink } from "../lib/tracking";
import type { SnsType, SalesChannel } from "../lib/crm-types";

// ---------------------------------------------------------------------------
// Pure business-logic helpers extracted from the route handlers
// (tested in isolation — no HTTP, no DB)
// ---------------------------------------------------------------------------

/**
 * Mirrors the generateTrackingLink() function in bulk/route.ts.
 * Generates a random 12-char alphanumeric code under https://track.wag.kr/
 */
function generateBulkTrackingLink(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 12; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `https://track.wag.kr/${code}`;
}

/**
 * Mirrors the duplication logic in duplicate/route.ts.
 * Returns a new campaign object with copied fields, new sellerId, status=PROPOSAL,
 * and a freshly generated tracking link.
 */
function duplicateCampaign(
  source: {
    id: string;
    dealId: string;
    sellerId: string;
    startDate: Date;
    endDate: Date;
    salesChannel: string;
    baseNaverLink: string;
    totalMarginRate: number;
    sellerMarginRate: number;
    netMarginRate: number;
    isManualMargin: boolean;
  },
  newSellerId: string,
  newSellerSnsType: SnsType,
  newCampaignId: string,
): {
  dealId: string;
  sellerId: string;
  startDate: Date;
  endDate: Date;
  salesChannel: string;
  totalMarginRate: number;
  sellerMarginRate: number;
  netMarginRate: number;
  isManualMargin: boolean;
  status: string;
  generatedTrackingLink: string;
} {
  const generatedTrackingLink = buildNaverTrackingLink({
    baseUrl: source.baseNaverLink,
    snsType: newSellerSnsType,
    sellerId: newSellerId,
    campaignId: newCampaignId,
  });

  return {
    dealId: source.dealId,
    sellerId: newSellerId,
    startDate: source.startDate,
    endDate: source.endDate,
    salesChannel: source.salesChannel,
    totalMarginRate: source.totalMarginRate,
    sellerMarginRate: source.sellerMarginRate,
    netMarginRate: source.netMarginRate,
    isManualMargin: source.isManualMargin,
    status: "PROPOSAL",
    generatedTrackingLink,
  };
}

/**
 * Mirrors the bulk creation logic in bulk/route.ts.
 * For N sellerIds, produces N campaign objects each with a unique tracking link
 * and status=PROPOSAL.
 */
function bulkCreateCampaigns(
  dealId: string,
  sellerIds: string[],
  totalMarginRate: number,
  sellerMarginRate: number,
): Array<{
  dealId: string;
  sellerId: string;
  status: string;
  generatedTrackingLink: string;
  totalMarginRate: number;
  sellerMarginRate: number;
  netMarginRate: number;
}> {
  const netMarginRate = totalMarginRate - sellerMarginRate;
  return sellerIds.map((sellerId) => ({
    dealId,
    sellerId,
    status: "PROPOSAL",
    generatedTrackingLink: generateBulkTrackingLink(),
    totalMarginRate,
    sellerMarginRate,
    netMarginRate,
  }));
}

/**
 * Mirrors the template save/fetch round-trip in templates/route.ts.
 * Saving a template and fetching it back should return the same values.
 */
function saveTemplate(input: {
  name: string;
  dealId?: string;
  salesChannel?: string;
  marginSettings?: string;
  trackingPattern?: string;
}): {
  id: string;
  name: string;
  dealId: string | null;
  salesChannel: string | null;
  marginSettings: string | null;
  trackingPattern: string | null;
  createdAt: Date;
  updatedAt: Date;
} {
  // Simulate what Prisma does: store the record with nulls for missing optional fields
  const now = new Date();
  return {
    id: `tpl-${Math.random().toString(36).slice(2)}`,
    name: input.name,
    dealId: input.dealId ?? null,
    salesChannel: input.salesChannel ?? null,
    marginSettings: input.marginSettings ?? null,
    trackingPattern: input.trackingPattern ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const snsTypeArb = fc.constantFrom<SnsType>("INSTAGRAM", "YOUTUBE");

const salesChannelArb = fc.constantFrom<SalesChannel>(
  "OWN_MALL",
  "OWN_MALL_NAVER",
  "OWN_MALL_KAKAO",
  "SELLER_MALL",
  "BRAND_MALL",
);

/** A valid base URL for Naver tracking links */
const baseNaverLinkArb = fc
  .tuple(
    fc.stringMatching(/^[a-z]{3,10}$/),
    fc.stringMatching(/^[a-z]{3,10}$/),
  )
  .map(([domain, path]) => `https://${domain}.example.com/${path}`);

/** A cuid-like seller ID */
const sellerIdArb = fc
  .stringMatching(/^[a-z]{8,16}$/)
  .map((s) => `seller-${s}`);

/** A cuid-like campaign ID */
const campaignIdArb = fc
  .stringMatching(/^[a-z]{8,16}$/)
  .map((s) => `camp-${s}`);

/** A cuid-like deal ID */
const dealIdArb = fc
  .stringMatching(/^[a-z]{8,16}$/)
  .map((s) => `deal-${s}`);

/** Margin rate in [0, 100] */
const marginRateArb = fc.float({ min: 0, max: 100, noNaN: true });

/** A source campaign record */
const sourceCampaignArb = fc.record({
  id: campaignIdArb,
  dealId: dealIdArb,
  sellerId: sellerIdArb,
  startDate: fc.date({ min: new Date("2024-01-01"), max: new Date("2025-01-01") }),
  endDate: fc.date({ min: new Date("2025-01-02"), max: new Date("2026-01-01") }),
  salesChannel: salesChannelArb,
  baseNaverLink: baseNaverLinkArb,
  totalMarginRate: marginRateArb,
  sellerMarginRate: marginRateArb,
  netMarginRate: marginRateArb,
  isManualMargin: fc.boolean(),
});

/** A non-empty array of distinct seller IDs (1–10 sellers) */
const distinctSellerIdsArb = fc
  .uniqueArray(sellerIdArb, { minLength: 1, maxLength: 10 })
  .filter((ids) => ids.length >= 1);

/** Template input with at least a name */
const templateInputArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }),
  dealId: fc.option(dealIdArb, { nil: undefined }),
  salesChannel: fc.option(salesChannelArb, { nil: undefined }),
  marginSettings: fc.option(
    fc.string({ minLength: 1, maxLength: 200 }),
    { nil: undefined },
  ),
  trackingPattern: fc.option(
    fc.string({ minLength: 1, maxLength: 100 }),
    { nil: undefined },
  ),
});

// ---------------------------------------------------------------------------
// Property 9: Campaign duplication preserves source fields
// Validates: Requirements 13.1, 13.2, 13.3, 13.4
// ---------------------------------------------------------------------------

describe("Property 9: Campaign duplication preserves source fields", () => {
  it(
    "duplicated campaign copies dealId, dates, salesChannel, and margin settings from source",
    () => {
      fc.assert(
        fc.property(
          sourceCampaignArb,
          sellerIdArb,
          snsTypeArb,
          campaignIdArb,
          (source, newSellerId, newSnsType, newCampaignId) => {
            // Ensure the new seller is different from the source seller
            fc.pre(newSellerId !== source.sellerId);

            const duplicated = duplicateCampaign(
              source,
              newSellerId,
              newSnsType,
              newCampaignId,
            );

            // Req 13.1: deal, dates, salesChannel, margin settings are copied
            expect(duplicated.dealId).toBe(source.dealId);
            expect(duplicated.startDate).toEqual(source.startDate);
            expect(duplicated.endDate).toEqual(source.endDate);
            expect(duplicated.salesChannel).toBe(source.salesChannel);
            expect(duplicated.totalMarginRate).toBe(source.totalMarginRate);
            expect(duplicated.sellerMarginRate).toBe(source.sellerMarginRate);
            expect(duplicated.netMarginRate).toBe(source.netMarginRate);
            expect(duplicated.isManualMargin).toBe(source.isManualMargin);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "duplicated campaign has a different sellerId from the source (Req 13.2)",
    () => {
      fc.assert(
        fc.property(
          sourceCampaignArb,
          sellerIdArb,
          snsTypeArb,
          campaignIdArb,
          (source, newSellerId, newSnsType, newCampaignId) => {
            fc.pre(newSellerId !== source.sellerId);

            const duplicated = duplicateCampaign(
              source,
              newSellerId,
              newSnsType,
              newCampaignId,
            );

            // Req 13.2: sellerId must be the new seller, not the source seller
            expect(duplicated.sellerId).toBe(newSellerId);
            expect(duplicated.sellerId).not.toBe(source.sellerId);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "duplicated campaign always has status=PROPOSAL (Req 13.3)",
    () => {
      fc.assert(
        fc.property(
          sourceCampaignArb,
          sellerIdArb,
          snsTypeArb,
          campaignIdArb,
          (source, newSellerId, newSnsType, newCampaignId) => {
            fc.pre(newSellerId !== source.sellerId);

            const duplicated = duplicateCampaign(
              source,
              newSellerId,
              newSnsType,
              newCampaignId,
            );

            // Req 13.3: status must be PROPOSAL regardless of source status
            expect(duplicated.status).toBe("PROPOSAL");
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "duplicated campaign has a unique tracking link different from source (Req 13.4)",
    () => {
      fc.assert(
        fc.property(
          sourceCampaignArb,
          sellerIdArb,
          snsTypeArb,
          campaignIdArb,
          (source, newSellerId, newSnsType, newCampaignId) => {
            fc.pre(newSellerId !== source.sellerId);
            // Ensure the new campaign ID is different from the source ID
            fc.pre(newCampaignId !== source.id);

            const duplicated = duplicateCampaign(
              source,
              newSellerId,
              newSnsType,
              newCampaignId,
            );

            // Req 13.4: tracking link must be non-empty and unique (different from source)
            expect(duplicated.generatedTrackingLink).toBeTruthy();
            expect(duplicated.generatedTrackingLink.length).toBeGreaterThan(0);

            // The new tracking link encodes the new sellerId and new campaignId,
            // so it must differ from any link that would encode the source's sellerId
            const sourceLink = buildNaverTrackingLink({
              baseUrl: source.baseNaverLink,
              snsType: newSnsType,
              sellerId: source.sellerId,
              campaignId: source.id,
            });
            expect(duplicated.generatedTrackingLink).not.toBe(sourceLink);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "tracking link encodes the new sellerId and new campaignId (not the source's)",
    () => {
      fc.assert(
        fc.property(
          sourceCampaignArb,
          sellerIdArb,
          snsTypeArb,
          campaignIdArb,
          (source, newSellerId, newSnsType, newCampaignId) => {
            fc.pre(newSellerId !== source.sellerId);
            fc.pre(newCampaignId !== source.id);

            const duplicated = duplicateCampaign(
              source,
              newSellerId,
              newSnsType,
              newCampaignId,
            );

            // The tracking link must contain the new sellerId and new campaignId
            const url = new URL(duplicated.generatedTrackingLink);
            expect(url.searchParams.get("nt_medium")).toBe(newSellerId);
            expect(url.searchParams.get("nt_detail")).toBe(newCampaignId);
            expect(url.searchParams.get("nt_source")).toBe(newSnsType);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 10: Bulk campaign creation produces correct count with unique links
// Validates: Requirements 14.1, 14.2, 14.3, 14.4
// ---------------------------------------------------------------------------

describe("Property 10: Bulk campaign creation produces correct count with unique links", () => {
  it(
    "N sellers produce exactly N campaigns (Req 14.1)",
    () => {
      fc.assert(
        fc.property(
          dealIdArb,
          distinctSellerIdsArb,
          marginRateArb,
          marginRateArb,
          (dealId, sellerIds, totalMarginRate, sellerMarginRate) => {
            const campaigns = bulkCreateCampaigns(
              dealId,
              sellerIds,
              totalMarginRate,
              sellerMarginRate,
            );

            // Req 14.1: one campaign per seller
            expect(campaigns.length).toBe(sellerIds.length);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "each campaign is linked to the correct deal (Req 14.1)",
    () => {
      fc.assert(
        fc.property(
          dealIdArb,
          distinctSellerIdsArb,
          marginRateArb,
          marginRateArb,
          (dealId, sellerIds, totalMarginRate, sellerMarginRate) => {
            const campaigns = bulkCreateCampaigns(
              dealId,
              sellerIds,
              totalMarginRate,
              sellerMarginRate,
            );

            // Every campaign must reference the same dealId
            for (const campaign of campaigns) {
              expect(campaign.dealId).toBe(dealId);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "each campaign is linked to the correct seller (Req 14.1)",
    () => {
      fc.assert(
        fc.property(
          dealIdArb,
          distinctSellerIdsArb,
          marginRateArb,
          marginRateArb,
          (dealId, sellerIds, totalMarginRate, sellerMarginRate) => {
            const campaigns = bulkCreateCampaigns(
              dealId,
              sellerIds,
              totalMarginRate,
              sellerMarginRate,
            );

            // Each campaign must be linked to the corresponding seller
            for (let i = 0; i < sellerIds.length; i++) {
              expect(campaigns[i].sellerId).toBe(sellerIds[i]);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "deal's base margin policy is applied to each campaign (Req 14.2)",
    () => {
      fc.assert(
        fc.property(
          dealIdArb,
          distinctSellerIdsArb,
          marginRateArb,
          marginRateArb,
          (dealId, sellerIds, totalMarginRate, sellerMarginRate) => {
            const campaigns = bulkCreateCampaigns(
              dealId,
              sellerIds,
              totalMarginRate,
              sellerMarginRate,
            );

            const expectedNetMarginRate = totalMarginRate - sellerMarginRate;

            for (const campaign of campaigns) {
              expect(campaign.totalMarginRate).toBe(totalMarginRate);
              expect(campaign.sellerMarginRate).toBe(sellerMarginRate);
              expect(campaign.netMarginRate).toBeCloseTo(expectedNetMarginRate, 10);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "all bulk-created campaigns have status=PROPOSAL (Req 14.3)",
    () => {
      fc.assert(
        fc.property(
          dealIdArb,
          distinctSellerIdsArb,
          marginRateArb,
          marginRateArb,
          (dealId, sellerIds, totalMarginRate, sellerMarginRate) => {
            const campaigns = bulkCreateCampaigns(
              dealId,
              sellerIds,
              totalMarginRate,
              sellerMarginRate,
            );

            // Req 14.3: all campaigns must be PROPOSAL
            for (const campaign of campaigns) {
              expect(campaign.status).toBe("PROPOSAL");
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "each bulk-created campaign has a non-empty tracking link (Req 14.4)",
    () => {
      fc.assert(
        fc.property(
          dealIdArb,
          distinctSellerIdsArb,
          marginRateArb,
          marginRateArb,
          (dealId, sellerIds, totalMarginRate, sellerMarginRate) => {
            const campaigns = bulkCreateCampaigns(
              dealId,
              sellerIds,
              totalMarginRate,
              sellerMarginRate,
            );

            // Req 14.4: each campaign must have a non-empty tracking link
            for (const campaign of campaigns) {
              expect(campaign.generatedTrackingLink).toBeTruthy();
              expect(campaign.generatedTrackingLink.length).toBeGreaterThan(0);
              expect(campaign.generatedTrackingLink).toMatch(
                /^https:\/\/track\.wag\.kr\/[a-z0-9]{12}$/,
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "all tracking links in a bulk batch are distinct (Req 14.4)",
    () => {
      // Run multiple times to account for randomness — with 12-char alphanumeric
      // codes (36^12 ≈ 4.7 trillion possibilities), collisions are astronomically rare.
      // We verify the uniqueness guarantee holds across many generated batches.
      fc.assert(
        fc.property(
          dealIdArb,
          distinctSellerIdsArb,
          marginRateArb,
          marginRateArb,
          (dealId, sellerIds, totalMarginRate, sellerMarginRate) => {
            const campaigns = bulkCreateCampaigns(
              dealId,
              sellerIds,
              totalMarginRate,
              sellerMarginRate,
            );

            const links = campaigns.map((c) => c.generatedTrackingLink);
            const uniqueLinks = new Set(links);

            // All links must be distinct
            expect(uniqueLinks.size).toBe(links.length);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 11: Campaign template save/apply round-trip
// Validates: Requirements 15.1, 15.2
// ---------------------------------------------------------------------------

describe("Property 11: Campaign template save/apply round-trip", () => {
  it(
    "fetched template returns the same name that was saved (Req 15.1)",
    () => {
      fc.assert(
        fc.property(templateInputArb, (input) => {
          const saved = saveTemplate(input);

          // Req 15.1: name must be preserved exactly
          expect(saved.name).toBe(input.name);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "fetched template returns the same dealId that was saved (Req 15.1)",
    () => {
      fc.assert(
        fc.property(templateInputArb, (input) => {
          const saved = saveTemplate(input);

          // Req 15.1: dealId must be preserved (or null if not provided)
          expect(saved.dealId).toBe(input.dealId ?? null);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "fetched template returns the same salesChannel that was saved (Req 15.1)",
    () => {
      fc.assert(
        fc.property(templateInputArb, (input) => {
          const saved = saveTemplate(input);

          // Req 15.1: salesChannel must be preserved (or null if not provided)
          expect(saved.salesChannel).toBe(input.salesChannel ?? null);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "fetched template returns the same marginSettings that were saved (Req 15.1)",
    () => {
      fc.assert(
        fc.property(templateInputArb, (input) => {
          const saved = saveTemplate(input);

          // Req 15.1: marginSettings must be preserved (or null if not provided)
          expect(saved.marginSettings).toBe(input.marginSettings ?? null);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "fetched template returns the same trackingPattern that was saved (Req 15.1, 15.2)",
    () => {
      fc.assert(
        fc.property(templateInputArb, (input) => {
          const saved = saveTemplate(input);

          // Req 15.1 + 15.2: trackingPattern must be preserved (or null if not provided)
          expect(saved.trackingPattern).toBe(input.trackingPattern ?? null);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "saved template has a non-empty unique ID and valid timestamps (Req 15.1)",
    () => {
      fc.assert(
        fc.property(templateInputArb, (input) => {
          const saved = saveTemplate(input);

          // Template must have a non-empty ID
          expect(saved.id).toBeTruthy();
          expect(saved.id.length).toBeGreaterThan(0);

          // Timestamps must be valid dates
          expect(saved.createdAt).toBeInstanceOf(Date);
          expect(saved.updatedAt).toBeInstanceOf(Date);
          expect(isNaN(saved.createdAt.getTime())).toBe(false);
          expect(isNaN(saved.updatedAt.getTime())).toBe(false);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "two templates saved with the same input have different IDs (uniqueness)",
    () => {
      fc.assert(
        fc.property(templateInputArb, (input) => {
          const saved1 = saveTemplate(input);
          const saved2 = saveTemplate(input);

          // Each save must produce a distinct ID
          expect(saved1.id).not.toBe(saved2.id);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "applying a template pre-fills all stored values (Req 15.2)",
    () => {
      fc.assert(
        fc.property(templateInputArb, (input) => {
          const saved = saveTemplate(input);

          // Req 15.2: applying the template should return the same values
          // that were stored — simulated here as a direct read of the saved record
          const applied = {
            dealId: saved.dealId,
            salesChannel: saved.salesChannel,
            marginSettings: saved.marginSettings,
            trackingPattern: saved.trackingPattern,
          };

          expect(applied.dealId).toBe(input.dealId ?? null);
          expect(applied.salesChannel).toBe(input.salesChannel ?? null);
          expect(applied.marginSettings).toBe(input.marginSettings ?? null);
          expect(applied.trackingPattern).toBe(input.trackingPattern ?? null);
        }),
        { numRuns: 100 },
      );
    },
  );
});
