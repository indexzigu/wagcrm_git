// @vitest-environment jsdom
/**
 * Integration tests for filter compatibility across zones.
 *
 * Feature: pipeline-zone-views
 * Task 9.2: Write integration tests for filter compatibility
 *
 * Tests that filters (team, search, saved views) apply consistently
 * across all pipeline zones.
 *
 * **Validates: Requirements 7.1, 7.2**
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";

import type { CampaignRow, CampaignStatus } from "../crm-types";
import {
  applyPipelineFilters,
  matchesSearchQuery,
  type PipelineFilterParams,
} from "../pipeline-filters";
import {
  getZoneForStatus,
  ZONE_ORDER,
} from "../zone-config";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const ALL_STATUSES: CampaignStatus[] = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "COMPLETED",
];

const arbCampaignStatus: fc.Arbitrary<CampaignStatus> = fc.constantFrom(...ALL_STATUSES);

const TEAM_IDS = ["team-alpha", "team-beta", "team-gamma", "team-delta"];
const SELLER_NAMES = ["김셀러", "이판매", "박인플", "최크리", "정마케"];
const DEAL_NAMES = ["글로우앰플", "비타민세럼", "선크림", "클렌저", "토너패드"];
const PARTNER_NAMES = ["코링코", "뷰티랩", "스킨팩토리", "더마솔루션"];

/** Generates a CampaignRow with controllable fields for filter testing. */
function arbCampaignRowForFilters(): fc.Arbitrary<CampaignRow> {
  return fc
    .record({
      id: fc.uuid(),
      status: arbCampaignStatus,
      assignedTo: fc.constantFrom(...TEAM_IDS, null),
      sellerName: fc.constantFrom(...SELLER_NAMES),
      dealName: fc.constantFrom(...DEAL_NAMES),
      partnerName: fc.constantFrom(...PARTNER_NAMES),
      actualSales: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 10000000 })),
      isManualMargin: fc.boolean(),
      startDate: fc.constantFrom("2025-01-01", "2025-03-15", "2025-06-20", "2024-12-01"),
      endDate: fc.constantFrom("2025-02-01", "2025-04-15", "2025-07-20", "2025-01-01"),
    })
    .map(({ id, status, assignedTo, sellerName, dealName, partnerName, actualSales, isManualMargin, startDate, endDate }) => ({
      id,
      dealId: "deal-1",
      sellerId: "seller-1",
      campaignName: `${dealName} ${sellerName}`,
      dealName,
      partnerName,
      sellerName,
      snsType: "INSTAGRAM" as const,
      snsHandle: "@test",
      startDate,
      endDate,
      salesChannel: "OWN_MALL" as const,
      baseNaverLink: "",
      generatedTrackingLink: "",
      actualSales,
      totalMarginRate: 30,
      sellerMarginRate: 15,
      netMarginRate: 15,
      status,
      isManualMargin,
      assignedTo,
      updatedAt: "2025-01-01T00:00:00Z",
      followerHistory: [],
      activityHistory: [],
      notes: [],
    }));
}

const arbCampaignList: fc.Arbitrary<CampaignRow[]> = fc.array(
  arbCampaignRowForFilters(),
  { minLength: 0, maxLength: 30 },
);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Test: Team filter applies across all zones
// **Validates: Requirements 7.1**
// ---------------------------------------------------------------------------

describe("Team filter applies across all zones", () => {
  it("team filter reduces campaigns in every zone proportionally", () => {
    /**
     * **Validates: Requirements 7.1**
     */
    fc.assert(
      fc.property(
        arbCampaignList,
        fc.constantFrom(...TEAM_IDS),
        (campaigns, teamId) => {
          // All zones are visible — apply team filter
          const params: PipelineFilterParams = {
            stageFilter: "ALL",
            teamId,
            searchQuery: "",
            savedView: "DEFAULT",
          };

          const filtered = applyPipelineFilters(campaigns, params);

          // Every filtered campaign must match the team filter
          for (const campaign of filtered) {
            expect(campaign.assignedTo).toBe(teamId);
          }

          // Filtered campaigns should span all zones that had matching campaigns
          for (const zone of ZONE_ORDER) {
            const zoneFiltered = filtered.filter(
              (c) => getZoneForStatus(c.status) === zone,
            );
            const zoneOriginalMatching = campaigns.filter(
              (c) => getZoneForStatus(c.status) === zone && c.assignedTo === teamId,
            );
            expect(zoneFiltered.length).toBe(zoneOriginalMatching.length);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("null team filter passes all campaigns in all zones", () => {
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        const params: PipelineFilterParams = {
          stageFilter: "ALL",
          teamId: null,
          searchQuery: "",
          savedView: "DEFAULT",
        };

        const filtered = applyPipelineFilters(campaigns, params);
        expect(filtered.length).toBe(campaigns.length);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Test: Search applies across all zones
// **Validates: Requirements 7.2**
// ---------------------------------------------------------------------------

describe("Search applies across all zones", () => {
  it("search query filters campaigns across all zones by sellerName, dealName, partnerName", () => {
    /**
     * **Validates: Requirements 7.2**
     */
    fc.assert(
      fc.property(
        arbCampaignList,
        fc.constantFrom(...SELLER_NAMES, ...DEAL_NAMES, ...PARTNER_NAMES),
        (campaigns, searchTerm) => {
          const params: PipelineFilterParams = {
            stageFilter: "ALL",
            teamId: null,
            searchQuery: searchTerm,
            savedView: "DEFAULT",
          };

          const filtered = applyPipelineFilters(campaigns, params);

          // Every filtered campaign must match the search query
          for (const campaign of filtered) {
            const matches = matchesSearchQuery(campaign, searchTerm);
            expect(matches).toBe(true);
          }

          // Search applies across all zones — verify zone coverage
          for (const zone of ZONE_ORDER) {
            const zoneFiltered = filtered.filter(
              (c) => getZoneForStatus(c.status) === zone,
            );
            const zoneOriginalMatching = campaigns.filter(
              (c) =>
                getZoneForStatus(c.status) === zone &&
                matchesSearchQuery(c, searchTerm),
            );
            expect(zoneFiltered.length).toBe(zoneOriginalMatching.length);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("empty search query passes all campaigns", () => {
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        const params: PipelineFilterParams = {
          stageFilter: "ALL",
          teamId: null,
          searchQuery: "",
          savedView: "DEFAULT",
        };

        const filtered = applyPipelineFilters(campaigns, params);
        expect(filtered.length).toBe(campaigns.length);
      }),
      { numRuns: 100 },
    );
  });
});
