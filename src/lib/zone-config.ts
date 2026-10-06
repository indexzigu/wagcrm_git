import type { CampaignStatus, CampaignRow } from "./crm-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelineZone = "SALES" | "DEAL_EXECUTION" | "SETTLEMENT" | "DROPPED";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical zone ordering from left to right. */
export const ZONE_ORDER: PipelineZone[] = ["SALES", "DEAL_EXECUTION", "SETTLEMENT", "DROPPED"];

/** Human-readable zone labels. */
export const ZONE_LABELS: Record<PipelineZone, string> = {
  SALES: "영업",
  DEAL_EXECUTION: "딜 진행",
  SETTLEMENT: "정산",
  DROPPED: "드랍",
};

/** Mapping of each zone to its constituent CampaignStatus values. */
export const ZONE_STATUSES: Record<PipelineZone, CampaignStatus[]> = {
  SALES: ["PROPOSAL"],
  DEAL_EXECUTION: ["PREPARATION", "ACTIVE", "CLOSED", "SETTLEMENT_WAIT"],
  SETTLEMENT: ["SETTLEMENT_IN_PROGRESS", "COMPLETED"],
  DROPPED: ["DROPPED"],
};

/** Default status assigned when a campaign is dropped into a zone via drag-and-drop. */
export const ZONE_DEFAULT_STATUS: Record<PipelineZone, CampaignStatus> = {
  SALES: "PROPOSAL",
  DEAL_EXECUTION: "PREPARATION",
  SETTLEMENT: "SETTLEMENT_IN_PROGRESS",
  DROPPED: "DROPPED",
};

/** Sub-status ordering within each zone (top to bottom in kanban column). */
export const ZONE_SUB_STATUS_ORDER: Record<PipelineZone, CampaignStatus[]> = {
  SALES: ["PROPOSAL"],
  DEAL_EXECUTION: ["PREPARATION", "ACTIVE", "CLOSED", "SETTLEMENT_WAIT"],
  SETTLEMENT: ["SETTLEMENT_IN_PROGRESS", "COMPLETED"],
  DROPPED: ["DROPPED"],
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Returns the PipelineZone for a given CampaignStatus.
 * Every valid CampaignStatus maps to exactly one zone.
 */
export function getZoneForStatus(status: CampaignStatus): PipelineZone {
  for (const zone of ZONE_ORDER) {
    if (ZONE_STATUSES[zone].includes(status)) {
      return zone;
    }
  }
  // Exhaustive — all CampaignStatus values are covered by ZONE_STATUSES.
  // This line is unreachable for valid CampaignStatus but satisfies TypeScript.
  return "DEAL_EXECUTION";
}

/**
 * Computes the number of campaigns in each zone.
 * Returns a Record<PipelineZone, number> with counts for all three zones.
 */
export function getZoneCounts(campaigns: CampaignRow[]): Record<PipelineZone, number> {
  const counts: Record<PipelineZone, number> = {
    SALES: 0,
    DEAL_EXECUTION: 0,
    SETTLEMENT: 0,
    DROPPED: 0,
  };

  for (const campaign of campaigns) {
    const zone = getZoneForStatus(campaign.status);
    counts[zone]++;
  }

  return counts;
}

/**
 * Groups campaigns by their pipeline zone.
 * Returns a Record mapping each PipelineZone to its campaigns.
 * Each group's campaigns maintain their original order.
 */
export function groupCampaignsByZone(
  campaigns: CampaignRow[],
): Record<PipelineZone, CampaignRow[]> {
  const groups: Record<PipelineZone, CampaignRow[]> = {
    SALES: [],
    DEAL_EXECUTION: [],
    SETTLEMENT: [],
    DROPPED: [],
  };

  for (const campaign of campaigns) {
    const zone = getZoneForStatus(campaign.status);
    groups[zone].push(campaign);
  }

  return groups;
}

/**
 * Sorts campaigns by startDate based on their status.
 *
 * Rules:
 * - "PREPARATION", "ACTIVE", "CLOSED", "SETTLEMENT_WAIT" are sorted by startDate ascending (oldest first).
 * - "PROPOSAL", "SETTLEMENT_IN_PROGRESS", "COMPLETED", "DROPPED" are sorted by startDate descending (newest first).
 * Campaigns with empty/null startDate are always placed at the end.
 */
export function sortCampaignsByStatus(
  campaigns: CampaignRow[],
  status: CampaignStatus,
): CampaignRow[] {
  const isAsc = [
    "PREPARATION",
    "ACTIVE",
    "CLOSED",
    "SETTLEMENT_WAIT",
  ].includes(status);

  return [...campaigns].sort((a, b) => {
    const dateA = a.startDate || "";
    const dateB = b.startDate || "";
    if (!dateA && !dateB) return 0;
    if (!dateA) return 1;
    if (!dateB) return -1;

    return isAsc ? dateA.localeCompare(dateB) : dateB.localeCompare(dateA);
  });
}
