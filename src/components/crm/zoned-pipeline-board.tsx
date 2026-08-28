"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, LayoutGrid, Table2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CampaignRow, CampaignStatus } from "@/lib/crm-types";
import {
  type PipelineZone,
  ZONE_ORDER,
  ZONE_LABELS,
  ZONE_DEFAULT_STATUS,
  getZoneForStatus,
  getZoneCounts,
  sortCampaignsByZone,
} from "@/lib/zone-config";
import type { ZoneCollapseState } from "@/lib/zone-settings";
import { ZoneDivider } from "./zone-divider";
import { SalesZoneTable } from "./sales-zone-table";
import { CampaignCard } from "./campaign-card";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZonedPipelineBoardProps {
  campaigns: CampaignRow[];
  zoneCollapseState: ZoneCollapseState;
  salesZoneViewMode: "kanban" | "table";
  onZoneCollapseChange: (state: ZoneCollapseState) => void;
  onSalesZoneViewModeChange: (mode: "kanban" | "table") => void;
  onRowOpen: (campaign: CampaignRow) => void;
  onRowDelete: (campaign: CampaignRow) => void;
  onRowDuplicate: (campaign: CampaignRow) => void;
  onStatusChange: (campaignId: string, status: CampaignStatus) => Promise<void>;
  onAddCampaign?: () => void;
}

// ---------------------------------------------------------------------------
// ZoneCollapseControl (inline sub-component)
// ---------------------------------------------------------------------------

interface ZoneCollapseControlProps {
  zone: PipelineZone;
  expanded: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

function ZoneCollapseControl({
  zone,
  expanded,
  disabled = false,
  onToggle,
}: ZoneCollapseControlProps) {
  const label = ZONE_LABELS[zone];

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn(
        "size-6 rounded-md",
        disabled && "cursor-not-allowed opacity-50",
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onToggle();
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) {
          e.preventDefault();
          onToggle();
        }
      }}
      aria-expanded={expanded}
      aria-label={`${label} 존 ${expanded ? "접기" : "펼치기"}`}
      disabled={disabled}
      data-testid={`zone-collapse-${zone}`}
    >
      {expanded ? (
        <ChevronDown className="size-3.5" />
      ) : (
        <ChevronRight className="size-3.5" />
      )}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// SalesZoneViewToggle (inline sub-component)
// ---------------------------------------------------------------------------

interface SalesZoneViewToggleProps {
  mode: "kanban" | "table";
  onModeChange: (mode: "kanban" | "table") => void;
}

function SalesZoneViewToggle({ mode, onModeChange }: SalesZoneViewToggleProps) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-white p-0.5">
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn(
          "size-6 rounded",
          mode === "kanban" && "bg-slate-100 text-foreground",
        )}
        onClick={() => onModeChange("kanban")}
        aria-label="칸반 뷰"
        aria-pressed={mode === "kanban"}
        data-testid="sales-zone-kanban-toggle"
      >
        <LayoutGrid className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn(
          "size-6 rounded",
          mode === "table" && "bg-slate-100 text-foreground",
        )}
        onClick={() => onModeChange("table")}
        aria-label="테이블 뷰"
        aria-pressed={mode === "table"}
        data-testid="sales-zone-table-toggle"
      >
        <Table2 className="size-3.5" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ZonedPipelineBoard Component
// ---------------------------------------------------------------------------

/**
 * View B wrapper: renders the pipeline board with 3 zones separated by dividers.
 *
 * Features:
 * - Zone dividers between zone boundaries with campaign counts
 * - Collapse/expand controls per zone
 * - Collapsed zones show only zone name + count
 * - Sales Zone supports kanban/table toggle
 * - DnD across zone boundaries (maintains existing DnD behavior)
 * - DnD into collapsed zones: accepts status change, updates count, keeps zone collapsed
 */
