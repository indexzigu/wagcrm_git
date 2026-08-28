"use client";

import * as React from "react";
import { ArrowUpDownIcon, ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CampaignRow, CampaignStatus } from "@/lib/crm-types";
import type { StageFilter } from "@/lib/pipeline-filters";
import {
  groupCampaignsByZone,
  ZONE_LABELS,
  ZONE_ORDER,
  type PipelineZone,
} from "@/lib/zone-config";
import { formatCurrency, formatRate } from "@/lib/format";
import { SubStageBadge } from "./sub-stage-badge";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortField =
  | "sellerName"
  | "dealName"
  | "status"
  | "startDate"
  | "endDate"
  | "actualSales"
  | "netMarginRate"
  | "depositReceivedAt"
  | "payoutCompletedAt"
  | "accountingCompletedAt";

type SortDirection = "asc" | "desc";

type GroupSortState = {
  field: SortField | null;
  direction: SortDirection;
};

export interface GroupedTableViewProps {
  campaigns: CampaignRow[];
  stageFilter: StageFilter;
  onRowOpen: (campaign: CampaignRow) => void;
  onRowDelete: (campaign: CampaignRow) => void;
  onRowDuplicate: (campaign: CampaignRow) => void;
  onStatusChange: (campaignId: string, status: CampaignStatus) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STAGE_FILTER_TO_ZONES: Record<StageFilter, PipelineZone[]> = {
  ALL: ["SALES", "DEAL_EXECUTION", "SETTLEMENT", "DROPPED"],
  SALES: ["SALES"],
  PROGRESS: ["DEAL_EXECUTION", "SETTLEMENT"],
  SETTLEMENT: ["SETTLEMENT"],
};

function dateText(value: string | null | undefined): string {
  if (!value) return "-";
  return value.slice(5).replace("-", ".");
}

function compareCampaigns(
  a: CampaignRow,
  b: CampaignRow,
  field: SortField,
  direction: SortDirection,
): number {
  let cmp = 0;

  switch (field) {
    case "sellerName":
      cmp = a.sellerName.localeCompare(b.sellerName, "ko");
      break;
    case "dealName":
      cmp = a.dealName.localeCompare(b.dealName, "ko");
      break;
    case "status":
      cmp = a.status.localeCompare(b.status);
      break;
    case "startDate":
      cmp = (a.startDate || "").localeCompare(b.startDate || "");
      break;
    case "endDate":
      cmp = (a.endDate || "").localeCompare(b.endDate || "");
      break;
    case "actualSales":
      cmp = (a.actualSales ?? 0) - (b.actualSales ?? 0);
      break;
    case "netMarginRate":
      cmp = (a.netMarginRate ?? 0) - (b.netMarginRate ?? 0);
      break;
    case "depositReceivedAt":
      cmp = (a.depositReceivedAt || "").localeCompare(b.depositReceivedAt || "");
      break;
    case "payoutCompletedAt":
      cmp = (a.payoutCompletedAt || "").localeCompare(b.payoutCompletedAt || "");
      break;
    case "accountingCompletedAt":
      cmp = (a.accountingCompletedAt || "").localeCompare(b.accountingCompletedAt || "");
      break;
  }

  return direction === "asc" ? cmp : -cmp;
}

function sortCampaigns(
  campaigns: CampaignRow[],
  sortState: GroupSortState,
): CampaignRow[] {
  if (!sortState.field) return campaigns;
  return [...campaigns].sort((a, b) =>
    compareCampaigns(a, b, sortState.field!, sortState.direction),
  );
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const DEFAULT_COLUMNS: { field: SortField; label: string; width: string }[] = [
  { field: "sellerName", label: "셀러명", width: "w-[160px]" },
  { field: "dealName", label: "딜명", width: "w-[200px]" },
  { field: "status", label: "상태", width: "w-[130px]" },
  { field: "startDate", label: "시작일", width: "w-[100px]" },
  { field: "endDate", label: "종료일", width: "w-[100px]" },
  { field: "actualSales", label: "매출", width: "w-[120px]" },
  { field: "netMarginRate", label: "마진율", width: "w-[90px]" },
];

const SETTLEMENT_COLUMNS: { field: SortField; label: string; width: string }[] = [
  { field: "sellerName", label: "셀러명", width: "w-[140px]" },
  { field: "dealName", label: "딜명", width: "w-[160px]" },
  { field: "status", label: "상태", width: "w-[120px]" },
  { field: "actualSales", label: "매출", width: "w-[100px]" },
  { field: "depositReceivedAt", label: "입금일", width: "w-[100px]" },
  { field: "payoutCompletedAt", label: "지급일", width: "w-[100px]" },
  { field: "accountingCompletedAt", label: "회계마감", width: "w-[100px]" },
];

// ---------------------------------------------------------------------------
// GroupSection Component
// ---------------------------------------------------------------------------

interface GroupSectionProps {
  zone: PipelineZone;
  campaigns: CampaignRow[];
  expanded: boolean;
  onToggle: () => void;
  sortState: GroupSortState;
  onSort: (field: SortField) => void;
  onRowOpen: (campaign: CampaignRow) => void;
  columns: { field: SortField; label: string; width: string }[];
}

function GroupSection({
  zone,
  campaigns,
  expanded,
  onToggle,
  sortState,
  onSort,
  onRowOpen,
  columns,
}: GroupSectionProps) {
  const label = ZONE_LABELS[zone];
  const count = campaigns.length;
  const sorted = sortCampaigns(campaigns, sortState);

  return (
    <div className="mb-4">
      {/* Group Header */}
      <div className="flex items-center gap-2 rounded-t-md border border-border/70 bg-muted/50 px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-expanded={expanded}
          aria-label={`${label} 그룹 ${expanded ? "접기" : "펼치기"}`}
          onClick={onToggle}
          className="size-7"
        >
          {expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </Button>
        <span className="text-sm font-semibold text-foreground">{label}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {count}
        </span>
      </div>

      {/* Group Content */}
      {expanded && (
        <div className="overflow-hidden rounded-b-md border border-t-0 border-border/70">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {columns.map((col) => (
                  <TableHead key={col.field} className={cn(col.width)}>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="-ml-1 h-8 rounded-md px-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase hover:bg-slate-100 hover:text-foreground"
                      onClick={() => onSort(col.field)}
                    >
                      {col.label}
                      <ArrowUpDownIcon className="ml-1 size-3" />
                    </Button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {count === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={columns.length}
                    className="h-20 text-center text-sm text-muted-foreground"
                  >
                    해당 단계에 캠페인이 없습니다.
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map((campaign) => (
                  <TableRow
                    key={campaign.id}
                    className="cursor-pointer transition-colors hover:bg-muted/30"
                    onClick={() => onRowOpen(campaign)}
                  >
                    {columns.map((col) => {
                      switch (col.field) {
                        case "sellerName":
                          return (
                            <TableCell key={col.field} className={col.width}>
                              <span className="block truncate text-sm text-foreground">
                                {campaign.sellerName}
                              </span>
                            </TableCell>
                          );
                        case "dealName":
                          return (
                            <TableCell key={col.field} className={col.width}>
                              <span className="block truncate text-sm text-foreground">
                                {campaign.dealName}
                              </span>
                            </TableCell>
                          );
                        case "status":
                          return (
                            <TableCell key={col.field} className={col.width}>
                              <SubStageBadge status={campaign.status} size="compact" />
                            </TableCell>
                          );
                        case "startDate":
                          return (
                            <TableCell key={col.field} className={col.width}>
                              <span className="font-mono text-xs text-muted-foreground">
                                {dateText(campaign.startDate)}
                              </span>
                            </TableCell>
                          );
                        case "endDate":
                          return (
                            <TableCell key={col.field} className={col.width}>
                              <span className="font-mono text-xs text-muted-foreground">
                                {dateText(campaign.endDate)}
                              </span>
                            </TableCell>
                          );
                        case "actualSales":
                          return (
                            <TableCell key={col.field} className={col.width}>
                              <span className="font-mono text-xs text-foreground">
                                {formatCurrency(campaign.actualSales ?? 0)}
                              </span>
                            </TableCell>
                          );
                        case "netMarginRate":
                          return (
                            <TableCell key={col.field} className={col.width}>
                              <span className="font-mono text-xs text-foreground">
                                {formatRate(campaign.netMarginRate)}
                              </span>
                            </TableCell>
                          );
                        case "depositReceivedAt":
                          return (
                            <TableCell key={col.field} className={col.width}>
                              <span className="font-mono text-xs text-muted-foreground">
                                {dateText(campaign.depositReceivedAt)}
                              </span>
                            </TableCell>
                          );
                        case "payoutCompletedAt":
                          return (
                            <TableCell key={col.field} className={col.width}>
                              <span className="font-mono text-xs text-muted-foreground">
                                {dateText(campaign.payoutCompletedAt)}
                              </span>
                            </TableCell>
                          );
                        case "accountingCompletedAt":
                          return (
                            <TableCell key={col.field} className={col.width}>
                              <span className="font-mono text-xs text-muted-foreground">
                                {dateText(campaign.accountingCompletedAt)}
                              </span>
                            </TableCell>
                          );
                        default:
                          return <TableCell key={col.field} className={col.width} />;
                      }
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GroupedTableView Component
// ---------------------------------------------------------------------------

export function GroupedTableView({
  campaigns,
  stageFilter,
  onRowOpen,
}: GroupedTableViewProps) {
  // Collapse state: all groups expanded by default
  const [collapsed, setCollapsed] = React.useState<Record<PipelineZone, boolean>>({
    SALES: false,
    DEAL_EXECUTION: false,
    SETTLEMENT: false,
    DROPPED: false,
  });

  // Independent sort state per group
  const [sortStates, setSortStates] = React.useState<
    Record<PipelineZone, GroupSortState>
  >({
    SALES: { field: null, direction: "asc" },
    DEAL_EXECUTION: { field: null, direction: "asc" },
    SETTLEMENT: { field: null, direction: "asc" },
    DROPPED: { field: null, direction: "asc" },
  });

  // Group campaigns by zone
  const grouped = React.useMemo(
    () => groupCampaignsByZone(campaigns),
    [campaigns],
  );

  // Determine which zones to show based on stageFilter
  const visibleZones = STAGE_FILTER_TO_ZONES[stageFilter];

  const handleToggle = React.useCallback((zone: PipelineZone) => {
    setCollapsed((prev) => ({ ...prev, [zone]: !prev[zone] }));
  }, []);

  const handleSort = React.useCallback((zone: PipelineZone, field: SortField) => {
    setSortStates((prev) => {
      const current = prev[zone];
      const newDirection: SortDirection =
        current.field === field && current.direction === "asc" ? "desc" : "asc";
      return {
        ...prev,
        [zone]: { field, direction: newDirection },
      };
    });
  }, []);

  const columns = stageFilter === "SETTLEMENT" ? SETTLEMENT_COLUMNS : DEFAULT_COLUMNS;

  return (
    <div className="space-y-0 px-4 py-4">
      {ZONE_ORDER.filter((zone) => visibleZones.includes(zone)).map((zone) => (
        <GroupSection
          key={zone}
          zone={zone}
          campaigns={grouped[zone]}
          expanded={!collapsed[zone]}
          onToggle={() => handleToggle(zone)}
          sortState={sortStates[zone]}
          onSort={(field) => handleSort(zone, field)}
          onRowOpen={onRowOpen}
          columns={columns}
        />
      ))}
    </div>
  );
}
