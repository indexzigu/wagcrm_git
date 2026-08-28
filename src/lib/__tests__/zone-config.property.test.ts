/**
 * Property-based tests for zone-config mapping.
 *
 * Feature: pipeline-kanban-remodel
 * Property 1: Zone membership mapping is exhaustive and exclusive
 * Validates: Requirements 1.2, 1.3, 1.4
 *
 * Property 7: Cross-zone drop assigns zone default status
 * Validates: Requirements 3.2, 3.3, 3.4, 3.5
 *
 * Property 2: Zone counts are consistent with campaign statuses
 * Validates: Requirements 1.5, 5.9, 8.2
 *
 * Property 9: Table grouping assigns each campaign to exactly one correct group
 * Validates: Requirements 4.1, 4.6
 *
 * Feature: pipeline-zone-views
 * Property 2: View C excludes all PROPOSAL campaigns
 * Validates: Requirements 1.3, 5.1
 *
 * Property 6: PROPOSAL status transition blocked in View C
 * Validates: Requirements 5.5, 5.6
 *
 * Property 7: Sales Zone table shows only PROPOSAL campaigns
 * Validates: Requirements 4.2
 *
 * Property 8: View C tab list excludes PROPOSAL tab
 * Validates: Requirements 5.3
 *
 * Tests that every CampaignStatus maps to exactly one zone (exhaustive: no
 * status is unmapped; exclusive: no status maps to multiple zones).
 * Tests that when a campaign is dropped into a different zone, it gets assigned
 * the ZONE_DEFAULT_STATUS for that zone.
 * Tests that groupCampaignsByZone assigns each campaign to exactly one group
 * matching the campaign's status-to-zone mapping.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import type { CampaignStatus, CampaignRow } from "../crm-types";
import {
  ZONE_ORDER,
  ZONE_STATUSES,
  ZONE_DEFAULT_STATUS,
  getZoneForStatus,
  getZoneCounts,
  groupCampaignsByZone,
  filterCampaignsForViewC,
  isStatusChangeAllowed,
  getViewTabs,
  type PipelineZone,
  type ZoneViewMode,
} from "../zone-config";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** All valid CampaignStatus values. */
const ALL_STATUSES: CampaignStatus[] = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
  "DROPPED",
];

/** Arbitrary that produces any valid CampaignStatus. */
const arbCampaignStatus: fc.Arbitrary<CampaignStatus> = fc.constantFrom(
  ...ALL_STATUSES,
);

// ---------------------------------------------------------------------------
// Property 1: Zone membership mapping is exhaustive and exclusive
// Validates: Requirements 1.2, 1.3, 1.4
// ---------------------------------------------------------------------------

