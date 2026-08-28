"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { useDroppable, useDraggable } from "@dnd-kit/core";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CampaignRow, CampaignStatus } from "@/lib/crm-types";
import {
  type PipelineZone,
  ZONE_LABELS,
  ZONE_SUB_STATUS_ORDER,
  sortCampaignsByStatus,
} from "@/lib/zone-config";
import { SUB_STAGE_BADGE_CONFIG } from "@/lib/badge-config";
import { CampaignCard } from "./campaign-card";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StageColumnProps {
  zone: PipelineZone;
  campaigns: CampaignRow[];
  onRowOpen: (campaign: CampaignRow) => void;
  onRowDelete: (campaign: CampaignRow) => void;
  onRowDuplicate: (campaign: CampaignRow) => void;
  onAddCampaign?: (defaultStatus?: CampaignStatus) => void;
}

/** dnd-kit draggable 배선 데이터(onDragEnd에서 원본 zone 식별용). */
export interface CardDragData {
  campaignId: string;
  zone: PipelineZone;
}

/** droppable 배선 데이터(드롭 대상 zone 식별용). */
export interface ZoneDropData {
  zone: PipelineZone;
}

// ---------------------------------------------------------------------------
// DraggableCampaignCard — useDraggable로 CampaignCard를 감싼다
// ---------------------------------------------------------------------------

interface DraggableCampaignCardProps {
  campaign: CampaignRow;
  zone: PipelineZone;
  onRowOpen: (campaign: CampaignRow) => void;
  onRowDelete: (campaign: CampaignRow) => void;
  onRowDuplicate: (campaign: CampaignRow) => void;
}

function DraggableCampaignCard({
  campaign,
  zone,
  onRowOpen,
  onRowDelete,
  onRowDuplicate,
}: DraggableCampaignCardProps) {
  const data: CardDragData = { campaignId: campaign.id, zone };
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: campaign.id,
    data,
  });

  return (
    <CampaignCard
      campaign={campaign}
      onOpen={onRowOpen}
      onDelete={onRowDelete}
      onDuplicate={onRowDuplicate}
      dragRef={setNodeRef}
      dragListeners={listeners}
      dragAttributes={attributes}
      isDragging={isDragging}
    />
  );
}

// ---------------------------------------------------------------------------
// SubGroupDivider
// ---------------------------------------------------------------------------

interface SubGroupDividerProps {
  status: CampaignStatus;
  label: string;
  count: number;
}

/**
 * Lightweight divider between sub-groups within a StageColumn.
 * Shows the sub-status label and count.
 */
function SubGroupDivider({ status, label, count }: SubGroupDividerProps) {
  const config = SUB_STAGE_BADGE_CONFIG[status];

  return (
    <div className="flex items-center gap-2 px-1 py-1.5">
      <div className="h-px flex-1 bg-slate-200/80" />
      <span
        className={cn(
          // 테두리 유틸을 두지 않는다 — 한 축 규칙(테두리 상수, 의미는 채움만)이라
          // 이 칩에는 그릴 테두리가 없다. `border` 만 붙이면 Tailwind v4 기본
          // border-color 가 currentColor 라 글자색 테두리가 그려진다.
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
          config.bg,
          config.text,
        )}
      >
        {label}
        <span className="tabular-nums">({count})</span>
      </span>
      <div className="h-px flex-1 bg-slate-200/80" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// StageColumn Component
// ---------------------------------------------------------------------------

/**
 * A single column in the StageKanbanBoard representing a pipeline zone.
 *
 * Features:
 * - Column header with zone label + campaign count
 * - Sub-group dividers for zones with 2+ statuses (Progress, Settlement)
 * - Campaigns sorted by startDate descending within each sub-group
 * - Empty state message when no campaigns
 * - dnd-kit droppable target: highlights when a card hovers over it
 * - Add campaign button
 */
export function StageColumn({
  zone,
  campaigns,
  onRowOpen,
  onRowDelete,
  onRowDuplicate,
  onAddCampaign,
}: StageColumnProps) {
  const label = ZONE_LABELS[zone];
  const subStatuses = ZONE_SUB_STATUS_ORDER[zone];
  const hasSubGroups = subStatuses.length >= 2;

  const dropData: ZoneDropData = { zone };
  const { setNodeRef, isOver } = useDroppable({ id: zone, data: dropData });

  // Group campaigns by sub-status
  const groupedCampaigns = React.useMemo(() => {
    const groups: Record<CampaignStatus, CampaignRow[]> = {} as Record<
      CampaignStatus,
      CampaignRow[]
    >;
    for (const status of subStatuses) {
      groups[status] = sortCampaignsByStatus(
        campaigns.filter((c) => c.status === status),
        status,
      );
    }
    return groups;
  }, [campaigns, subStatuses]);

  const renderCard = (campaign: CampaignRow) => (
    <DraggableCampaignCard
      key={campaign.id}
      campaign={campaign}
      zone={zone}
      onRowOpen={onRowOpen}
      onRowDelete={onRowDelete}
      onRowDuplicate={onRowDuplicate}
    />
  );

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "crm-horizontal-accent flex w-[300px] shrink-0 flex-col overflow-hidden rounded-xl border bg-slate-50/60 transition-colors duration-150",
        isOver
          ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
          : "border-slate-200/80",
      )}
    >
      {/* Column Header */}
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{label}</h3>
          <span className="inline-flex items-center rounded-full bg-slate-200/80 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-600">
            {campaigns.length}
          </span>
        </div>
        {onAddCampaign && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-6 rounded-md text-muted-foreground hover:text-foreground"
            onClick={() => onAddCampaign(subStatuses[0])}
            aria-label={`${label}에 캠페인 추가`}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>

      {/* Campaign Cards Area */}
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {campaigns.length === 0 ? (
          /* Empty state */
          <div className="flex flex-1 items-center justify-center py-8">
            <p className="text-xs text-muted-foreground">캠페인이 없습니다</p>
          </div>
        ) : hasSubGroups ? (
          /* Render with sub-group dividers */
          subStatuses.map((status, idx) => {
            const group = groupedCampaigns[status];
            const badgeConfig = SUB_STAGE_BADGE_CONFIG[status];

            return (
              <React.Fragment key={status}>
                {idx > 0 && (
                  <SubGroupDivider
                    status={status}
                    label={badgeConfig.label}
                    count={group.length}
                  />
                )}
                {idx === 0 && (
                  <SubGroupDivider
                    status={status}
                    label={badgeConfig.label}
                    count={group.length}
                  />
                )}
                {group.map(renderCard)}
              </React.Fragment>
            );
          })
        ) : (
          /* Single status zone (Sales) — no sub-group dividers */
          sortCampaignsByStatus(campaigns, subStatuses[0]).map(renderCard)
        )}
      </div>
    </div>
  );
}
