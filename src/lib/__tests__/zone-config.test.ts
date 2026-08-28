import { describe, expect, it } from "vitest";
import type { CampaignRow } from "../crm-types";
import {
  ZONE_DEFAULT_STATUS,
  ZONE_SUB_STATUS_ORDER,
  getZoneCounts,
  sortByStartDateDesc,
  groupCampaignsByZone,
  sortCampaignsByStatus,
  sortCampaignsByZone,
} from "../zone-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCampaign(overrides: Partial<CampaignRow>): CampaignRow {
  return {
    id: "test-id",
    dealId: "deal-1",
    sellerId: "seller-1",
    campaignName: "Test Deal Seller",
    dealName: "Test Deal",
    partnerName: "Partner",
    sellerName: "Seller",
    snsType: "INSTAGRAM",
    snsHandle: "@test",
    startDate: "2025-01-01",
    endDate: "2025-01-31",
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: null,
    totalMarginRate: 30,
    sellerMarginRate: 15,
    netMarginRate: 15,
    status: "PROPOSAL",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2025-01-01T00:00:00Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ZONE_DEFAULT_STATUS
// ---------------------------------------------------------------------------

describe("ZONE_DEFAULT_STATUS", () => {
  it("maps SALES to PROPOSAL", () => {
    expect(ZONE_DEFAULT_STATUS.SALES).toBe("PROPOSAL");
  });

  it("maps DEAL_EXECUTION to PREPARATION", () => {
    expect(ZONE_DEFAULT_STATUS.DEAL_EXECUTION).toBe("PREPARATION");
  });

  it("maps SETTLEMENT to SETTLEMENT_IN_PROGRESS", () => {
    expect(ZONE_DEFAULT_STATUS.SETTLEMENT).toBe("SETTLEMENT_IN_PROGRESS");
  });

  it("maps DROPPED to DROPPED", () => {
    expect(ZONE_DEFAULT_STATUS.DROPPED).toBe("DROPPED");
  });
});

// ---------------------------------------------------------------------------
// ZONE_SUB_STATUS_ORDER
// ---------------------------------------------------------------------------

describe("ZONE_SUB_STATUS_ORDER", () => {
  it("SALES has PROPOSAL only", () => {
    expect(ZONE_SUB_STATUS_ORDER.SALES).toEqual(["PROPOSAL"]);
  });

  it("DEAL_EXECUTION has PREPARATION, ACTIVE, CLOSED, SETTLEMENT_WAIT in order", () => {
    expect(ZONE_SUB_STATUS_ORDER.DEAL_EXECUTION).toEqual([
      "PREPARATION",
      "ACTIVE",
      "CLOSED",
      "SETTLEMENT_WAIT",
    ]);
  });

  it("SETTLEMENT has SETTLEMENT_IN_PROGRESS, COMPLETED in order", () => {
    expect(ZONE_SUB_STATUS_ORDER.SETTLEMENT).toEqual([
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
    ]);
  });

  it("DROPPED has DROPPED only", () => {
    expect(ZONE_SUB_STATUS_ORDER.DROPPED).toEqual(["DROPPED"]);
  });
});

// ---------------------------------------------------------------------------
// getZoneCounts
// ---------------------------------------------------------------------------

describe("getZoneCounts", () => {
  it("returns zero counts for empty array", () => {
    expect(getZoneCounts([])).toEqual({
      SALES: 0,
      DEAL_EXECUTION: 0,
      SETTLEMENT: 0,
      DROPPED: 0,
    });
  });

  it("counts campaigns correctly by zone", () => {
    const campaigns = [
      makeCampaign({ id: "1", status: "PROPOSAL" }),
      makeCampaign({ id: "2", status: "PREPARATION" }),
      makeCampaign({ id: "3", status: "ACTIVE" }),
      makeCampaign({ id: "4", status: "CLOSED" }),
      makeCampaign({ id: "5", status: "SETTLEMENT_WAIT" }),
      makeCampaign({ id: "6", status: "SETTLEMENT_IN_PROGRESS" }),
      makeCampaign({ id: "7", status: "COMPLETED" }),
      makeCampaign({ id: "8", status: "DROPPED" }),
    ];

    expect(getZoneCounts(campaigns)).toEqual({
      SALES: 1,
      DEAL_EXECUTION: 4,
      SETTLEMENT: 2,
      DROPPED: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// sortByStartDateDesc
// ---------------------------------------------------------------------------

describe("sortByStartDateDesc", () => {
  it("sorts campaigns by startDate descending", () => {
    const campaigns = [
      makeCampaign({ id: "1", startDate: "2025-01-01" }),
      makeCampaign({ id: "2", startDate: "2025-03-15" }),
      makeCampaign({ id: "3", startDate: "2025-02-10" }),
    ];

    const sorted = sortByStartDateDesc(campaigns);
    expect(sorted.map((c) => c.id)).toEqual(["2", "3", "1"]);
  });

  it("does not mutate the original array", () => {
    const campaigns = [
      makeCampaign({ id: "1", startDate: "2025-01-01" }),
      makeCampaign({ id: "2", startDate: "2025-03-15" }),
    ];
    const original = [...campaigns];
    sortByStartDateDesc(campaigns);
    expect(campaigns).toEqual(original);
  });

  it("places campaigns with empty startDate at the end", () => {
    const campaigns = [
      makeCampaign({ id: "1", startDate: "" }),
      makeCampaign({ id: "2", startDate: "2025-03-15" }),
      makeCampaign({ id: "3", startDate: "2025-01-01" }),
    ];

    const sorted = sortByStartDateDesc(campaigns);
    expect(sorted.map((c) => c.id)).toEqual(["2", "3", "1"]);
  });

  it("returns empty array for empty input", () => {
    expect(sortByStartDateDesc([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// groupCampaignsByZone
// ---------------------------------------------------------------------------

describe("groupCampaignsByZone", () => {
  it("returns empty arrays for all zones when input is empty", () => {
    expect(groupCampaignsByZone([])).toEqual({
      SALES: [],
      DEAL_EXECUTION: [],
      SETTLEMENT: [],
      DROPPED: [],
    });
  });

  it("groups campaigns correctly by zone", () => {
    const campaigns = [
      makeCampaign({ id: "1", status: "PROPOSAL" }),
      makeCampaign({ id: "2", status: "ACTIVE" }),
      makeCampaign({ id: "3", status: "SETTLEMENT_WAIT" }),
      makeCampaign({ id: "4", status: "PREPARATION" }),
      makeCampaign({ id: "5", status: "SETTLEMENT_IN_PROGRESS" }),
      makeCampaign({ id: "6", status: "COMPLETED" }),
      makeCampaign({ id: "7", status: "DROPPED" }),
    ];

    const groups = groupCampaignsByZone(campaigns);
    expect(groups.SALES.map((c) => c.id)).toEqual(["1"]);
    expect(groups.DEAL_EXECUTION.map((c) => c.id)).toEqual(["2", "3", "4"]);
    expect(groups.SETTLEMENT.map((c) => c.id)).toEqual(["5", "6"]);
    expect(groups.DROPPED.map((c) => c.id)).toEqual(["7"]);
  });

  it("maintains original order within each group", () => {
    const campaigns = [
      makeCampaign({ id: "a", status: "ACTIVE" }),
      makeCampaign({ id: "b", status: "PREPARATION" }),
      makeCampaign({ id: "c", status: "CLOSED" }),
    ];

    const groups = groupCampaignsByZone(campaigns);
    expect(groups.DEAL_EXECUTION.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("every campaign appears in exactly one group", () => {
    const campaigns = [
      makeCampaign({ id: "1", status: "PROPOSAL" }),
      makeCampaign({ id: "2", status: "ACTIVE" }),
      makeCampaign({ id: "3", status: "COMPLETED" }),
      makeCampaign({ id: "4", status: "DROPPED" }),
    ];

    const groups = groupCampaignsByZone(campaigns);
    const allGrouped = [
      ...groups.SALES,
      ...groups.DEAL_EXECUTION,
      ...groups.SETTLEMENT,
      ...groups.DROPPED,
    ];
    expect(allGrouped).toHaveLength(campaigns.length);
  });
});

// ---------------------------------------------------------------------------
// sortCampaignsByStatus
// ---------------------------------------------------------------------------

describe("sortCampaignsByStatus", () => {
  it("sorts PREPARATION/ACTIVE/CLOSED/SETTLEMENT_WAIT campaigns by startDate ascending", () => {
    const campaigns = [
      makeCampaign({ id: "1", startDate: "2025-01-01", status: "PREPARATION" }),
      makeCampaign({ id: "2", startDate: "2025-03-15", status: "PREPARATION" }),
      makeCampaign({ id: "3", startDate: "2025-02-10", status: "PREPARATION" }),
    ];

    const sorted = sortCampaignsByStatus(campaigns, "PREPARATION");
    expect(sorted.map((c) => c.id)).toEqual(["1", "3", "2"]);
  });

  it("sorts SETTLEMENT_IN_PROGRESS/COMPLETED/PROPOSAL/DROPPED campaigns by startDate descending (reverse)", () => {
    const campaigns = [
      makeCampaign({ id: "1", startDate: "2025-01-01", status: "SETTLEMENT_IN_PROGRESS" }),
      makeCampaign({ id: "2", startDate: "2025-03-15", status: "SETTLEMENT_IN_PROGRESS" }),
      makeCampaign({ id: "3", startDate: "2025-02-10", status: "SETTLEMENT_IN_PROGRESS" }),
    ];

    const sorted = sortCampaignsByStatus(campaigns, "SETTLEMENT_IN_PROGRESS");
    expect(sorted.map((c) => c.id)).toEqual(["2", "3", "1"]);
  });

  it("places campaigns with empty startDate at the end for both ascending and descending", () => {
    const campaigns = [
      makeCampaign({ id: "1", startDate: "", status: "PREPARATION" }),
      makeCampaign({ id: "2", startDate: "2025-03-15", status: "PREPARATION" }),
      makeCampaign({ id: "3", startDate: "2025-01-01", status: "PREPARATION" }),
    ];

    const sortedAsc = sortCampaignsByStatus(campaigns, "PREPARATION");
    expect(sortedAsc.map((c) => c.id)).toEqual(["3", "2", "1"]);

    const campaignsDesc = [
      makeCampaign({ id: "1", startDate: "", status: "SETTLEMENT_IN_PROGRESS" }),
      makeCampaign({ id: "2", startDate: "2025-03-15", status: "SETTLEMENT_IN_PROGRESS" }),
      makeCampaign({ id: "3", startDate: "2025-01-01", status: "SETTLEMENT_IN_PROGRESS" }),
    ];

    const sortedDesc = sortCampaignsByStatus(campaignsDesc, "SETTLEMENT_IN_PROGRESS");
    expect(sortedDesc.map((c) => c.id)).toEqual(["2", "3", "1"]);
  });
});

// ---------------------------------------------------------------------------
// sortCampaignsByZone
// ---------------------------------------------------------------------------

describe("sortCampaignsByZone", () => {
  it("sorts DEAL_EXECUTION zone campaigns by startDate ascending", () => {
    const campaigns = [
      makeCampaign({ id: "1", startDate: "2025-01-01", status: "PREPARATION" }),
      makeCampaign({ id: "2", startDate: "2025-03-15", status: "ACTIVE" }),
      makeCampaign({ id: "3", startDate: "2025-02-10", status: "CLOSED" }),
    ];

    const sorted = sortCampaignsByZone(campaigns, "DEAL_EXECUTION");
    expect(sorted.map((c) => c.id)).toEqual(["1", "3", "2"]);
  });

  it("sorts SETTLEMENT zone campaigns by startDate descending", () => {
    const campaigns = [
      makeCampaign({ id: "1", startDate: "2025-01-01", status: "SETTLEMENT_IN_PROGRESS" }),
      makeCampaign({ id: "2", startDate: "2025-03-15", status: "COMPLETED" }),
      makeCampaign({ id: "3", startDate: "2025-02-10", status: "SETTLEMENT_IN_PROGRESS" }),
    ];

    const sorted = sortCampaignsByZone(campaigns, "SETTLEMENT");
    expect(sorted.map((c) => c.id)).toEqual(["2", "3", "1"]);
  });
});