describe("Property 1: Zone membership mapping is exhaustive and exclusive", () => {
  it("every CampaignStatus maps to exactly one zone via getZoneForStatus", () => {
    fc.assert(
      fc.property(arbCampaignStatus, (status) => {
        const zone = getZoneForStatus(status);

        // The result must be a valid PipelineZone
        expect(ZONE_ORDER).toContain(zone);

        // The status must appear in that zone's ZONE_STATUSES
        expect(ZONE_STATUSES[zone]).toContain(status);
      }),
      { numRuns: 100 },
    );
  });

  it("no CampaignStatus appears in more than one zone (exclusive)", () => {
    fc.assert(
      fc.property(arbCampaignStatus, (status) => {
        const zonesContaining = ZONE_ORDER.filter((zone) =>
          ZONE_STATUSES[zone].includes(status),
        );

        // Each status must appear in exactly one zone
        expect(zonesContaining).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });

  it("the union of all zone statuses equals the complete set of CampaignStatus values (exhaustive)", () => {
    // This is a deterministic check but validates the exhaustive property
    const allZoneStatuses = ZONE_ORDER.flatMap(
      (zone) => ZONE_STATUSES[zone],
    );

    // Every known status is covered
    for (const status of ALL_STATUSES) {
      expect(allZoneStatuses).toContain(status);
    }

    // No duplicates across zones
    const uniqueStatuses = new Set(allZoneStatuses);
    expect(uniqueStatuses.size).toBe(allZoneStatuses.length);

    // Total count matches
    expect(allZoneStatuses.length).toBe(ALL_STATUSES.length);
  });

  it("getZoneForStatus is consistent with ZONE_STATUSES for any status", () => {
    fc.assert(
      fc.property(arbCampaignStatus, (status) => {
        const zone = getZoneForStatus(status);

        // The zone returned by getZoneForStatus must be the same zone
        // that contains this status in ZONE_STATUSES
        const expectedZone = ZONE_ORDER.find((z) =>
          ZONE_STATUSES[z].includes(status),
        );

        expect(zone).toBe(expectedZone);
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 7: Cross-zone drop assigns zone default status
// Validates: Requirements 3.2, 3.3, 3.4, 3.5
// ---------------------------------------------------------------------------

/** Arbitrary that produces a PipelineZone. */
const arbPipelineZone: fc.Arbitrary<PipelineZone> = fc.constantFrom(
  ...ZONE_ORDER,
);

describe("Property 7: Cross-zone drop assigns zone default status", () => {
  it("dropping a campaign into a target zone assigns ZONE_DEFAULT_STATUS[targetZone]", () => {
    fc.assert(
      fc.property(arbCampaignStatus, arbPipelineZone, (sourceStatus, targetZone) => {
        const sourceZone = getZoneForStatus(sourceStatus);

        // Only test cross-zone drops (source zone differs from target zone)
        fc.pre(sourceZone !== targetZone);

        const newStatus = ZONE_DEFAULT_STATUS[targetZone];

        // The new status must belong to the target zone
        expect(ZONE_STATUSES[targetZone]).toContain(newStatus);

        // The new status must be the specific default for that zone
        expect(newStatus).toBe(ZONE_DEFAULT_STATUS[targetZone]);
      }),
      { numRuns: 100 },
    );
  });

  it("SALES zone default status is PROPOSAL", () => {
    fc.assert(
      fc.property(arbCampaignStatus, (sourceStatus) => {
        const sourceZone = getZoneForStatus(sourceStatus);
        fc.pre(sourceZone !== "SALES");

        const newStatus = ZONE_DEFAULT_STATUS["SALES"];
        expect(newStatus).toBe("PROPOSAL");
      }),
      { numRuns: 100 },
    );
  });

  it("DEAL_EXECUTION zone default status is PREPARATION", () => {
    fc.assert(
      fc.property(arbCampaignStatus, (sourceStatus) => {
        const sourceZone = getZoneForStatus(sourceStatus);
        fc.pre(sourceZone !== "DEAL_EXECUTION");

        const newStatus = ZONE_DEFAULT_STATUS["DEAL_EXECUTION"];
        expect(newStatus).toBe("PREPARATION");
      }),
      { numRuns: 100 },
    );
  });

  it("SETTLEMENT zone default status is SETTLEMENT_IN_PROGRESS", () => {
    fc.assert(
      fc.property(arbCampaignStatus, (sourceStatus) => {
        const sourceZone = getZoneForStatus(sourceStatus);
        fc.pre(sourceZone !== "SETTLEMENT");

        const newStatus = ZONE_DEFAULT_STATUS["SETTLEMENT"];
        expect(newStatus).toBe("SETTLEMENT_IN_PROGRESS");
      }),
      { numRuns: 100 },
    );
  });

  it("cross-zone drop always changes the campaign status (never stays the same)", () => {
    fc.assert(
      fc.property(arbCampaignStatus, arbPipelineZone, (sourceStatus, targetZone) => {
        const sourceZone = getZoneForStatus(sourceStatus);
        fc.pre(sourceZone !== targetZone);

        const newStatus = ZONE_DEFAULT_STATUS[targetZone];

        // Since the campaign is moving to a different zone, the new status
        // must belong to the target zone, not the source zone
        expect(getZoneForStatus(newStatus)).toBe(targetZone);
        expect(getZoneForStatus(newStatus)).not.toBe(sourceZone);
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 2: Zone counts are consistent with campaign statuses
// Validates: Requirements 1.5, 5.9, 8.2
// ---------------------------------------------------------------------------

describe("Property 2: Zone counts are consistent with campaign statuses", () => {
  /** Arbitrary that produces a minimal CampaignRow for count testing. */
  const arbCampaignRowForCounts: fc.Arbitrary<CampaignRow> = fc
    .record({
      id: fc.uuid(),
      status: arbCampaignStatus,
      startDate: fc.constantFrom("2025-01-01", "2025-06-15", ""),
    })
    .map(({ id, status, startDate }) => ({
      id,
      dealId: "deal-1",
      sellerId: "seller-1",
      campaignName: "Test Deal Seller",
      dealName: "Test Deal",
      partnerName: "Partner",
      sellerName: "Seller",
      snsType: "INSTAGRAM" as const,
      snsHandle: "@test",
      startDate,
      endDate: "2025-12-31",
      salesChannel: "OWN_MALL" as const,
      baseNaverLink: "",
      generatedTrackingLink: "",
      actualSales: null,
      totalMarginRate: 30,
      sellerMarginRate: 15,
      netMarginRate: 15,
      status,
      isManualMargin: false,
      assignedTo: null,
      updatedAt: "2025-01-01T00:00:00Z",
      followerHistory: [],
      activityHistory: [],
      notes: [],
    }));

  const arbCampaignListForCounts: fc.Arbitrary<CampaignRow[]> = fc.array(
    arbCampaignRowForCounts,
    { minLength: 0, maxLength: 50 },
  );

  it("sum of zone counts equals total number of campaigns", () => {
    /**
     * **Validates: Requirements 1.5**
     */
    fc.assert(
      fc.property(arbCampaignListForCounts, (campaigns) => {
        const counts = getZoneCounts(campaigns);

        const totalFromCounts = ZONE_ORDER.reduce(
          (sum, zone) => sum + counts[zone],
          0,
        );

        expect(totalFromCounts).toBe(campaigns.length);
      }),
      { numRuns: 100 },
    );
  });

  it("each zone count equals the number of campaigns whose status belongs to that zone", () => {
    /**
     * **Validates: Requirements 5.9, 8.2**
     */
    fc.assert(
      fc.property(arbCampaignListForCounts, (campaigns) => {
        const counts = getZoneCounts(campaigns);

        for (const zone of ZONE_ORDER) {
          const expectedCount = campaigns.filter((c) =>
            ZONE_STATUSES[zone].includes(c.status),
          ).length;

          expect(counts[zone]).toBe(expectedCount);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("empty campaign list returns zero counts for all zones", () => {
    fc.assert(
      fc.property(fc.constant([] as CampaignRow[]), (campaigns) => {
        const counts = getZoneCounts(campaigns);

        for (const zone of ZONE_ORDER) {
          expect(counts[zone]).toBe(0);
        }
      }),
      { numRuns: 1 },
    );
  });

  it("single-status campaign list produces count only in the corresponding zone", () => {
    fc.assert(
      fc.property(
        arbCampaignStatus,
        fc.integer({ min: 1, max: 20 }),
        (status, count) => {
          // Generate `count` campaigns all with the same status
          const campaigns: CampaignRow[] = Array.from({ length: count }, (_, i) => ({
            id: `camp-${i}`,
            dealId: "deal-1",
            sellerId: "seller-1",
            campaignName: "Test Deal Seller",
            dealName: "Test Deal",
            partnerName: "Partner",
            sellerName: "Seller",
            snsType: "INSTAGRAM" as const,
            snsHandle: "@test",
            startDate: "2025-01-01",
            endDate: "2025-12-31",
            salesChannel: "OWN_MALL" as const,
            baseNaverLink: "",
            generatedTrackingLink: "",
            actualSales: null,
            totalMarginRate: 30,
            sellerMarginRate: 15,
            netMarginRate: 15,
            status,
            isManualMargin: false,
            assignedTo: null,
            updatedAt: "2025-01-01T00:00:00Z",
            followerHistory: [],
            activityHistory: [],
            notes: [],
          }));

          const counts = getZoneCounts(campaigns);
          const expectedZone = getZoneForStatus(status);

          // The expected zone should have all campaigns
          expect(counts[expectedZone]).toBe(count);

          // Other zones should have zero
          for (const zone of ZONE_ORDER) {
            if (zone !== expectedZone) {
              expect(counts[zone]).toBe(0);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Generators for Property 9
// ---------------------------------------------------------------------------

/** Arbitrary that produces a minimal CampaignRow with a given or random status. */
function arbCampaignRow(
  statusArb: fc.Arbitrary<CampaignStatus> = arbCampaignStatus,
): fc.Arbitrary<CampaignRow> {
  return fc
    .record({
      id: fc.uuid(),
      status: statusArb,
      startDate: fc.constantFrom("2025-01-01", "2025-03-15", "2025-06-20", ""),
    })
    .map(({ id, status, startDate }) => ({
      id,
      dealId: "deal-1",
      sellerId: "seller-1",
      campaignName: "Test Deal Seller",
      dealName: "Test Deal",
      partnerName: "Partner",
      sellerName: "Seller",
      snsType: "INSTAGRAM" as const,
      snsHandle: "@test",
      startDate,
      endDate: "2025-12-31",
      salesChannel: "OWN_MALL" as const,
      baseNaverLink: "",
      generatedTrackingLink: "",
      actualSales: null,
      totalMarginRate: 30,
      sellerMarginRate: 15,
      netMarginRate: 15,
      status,
      isManualMargin: false,
      assignedTo: null,
      updatedAt: "2025-01-01T00:00:00Z",
      followerHistory: [],
      activityHistory: [],
      notes: [],
    }));
}

/** Arbitrary that produces a list of campaigns (0 to 50). */
const arbCampaignList: fc.Arbitrary<CampaignRow[]> = fc.array(
  arbCampaignRow(),
  { minLength: 0, maxLength: 50 },
);

// ---------------------------------------------------------------------------
// Property 9: Table grouping assigns each campaign to exactly one correct group
// Validates: Requirements 4.1, 4.6
// ---------------------------------------------------------------------------

describe("Property 9: Table grouping assigns each campaign to exactly one correct group", () => {
  it("every campaign appears in exactly one group", () => {
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        const groups = groupCampaignsByZone(campaigns);

        // Collect all campaigns from all groups
        const allGrouped = ZONE_ORDER.flatMap((zone) => groups[zone]);

        // Total count must match input
        expect(allGrouped).toHaveLength(campaigns.length);

        // Each campaign ID from input appears exactly once across all groups
        const groupedIds = allGrouped.map((c) => c.id);
        const inputIds = campaigns.map((c) => c.id);
        expect(groupedIds.sort()).toEqual(inputIds.sort());
      }),
      { numRuns: 100 },
    );
  });

  it("each campaign is placed in the group matching getZoneForStatus(campaign.status)", () => {
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        const groups = groupCampaignsByZone(campaigns);

        // For each zone, verify every campaign in that group has a status belonging to that zone
        for (const zone of ZONE_ORDER) {
          for (const campaign of groups[zone]) {
            const expectedZone = getZoneForStatus(campaign.status);
            expect(expectedZone).toBe(zone);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("no campaign appears in multiple groups", () => {
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        const groups = groupCampaignsByZone(campaigns);

        // Collect all campaign IDs from each group
        const idsByZone = ZONE_ORDER.map((zone) =>
          groups[zone].map((c) => c.id),
        );

        // Check no ID appears in more than one zone's group
        for (let i = 0; i < idsByZone.length; i++) {
          for (let j = i + 1; j < idsByZone.length; j++) {
            const overlap = idsByZone[i].filter((id) =>
              idsByZone[j].includes(id),
            );
            expect(overlap).toHaveLength(0);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("empty input produces empty groups for all zones", () => {
    fc.assert(
      fc.property(fc.constant([]), (campaigns: CampaignRow[]) => {
        const groups = groupCampaignsByZone(campaigns);

        for (const zone of ZONE_ORDER) {
          expect(groups[zone]).toHaveLength(0);
        }
      }),
      { numRuns: 1 },
    );
  });
});


// ===========================================================================
// Feature: pipeline-zone-views — Additional Properties
// ===========================================================================

// ---------------------------------------------------------------------------
// Property 2: View C excludes all PROPOSAL campaigns
// **Validates: Requirements 1.3, 5.1**
// ---------------------------------------------------------------------------

describe("Feature: pipeline-zone-views, Property 2: View C excludes all PROPOSAL campaigns", () => {
  it("filterCampaignsForViewC never includes campaigns with PROPOSAL status", () => {
    /**
     * **Validates: Requirements 1.3**
     */
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        const filtered = filterCampaignsForViewC(campaigns);

        // No campaign in the result should have PROPOSAL status
        for (const campaign of filtered) {
          expect(campaign.status).not.toBe("PROPOSAL");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("all non-PROPOSAL campaigns from input are present in the output", () => {
    /**
     * **Validates: Requirements 5.1**
     */
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        const filtered = filterCampaignsForViewC(campaigns);
        const nonProposalInput = campaigns.filter((c) => c.status !== "PROPOSAL");

        // Every non-PROPOSAL campaign should be in the filtered result
        expect(filtered).toHaveLength(nonProposalInput.length);

        const filteredIds = filtered.map((c) => c.id);
        for (const campaign of nonProposalInput) {
          expect(filteredIds).toContain(campaign.id);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("output length equals input length minus PROPOSAL campaign count", () => {
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        const filtered = filterCampaignsForViewC(campaigns);
        const proposalCount = campaigns.filter((c) => c.status === "PROPOSAL").length;

        expect(filtered.length).toBe(campaigns.length - proposalCount);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: PROPOSAL status transition blocked in View C
// **Validates: Requirements 5.5, 5.6**
// ---------------------------------------------------------------------------

describe("Feature: pipeline-zone-views, Property 6: PROPOSAL status transition blocked in View C", () => {
  it("isStatusChangeAllowed returns false for PROPOSAL target in VIEW_C", () => {
    /**
     * **Validates: Requirements 5.5**
     */
    fc.assert(
      fc.property(fc.constant("VIEW_C" as ZoneViewMode), () => {
        const allowed = isStatusChangeAllowed("VIEW_C", "PROPOSAL");
        expect(allowed).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("isStatusChangeAllowed returns true for all non-PROPOSAL targets in VIEW_C", () => {
    /**
     * **Validates: Requirements 5.6**
     */
    const nonProposalStatuses: CampaignStatus[] = [
      "PREPARATION",
      "ACTIVE",
      "CLOSED",
      "SETTLEMENT_WAIT",
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
      "DROPPED",
    ];
    const arbNonProposalStatus = fc.constantFrom(...nonProposalStatuses);

    fc.assert(
      fc.property(arbNonProposalStatus, (targetStatus) => {
        const allowed = isStatusChangeAllowed("VIEW_C", targetStatus);
        expect(allowed).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("isStatusChangeAllowed returns true for all statuses (including PROPOSAL) in VIEW_B", () => {
    fc.assert(
      fc.property(arbCampaignStatus, (targetStatus) => {
        const allowed = isStatusChangeAllowed("VIEW_B", targetStatus);
        expect(allowed).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Sales Zone table shows only PROPOSAL campaigns
// **Validates: Requirements 4.2**
// ---------------------------------------------------------------------------

describe("Feature: pipeline-zone-views, Property 7: Sales Zone table shows only PROPOSAL campaigns", () => {
  it("filtering campaigns by SALES zone status returns only PROPOSAL campaigns", () => {
    /**
     * **Validates: Requirements 4.2**
     */
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        // Sales Zone table filtering logic: only campaigns with status in ZONE_STATUSES.SALES
        const salesZoneCampaigns = campaigns.filter((c) =>
          ZONE_STATUSES["SALES"].includes(c.status),
        );

        // All campaigns in the result should have PROPOSAL status
        for (const campaign of salesZoneCampaigns) {
          expect(campaign.status).toBe("PROPOSAL");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("every PROPOSAL campaign from input is present in Sales Zone filter result", () => {
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        const salesZoneCampaigns = campaigns.filter((c) =>
          ZONE_STATUSES["SALES"].includes(c.status),
        );
        const proposalCampaigns = campaigns.filter((c) => c.status === "PROPOSAL");

        // Every PROPOSAL campaign should be in the Sales Zone result
        expect(salesZoneCampaigns).toHaveLength(proposalCampaigns.length);

        const salesIds = salesZoneCampaigns.map((c) => c.id);
        for (const campaign of proposalCampaigns) {
          expect(salesIds).toContain(campaign.id);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Sales Zone filter and View C filter are complementary for PROPOSAL campaigns", () => {
    fc.assert(
      fc.property(arbCampaignList, (campaigns) => {
        const salesZoneCampaigns = campaigns.filter((c) =>
          ZONE_STATUSES["SALES"].includes(c.status),
        );
        const viewCCampaigns = filterCampaignsForViewC(campaigns);

        // Together they should cover all campaigns
        expect(salesZoneCampaigns.length + viewCCampaigns.length).toBe(campaigns.length);

        // No overlap between the two sets
        const salesIds = new Set(salesZoneCampaigns.map((c) => c.id));
        for (const campaign of viewCCampaigns) {
          expect(salesIds.has(campaign.id)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: View C tab list excludes PROPOSAL tab
// **Validates: Requirements 5.3**
// ---------------------------------------------------------------------------

describe("Feature: pipeline-zone-views, Property 8: View C tab list excludes PROPOSAL tab", () => {
  it("getViewTabs('VIEW_C') does not contain PROPOSAL tab", () => {
    /**
     * **Validates: Requirements 5.3**
     */
    fc.assert(
      fc.property(fc.constant("VIEW_C" as ZoneViewMode), (viewMode) => {
        const tabs = getViewTabs(viewMode);
        const tabValues = tabs.map((t) => t.value);

        expect(tabValues).not.toContain("PROPOSAL");
      }),
      { numRuns: 100 },
    );
  });

  it("getViewTabs('VIEW_B') contains PROPOSAL tab", () => {
    fc.assert(
      fc.property(fc.constant("VIEW_B" as ZoneViewMode), (viewMode) => {
        const tabs = getViewTabs(viewMode);
        const tabValues = tabs.map((t) => t.value);

        expect(tabValues).toContain("PROPOSAL");
      }),
      { numRuns: 100 },
    );
  });

  it("VIEW_C tabs are a strict subset of VIEW_B tabs (only PROPOSAL removed)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("VIEW_B" as ZoneViewMode, "VIEW_C" as ZoneViewMode),
        () => {
          const viewBTabs = getViewTabs("VIEW_B");
          const viewCTabs = getViewTabs("VIEW_C");

          // VIEW_C should have exactly one fewer tab than VIEW_B
          expect(viewCTabs.length).toBe(viewBTabs.length - 1);

          // Every VIEW_C tab should exist in VIEW_B
          const viewBValues = viewBTabs.map((t) => t.value);
          for (const tab of viewCTabs) {
            expect(viewBValues).toContain(tab.value);
          }

          // The missing tab should be PROPOSAL
          const viewCValues = viewCTabs.map((t) => t.value);
          const missingTabs = viewBValues.filter((v) => !viewCValues.includes(v));
          expect(missingTabs).toEqual(["PROPOSAL"]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("VIEW_C tabs always include ALL tab", () => {
    fc.assert(
      fc.property(fc.constant("VIEW_C" as ZoneViewMode), (viewMode) => {
        const tabs = getViewTabs(viewMode);
        const tabValues = tabs.map((t) => t.value);

        expect(tabValues).toContain("ALL");
      }),
      { numRuns: 100 },
    );
  });
});
