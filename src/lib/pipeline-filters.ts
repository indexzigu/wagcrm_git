import type { CampaignRow } from "./crm-types";
import { getZoneForStatus, type PipelineZone } from "./zone-config";
import { getCampaignAction } from "./campaign-actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StageFilter = "ALL" | "SALES" | "PROGRESS" | "SETTLEMENT";

export type SavedView =
  | "DEFAULT"
  | "URGENT"
  | "STAGNANT"
  | "MISSING_SALES"
  | "MANUAL_MARGIN";

export interface PipelineFilterParams {
  stageFilter: StageFilter;
  teamId: string | null;
  searchQuery: string;
  savedView: SavedView;
}

// ---------------------------------------------------------------------------
// StageFilter → PipelineZone mapping
// ---------------------------------------------------------------------------

const STAGE_FILTER_TO_ZONES: Record<Exclude<StageFilter, "ALL">, PipelineZone[]> = {
  SALES: ["SALES"],
  PROGRESS: ["DEAL_EXECUTION", "SETTLEMENT"],
  SETTLEMENT: ["SETTLEMENT"],
};

// ---------------------------------------------------------------------------
// Individual filter functions
// ---------------------------------------------------------------------------

/**
 * Checks if a campaign matches the given stage filter.
 * "ALL" matches everything; otherwise maps StageFilter to PipelineZones
 * and checks if the campaign's zone is included.
 */
export function matchesStageFilter(
  campaign: CampaignRow,
  stageFilter: StageFilter,
): boolean {
  if (stageFilter === "ALL") return true;
  const targetZones = STAGE_FILTER_TO_ZONES[stageFilter];
  return targetZones.includes(getZoneForStatus(campaign.status));
}

/**
 * Checks if a campaign matches the team filter.
 * null teamId means no filter (all campaigns pass).
 */
export function matchesTeamFilter(
  campaign: CampaignRow,
  teamId: string | null,
): boolean {
  if (teamId === null) return true;
  return campaign.assignedTo === teamId;
}

/**
 * Checks if a campaign matches the search query.
 * Searches sellerName, dealName, partnerName fields (case-insensitive).
 * Empty query matches everything.
 */
export function matchesSearchQuery(
  campaign: CampaignRow,
  query: string,
): boolean {
  const trimmed = query.trim();
  if (trimmed === "") return true;

  const lowerQuery = trimmed.toLowerCase();
  return (
    campaign.sellerName.toLowerCase().includes(lowerQuery) ||
    campaign.dealName.toLowerCase().includes(lowerQuery) ||
    campaign.partnerName.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Checks if a campaign matches the saved view filter.
 * - DEFAULT: all campaigns pass
 * - URGENT: endDate approaching (overdue or today)
 * - STAGNANT: no activity for threshold days
 * - MISSING_SALES: actualSales is null
 * - MANUAL_MARGIN: isManualMargin is true
 */
export function matchesSavedView(
  campaign: CampaignRow,
  savedView: SavedView,
): boolean {
  if (savedView === "DEFAULT") return true;

  switch (savedView) {
    case "URGENT": {
      const action = getCampaignAction(campaign);
      return action.tone === "overdue" || action.tone === "today";
    }
    case "STAGNANT": {
      const action = getCampaignAction(campaign);
      return action.isStagnant;
    }
    case "MISSING_SALES":
      return campaign.actualSales == null;
    case "MANUAL_MARGIN":
      return campaign.isManualMargin;
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Combined filter function
// ---------------------------------------------------------------------------

/**
 * Applies all pipeline filters with AND logic.
 * A campaign is included only if it satisfies ALL active filter conditions.
 */
export function applyPipelineFilters(
  campaigns: CampaignRow[],
  params: PipelineFilterParams,
): CampaignRow[] {
  return campaigns.filter(
    (campaign) =>
      matchesStageFilter(campaign, params.stageFilter) &&
      matchesTeamFilter(campaign, params.teamId) &&
      matchesSearchQuery(campaign, params.searchQuery) &&
      matchesSavedView(campaign, params.savedView),
  );
}
