"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";

import type { CampaignRow, CampaignStatus } from "@/lib/crm-types";
import {
  type PipelineZone,
  ZONE_ORDER,
  ZONE_DEFAULT_STATUS,
  getZoneForStatus,
} from "@/lib/zone-config";
import type { StageFilter } from "@/lib/pipeline-filters";
import { StageColumn } from "./stage-column";
import { CampaignCard } from "./campaign-card";
import { KanbanDragOverlay } from "./kanban-drag-overlay";

// ---------------------------------------------------------------------------
// StageFilter → PipelineZone mapping (for column visibility)
// ---------------------------------------------------------------------------

const STAGE_FILTER_TO_ZONE: Record<Exclude<StageFilter, "ALL">, PipelineZone> = {
  SALES: "SALES",
  PROGRESS: "DEAL_EXECUTION",
  SETTLEMENT: "SETTLEMENT",
};

const isPipelineZone = (value: string): value is PipelineZone =>
  (ZONE_ORDER as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StageKanbanBoardProps {
  campaigns: CampaignRow[];
  stageFilter: StageFilter;
  onRowOpen: (campaign: CampaignRow) => void;
  onRowDelete: (campaign: CampaignRow) => void;
  onRowDuplicate: (campaign: CampaignRow) => void;
  onStatusChange: (campaignId: string, status: CampaignStatus) => Promise<void>;
  onAddCampaign?: (defaultStatus?: CampaignStatus) => void;
}

// ---------------------------------------------------------------------------
// StageKanbanBoard Component
// ---------------------------------------------------------------------------

/**
 * Main kanban board with 3 stage columns (영업, 진행, 정산).
 *
 * Features:
 * - Renders StageColumns in ZONE_ORDER
 * - Filters visible columns based on stageFilter
 * - dnd-kit drag and drop between columns (smooth DragOverlay + drop highlight)
 * - Pointer sensor with 8px activation distance so a click still opens the card;
 *   keyboard sensor for accessible drag
 * - Cross-zone drop: optimistic update + API call via onStatusChange
 * - Intra-zone drop: no-op (order is derived from date sort, not persisted)
 * - On API failure: rollback + toast error (5 seconds)
 */
export function StageKanbanBoard({
  campaigns,
  stageFilter,
  onRowOpen,
  onRowDelete,
  onRowDuplicate,
  onStatusChange,
  onAddCampaign,
}: StageKanbanBoardProps) {
  // Local state for optimistic updates
  const [localCampaigns, setLocalCampaigns] = React.useState<CampaignRow[]>(campaigns);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  // Sync local state when campaigns prop changes
  React.useEffect(() => {
    // Intentional sync: local state holds optimistic drag/drop mutations.
    setLocalCampaigns(campaigns);
  }, [campaigns]);

  // Pointer needs to travel 8px before a drag begins → taps still open the card.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  // Determine which zones to show based on stageFilter
  const visibleZones = React.useMemo<PipelineZone[]>(() => {
    if (stageFilter === "ALL") return ZONE_ORDER;
    const targetZone = STAGE_FILTER_TO_ZONE[stageFilter];
    return [targetZone];
  }, [stageFilter]);

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

  const activeCampaign = React.useMemo(
    () => (activeId ? localCampaigns.find((c) => c.id === activeId) ?? null : null),
    [activeId, localCampaigns],
  );

  // --- Drag and Drop handlers ---

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = React.useCallback(
    async (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over) return;

      const campaignId = String(active.id);
      const overId = String(over.id);
      if (!isPipelineZone(overId)) return;
      const targetZone = overId;

      const campaign = localCampaigns.find((c) => c.id === campaignId);
      if (!campaign) return;

      const sourceZone = getZoneForStatus(campaign.status);
      // Intra-zone drop: reorder is derived from date sort, not persisted → no-op
      if (sourceZone === targetZone) return;

      // Cross-zone drop: optimistic update + API call
      const originalCampaigns = [...localCampaigns];
      const targetStatus = ZONE_DEFAULT_STATUS[targetZone];

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
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex gap-2 pb-2">
        {visibleZones.map((zone) => (
          <StageColumn
            key={zone}
            zone={zone}
            campaigns={campaignsByZone[zone]}
            onRowOpen={onRowOpen}
            onRowDelete={onRowDelete}
            onRowDuplicate={onRowDuplicate}
            onAddCampaign={onAddCampaign}
          />
        ))}
      </div>

      {/* 들린 카드 — 커서 중심을 따라오는 공용 오버레이(body 포털) */}
      <KanbanDragOverlay>
        {activeCampaign ? (
          <CampaignCard
            campaign={activeCampaign}
            onOpen={() => {}}
            onDelete={() => {}}
            onDuplicate={() => {}}
            isOverlay
          />
        ) : null}
      </KanbanDragOverlay>
    </DndContext>
  );
}
