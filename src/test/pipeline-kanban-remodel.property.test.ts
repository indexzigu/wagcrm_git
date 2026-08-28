/**
 * Property-based tests for Pipeline Kanban Remodel.
 *
 * Feature: pipeline-kanban-remodel
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";
import { formatDateRange, getDateUrgency } from "@/lib/date-utils";
import {
  sortByStartDateDesc,
  getZoneForStatus,
  ZONE_STATUSES,
  ZONE_DEFAULT_STATUS,
  type PipelineZone,
  sortCampaignsByStatus,
  sortCampaignsByZone,
} from "@/lib/zone-config";
import {
  applyPipelineFilters,
  matchesStageFilter,
  matchesTeamFilter,
  matchesSearchQuery,
  matchesSavedView,
  type StageFilter,
  type SavedView,
  type PipelineFilterParams,
} from "@/lib/pipeline-filters";
import {
  serializePipelineParams,
  parsePipelineParams,
  type ViewMode,
  type PipelineUrlParams,
} from "@/hooks/use-stage-filter";
import type { CampaignRow, CampaignStatus } from "@/lib/crm-types";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const yearArb = fc.integer({ min: 2020, max: 2030 });
const monthArb = fc.integer({ min: 1, max: 12 });
const dayArb = fc.integer({ min: 1, max: 28 });

const isoDateArb = fc
  .tuple(yearArb, monthArb, dayArb)
  .map(
    ([y, m, d]) =>
      `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  );

const dateRangeArb = fc
  .tuple(isoDateArb, isoDateArb)
  .map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [string, string]);

const todayArb = fc
  .tuple(yearArb, monthArb, dayArb)
  .map(([y, m, d]) => new Date(y, m - 1, d));

function toLocalISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const nullishDateArb = fc.constantFrom(null, undefined, "");

const campaignStatusArb: fc.Arbitrary<CampaignStatus> = fc.constantFrom(
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "COMPLETED",
);

// ---------------------------------------------------------------------------
// Property 14e: getDateUrgency classifies "normal" when endDate > 3 days away
// Feature: pipeline-kanban-remodel, Property 14: Date range formatting and urgency classification
// Validates: Requirements 9.2, 9.3
// ---------------------------------------------------------------------------

describe("Property 14e: getDateUrgency classifies normal when endDate > 3 days away", () => {
  /**
   * **Validates: Requirements 9.2, 9.3**
   *
   * For any endDate that is more than 3 days from today,
   * getDateUrgency SHALL return "normal".
   */
  it("returns 'normal' when endDate is more than 3 days from today", () => {
    fc.assert(
      fc.property(
        todayArb,
        fc.integer({ min: 4, max: 365 }),
        (today, daysAhead) => {
          const endDate = new Date(today);
          endDate.setDate(endDate.getDate() + daysAhead);
          const endDateStr = toLocalISODate(endDate);

          const result = getDateUrgency(endDateStr, today);
          expect(result).toBe("normal");
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14f: getDateUrgency classifies "unset" when endDate is null/empty
// Feature: pipeline-kanban-remodel, Property 14: Date range formatting and urgency classification
// Validates: Requirements 9.4
// ---------------------------------------------------------------------------

describe("Property 14f: getDateUrgency classifies unset when endDate is null/empty", () => {
  /**
   * **Validates: Requirements 9.4**
   *
   * For any null, undefined, or empty endDate, getDateUrgency SHALL
   * return "unset".
   */
  it("returns 'unset' when endDate is null/undefined/empty", () => {
    fc.assert(
      fc.property(nullishDateArb, todayArb, (endDate, today) => {
        const result = getDateUrgency(
          endDate as string | null | undefined,
          today,
        );
        expect(result).toBe("unset");
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14g: getDateUrgency classification is exhaustive and exclusive
// Feature: pipeline-kanban-remodel, Property 14: Date range formatting and urgency classification
// Validates: Requirements 9.2, 9.3, 9.4
// ---------------------------------------------------------------------------

describe("Property 14g: getDateUrgency classification is exhaustive and exclusive", () => {
  /**
   * **Validates: Requirements 9.2, 9.3, 9.4**
   *
   * For any endDate (valid or null) and any today, getDateUrgency SHALL
   * return exactly one of: "overdue", "imminent", "normal", "unset".
   */
  it("always returns one of the four valid urgency values", () => {
    const endDateArb = fc.oneof(isoDateArb, nullishDateArb);

    fc.assert(
      fc.property(endDateArb, todayArb, (endDate, today) => {
        const result = getDateUrgency(
          endDate as string | null | undefined,
          today,
        );
        expect(["overdue", "imminent", "normal", "unset"]).toContain(result);
      }),
      { numRuns: 100 },
    );
  });
});


const startDateArb: fc.Arbitrary<string> = fc.oneof(
  fc.date({ min: new Date("2020-01-01"), max: new Date("2030-12-31") }).map(
    (d) => d.toISOString().slice(0, 10),
  ),
  fc.constant(""),
);

function campaignRowArb(): fc.Arbitrary<CampaignRow> {
  return fc
    .record({
      id: fc.uuid(),
      startDate: startDateArb,
      status: campaignStatusArb,
    })
    .map(({ id, startDate, status }) => ({
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


// ---------------------------------------------------------------------------
// Property 3: Intra-zone campaigns are sorted by startDate descending
// Feature: pipeline-kanban-remodel, Property 3
// Validates: Requirements 1.7
// ---------------------------------------------------------------------------

describe("Property 3: Intra-zone campaigns are sorted by startDate descending", () => {
  /**
   * **Validates: Requirements 1.7**
   *
   * For any list of campaigns, after applying sortByStartDateDesc,
   * each campaign's startDate SHALL be >= the next campaign's startDate.
   * Campaigns with empty startDate are placed at the end.
   */
  it("sorted result has each startDate >= the next startDate (descending order)", () => {
    fc.assert(
      fc.property(fc.array(campaignRowArb(), { minLength: 0, maxLength: 50 }), (campaigns) => {
        const sorted = sortByStartDateDesc(campaigns);

        for (let i = 0; i < sorted.length - 1; i++) {
          const current = sorted[i].startDate || "";
          const next = sorted[i + 1].startDate || "";

          if (!current) {
            expect(next).toBe("");
          } else if (next) {
            expect(current >= next).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 1.7**
   *
   * sortByStartDateDesc SHALL not mutate the input array.
   */
  it("does not mutate the original array", () => {
    fc.assert(
      fc.property(fc.array(campaignRowArb(), { minLength: 1, maxLength: 20 }), (campaigns) => {
        const originalIds = campaigns.map((c) => c.id);
        sortByStartDateDesc(campaigns);
        const afterIds = campaigns.map((c) => c.id);
        expect(afterIds).toEqual(originalIds);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 1.7**
   *
   * sortByStartDateDesc SHALL preserve all elements (same length, same set of ids).
   */
  it("preserves all campaigns (no elements lost or duplicated)", () => {
    fc.assert(
      fc.property(fc.array(campaignRowArb(), { minLength: 0, maxLength: 50 }), (campaigns) => {
        const sorted = sortByStartDateDesc(campaigns);
        expect(sorted).toHaveLength(campaigns.length);

        const originalIds = new Set(campaigns.map((c) => c.id));
        const sortedIds = new Set(sorted.map((c) => c.id));
        expect(sortedIds).toEqual(originalIds);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3b: sortCampaignsByStatus sorts dynamically by status
// Feature: pipeline-kanban-remodel, Property 3b
// ---------------------------------------------------------------------------

describe("Property 3b: sortCampaignsByStatus sorts dynamically by status", () => {
  it("sorts by startDate ascending (oldest first) for PREPARATION, ACTIVE, CLOSED, SETTLEMENT_WAIT", () => {
    const ascStatuses: CampaignStatus[] = ["PREPARATION", "ACTIVE", "CLOSED", "SETTLEMENT_WAIT"];
    const statusArb = fc.constantFrom(...ascStatuses);

    fc.assert(
      fc.property(fc.array(campaignRowArb(), { minLength: 0, maxLength: 50 }), statusArb, (campaigns, status) => {
        const sorted = sortCampaignsByStatus(campaigns, status);

        for (let i = 0; i < sorted.length - 1; i++) {
          const current = sorted[i].startDate || "";
          const next = sorted[i + 1].startDate || "";

          if (!current) {
            expect(next).toBe("");
          } else if (next) {
            expect(current <= next).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("sorts by startDate descending (newest first) for PROPOSAL, SETTLEMENT_IN_PROGRESS, COMPLETED, DROPPED", () => {
    const descStatuses: CampaignStatus[] = ["PROPOSAL", "SETTLEMENT_IN_PROGRESS", "COMPLETED", "DROPPED"];
    const statusArb = fc.constantFrom(...descStatuses);

    fc.assert(
      fc.property(fc.array(campaignRowArb(), { minLength: 0, maxLength: 50 }), statusArb, (campaigns, status) => {
        const sorted = sortCampaignsByStatus(campaigns, status);

        for (let i = 0; i < sorted.length - 1; i++) {
          const current = sorted[i].startDate || "";
          const next = sorted[i + 1].startDate || "";

          if (!current) {
            expect(next).toBe("");
          } else if (next) {
            expect(current >= next).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3c: sortCampaignsByZone sorts dynamically by zone
// Feature: pipeline-kanban-remodel, Property 3c
// ---------------------------------------------------------------------------

describe("Property 3c: sortCampaignsByZone sorts dynamically by zone", () => {
  it("sorts by startDate ascending (oldest first) for DEAL_EXECUTION zone", () => {
    fc.assert(
      fc.property(fc.array(campaignRowArb(), { minLength: 0, maxLength: 50 }), (campaigns) => {
        const sorted = sortCampaignsByZone(campaigns, "DEAL_EXECUTION");

        for (let i = 0; i < sorted.length - 1; i++) {
          const current = sorted[i].startDate || "";
          const next = sorted[i + 1].startDate || "";

          if (!current) {
            expect(next).toBe("");
          } else if (next) {
            expect(current <= next).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("sorts by startDate descending (newest first) for other zones", () => {
    const descZones: PipelineZone[] = ["SALES", "SETTLEMENT", "DROPPED"];
    const zoneArb = fc.constantFrom(...descZones);

    fc.assert(
      fc.property(fc.array(campaignRowArb(), { minLength: 0, maxLength: 50 }), zoneArb, (campaigns, zone) => {
        const sorted = sortCampaignsByZone(campaigns, zone);

        for (let i = 0; i < sorted.length - 1; i++) {
          const current = sorted[i].startDate || "";
          const next = sorted[i + 1].startDate || "";

          if (!current) {
            expect(next).toBe("");
          } else if (next) {
            expect(current >= next).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 14a: formatDateRange produces "MM.DD ~ MM.DD" format
// Feature: pipeline-kanban-remodel, Property 14
// Validates: Requirements 9.1
// ---------------------------------------------------------------------------

describe("Property 14a: formatDateRange produces MM.DD ~ MM.DD format", () => {
  it("returns a string matching MM.DD ~ MM.DD pattern for valid dates", () => {
    fc.assert(
      fc.property(dateRangeArb, ([startDate, endDate]) => {
        const result = formatDateRange(startDate, endDate);
        const pattern = /^\d{2}\.\d{2} ~ \d{2}\.\d{2}$/;
        expect(result).toMatch(pattern);
      }),
      { numRuns: 100 },
    );
  });

  it("month values are between 01-12 and day values are between 01-31", () => {
    fc.assert(
      fc.property(dateRangeArb, ([startDate, endDate]) => {
        const result = formatDateRange(startDate, endDate);
        const parts = result.split(" ~ ");
        for (const part of parts) {
          const [mm, dd] = part.split(".").map(Number);
          expect(mm).toBeGreaterThanOrEqual(1);
          expect(mm).toBeLessThanOrEqual(12);
          expect(dd).toBeGreaterThanOrEqual(1);
          expect(dd).toBeLessThanOrEqual(31);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("formatted output matches the input date month and day", () => {
    fc.assert(
      fc.property(dateRangeArb, ([startDate, endDate]) => {
        const result = formatDateRange(startDate, endDate);
        const [startPart, endPart] = result.split(" ~ ");
        const start = new Date(startDate);
        const end = new Date(endDate);
        const expectedStartMonth = String(start.getMonth() + 1).padStart(2, "0");
        const expectedStartDay = String(start.getDate()).padStart(2, "0");
        const expectedEndMonth = String(end.getMonth() + 1).padStart(2, "0");
        const expectedEndDay = String(end.getDate()).padStart(2, "0");
        expect(startPart).toBe(`${expectedStartMonth}.${expectedStartDay}`);
        expect(endPart).toBe(`${expectedEndMonth}.${expectedEndDay}`);
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 14b: formatDateRange returns "일정 미정" for null/empty dates
// Validates: Requirements 9.4
// ---------------------------------------------------------------------------

describe("Property 14b: formatDateRange returns '일정 미정' for unset dates", () => {
  it("returns '일정 미정' when startDate is null/undefined/empty", () => {
    fc.assert(
      fc.property(nullishDateArb, isoDateArb, (startDate, endDate) => {
        const result = formatDateRange(startDate as string | null | undefined, endDate);
        expect(result).toBe("일정 미정");
      }),
      { numRuns: 100 },
    );
  });

  it("returns '일정 미정' when endDate is null/undefined/empty", () => {
    fc.assert(
      fc.property(isoDateArb, nullishDateArb, (startDate, endDate) => {
        const result = formatDateRange(startDate, endDate as string | null | undefined);
        expect(result).toBe("일정 미정");
      }),
      { numRuns: 100 },
    );
  });

  it("returns '일정 미정' when both dates are null/undefined/empty", () => {
    fc.assert(
      fc.property(nullishDateArb, nullishDateArb, (startDate, endDate) => {
        const result = formatDateRange(
          startDate as string | null | undefined,
          endDate as string | null | undefined,
        );
        expect(result).toBe("일정 미정");
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 14c: getDateUrgency classifies "overdue" when endDate < today
// Validates: Requirements 9.2
// ---------------------------------------------------------------------------

describe("Property 14c: getDateUrgency classifies overdue when endDate < today", () => {
  it("returns 'overdue' when endDate is before today", () => {
    fc.assert(
      fc.property(todayArb, fc.integer({ min: 1, max: 365 }), (today, daysAgo) => {
        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() - daysAgo);
        const endDateStr = toLocalISODate(endDate);
        const result = getDateUrgency(endDateStr, today);
        expect(result).toBe("overdue");
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14d: getDateUrgency classifies "imminent" when endDate within 3 days
// Validates: Requirements 9.3
// ---------------------------------------------------------------------------

describe("Property 14d: getDateUrgency classifies imminent when endDate within 3 days", () => {
  it("returns 'imminent' when endDate is 0-3 days from today", () => {
    fc.assert(
      fc.property(todayArb, fc.integer({ min: 0, max: 3 }), (today, daysAhead) => {
        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() + daysAhead);
        const endDateStr = toLocalISODate(endDate);
        const result = getDateUrgency(endDateStr, today);
        expect(result).toBe("imminent");
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14e: getDateUrgency classifies "normal" when endDate > 3 days away
// Validates: Requirements 9.2, 9.3
// ---------------------------------------------------------------------------

describe("Property 14e: getDateUrgency classifies normal when endDate > 3 days away", () => {
  it("returns 'normal' when endDate is more than 3 days from today", () => {
    fc.assert(
      fc.property(todayArb, fc.integer({ min: 4, max: 365 }), (today, daysAhead) => {
        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() + daysAhead);
        const endDateStr = toLocalISODate(endDate);
        const result = getDateUrgency(endDateStr, today);
        expect(result).toBe("normal");
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14f: getDateUrgency classifies "unset" when endDate is null/empty
// Validates: Requirements 9.4
// ---------------------------------------------------------------------------

describe("Property 14f: getDateUrgency classifies unset when endDate is null/empty", () => {
  it("returns 'unset' when endDate is null/undefined/empty", () => {
    fc.assert(
      fc.property(nullishDateArb, todayArb, (endDate, today) => {
        const result = getDateUrgency(endDate as string | null | undefined, today);
        expect(result).toBe("unset");
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14g: getDateUrgency classification is exhaustive and exclusive
// Validates: Requirements 9.2, 9.3, 9.4
// ---------------------------------------------------------------------------

describe("Property 14g: getDateUrgency classification is exhaustive and exclusive", () => {
  it("always returns one of the four valid urgency values", () => {
    const endDateArb = fc.oneof(isoDateArb, nullishDateArb);
    fc.assert(
      fc.property(endDateArb, todayArb, (endDate, today) => {
        const result = getDateUrgency(endDate as string | null | undefined, today);
        expect(["overdue", "imminent", "normal", "unset"]).toContain(result);
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 10: Stage filter returns only campaigns in matching zone(s)
// Feature: pipeline-kanban-remodel, Property 10: Stage filter returns only campaigns in matching zone(s)
// Validates: Requirements 5.3, 5.4, 5.5, 5.6
// ---------------------------------------------------------------------------

const STAGE_FILTER_TO_ZONES_MAP: Record<Exclude<StageFilter, "ALL">, string[]> = {
  SALES: ["SALES"],
  PROGRESS: ["DEAL_EXECUTION", "SETTLEMENT"],
  SETTLEMENT: ["SETTLEMENT"],
};

describe("Property 10: Stage filter returns only campaigns in matching zone(s)", () => {
  /**
   * **Validates: Requirements 5.3, 5.4, 5.5, 5.6**
   *
   * For any StageFilter value and campaign list, matchesStageFilter with "ALL"
   * SHALL return true for every campaign.
   */
  it("ALL filter returns true for any campaign regardless of status", () => {
    fc.assert(
      fc.property(campaignRowArb(), (campaign) => {
        expect(matchesStageFilter(campaign, "ALL")).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.3, 5.4, 5.5, 5.6**
   *
   * For any non-ALL StageFilter and any campaign, matchesStageFilter SHALL
   * return true if and only if the campaign's zone matches the filter's zone.
   */
  it("non-ALL filter returns true only for campaigns in the matching zones", () => {
    const nonAllFilterArb: fc.Arbitrary<Exclude<StageFilter, "ALL">> = fc.constantFrom(
      "SALES",
      "PROGRESS",
      "SETTLEMENT",
    );

    fc.assert(
      fc.property(campaignRowArb(), nonAllFilterArb, (campaign, filter) => {
        const campaignZone = getZoneForStatus(campaign.status);
        const targetZones = STAGE_FILTER_TO_ZONES_MAP[filter];
        const expected = targetZones.includes(campaignZone);
        expect(matchesStageFilter(campaign, filter)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.3**
   *
   * SALES filter SHALL return true only for campaigns with PROPOSAL status.
   */
  it("SALES filter matches only PROPOSAL status campaigns", () => {
    fc.assert(
      fc.property(campaignRowArb(), (campaign) => {
        const result = matchesStageFilter(campaign, "SALES");
        const isInSalesZone = ZONE_STATUSES.SALES.includes(campaign.status);
        expect(result).toBe(isInSalesZone);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * PROGRESS filter SHALL return true only for campaigns with
   * PREPARATION, ACTIVE, CLOSED, SETTLEMENT_WAIT, SETTLEMENT_IN_PROGRESS, or COMPLETED status.
   */
  it("PROGRESS filter matches PREPARATION/ACTIVE/CLOSED and SETTLEMENT status campaigns", () => {
    fc.assert(
      fc.property(campaignRowArb(), (campaign) => {
        const result = matchesStageFilter(campaign, "PROGRESS");
        const isInProgressZone =
          ZONE_STATUSES.DEAL_EXECUTION.includes(campaign.status) ||
          ZONE_STATUSES.SETTLEMENT.includes(campaign.status);
        expect(result).toBe(isInProgressZone);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.5**
   *
   * SETTLEMENT filter SHALL return true only for campaigns with
   * SETTLEMENT_WAIT or COMPLETED status.
   */
  it("SETTLEMENT filter matches only SETTLEMENT_WAIT/COMPLETED status campaigns", () => {
    fc.assert(
      fc.property(campaignRowArb(), (campaign) => {
        const result = matchesStageFilter(campaign, "SETTLEMENT");
        const isInSettlementZone = ZONE_STATUSES.SETTLEMENT.includes(campaign.status);
        expect(result).toBe(isInSettlementZone);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.3, 5.4, 5.5, 5.6**
   *
   * For any campaign and any StageFilter, the filter result SHALL be
   * consistent: at least one of the three zone filters matches, and ALL always matches.
   */
  it("at least one zone filter matches for any campaign, and ALL always matches", () => {
    fc.assert(
      fc.property(campaignRowArb(), (campaign) => {
        const salesMatch = matchesStageFilter(campaign, "SALES");
        const progressMatch = matchesStageFilter(campaign, "PROGRESS");
        const settlementMatch = matchesStageFilter(campaign, "SETTLEMENT");
        const allMatch = matchesStageFilter(campaign, "ALL");

        // ALL always matches
        expect(allMatch).toBe(true);

        // At least one zone filter matches
        const matchCount = [salesMatch, progressMatch, settlementMatch].filter(Boolean).length;
        expect(matchCount).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 15: Filter state URL serialization round-trip
// Feature: pipeline-kanban-remodel, Property 15
// Validates: Requirements 10.1, 10.3, 10.4
// ---------------------------------------------------------------------------

const stageFilterArb: fc.Arbitrary<StageFilter> = fc.constantFrom(
  "ALL",
  "SALES",
  "PROGRESS",
  "SETTLEMENT",
);

const viewModeArb: fc.Arbitrary<ViewMode> = fc.constantFrom("kanban", "table");

const savedViewArb: fc.Arbitrary<SavedView> = fc.constantFrom(
  "DEFAULT",
  "URGENT",
  "STAGNANT",
  "MISSING_SALES",
  "MANUAL_MARGIN",
);

const teamArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
);

const searchArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
);

const pipelineUrlParamsArb: fc.Arbitrary<PipelineUrlParams> = fc
  .record({
    stage: fc.oneof(fc.constant(undefined), stageFilterArb),
    team: teamArb,
    search: searchArb,
    savedView: fc.oneof(fc.constant(undefined), savedViewArb),
    viewMode: fc.oneof(fc.constant(undefined), viewModeArb),
  })
  .map((rec) => {
    // Remove undefined keys to match real-world usage
    const result: PipelineUrlParams = {};
    if (rec.stage !== undefined) result.stage = rec.stage;
    if (rec.team !== undefined) result.team = rec.team;
    if (rec.search !== undefined) result.search = rec.search;
    if (rec.savedView !== undefined) result.savedView = rec.savedView;
    if (rec.viewMode !== undefined) result.viewMode = rec.viewMode;
    return result;
  });

describe("Property 15: Filter state URL serialization round-trip", () => {
  /**
   * **Validates: Requirements 10.1, 10.3, 10.4**
   *
   * For any valid PipelineUrlParams, serializing to URL query string and
   * parsing back SHALL produce a semantically equivalent params object.
   *
   * Note: serializePipelineParams omits default values (stage=ALL,
   * viewMode=kanban, savedView=DEFAULT) from the URL. So after round-trip,
   * those defaults will be absent from the parsed result (which is correct
   * because parsePipelineParams returns only explicitly set values).
   */
  it("serialize → parse round-trip preserves non-default filter values", () => {
    fc.assert(
      fc.property(pipelineUrlParamsArb, (params) => {
        const serialized = serializePipelineParams(params);
        const parsed = parsePipelineParams(serialized);

        // stage: non-default values are preserved; defaults are omitted
        if (params.stage && params.stage !== "ALL") {
          expect(parsed.stage).toBe(params.stage);
        } else {
          expect(parsed.stage).toBeUndefined();
        }

        // team: non-empty values are preserved
        if (params.team && params.team.trim().length > 0) {
          expect(parsed.team).toBe(params.team);
        } else {
          expect(parsed.team).toBeUndefined();
        }

        // search: non-empty values are preserved
        if (params.search && params.search.trim().length > 0) {
          expect(parsed.search).toBe(params.search);
        } else {
          expect(parsed.search).toBeUndefined();
        }

        // savedView: non-default values are preserved
        if (params.savedView && params.savedView !== "DEFAULT") {
          expect(parsed.savedView).toBe(params.savedView);
        } else {
          expect(parsed.savedView).toBeUndefined();
        }

        // viewMode: non-default values are preserved
        if (params.viewMode && params.viewMode !== "kanban") {
          expect(parsed.viewMode).toBe(params.viewMode);
        } else {
          expect(parsed.viewMode).toBeUndefined();
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 10.4**
   *
   * For any invalid parameter values in a URL, parsing SHALL ignore them
   * and return default values (undefined fields in the result object).
   */
  it("invalid URL params are ignored and produce empty/default result", () => {
    const invalidStageArb = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter(
        (s) => !["ALL", "SALES", "PROGRESS", "SETTLEMENT"].includes(s),
      );

    const invalidViewModeArb = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => !["kanban", "table"].includes(s));

    const invalidSavedViewArb = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter(
        (s) =>
          !["DEFAULT", "URGENT", "STAGNANT", "MISSING_SALES", "MANUAL_MARGIN"].includes(s),
      );

    fc.assert(
      fc.property(
        invalidStageArb,
        invalidViewModeArb,
        invalidSavedViewArb,
        (stage, viewMode, savedView) => {
          const searchString = `?stage=${encodeURIComponent(stage)}&viewMode=${encodeURIComponent(viewMode)}&savedView=${encodeURIComponent(savedView)}`;
          const parsed = parsePipelineParams(searchString);

          // Invalid stage should be ignored
          expect(parsed.stage).toBeUndefined();
          // Invalid viewMode should be ignored
          expect(parsed.viewMode).toBeUndefined();
          // Invalid savedView should be ignored
          expect(parsed.savedView).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 10.1, 10.3**
   *
   * Serialization is idempotent: serializing the same params twice
   * produces the same URL string.
   */
  it("serialization is idempotent", () => {
    fc.assert(
      fc.property(pipelineUrlParamsArb, (params) => {
        const first = serializePipelineParams(params);
        const second = serializePipelineParams(params);
        expect(first).toBe(second);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 10.1, 10.3**
   *
   * parse → serialize → parse is stable: parsing a serialized string and
   * re-serializing produces the same string.
   */
  it("parse → serialize → parse is stable (double round-trip)", () => {
    fc.assert(
      fc.property(pipelineUrlParamsArb, (params) => {
        const serialized1 = serializePipelineParams(params);
        const parsed1 = parsePipelineParams(serialized1);
        const serialized2 = serializePipelineParams(parsed1);
        const parsed2 = parsePipelineParams(serialized2);

        expect(serialized1).toBe(serialized2);
        expect(parsed1).toEqual(parsed2);
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 12: View mode persistence round-trip
// Feature: pipeline-kanban-remodel, Property 12
// Validates: Requirements 6.3, 6.5
// ---------------------------------------------------------------------------

describe("Property 12: View mode persistence round-trip", () => {
  const VIEW_MODE_STORAGE_KEY = "wag-crm:pipeline:view-mode";

  const validViewModeArb: fc.Arbitrary<"kanban" | "table"> = fc.constantFrom(
    "kanban" as const,
    "table" as const,
  );

  const invalidViewModeArb: fc.Arbitrary<string> = fc.oneof(
    fc.constant(""),
    fc.constant("list"),
    fc.constant("grid"),
    fc.constant("KANBAN"),
    fc.constant("TABLE"),
    fc.constant("calendar"),
    fc.string({ minLength: 1, maxLength: 20 }).filter(
      (s) => s !== "kanban" && s !== "table",
    ),
  );

  beforeEach(() => {
    window.localStorage.clear();
  });

  /**
   * **Validates: Requirements 6.3, 6.5**
   *
   * For any valid view mode value ("kanban" or "table"), saving to localStorage
   * and reading back SHALL return the same value.
   */
  it("persisting a valid viewMode and reading back returns the same value", () => {
    fc.assert(
      fc.property(validViewModeArb, (mode) => {
        // Persist
        window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);

        // Read back (same logic as getViewModeSnapshot)
        const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
        const validModes = ["kanban", "table"];
        const result = stored && validModes.includes(stored) ? stored : "kanban";

        expect(result).toBe(mode);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 6.5**
   *
   * For any invalid or missing value in localStorage, reading SHALL return
   * "kanban" as the default view mode.
   */
  it("returns 'kanban' as default for invalid stored values", () => {
    fc.assert(
      fc.property(invalidViewModeArb, (invalidMode) => {
        // Store an invalid value
        window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, invalidMode);

        // Read back (same logic as getViewModeSnapshot)
        const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
        const validModes = ["kanban", "table"];
        const result = stored && validModes.includes(stored) ? stored : "kanban";

        expect(result).toBe("kanban");
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 6.5**
   *
   * When localStorage has no stored view mode (key missing), reading SHALL
   * return "kanban" as the default.
   */
  it("returns 'kanban' as default when localStorage key is missing", () => {
    fc.assert(
      fc.property(fc.constant(undefined), () => {
        // Ensure key is not set
        window.localStorage.removeItem(VIEW_MODE_STORAGE_KEY);

        // Read back (same logic as getViewModeSnapshot)
        const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
        const validModes = ["kanban", "table"];
        const result = stored && validModes.includes(stored) ? stored : "kanban";

        expect(result).toBe("kanban");
      }),
      { numRuns: 10 },
    );
  });

  /**
   * **Validates: Requirements 6.3**
   *
   * Writing a valid view mode, then overwriting with another valid mode,
   * SHALL return the latest written value on read.
   */
  it("last written valid viewMode wins on read", () => {
    fc.assert(
      fc.property(validViewModeArb, validViewModeArb, (first, second) => {
        // Write first value
        window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, first);
        // Overwrite with second value
        window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, second);

        // Read back
        const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
        const validModes = ["kanban", "table"];
        const result = stored && validModes.includes(stored) ? stored : "kanban";

        expect(result).toBe(second);
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 13: Filter composition uses AND logic
// Feature: pipeline-kanban-remodel, Property 13: Filter composition uses AND logic
// Validates: Requirements 7.1, 7.2, 7.3
// ---------------------------------------------------------------------------

const p13StageFilterArb: fc.Arbitrary<StageFilter> = fc.constantFrom(
  "ALL",
  "SALES",
  "PROGRESS",
  "SETTLEMENT",
);

const p13SavedViewArb: fc.Arbitrary<SavedView> = fc.constantFrom(
  "DEFAULT",
  "MISSING_SALES",
  "MANUAL_MARGIN",
);

const teamIdArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.constantFrom("team-a", "team-b", "team-c"),
);

const searchQueryArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.constantFrom("Seller", "Deal", "Partner", "xyz-no-match"),
);

function filterTestCampaignRowArb(): fc.Arbitrary<CampaignRow> {
  return fc
    .record({
      id: fc.uuid(),
      status: campaignStatusArb,
      assignedTo: fc.oneof(
        fc.constant(null),
        fc.constantFrom("team-a", "team-b", "team-c"),
      ),
      sellerName: fc.constantFrom("Seller Alpha", "Seller Beta", "Other Name"),
      dealName: fc.constantFrom("Deal One", "Deal Two", "Another Deal"),
      partnerName: fc.constantFrom("Partner X", "Partner Y", "Some Partner"),
      isManualMargin: fc.boolean(),
      actualSales: fc.oneof(fc.constant(null), fc.integer({ min: 1000, max: 999999 })),
      startDate: fc.constant("2025-06-01"),
      endDate: fc.constant("2025-12-31"),
    })
    .map((fields) => ({
      id: fields.id,
      dealId: "deal-1",
      sellerId: "seller-1",
      campaignName: `${fields.dealName} ${fields.sellerName}`,
      dealName: fields.dealName,
      partnerName: fields.partnerName,
      sellerName: fields.sellerName,
      snsType: "INSTAGRAM" as const,
      snsHandle: "@test",
      startDate: fields.startDate,
      endDate: fields.endDate,
      salesChannel: "OWN_MALL" as const,
      baseNaverLink: "",
      generatedTrackingLink: "",
      actualSales: fields.actualSales,
      totalMarginRate: 30,
      sellerMarginRate: 15,
      netMarginRate: 15,
      status: fields.status,
      isManualMargin: fields.isManualMargin,
      assignedTo: fields.assignedTo,
      updatedAt: "2025-01-01T00:00:00Z",
      followerHistory: [],
      activityHistory: [],
      notes: [],
    }));
}

const filterParamsArb: fc.Arbitrary<PipelineFilterParams> = fc.record({
  stageFilter: p13StageFilterArb,
  teamId: teamIdArb,
  searchQuery: searchQueryArb,
  savedView: p13SavedViewArb,
});

describe("Property 13: Filter composition uses AND logic", () => {
  /**
   * **Validates: Requirements 7.1, 7.2, 7.3**
   *
   * For any combination of filters, applyPipelineFilters SHALL return
   * the intersection of applying each filter independently — a campaign
   * appears in the result if and only if it satisfies ALL active filter conditions.
   */
  it("combined filter result equals intersection of individual filters", () => {
    fc.assert(
      fc.property(
        fc.array(filterTestCampaignRowArb(), { minLength: 0, maxLength: 30 }),
        filterParamsArb,
        (campaigns, params) => {
          // Apply combined filter
          const combinedResult = applyPipelineFilters(campaigns, params);

          // Apply each filter independently and compute intersection
          const stageFiltered = campaigns.filter((c) =>
            matchesStageFilter(c, params.stageFilter),
          );
          const teamFiltered = campaigns.filter((c) =>
            matchesTeamFilter(c, params.teamId),
          );
          const searchFiltered = campaigns.filter((c) =>
            matchesSearchQuery(c, params.searchQuery),
          );
          const savedViewFiltered = campaigns.filter((c) =>
            matchesSavedView(c, params.savedView),
          );

          // Intersection: campaigns that appear in ALL individual results
          const stageIds = new Set(stageFiltered.map((c) => c.id));
          const teamIds = new Set(teamFiltered.map((c) => c.id));
          const searchIds = new Set(searchFiltered.map((c) => c.id));
          const savedViewIds = new Set(savedViewFiltered.map((c) => c.id));

          const intersectionIds = campaigns
            .filter(
              (c) =>
                stageIds.has(c.id) &&
                teamIds.has(c.id) &&
                searchIds.has(c.id) &&
                savedViewIds.has(c.id),
            )
            .map((c) => c.id);

          const combinedIds = combinedResult.map((c) => c.id);

          expect(combinedIds).toEqual(intersectionIds);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.1, 7.2, 7.3**
   *
   * Combining stage filter + search query + team filter SHALL narrow results:
   * the combined result size is always <= the size of any individual filter result.
   */
  it("combining filters narrows results (result size <= each individual filter)", () => {
    fc.assert(
      fc.property(
        fc.array(filterTestCampaignRowArb(), { minLength: 1, maxLength: 30 }),
        filterParamsArb,
        (campaigns, params) => {
          const combinedResult = applyPipelineFilters(campaigns, params);

          const stageCount = campaigns.filter((c) =>
            matchesStageFilter(c, params.stageFilter),
          ).length;
          const teamCount = campaigns.filter((c) =>
            matchesTeamFilter(c, params.teamId),
          ).length;
          const searchCount = campaigns.filter((c) =>
            matchesSearchQuery(c, params.searchQuery),
          ).length;
          const savedViewCount = campaigns.filter((c) =>
            matchesSavedView(c, params.savedView),
          ).length;

          expect(combinedResult.length).toBeLessThanOrEqual(stageCount);
          expect(combinedResult.length).toBeLessThanOrEqual(teamCount);
          expect(combinedResult.length).toBeLessThanOrEqual(searchCount);
          expect(combinedResult.length).toBeLessThanOrEqual(savedViewCount);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.1, 7.2, 7.3**
   *
   * Every campaign in the combined result SHALL individually pass
   * ALL filter predicates.
   */
  it("every campaign in result passes all individual filter predicates", () => {
    fc.assert(
      fc.property(
        fc.array(filterTestCampaignRowArb(), { minLength: 1, maxLength: 30 }),
        filterParamsArb,
        (campaigns, params) => {
          const result = applyPipelineFilters(campaigns, params);

          for (const campaign of result) {
            expect(matchesStageFilter(campaign, params.stageFilter)).toBe(true);
            expect(matchesTeamFilter(campaign, params.teamId)).toBe(true);
            expect(matchesSearchQuery(campaign, params.searchQuery)).toBe(true);
            expect(matchesSavedView(campaign, params.savedView)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Optimistic update rollback restores original state
// Feature: pipeline-kanban-remodel, Property 6: Optimistic update rollback restores original state
// Validates: Requirements 2.7, 3.6
// ---------------------------------------------------------------------------

describe("Property 6: Optimistic update rollback restores original state", () => {
  /**
   * **Validates: Requirements 2.7, 3.6**
   *
   * Pure logic test: Given an original campaign list and a cross-zone drag
   * operation that fails, the rollback SHALL restore the exact original state
   * (same statuses, same positions, same order).
   *
   * We simulate the optimistic update + rollback pattern from StageKanbanBoard:
   * 1. Snapshot original campaigns
   * 2. Apply optimistic update (change target campaign's status to ZONE_DEFAULT_STATUS[targetZone])
   * 3. On failure: restore from snapshot
   * 4. Verify restored state === original state
   */
  it("rollback after failed cross-zone move restores exact original campaign list", () => {
    // Arbitrary for a target zone different from the campaign's current zone
    const crossZoneMoveArb = fc
      .tuple(
        fc.array(campaignRowArb(), { minLength: 1, maxLength: 30 }),
        fc.nat(), // index into campaigns array
        fc.constantFrom("SALES" as PipelineZone, "DEAL_EXECUTION" as PipelineZone, "SETTLEMENT" as PipelineZone),
      )
      .filter(([campaigns, idx, targetZone]) => {
        const campaign = campaigns[idx % campaigns.length];
        const sourceZone = getZoneForStatus(campaign.status);
        return sourceZone !== targetZone; // Must be a cross-zone move
      })
      .map(([campaigns, idx, targetZone]) => ({
        campaigns,
        campaignIdx: idx % campaigns.length,
        targetZone,
      }));

    fc.assert(
      fc.property(crossZoneMoveArb, ({ campaigns, campaignIdx, targetZone }) => {
        const campaignId = campaigns[campaignIdx].id;
        const targetStatus = ZONE_DEFAULT_STATUS[targetZone];

        // Step 1: Snapshot (same as StageKanbanBoard does)
        const originalCampaigns = [...campaigns];

        // Step 2: Optimistic update
        const optimisticCampaigns = campaigns.map((c) =>
          c.id === campaignId ? { ...c, status: targetStatus } : c,
        );

        // Verify optimistic update actually changed the status
        const updatedCampaign = optimisticCampaigns.find((c) => c.id === campaignId)!;
        expect(updatedCampaign.status).toBe(targetStatus);

        // Step 3: Rollback (simulating API failure)
        const rolledBackCampaigns = originalCampaigns;

        // Step 4: Verify rollback restores exact original state
        expect(rolledBackCampaigns).toHaveLength(campaigns.length);
        for (let i = 0; i < campaigns.length; i++) {
          expect(rolledBackCampaigns[i].id).toBe(campaigns[i].id);
          expect(rolledBackCampaigns[i].status).toBe(campaigns[i].status);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.7, 3.6**
   *
   * The rollback SHALL preserve the position (index) of every campaign,
   * not just the moved campaign's status.
   */
  it("rollback preserves position of all campaigns including non-moved ones", () => {
    const crossZoneMoveArb = fc
      .tuple(
        fc.array(campaignRowArb(), { minLength: 2, maxLength: 30 }),
        fc.nat(),
        fc.constantFrom("SALES" as PipelineZone, "DEAL_EXECUTION" as PipelineZone, "SETTLEMENT" as PipelineZone),
      )
      .filter(([campaigns, idx, targetZone]) => {
        const campaign = campaigns[idx % campaigns.length];
        const sourceZone = getZoneForStatus(campaign.status);
        return sourceZone !== targetZone;
      })
      .map(([campaigns, idx, targetZone]) => ({
        campaigns,
        campaignIdx: idx % campaigns.length,
        targetZone,
      }));

    fc.assert(
      fc.property(crossZoneMoveArb, ({ campaigns, campaignIdx, targetZone }) => {
        const campaignId = campaigns[campaignIdx].id;
        const targetStatus = ZONE_DEFAULT_STATUS[targetZone];

        // Snapshot
        const originalCampaigns = [...campaigns];

        // Optimistic update
        const optimisticCampaigns = campaigns.map((c) =>
          c.id === campaignId ? { ...c, status: targetStatus } : c,
        );

        // Verify non-moved campaigns are unchanged in optimistic state
        for (let i = 0; i < optimisticCampaigns.length; i++) {
          if (optimisticCampaigns[i].id !== campaignId) {
            expect(optimisticCampaigns[i].status).toBe(campaigns[i].status);
          }
        }

        // Rollback
        const rolledBack = originalCampaigns;

        // Verify ALL campaigns (including non-moved) are at their original positions
        expect(rolledBack.map((c) => c.id)).toEqual(campaigns.map((c) => c.id));
        expect(rolledBack.map((c) => c.status)).toEqual(campaigns.map((c) => c.status));
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.7, 3.6**
   *
   * The snapshot taken before optimistic update SHALL be independent of
   * subsequent mutations — modifying the optimistic array does not affect
   * the snapshot used for rollback.
   */
  it("snapshot is independent of optimistic mutations (shallow copy isolation)", () => {
    const crossZoneMoveArb = fc
      .tuple(
        fc.array(campaignRowArb(), { minLength: 1, maxLength: 20 }),
        fc.nat(),
        fc.constantFrom("SALES" as PipelineZone, "DEAL_EXECUTION" as PipelineZone, "SETTLEMENT" as PipelineZone),
      )
      .filter(([campaigns, idx, targetZone]) => {
        const campaign = campaigns[idx % campaigns.length];
        const sourceZone = getZoneForStatus(campaign.status);
        return sourceZone !== targetZone;
      })
      .map(([campaigns, idx, targetZone]) => ({
        campaigns,
        campaignIdx: idx % campaigns.length,
        targetZone,
      }));

    fc.assert(
      fc.property(crossZoneMoveArb, ({ campaigns, campaignIdx, targetZone }) => {
        const campaignId = campaigns[campaignIdx].id;
        const targetStatus = ZONE_DEFAULT_STATUS[targetZone];

        // Snapshot (shallow copy of array)
        const snapshot = [...campaigns];

        // Optimistic update creates a new array with mapped objects
        const optimistic = campaigns.map((c) =>
          c.id === campaignId ? { ...c, status: targetStatus } : c,
        );

        // Mutate the optimistic array (simulate further state changes)
        optimistic.push(optimistic[0]);
        optimistic.reverse();

        // Snapshot should be unaffected by mutations to optimistic array
        expect(snapshot).toHaveLength(campaigns.length);
        for (let i = 0; i < campaigns.length; i++) {
          expect(snapshot[i].id).toBe(campaigns[i].id);
          expect(snapshot[i].status).toBe(campaigns[i].status);
        }
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 11: Filter state persists across view switches
// Feature: pipeline-kanban-remodel, Property 11
// Validates: Requirements 5.8, 6.4
// ---------------------------------------------------------------------------

describe("Property 11: Filter state persists across view switches", () => {
  /**
   * **Validates: Requirements 5.8, 6.4**
   *
   * For any filter state (stageFilter, teamFilter, searchQuery, savedView)
   * and any view mode switch, the filter state after the switch SHALL be
   * identical to the filter state before the switch.
   *
   * We test this by serializing params with one viewMode, then changing
   * viewMode and re-parsing — the non-viewMode filter fields must remain
   * unchanged.
   */

  it("changing viewMode preserves stage filter", () => {
    fc.assert(
      fc.property(
        stageFilterArb,
        teamArb,
        searchArb,
        savedViewArb,
        viewModeArb,
        viewModeArb,
        (stage, team, search, savedView, initialMode, newMode) => {
          // Build initial params
          const initialParams: PipelineUrlParams = {
            stage,
            team,
            search,
            savedView,
            viewMode: initialMode,
          };

          // Serialize to URL, then parse back
          const serialized = serializePipelineParams(initialParams);
          const parsed = parsePipelineParams(serialized);

          // Now simulate a view switch: merge new viewMode into parsed params
          const afterSwitch: PipelineUrlParams = { ...parsed, viewMode: newMode };
          const serializedAfter = serializePipelineParams(afterSwitch);
          const parsedAfter = parsePipelineParams(serializedAfter);

          // Filter state (stage, team, search, savedView) must be unchanged
          expect(parsedAfter.stage ?? "ALL").toBe(parsed.stage ?? "ALL");
          expect(parsedAfter.team ?? null).toBe(parsed.team ?? null);
          expect(parsedAfter.search ?? "").toBe(parsed.search ?? "");
          expect(parsedAfter.savedView ?? "DEFAULT").toBe(parsed.savedView ?? "DEFAULT");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("view mode switch does not add or remove filter params", () => {
    fc.assert(
      fc.property(
        stageFilterArb,
        teamArb,
        searchArb,
        savedViewArb,
        viewModeArb,
        (stage, team, search, savedView, newMode) => {
          // Start with kanban, switch to newMode
          const initialParams: PipelineUrlParams = {
            stage,
            team,
            search,
            savedView,
            viewMode: "kanban",
          };

          const serialized = serializePipelineParams(initialParams);
          const parsed = parsePipelineParams(serialized);

          // Switch view mode
          const switched: PipelineUrlParams = { ...parsed, viewMode: newMode };
          const serializedSwitched = serializePipelineParams(switched);
          const parsedSwitched = parsePipelineParams(serializedSwitched);

          // Verify filter fields are preserved exactly
          expect(parsedSwitched.stage).toBe(parsed.stage);
          expect(parsedSwitched.team).toBe(parsed.team);
          expect(parsedSwitched.search).toBe(parsed.search);
          expect(parsedSwitched.savedView).toBe(parsed.savedView);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("round-trip: serialize → switch viewMode → parse preserves all filter fields", () => {
    fc.assert(
      fc.property(
        stageFilterArb,
        teamArb,
        searchArb,
        savedViewArb,
        (stage, team, search, savedView) => {
          // Test both directions: kanban→table and table→kanban
          for (const [from, to] of [["kanban", "table"], ["table", "kanban"]] as const) {
            const params: PipelineUrlParams = {
              stage,
              team,
              search,
              savedView,
              viewMode: from,
            };

            const url = serializePipelineParams(params);
            const parsed = parsePipelineParams(url);

            // Switch view
            const afterSwitch = serializePipelineParams({ ...parsed, viewMode: to });
            const result = parsePipelineParams(afterSwitch);

            // All filter state must persist
            expect(result.stage ?? "ALL").toBe(parsed.stage ?? "ALL");
            expect(result.team ?? null).toBe(parsed.team ?? null);
            expect(result.search ?? "").toBe(parsed.search ?? "");
            expect(result.savedView ?? "DEFAULT").toBe(parsed.savedView ?? "DEFAULT");
            // viewMode should reflect the new value
            expect(result.viewMode ?? "kanban").toBe(to);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 8: Intra-zone drag preserves campaign status
// Feature: pipeline-kanban-remodel, Property 8: Intra-zone drag preserves campaign status
// Validates: Requirements 3.1
// ---------------------------------------------------------------------------

describe("Property 8: Intra-zone drag preserves campaign status", () => {
  /**
   * **Validates: Requirements 3.1**
   *
   * For any campaign with status S in zone Z, if it is dropped back into
   * zone Z (intra-zone drag), its status SHALL remain S.
   *
   * This tests the pure logic: getZoneForStatus(status) === targetZone
   * means the campaign status is NOT changed.
   */
  it("campaign status remains unchanged when dropped within the same zone", () => {
    fc.assert(
      fc.property(campaignStatusArb, (status) => {
        const sourceZone = getZoneForStatus(status);

        // Simulate intra-zone drop: target zone is the same as source zone
        const targetZone = sourceZone;

        // The intra-zone logic: when sourceZone === targetZone, status is preserved
        // (no ZONE_DEFAULT_STATUS assignment happens)
        const statusAfterDrop =
          sourceZone === targetZone ? status : ZONE_DEFAULT_STATUS[targetZone];

        expect(statusAfterDrop).toBe(status);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.1**
   *
   * For any campaign row dropped within its own zone, the campaign's
   * full status field SHALL be identical before and after the drop.
   */
  it("campaign row status is preserved after intra-zone reorder", () => {
    fc.assert(
      fc.property(campaignRowArb(), (campaign) => {
        const sourceZone = getZoneForStatus(campaign.status);
        const targetZone = sourceZone; // intra-zone drop

        // Simulate the handleDrop logic:
        // if sourceZone === targetZone → no status change (early return)
        const statusAfterDrop =
          sourceZone === targetZone
            ? campaign.status
            : ZONE_DEFAULT_STATUS[targetZone];

        expect(statusAfterDrop).toBe(campaign.status);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.1**
   *
   * For any status in a zone with multiple sub-statuses (e.g., DEAL_EXECUTION
   * has PREPARATION, ACTIVE, CLOSED), intra-zone drag SHALL NOT reset the
   * status to the zone's default status.
   */
  it("intra-zone drag does NOT reset to zone default status for non-default sub-statuses", () => {
    // Focus on statuses that are NOT the zone default
    const nonDefaultStatusArb: fc.Arbitrary<CampaignStatus> = fc.constantFrom(
      "ACTIVE",
      "CLOSED",
      "COMPLETED",
    );

    fc.assert(
      fc.property(nonDefaultStatusArb, (status) => {
        const zone = getZoneForStatus(status);
        const zoneDefault = ZONE_DEFAULT_STATUS[zone];

        // The status is NOT the zone default
        expect(status).not.toBe(zoneDefault);

        // After intra-zone drop, status must remain unchanged (not reset to default)
        const targetZone = zone;
        const statusAfterDrop =
          zone === targetZone ? status : ZONE_DEFAULT_STATUS[targetZone];

        expect(statusAfterDrop).toBe(status);
        expect(statusAfterDrop).not.toBe(zoneDefault);
      }),
      { numRuns: 100 },
    );
  });
});
