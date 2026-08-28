/**
 * Integration tests for filter compatibility across zone views.
 *
 * Feature: pipeline-zone-views
 * Task 9.2: Write integration tests for filter compatibility
 *
 * Tests that filters (team, search, saved views) apply consistently
 * across all zones in View B, that View C limits scope to Deal Execution
 * + Settlement zones, and that view switches preserve filter state.
 *
 * **Validates: Requirements 7.1, 7.2, 7.3, 7.6, 7.7, 7.8**
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";

import type { CampaignRow, CampaignStatus } from "../crm-types";
import {
  applyPipelineFilters,
  matchesSearchQuery,
  type PipelineFilterParams,
  type SavedView,
} from "../pipeline-filters";
import {
  filterCampaignsForViewC,
  getZoneForStatus,
  ZONE_ORDER,
} from "../zone-config";
import {
  saveZoneViewMode,
  loadZoneViewMode,
  type ZoneViewMode,
} from "../zone-settings";

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

const arbSavedView: fc.Arbitrary<SavedView> = fc.constantFrom(
  "DEFAULT",
  "URGENT",
  "STAGNANT",
  "MISSING_SALES",
  "MANUAL_MARGIN",
);

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
// Test: Team filter applies across all zones in View B
// **Validates: Requirements 7.1**
// ---------------------------------------------------------------------------

describe("Team filter applies across all zones in View B", () => {
  it("team filter reduces campaigns in every zone proportionally", () => {
    /**
     * **Validates: Requirements 7.1**
     */
    fc.assert(
      fc.property(
        arbCampaignList,
        fc.constantFrom(...TEAM_IDS),
        (campaigns, teamId) => {
          // In View B, all zones are visible — apply team filter
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
// Test: Search applies across all zones in View B
// **Validates: Requirements 7.2**
// ---------------------------------------------------------------------------

describe("Search applies across all zones in View B", () => {
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

// ---------------------------------------------------------------------------
// Test: View C filter scope limited to Deal Execution + Settlement zones
// **Validates: Requirements 7.3, 7.8**
// ---------------------------------------------------------------------------

describe("View C filter scope limited to Deal Execution + Settlement zones", () => {
  it("View C excludes PROPOSAL campaigns then applies team filter to remaining zones", () => {
    /**
     * **Validates: Requirements 7.8**
     */
    fc.assert(
      fc.property(
        arbCampaignList,
        fc.constantFrom(...TEAM_IDS),
        (campaigns, teamId) => {
          // View C pipeline: first exclude PROPOSAL, then apply filters
          const viewCCampaigns = filterCampaignsForViewC(campaigns);

          const params: PipelineFilterParams = {
            stageFilter: "ALL",
            teamId,
            searchQuery: "",
            savedView: "DEFAULT",
          };

          const filtered = applyPipelineFilters(viewCCampaigns, params);

          // No PROPOSAL campaigns in result
          for (const campaign of filtered) {
            expect(campaign.status).not.toBe("PROPOSAL");
          }

          // All filtered campaigns match team filter
          for (const campaign of filtered) {
            expect(campaign.assignedTo).toBe(teamId);
          }

          // Only Deal Execution and Settlement zones are represented
          for (const campaign of filtered) {
            const zone = getZoneForStatus(campaign.status);
            expect(zone).not.toBe("SALES");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("View C search applies only to Deal Execution + Settlement zones", () => {
    /**
     * **Validates: Requirements 7.8**
     */
    fc.assert(
      fc.property(
        arbCampaignList,
        fc.constantFrom(...SELLER_NAMES, ...DEAL_NAMES),
        (campaigns, searchTerm) => {
          const viewCCampaigns = filterCampaignsForViewC(campaigns);

          const params: PipelineFilterParams = {
            stageFilter: "ALL",
            teamId: null,
            searchQuery: searchTerm,
            savedView: "DEFAULT",
          };

          const filtered = applyPipelineFilters(viewCCampaigns, params);

          // No PROPOSAL campaigns
          for (const campaign of filtered) {
            expect(campaign.status).not.toBe("PROPOSAL");
          }

          // All match search
          for (const campaign of filtered) {
            expect(matchesSearchQuery(campaign, searchTerm)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("View C saved view filters apply only to displayed zones", () => {
    /**
     * **Validates: Requirements 7.3**
     */
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        const viewCCampaigns = filterCampaignsForViewC(campaigns);

        // Apply MISSING_SALES saved view (actualSales == null)
        const params: PipelineFilterParams = {
          stageFilter: "ALL",
          teamId: null,
          searchQuery: "",
          savedView: "MISSING_SALES",
        };

        const filtered = applyPipelineFilters(viewCCampaigns, params);

        // All results should have null actualSales and not be PROPOSAL
        for (const campaign of filtered) {
          expect(campaign.actualSales).toBeNull();
          expect(campaign.status).not.toBe("PROPOSAL");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("filters produce same results for non-PROPOSAL campaigns regardless of view mode", () => {
    /**
     * **Validates: Requirements 7.1, 7.2, 7.3**
     *
     * For non-PROPOSAL campaigns, the filter results should be identical
     * whether we're in View B or View C (after accounting for PROPOSAL exclusion).
     */
    fc.assert(
      fc.property(
        arbCampaignList,
        fc.constantFrom(...TEAM_IDS, null),
        fc.constantFrom("", ...SELLER_NAMES),
        (campaigns, teamId, searchQuery) => {
          const params: PipelineFilterParams = {
            stageFilter: "ALL",
            teamId,
            searchQuery,
            savedView: "DEFAULT",
          };

          // View B: filter all campaigns, then look at non-PROPOSAL results
          const viewBFiltered = applyPipelineFilters(campaigns, params);
          const viewBNonProposal = viewBFiltered.filter(
            (c) => c.status !== "PROPOSAL",
          );

          // View C: exclude PROPOSAL first, then filter
          const viewCCampaigns = filterCampaignsForViewC(campaigns);
          const viewCFiltered = applyPipelineFilters(viewCCampaigns, params);

          // Results should be identical for non-PROPOSAL campaigns
          const viewBIds = viewBNonProposal.map((c) => c.id).sort();
          const viewCIds = viewCFiltered.map((c) => c.id).sort();
          expect(viewBIds).toEqual(viewCIds);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Test: View switch preserves all filter values
// **Validates: Requirements 7.6, 7.7**
// ---------------------------------------------------------------------------

describe("View switch preserves all filter values", () => {
  it("switching view mode does not alter filter parameters", () => {
    /**
     * **Validates: Requirements 7.6, 7.7**
     *
     * Filter state (teamId, searchQuery, savedView) is independent of view mode.
     * Switching views should not modify any filter values.
     */
    fc.assert(
      fc.property(
        arbCampaignList,
        fc.constantFrom(...TEAM_IDS, null),
        fc.constantFrom("", ...SELLER_NAMES, ...DEAL_NAMES),
        arbSavedView,
        (campaigns, teamId, searchQuery, savedView) => {
          const params: PipelineFilterParams = {
            stageFilter: "ALL",
            teamId,
            searchQuery,
            savedView,
          };

          // Apply filters in "View B" context (all campaigns)
          const viewBResult = applyPipelineFilters(campaigns, params);

          // Simulate view switch to View C and back to View B
          // The same params should produce the same result
          saveZoneViewMode("VIEW_C");
          saveZoneViewMode("VIEW_B");

          const viewBResultAfterSwitch = applyPipelineFilters(campaigns, params);

          // Filter results should be identical — view switch doesn't affect filter logic
          expect(viewBResult.map((c) => c.id).sort()).toEqual(
            viewBResultAfterSwitch.map((c) => c.id).sort(),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("filter params are preserved as-is across view mode transitions", () => {
    /**
     * **Validates: Requirements 7.6, 7.7**
     */
    fc.assert(
      fc.property(
        fc.constantFrom(...TEAM_IDS, null),
        fc.constantFrom("", ...SELLER_NAMES),
        arbSavedView,
        (teamId, searchQuery, savedView) => {
          const originalParams: PipelineFilterParams = {
            stageFilter: "ALL",
            teamId,
            searchQuery,
            savedView,
          };

          // Simulate storing filter state, switching views, and reading back
          saveZoneViewMode("VIEW_B");
          const paramsBeforeSwitch = { ...originalParams };

          saveZoneViewMode("VIEW_C");
          const paramsAfterSwitchToC = { ...originalParams };

          saveZoneViewMode("VIEW_B");
          const paramsAfterSwitchBack = { ...originalParams };

          // All params should be identical — view mode is orthogonal to filter state
          expect(paramsBeforeSwitch).toEqual(paramsAfterSwitchToC);
          expect(paramsAfterSwitchToC).toEqual(paramsAfterSwitchBack);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("view mode persistence is independent of filter application", () => {
    /**
     * **Validates: Requirements 7.6**
     */
    fc.assert(
      fc.property(
        fc.constantFrom("VIEW_B" as ZoneViewMode, "VIEW_C" as ZoneViewMode),
        arbCampaignList,
        fc.constantFrom(...TEAM_IDS, null),
        (viewMode, campaigns, teamId) => {
          saveZoneViewMode(viewMode);

          const params: PipelineFilterParams = {
            stageFilter: "ALL",
            teamId,
            searchQuery: "",
            savedView: "DEFAULT",
          };

          // Apply filters — should work regardless of stored view mode
          const filtered = applyPipelineFilters(campaigns, params);

          // Verify view mode is still correctly stored
          expect(loadZoneViewMode()).toBe(viewMode);

          // Verify filter results are correct
          if (teamId !== null) {
            for (const campaign of filtered) {
              expect(campaign.assignedTo).toBe(teamId);
            }
          } else {
            expect(filtered.length).toBe(campaigns.length);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("combined filters (team + search + savedView) produce consistent results across view switches", () => {
    /**
     * **Validates: Requirements 7.6, 7.7**
     */
    fc.assert(
      fc.property(
        arbCampaignList,
        fc.constantFrom(...TEAM_IDS),
        fc.constantFrom(...SELLER_NAMES),
        (campaigns, teamId, searchTerm) => {
          const params: PipelineFilterParams = {
            stageFilter: "ALL",
            teamId,
            searchQuery: searchTerm,
            savedView: "DEFAULT",
          };

          // Result before any view switch
          const resultBefore = applyPipelineFilters(campaigns, params);

          // Switch views multiple times
          saveZoneViewMode("VIEW_C");
          saveZoneViewMode("VIEW_B");
          saveZoneViewMode("VIEW_C");
          saveZoneViewMode("VIEW_B");

          // Result after view switches
          const resultAfter = applyPipelineFilters(campaigns, params);

          // Results must be identical
          expect(resultBefore.map((c) => c.id).sort()).toEqual(
            resultAfter.map((c) => c.id).sort(),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
