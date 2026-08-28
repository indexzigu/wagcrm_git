"use client";

import * as React from "react";
import { ChevronDownIcon, ChevronRightIcon, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";

import { Button } from "@/components/ui/button";
import { CampaignCard } from "@/components/crm/campaign-card";
import { KanbanDragOverlay } from "@/components/crm/kanban-drag-overlay";
import type { CampaignRow, CampaignStatus } from "@/lib/crm-types";
import { getCampaignAction } from "@/lib/campaign-actions";
import { getDaysUntilStart, isInSetupWindow } from "@/lib/campaign-setup";
import { cn } from "@/lib/utils";
import { sortCampaignsByStatus } from "@/lib/zone-config";

const EXECUTION_STATUS_ORDER: CampaignStatus[] = [
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
];

/**
 * 드롭을 받는 상태 컬럼(=상태 전이 목적지). DROPPED는 드래그로 진입시키지 않는다
 * (종료는 명시적 드랍 플로우로만) → droppable 비활성.
 */
const DROPPABLE_STATUSES: ReadonlySet<CampaignStatus> = new Set<CampaignStatus>([
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
]);

const EXECUTION_COLUMN_META: Record<
  CampaignStatus,
  { title: string; description: string; emptyLabel: string }
> = {
  PROPOSAL: {
    title: "",
    description: "",
    emptyLabel: "",
  },
  PREPARATION: {
    title: "판매 대기",
    description: "일정 확정, 자료 정리, 운영 시작 전 준비 작업",
    emptyLabel: "준비 중인 캠페인이 없습니다.",
  },
  ACTIVE: {
    title: "판매 진행",
    description: "라이브 운영, 링크 관리, 실매출 확인이 필요한 캠페인",
    emptyLabel: "현재 진행 중인 캠페인이 없습니다.",
  },
  CLOSED: {
    title: "판매 마감",
    description: "행사 종료 후 최종 매출과 운영 이슈를 정리하는 캠페인",
    emptyLabel: "마감 처리할 캠페인이 없습니다.",
  },
  SETTLEMENT_WAIT: {
    title: "정산 대기",
    // 컬럼 설명은 상태 단위(캠페인별이 아님)라 채널을 알 수 없다 — 중립 문구가 유일한
    // 정답이다(오너 확정 2026-08-25, 구 「몰 정산금」은 자사몰 전용 개념이었다).
    description: "반품기간과 정산금 입금을 기다리는 캠페인",
    emptyLabel: "정산 대기 중인 캠페인이 없습니다.",
  },
  SETTLEMENT_IN_PROGRESS: {
    title: "정산 진행",
    description: "정산 내역을 확인하고 처리 중인 캠페인",
    emptyLabel: "정산 진행 중인 캠페인이 없습니다.",
  },
  COMPLETED: {
    title: "정산 완료",
    description: "모든 정산이 완료된 캠페인",
    emptyLabel: "정산 완료된 캠페인이 없습니다.",
  },
  DROPPED: {
    title: "드랍",
    description: "진행 중 예외 사유로 종료된 캠페인",
    emptyLabel: "드랍 처리된 캠페인이 없습니다.",
  },
};

type ExecutionKanbanBoardProps = {
  campaigns: CampaignRow[];
  onRowOpen: (campaign: CampaignRow) => void;
  onRowDelete: (campaign: CampaignRow) => void;
  onRowDuplicate: (campaign: CampaignRow) => void;
  onStatusChange: (campaignId: string, status: CampaignStatus) => Promise<void>;
  onAddCampaign?: (defaultStatus?: CampaignStatus) => void;
};

type QuickFilter = "ALL" | "TODAY" | "DELAYED" | "MISSING_SALES" | "CHECKLIST_PENDING";

// ---------------------------------------------------------------------------
// DraggableExecutionCard — useDraggable로 CampaignCard를 감싼다
// (StageKanbanBoard와 동일한 dnd-kit 배선 — 카드 계약은 CampaignCard가 이미 지원)
// ---------------------------------------------------------------------------

interface DraggableExecutionCardProps {
  campaign: CampaignRow;
  onRowOpen: (campaign: CampaignRow) => void;
  onRowDelete: (campaign: CampaignRow) => void;
  onRowDuplicate: (campaign: CampaignRow) => void;
}

function DraggableExecutionCard({
  campaign,
  onRowOpen,
  onRowDelete,
  onRowDuplicate,
}: DraggableExecutionCardProps) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: campaign.id,
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
// ExecutionColumn — status 단위 컬럼. useDroppable 대상.
// ---------------------------------------------------------------------------

interface ExecutionColumnProps {
  status: CampaignStatus;
  column: CampaignRow[];
  onRowOpen: (campaign: CampaignRow) => void;
  onRowDelete: (campaign: CampaignRow) => void;
  onRowDuplicate: (campaign: CampaignRow) => void;
  onAddCampaign?: (defaultStatus?: CampaignStatus) => void;
  /**
   * 퀵필터가 걸린 상태 — 세팅 대기의 "시작 대기" 접힘을 강제로 펼친다.
   * 필터를 누른 목적은 매칭 카드를 한눈에 보는 것인데, 매칭 카드가 접힘 뒤에 있으면
   * 헤더 카운트만 오르고 화면엔 안 나와 필터가 무력화된다(code-reviewer 적발).
   */
  isFiltered?: boolean;
}

function ExecutionColumn({
  status,
  column,
  onRowOpen,
  onRowDelete,
  onRowDuplicate,
  onAddCampaign,
  isFiltered = false,
}: ExecutionColumnProps) {
  const meta = EXECUTION_COLUMN_META[status];
  const droppable = DROPPABLE_STATUSES.has(status);
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: !droppable });

  // 세팅 대기 2분할 — 세팅 창(D-10) 안만 펼치고, 판매일이 먼 건은 접는다.
  // 이 컬럼은 "지금 세팅할 것"과 "날짜만 기다리는 것"이 섞여 비대해 보였다(판매 일정이
  // 길게 확정되는 특성상 대부분이 후자). 접힌 카드는 **사라진 게 아니라** 요약 줄로
  // 남고 헤더 카운트에도 계속 잡힌다 — 근거는 `campaign-setup.ts` doc.
  const [showWaiting, setShowWaiting] = React.useState(false);
  const { setupCards, waitingCards } = React.useMemo(() => {
    if (status !== "PREPARATION") {
      return { setupCards: column, waitingCards: [] as CampaignRow[] };
    }
    const setup: CampaignRow[] = [];
    const waiting: CampaignRow[] = [];
    for (const campaign of column) {
      (isInSetupWindow(campaign) ? setup : waiting).push(campaign);
    }
    return { setupCards: setup, waitingCards: waiting };
  }, [column, status]);

  // 요약 줄에 최근접 시작일을 박는다 — 건수만 있으면 접힌 줄이 "볼 것 없음"으로
  // 읽혀 습관적으로 안 읽게 된다(ss-ux-designer 지적).
  const nearestWaitingDays = React.useMemo(() => {
    let nearest: number | null = null;
    for (const campaign of waitingCards) {
      const days = getDaysUntilStart(campaign);
      if (days === null) continue;
      if (nearest === null || days < nearest) nearest = days;
    }
    return nearest;
  }, [waitingCards]);

  const expandWaiting = showWaiting || isFiltered;

  const delayedCount = column.filter((campaign) => {
    const action = getCampaignAction(campaign);
    return action.isStagnant || action.tone === "overdue";
  }).length;
  const missingSalesCount = column.filter(
    (campaign) =>
      (campaign.status === "ACTIVE" ||
        campaign.status === "CLOSED" ||
        campaign.status === "SETTLEMENT_WAIT") &&
      campaign.actualSales == null,
  ).length;
  const avgCompletion =
    column.length === 0
      ? 0
      : Math.round(
          (column.reduce((sum, campaign) => {
            const summary = campaign.checklistSummary;
            if (!summary || summary.requiredTotalCount === 0) return sum;
            return sum + summary.requiredCheckedCount / summary.requiredTotalCount;
          }, 0) /
            column.length) *
            100,
        );

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "crm-horizontal-accent flex w-[300px] flex-none shrink-0 flex-col overflow-hidden rounded-xl border bg-white/85 shadow-soft-sm transition-colors",
        droppable && isOver
          ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
          : "border-slate-200/80",
      )}
    >
      <div className="border-b px-4 py-3 border-slate-200/80">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-[12px] font-semibold text-foreground">
                {meta.title}
              </h3>
              <span className="inline-flex shrink-0 items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-slate-600">
                {column.length}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-600">
              <div className="flex items-center gap-0.5">
                <span className="text-slate-500">지연</span>
                <span className="font-semibold">{delayedCount}</span>
              </div>
              <span className="text-slate-300">/</span>
              <div className="flex items-center gap-0.5">
                <span className="text-slate-500">미입력</span>
                <span className="font-semibold">{missingSalesCount}</span>
              </div>
              <span className="text-slate-300">/</span>
              <div className="flex items-center gap-0.5">
                <span className="text-slate-500">완료율</span>
                <span className="font-semibold">{avgCompletion}%</span>
              </div>
            </div>
          </div>
          {onAddCampaign && status === "PREPARATION" ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-7 rounded-md text-muted-foreground hover:text-foreground"
              onClick={() => onAddCampaign(status)}
              aria-label="세팅 대기 캠페인 추가"
            >
              <Plus className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 py-2">
        {column.length === 0 && !(droppable && isOver) ? (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-10 text-center text-xs text-muted-foreground">
            {meta.emptyLabel}
          </div>
        ) : (
          <>
            {setupCards.map((campaign) => (
              <DraggableExecutionCard
                key={campaign.id}
                campaign={campaign}
                onRowOpen={onRowOpen}
                onRowDelete={onRowDelete}
                onRowDuplicate={onRowDuplicate}
              />
            ))}
            {/* 세팅 창은 비었는데 시작 대기만 남은 상태 — 컬럼이 통째로 비지 않아
                기존 빈-상태 placeholder 가 안 뜨므로, 안내 없는 여백이 "렌더가 덜 됐나"로
                읽힌다(ss-ux-designer 적발). 정상 상태임을 명시한다. */}
            {setupCards.length === 0 && waitingCards.length > 0 ? (
              <div className="shrink-0 rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-xs text-muted-foreground">
                지금 세팅할 캠페인이 없습니다
              </div>
            ) : null}
            {waitingCards.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowWaiting((prev) => !prev)}
                // 퀵필터가 켜져 있으면 강제 펼침 상태라 토글이 무의미하다 — 눌러도
                // 화면이 안 바뀌면 "고장났나"로 읽히므로 disabled 로 정직하게 알린다.
                disabled={isFiltered}
                aria-expanded={expandWaiting}
                aria-label={`시작 대기 ${waitingCards.length}건 ${expandWaiting ? "접기" : "펼치기"}`}
                className="flex shrink-0 items-center justify-between gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-2.5 py-2 text-left text-[11px] text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-100/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-70"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium text-slate-700">시작 대기</span>{" "}
                  <span className="tabular-nums">{waitingCards.length}건</span>
                  {nearestWaitingDays !== null ? (
                    <span className="text-slate-500">
                      {" · 가장 빠른 "}
                      <span className="tabular-nums">D-{nearestWaitingDays}</span>
                    </span>
                  ) : null}
                </span>
                {/* 펼침 상태는 아이콘으로 — `zone-collapse-control.tsx` 관례. 텍스트
                    라벨("펼치기/접기")을 slate-400 으로 얹었다가 2.45:1 로 AA 미달이었다. */}
                {expandWaiting ? (
                  <ChevronDownIcon className="size-3.5 shrink-0 text-slate-500" />
                ) : (
                  <ChevronRightIcon className="size-3.5 shrink-0 text-slate-500" />
                )}
              </button>
            ) : null}
            {expandWaiting
              ? waitingCards.map((campaign) => (
                  <DraggableExecutionCard
                    key={campaign.id}
                    campaign={campaign}
                    onRowOpen={onRowOpen}
                    onRowDelete={onRowDelete}
                    onRowDuplicate={onRowDuplicate}
                  />
                ))
              : null}
            {/* 드롭 대상 컬럼에 카드가 들어올 자리 — 고스트 플레이스홀더.
                순서는 날짜정렬 파생이라 '컬럼에 합류' 의미로 목록 끝에 표시. */}
            {droppable && isOver ? (
              <div
                aria-hidden
                className="flex shrink-0 items-center justify-center rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 px-4 py-6 text-center text-[12px] font-medium text-primary/80"
              >
                여기에 놓기
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function ExecutionKanbanBoard({
  campaigns,
  onRowOpen,
  onRowDelete,
  onRowDuplicate,
  onStatusChange,
  onAddCampaign,
}: ExecutionKanbanBoardProps) {
  const [localCampaigns, setLocalCampaigns] = React.useState<CampaignRow[]>(campaigns);
  const [showDropped, setShowDropped] = React.useState(false);
  const [quickFilter, setQuickFilter] = React.useState<QuickFilter>("ALL");
  const [activeId, setActiveId] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Intentional sync: local state holds optimistic drag/drop mutations.

    setLocalCampaigns(campaigns);
  }, [campaigns]);

  // 포인터가 8px 이동해야 드래그 시작 → 탭(카드 열기)과 드래그를 구분. 키보드 센서(a11y).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const filteredCampaigns = React.useMemo(() => {
    return localCampaigns.filter((campaign) => {
      if (campaign.status === "DROPPED") return true;
      const action = getCampaignAction(campaign);
      switch (quickFilter) {
        case "TODAY":
          return action.tone === "today" || action.tone === "overdue";
        case "DELAYED":
          return action.isStagnant || action.tone === "overdue";
        case "MISSING_SALES":
          return (
            (campaign.status === "ACTIVE" ||
              campaign.status === "CLOSED" ||
              campaign.status === "SETTLEMENT_WAIT") &&
            campaign.actualSales == null
          );
        case "CHECKLIST_PENDING":
          return Boolean(
            campaign.checklistSummary &&
              !campaign.checklistSummary.isComplete &&
              campaign.checklistSummary.requiredTotalCount > 0,
          );
        case "ALL":
        default:
          return true;
      }
    });
  }, [localCampaigns, quickFilter]);

  const campaignsByStatus = React.useMemo(() => {
    const statusOrder: CampaignStatus[] = [...EXECUTION_STATUS_ORDER, "SETTLEMENT_IN_PROGRESS", "COMPLETED", "DROPPED"];
    return statusOrder.reduce<Record<CampaignStatus, CampaignRow[]>>(
      (groups, status) => {
        const filtered = filteredCampaigns.filter((campaign) => {
          return campaign.status === status;
        });
        groups[status] = sortCampaignsByStatus(filtered, status);
        return groups;
      },
      {
        PROPOSAL: [],
        PREPARATION: [],
        ACTIVE: [],
        CLOSED: [],
        SETTLEMENT_WAIT: [],
        SETTLEMENT_IN_PROGRESS: [],
        COMPLETED: [],
        DROPPED: [],
      },
    );
  }, [filteredCampaigns]);

  const quickFilterCounts = React.useMemo<Record<QuickFilter, number>>(() => {
    const actionable = localCampaigns.filter((campaign) => campaign.status !== "DROPPED");
    return {
      ALL: actionable.length,
      TODAY: actionable.filter((campaign) => {
        const action = getCampaignAction(campaign);
        return action.tone === "today" || action.tone === "overdue";
      }).length,
      DELAYED: actionable.filter((campaign) => {
        const action = getCampaignAction(campaign);
        return action.isStagnant || action.tone === "overdue";
      }).length,
      MISSING_SALES: actionable.filter(
        (campaign) =>
          (campaign.status === "ACTIVE" ||
            campaign.status === "CLOSED" ||
            campaign.status === "SETTLEMENT_WAIT") &&
          campaign.actualSales == null,
      ).length,
      CHECKLIST_PENDING: actionable.filter(
        (campaign) =>
          Boolean(
            campaign.checklistSummary &&
              !campaign.checklistSummary.isComplete &&
              campaign.checklistSummary.requiredTotalCount > 0,
          ),
      ).length,
    };
  }, [localCampaigns]);

  const handleDrop = React.useCallback(
    async (campaignId: string, targetStatus: CampaignStatus) => {
      const campaign = localCampaigns.find((item) => item.id === campaignId);
      if (!campaign || campaign.status === targetStatus) {
        return;
      }

      const previousCampaigns = [...localCampaigns];

      setLocalCampaigns((current) =>
        current.map((item) =>
          item.id === campaignId ? { ...item, status: targetStatus } : item,
        ),
      );

      try {
        await onStatusChange(campaignId, targetStatus);
      } catch (err) {
        setLocalCampaigns(previousCampaigns);
        // `onStatusChange` 는 사용자에게 보여도 되는 한국어 문구를 던진다(그룹 충돌 409
        // 안내 포함) — 여기서 문구를 덮으면 재시도 안내가 다시 사라진다.
        toast.error(
          err instanceof Error && err.message ? err.message : "진행 단계 이동에 실패했습니다. 다시 시도해주세요.",
          { duration: 5000 },
        );
      }
    },
    [localCampaigns, onStatusChange],
  );

  const activeCampaign = React.useMemo(
    () => (activeId ? localCampaigns.find((c) => c.id === activeId) ?? null : null),
    [activeId, localCampaigns],
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = React.useCallback(
    async (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over) return;

      const targetStatus = String(over.id) as CampaignStatus;
      // 드롭 대상이 유효한 상태 컬럼일 때만 전이(그 외 id는 무시).
      if (!DROPPABLE_STATUSES.has(targetStatus)) return;

      await handleDrop(String(active.id), targetStatus);
    },
    [handleDrop],
  );

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {[
            { value: "ALL", label: "전체 처리" },
            { value: "TODAY", label: "오늘 처리" },
            { value: "DELAYED", label: "지연" },
            { value: "MISSING_SALES", label: "실매출 미입력" },
            { value: "CHECKLIST_PENDING", label: "체크리스트 미완료" },
          ].map((filter) => (
            <Button
              key={filter.value}
              variant={quickFilter === filter.value ? "secondary" : "outline"}
              size="sm"
              onClick={() => setQuickFilter(filter.value as QuickFilter)}
            >
              {filter.label} {quickFilterCounts[filter.value as QuickFilter]}
            </Button>
          ))}
        </div>
        <Button
          variant={showDropped ? "secondary" : "outline"}
          size="sm"
          onClick={() => setShowDropped((value) => !value)}
        >
          {showDropped ? "진행 중인 캠페인 보기" : "정산 및 종료 캠페인 보기"}
        </Button>
      </div>
      <DndContext
        // 안정적 id — dnd-kit이 aria-describedby(DndDescribedBy)를 모듈 카운터로 만들어
        // SSR/클라이언트 하이드레이션 미스매치를 내는 것을 방지(결정론화).
        id="execution-kanban-board"
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto pb-2">
          {(showDropped ? (["SETTLEMENT_IN_PROGRESS", "COMPLETED", "DROPPED"] as CampaignStatus[]) : EXECUTION_STATUS_ORDER).map((status) => (
            <ExecutionColumn
              key={status}
              status={status}
              column={campaignsByStatus[status]}
              onRowOpen={onRowOpen}
              onRowDelete={onRowDelete}
              onRowDuplicate={onRowDuplicate}
              onAddCampaign={onAddCampaign}
              isFiltered={quickFilter !== "ALL"}
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
    </div>
  );
}