export function ZonedPipelineBoard({
  campaigns,
  zoneCollapseState,
  salesZoneViewMode,
  onZoneCollapseChange,
  onSalesZoneViewModeChange,
  onRowOpen,
  onRowDelete,
  onRowDuplicate,
  onStatusChange,
}: ZonedPipelineBoardProps) {
  const [localCampaigns, setLocalCampaigns] = React.useState(campaigns);
  const [dragOverZone, setDragOverZone] = React.useState<PipelineZone | null>(null);

  // Sync local state when campaigns prop changes
  React.useEffect(() => {
    // Intentional sync: local state holds optimistic drag/drop mutations.
     
    setLocalCampaigns(campaigns);
  }, [campaigns]);

  // Compute zone counts
  const zoneCounts = React.useMemo(
    () => getZoneCounts(localCampaigns),
    [localCampaigns],
  );

  // Group campaigns by zone
  const campaignsByZone = React.useMemo(() => {
    const groups: Record<PipelineZone, CampaignRow[]> = {
      SALES: [],
      DEAL_EXECUTION: [],
      SETTLEMENT: [],
      DROPPED: [],
    };
    for (const campaign of localCampaigns) {
      const zone = getZoneForStatus(campaign.status);
      groups[zone].push(campaign);
    }
    return groups;
  }, [localCampaigns]);

  // Count expanded zones (for disabling last-expanded collapse)
  const expandedCount = ZONE_ORDER.filter((z) => zoneCollapseState[z]).length;

  // Toggle zone collapse
  function handleToggleCollapse(zone: PipelineZone) {
    const isExpanded = zoneCollapseState[zone];
    // Block if this is the last expanded zone
    if (isExpanded && expandedCount <= 1) return;

    onZoneCollapseChange({
      ...zoneCollapseState,
      [zone]: !isExpanded,
    });
  }

  // --- Drag and Drop handlers ---

  const handleDragOver = (zone: PipelineZone) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverZone !== zone) {
      setDragOverZone(zone);
    }
  };

  const handleDragLeave = () => {
    setDragOverZone(null);
  };

  const handleDrop = React.useCallback(
    async (zone: PipelineZone, e: React.DragEvent) => {
      e.preventDefault();
      setDragOverZone(null);

      const campaignId = e.dataTransfer.getData("text/plain");
      if (!campaignId) return;

      const campaign = localCampaigns.find((c) => c.id === campaignId);
      if (!campaign) return;

      const sourceZone = getZoneForStatus(campaign.status);
      if (sourceZone === zone) return; // Same zone, no-op

      const targetStatus = ZONE_DEFAULT_STATUS[zone];
      const originalCampaigns = [...localCampaigns];

      // Optimistic update
      setLocalCampaigns((prev) =>
        prev.map((c) =>
          c.id === campaignId ? { ...c, status: targetStatus } : c,
        ),
      );

      try {
        await onStatusChange(campaignId, targetStatus);
      } catch (err) {
        // Rollback on failure
        setLocalCampaigns(originalCampaigns);
        // `onStatusChange` 는 사용자에게 보여도 되는 한국어 문구를 던진다(그룹 충돌 409
        // 안내 포함) — 여기서 문구를 덮으면 재시도 안내가 다시 사라진다.
        toast.error(
          err instanceof Error && err.message ? err.message : "상태 변경에 실패했습니다. 다시 시도해주세요.",
          { duration: 5000 },
        );
      }
    },
    [localCampaigns, onStatusChange],
  );

  return (
    <div className="flex flex-col gap-3" data-testid="zoned-pipeline-board">
      {ZONE_ORDER.map((zone) => {
        const isExpanded = zoneCollapseState[zone] ?? false;
        const count = zoneCounts[zone];
        const isLastExpanded = isExpanded && expandedCount <= 1;

        return (
          <div
            key={zone}
            data-testid={`zone-section-${zone}`}
            onDragOver={handleDragOver(zone)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(zone, e)}
            className={cn(
              "rounded-xl border transition-colors duration-150",
              dragOverZone === zone
                ? "border-primary/40 bg-primary/5"
                : "border-transparent",
            )}
          >
            {/* Zone Header: Divider + Controls */}
            <div className="flex items-center gap-2">
              <ZoneCollapseControl
                zone={zone}
                expanded={isExpanded}
                disabled={isLastExpanded}
                onToggle={() => handleToggleCollapse(zone)}
              />
              <div className="flex-1">
                <ZoneDivider zone={zone} campaignCount={count} />
              </div>
              {/* Sales Zone table/kanban toggle */}
              {zone === "SALES" && isExpanded && (
                <SalesZoneViewToggle
                  mode={salesZoneViewMode}
                  onModeChange={onSalesZoneViewModeChange}
                />
              )}
            </div>

            {/* Zone Content */}
            {isExpanded ? (
              <div className="mt-2 px-2 pb-3" data-testid={`zone-content-${zone}`}>
                {zone === "SALES" && salesZoneViewMode === "table" ? (
                  <SalesZoneTable
                    campaigns={campaignsByZone[zone]}
                    onRowOpen={onRowOpen}
                    onCampaignUpdate={(updated) => {
                      setLocalCampaigns((prev) =>
                        prev.map((c) => (c.id === updated.id ? updated : c)),
                      );
                    }}
                  />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {sortCampaignsByZone(campaignsByZone[zone], zone).map(
                      (campaign) => (
                        <CampaignCard
                          key={campaign.id}
                          campaign={campaign}
                          onOpen={onRowOpen}
                          onDelete={onRowDelete}
                          onDuplicate={onRowDuplicate}
                        />
                      ),
                    )}
                    {campaignsByZone[zone].length === 0 && (
                      <p className="py-4 text-center text-xs text-muted-foreground w-full">
                        캠페인이 없습니다
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              /* Collapsed: show count only */
              <div
                className="px-10 py-2 text-xs text-muted-foreground"
                data-testid={`zone-collapsed-${zone}`}
              >
                {count}건
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
