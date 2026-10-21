"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PlusIcon,
  SearchIcon,
  Boxes,
} from "lucide-react";
import { Button } from "@/components/ui/button";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";

import type { CampaignRow, DashboardData } from "@/lib/crm-types";
import { type CampaignStatus } from "@/lib/crm-types";
import { getZoneCounts, getZoneForStatus } from "@/lib/zone-config";
import { applyPipelineFilters } from "@/lib/pipeline-filters";
import { patchCampaign } from "@/lib/campaign-patch";
import {
  LIST_REFRESH_FAILED_MESSAGE,
  createGroupSiblingRefresher,
  refreshCampaignRows,
} from "@/lib/campaign-row-refresh";
import { toast } from "@/lib/toast";
import { useStageFilter, type StageFilter } from "@/hooks/use-stage-filter";
import { useCampaignDeepLink } from "@/hooks/use-campaign-deep-link";
import { CampaignCreationSheet } from "./campaign-creation-sheet";
import { BulkComboCampaignDialog } from "./bulk-combo-campaign-dialog";
import { maybeSuggestGroupJoin } from "./campaign-group-join-toast";
import { MobilePipelineView } from "@/components/mobile/mobile-pipeline-view";
import {
  campaignRowsToGroupDetailData,
  MobileCampaignDetailSheet,
} from "@/components/mobile/mobile-campaign-detail-sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { CampaignSidePanel } from "./campaign-side-panel";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { CrmShell } from "./crm-shell";
import { summarizeExecutionHeadline } from "@/lib/execution-quick-filters";
import { MoneySummaryStrip, moneyFlowGroup } from "./money-summary-strip";
import { DataSourceBanner } from "./data-source-banner";
import { ExecutionKanbanBoard } from "./execution-kanban-board";
import { StageFilterBar } from "./stage-filter-bar";
import { StageKanbanBoard } from "./stage-kanban-board";
import { GroupedTableView } from "./grouped-table-view";
import { summarizePipelineMoney } from "@/lib/pipeline-money-summary";

/** 보기 전환(칸반/테이블) — 셸 머리 가운데의 분할 버튼으로 그린다. 상태·저장은 useStageFilter 그대로. */
const VIEW_MODE_OPTIONS = [
  { value: "kanban", label: "칸반" },
  { value: "table", label: "테이블" },
] as const;

/** 상태 변경 실패의 기본 문구 — 보드가 그대로 토스트로 띄운다. */
const STATUS_CHANGE_ERROR = "상태 변경에 실패했습니다. 다시 시도해주세요.";

// ---------------------------------------------------------------------------
// CrmDashboard Component
// ---------------------------------------------------------------------------

type CrmDashboardProps = {
  initialData: DashboardData;
  lockedStageFilter?: StageFilter;
  allowCreate?: boolean;
  createDefaultStatus?: CampaignStatus;
};

export function CrmDashboard({
  initialData,
  lockedStageFilter,
  allowCreate = true,
  createDefaultStatus: preferredCreateDefaultStatus,
}: CrmDashboardProps) {
  const isMobile = useIsMobile();
  const [rows, setRows] = useState(initialData.campaigns);
  const [selected, setSelected] = useState<CampaignRow | null>(rows[0] ?? null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [comboOpen, setComboOpen] = useState(false);
  const [createSheetDefaultStatus, setCreateSheetDefaultStatus] = useState<CampaignStatus | undefined>(undefined);
  // Phase 3(모바일 전용): 모바일 UA에서는 데스크탑 SidePanel 대신 조회 전용 상세 시트를 연다.
  // 데스크탑 경로(openCampaign→CampaignSidePanel)는 그대로 — 아래 상태는 모바일 분기만 사용.
  const [mobileDetailCampaign, setMobileDetailCampaign] = useState<CampaignRow | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  // --- useStageFilter hook: manages stageFilter, teamFilter, searchQuery, viewMode ---
  const {
    stageFilter,
    setStageFilter,
    teamFilter,
    setTeamFilter,
    searchQuery,
    setSearchQuery,
    viewMode,
    setViewMode,
  } = useStageFilter();
  const effectiveStageFilter = lockedStageFilter ?? stageFilter;

  useEffect(() => {
    if (lockedStageFilter && stageFilter !== lockedStageFilter) {
      setStageFilter(lockedStageFilter);
    }
  }, [lockedStageFilter, stageFilter, setStageFilter]);

  function openCreationSheet(defaultStatus?: CampaignStatus) {
    setCreateSheetDefaultStatus(defaultStatus ?? preferredCreateDefaultStatus);
    setCreateOpen(true);
  }

  /** 행 하나를 목록·열린 패널에 되꽂는다(교체만). */
  const applyCampaignRow = useCallback((nextCampaign: CampaignRow) => {
    setRows((previous) =>
      previous.map((row) => (row.id === nextCampaign.id ? nextCampaign : row)),
    );
    setSelected((previous) =>
      previous?.id === nextCampaign.id ? nextCampaign : previous,
    );
  }, []);

  // 그룹 소속 캠페인을 저장하면 서버는 형제에도 반영하지만(정산 일정·플래그 = 그룹 스칼라,
  // 기간 = 팬아웃) 응답은 수정한 1건뿐이다 — 형제 카드를 다시 읽어 새 값을 보이게 한다.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  // 한 틱의 통지를 모으는 상태를 들고 있어 인스턴스는 하나여야 한다 — 첫 통지 때 만든다.
  const siblingRefresherRef = useRef<ReturnType<typeof createGroupSiblingRefresher> | null>(null);

  function replaceCampaignRow(nextCampaign: CampaignRow) {
    applyCampaignRow(nextCampaign);
    siblingRefresherRef.current ??= createGroupSiblingRefresher({
      getRows: () => rowsRef.current,
      applyRow: applyCampaignRow,
      onFailed: () => toast.warning(LIST_REFRESH_FAILED_MESSAGE),
    });
    siblingRefresherRef.current(nextCampaign);
  }

  function openCampaign(row: CampaignRow) {
    setSelected(row);
    setPanelOpen(true);
  }

  async function openCampaignById(campaignId: string) {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`);
      if (!res.ok) return;
      const campaign = (await res.json()) as CampaignRow;
      openCampaign(campaign);
    } catch (e) {
      console.error("Failed to load campaign details", e);
    }
  }

  useCampaignDeepLink(openCampaignById);

  function prependCampaignRow(nextCampaign: CampaignRow) {
    setRows((previous) => [nextCampaign, ...previous]);
    openCampaign(nextCampaign);
  }

  function removeCampaignRow(campaignId: string, closePanel = false) {
    setRows((previous) => previous.filter((row) => row.id !== campaignId));
    setSelected((previous) => (previous?.id === campaignId ? null : previous));
    if (closePanel) {
      setPanelOpen(false);
    }
  }

  // 카드·표 메뉴의 「삭제」는 확인 창을 거친다 — 상세 패널 삭제와 같은 조작이 여기서만
  // 즉시 영구 삭제되고 실패도 무음이었다(2026-09-24 interfaces 점검 #8).
  // 실패하면 확인 창을 유지해 재시도하게 한다(오류는 토스트).
  const [pendingDelete, setPendingDelete] = useState<CampaignRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function deleteCampaign(row: CampaignRow) {
    setDeleting(true);
    try {
      const response = await fetch(`/api/campaigns/${row.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        toast.error("캠페인을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      removeCampaignRow(row.id, selected?.id === row.id);
      setPendingDelete(null);
    } catch {
      toast.error("네트워크 오류로 삭제하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setDeleting(false);
    }
  }

  async function duplicateCampaign(row: CampaignRow) {
    const response = await fetch(`/api/campaigns/${row.id}/duplicate`, {
      method: "POST",
    });
    if (!response.ok) return;
    const duplicated = (await response.json()) as CampaignRow;
    prependCampaignRow(duplicated);
  }

  /**
   * ⚠️ 실패 토스트는 이 함수가 아니라 **호출한 보드**가 소유한다(P2 Toast Ownership) —
   * 보드는 낙관적 이동을 롤백해야 하므로 어차피 catch 를 갖는다. 여기서는 사용자에게
   * 그대로 보여도 되는 한국어 문구를 `Error.message` 에 실어 던진다(409 면 그룹 충돌
   * 안내). 던지는 문구를 영문·기술 문자열로 되돌리면 보드가 그대로 노출한다.
   */
  async function handleStatusChange(campaignId: string, status: CampaignStatus) {
    const result = await patchCampaign<CampaignRow>(
      campaignId,
      { status },
      { fallbackError: STATUS_CHANGE_ERROR, networkError: STATUS_CHANGE_ERROR },
    );
    if (!result.ok) throw new Error(result.error);
    replaceCampaignRow(result.data);
  }

  // ---------------------------------------------------------------------------
  // Filtering: apply all pipeline filters using applyPipelineFilters
  // ---------------------------------------------------------------------------

  const filteredRows = useMemo(
    () =>
      applyPipelineFilters(rows, {
        stageFilter: effectiveStageFilter,
        teamId: teamFilter,
        searchQuery,
        savedView: "DEFAULT",
      }),
    [rows, effectiveStageFilter, teamFilter, searchQuery],
  );

  // ---------------------------------------------------------------------------
  // Zone counts: computed from filtered rows (respects team, search)
  // but NOT stageFilter (so counts show totals per zone regardless of stage selection)
  // ---------------------------------------------------------------------------

  const rowsWithoutStageFilter = useMemo(
    () =>
      applyPipelineFilters(rows, {
        stageFilter: "ALL",
        teamId: teamFilter,
        searchQuery,
        savedView: "DEFAULT",
      }),
    [rows, teamFilter, searchQuery],
  );

  const zoneCounts = useMemo(
    () => getZoneCounts(rowsWithoutStageFilter),
    [rowsWithoutStageFilter],
  );

  const stageFilterCounts = useMemo(
    (): Record<StageFilter, number> => ({
      ALL: rowsWithoutStageFilter.length,
      SALES: zoneCounts.SALES,
      PROGRESS: zoneCounts.DEAL_EXECUTION,
      SETTLEMENT: zoneCounts.SETTLEMENT,
    }),
    [rowsWithoutStageFilter, zoneCounts],
  );

  // ---------------------------------------------------------------------------
  // Active filter detection
  // ---------------------------------------------------------------------------

  const hasActiveFilters =
    (!lockedStageFilter && stageFilter !== "ALL") ||
    Boolean(searchQuery.trim()) ||
    teamFilter !== null;

  const activeFilterLabels = [
    !lockedStageFilter && stageFilter !== "ALL"
      ? `단계 ${stageFilter === "SALES" ? "영업" : stageFilter === "PROGRESS" ? "진행" : "정산"}`
      : null,
    searchQuery.trim() ? `검색 "${searchQuery.trim().length > 20 ? searchQuery.trim().slice(0, 20) + "..." : searchQuery.trim()}"` : null,
    teamFilter
      ? `팀 ${(initialData.teams ?? []).find((t) => t.id === teamFilter)?.name ?? teamFilter}`
      : null,
  ].filter(Boolean) as string[];

  const selectedInFilteredRows =
    selected == null ? false : filteredRows.some((row) => row.id === selected.id);
  const useExecutionKanban =
    viewMode === "kanban" && effectiveStageFilter === "PROGRESS";
  const executionRows = useMemo(
    () =>
      rowsWithoutStageFilter.filter(
        (row) =>
          getZoneForStatus(row.status) === "DEAL_EXECUTION" ||
          getZoneForStatus(row.status) === "SETTLEMENT" ||
          row.status === "DROPPED",
      ),
    [rowsWithoutStageFilter],
  );

  // 머리 부제 건수 — 실행 보드가 받는 같은 행·같은 빠른 필터 판정(`execution-quick-filters`)을 읽는다.
  const executionHeadline = useMemo(() => summarizeExecutionHeadline(executionRows), [executionRows]);

  const kanbanSummary = useMemo(() => {
    const rowsToSum = useExecutionKanban ? executionRows : filteredRows;
    const m = summarizePipelineMoney(rowsToSum);
    return {
      sumTotal: m.grossMerchandise,
      sumRevenue: m.commissionRevenue,
      sumFee: m.sellerPayout,
      sumProfit: m.grossProfit,
    };
  }, [executionRows, filteredRows, useExecutionKanban]);

  // ---------------------------------------------------------------------------
  // Reset filters
  // ---------------------------------------------------------------------------

  function resetPipelineFilters() {
    setStageFilter(lockedStageFilter ?? "ALL");
    setTeamFilter(null);
    setSearchQuery("");
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // 검색·조합 캠페인 — 단계 칩 줄 오른쪽, 실행 보드에선 보드 빠른 필터 줄 오른쪽에 붙는다(한 벌만 그린다).
  const pipelineControls = (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {/* 실행 보드에선 적용 중 필터 줄을 보드 위에 따로 띄우지 않는다 — 검색을 치는 순간 그 줄이 생기며 보드와
          검색칸이 아래로 밀렸다(실측 87px). 빈 결과 안내와 초기화는 검색칸 왼쪽에 붙여 검색칸 자리를 고정한다. */}
      {useExecutionKanban && hasActiveFilters ? (
        <>
          {filteredRows.length === 0 ? (
            <span className="text-xs text-muted-foreground">조건에 맞는 캠페인 없음</span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-9 rounded-lg px-2 text-xs text-muted-foreground"
            onClick={resetPipelineFilters}
          >
            필터 초기화
          </Button>
        </>
      ) : null}
      <InputGroup className="h-9 w-full rounded-lg border border-slate-200 bg-white shadow-soft-sm md:w-64">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="캠페인, 셀러, 링크 검색"
          aria-label="캠페인 검색"
          className="h-full border-0 text-xs focus-visible:ring-0"
        />
      </InputGroup>
      {allowCreate ? (
        <Button
          variant="outline"
          size="sm"
          className="h-9 rounded-lg border-primary/30 bg-white px-3.5 text-xs text-primary hover:bg-primary/5"
          onClick={() => setComboOpen(true)}
          title="한 셀러에게 여러 판매 조건을 같은 기간으로 한 번에 올립니다."
        >
          <Boxes className="mr-1 size-3.5" />
          조합 캠페인
        </Button>
      ) : null}
    </div>
  );
  const showFilterRow = !lockedStageFilter || !useExecutionKanban;
  const showOutOfFilterNotice = Boolean(panelOpen && selected && !selectedInFilteredRows);
  const showActiveFilterRow = hasActiveFilters && !useExecutionKanban;
  const showCardHead = showFilterRow || showActiveFilterRow || showOutOfFilterNotice;

  return (
    <>
      {/* 모바일 표면은 자체 머리를 쓴다(P5 UA 분기 유지) — 제목은 데스크톱에서만 CrmShell 머리에 올린다 */}
      <CrmShell
        variant="focus"
        title={isMobile ? undefined : "판매 관리"}
        description={isMobile ? undefined : `판매중 ${executionHeadline.selling}건 · 지연 ${executionHeadline.delayed}건`}
        segments={
          isMobile
            ? undefined
            : {
                options: VIEW_MODE_OPTIONS,
                value: viewMode,
                onValueChange: (value) => setViewMode(value === "table" ? "table" : "kanban"),
                ariaLabel: "보기 전환",
              }
        }
        actions={
          !isMobile && allowCreate ? (
            <Button
              variant="default"
              size="sm"
              className="h-9 rounded-lg bg-primary px-3.5 text-xs text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/95"
              onClick={() => openCreationSheet(preferredCreateDefaultStatus)}
            >
              <PlusIcon className="mr-1 size-3.5" />
              캠페인 등록
            </Button>
          ) : undefined
        }
      >
        {isMobile ? (
          <MobilePipelineView
            campaigns={filteredRows}
            stageFilter={effectiveStageFilter}
            setStageFilter={setStageFilter}
            counts={stageFilterCounts}
            isStageLocked={Boolean(lockedStageFilter)}
            overdueReminders={initialData.actionRequiredCounts?.overdueReminders ?? 0}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            onOpenCampaign={(campaign) => {
              // 모바일=조회 전용 상세 시트(§5) — SidePanel(panelOpen)은 열지 않는다.
              setMobileDetailCampaign(campaign);
              setMobileDetailOpen(true);
            }}
          />
        ) : (
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
            <MoneySummaryStrip
              className="mb-4 shrink-0"
              groups={[
                moneyFlowGroup({
                  grossMerchandise: kanbanSummary.sumTotal,
                  commissionRevenue: kanbanSummary.sumRevenue,
                  sellerPayout: kanbanSummary.sumFee,
                  grossProfit: kanbanSummary.sumProfit,
                }),
              ]}
            />

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
            {initialData.dataSource === "mock" && initialData.dataSourceMessage ? (
               <div className="px-5 pt-5">
                 <DataSourceBanner message={initialData.dataSourceMessage} />
               </div>
            ) : null}
            {showCardHead ? (
            <div data-slot="pipeline-card-head" className="flex flex-col gap-4 border-b border-border/70 px-5 py-4">
              {/* 단계 칩(왼쪽)과 검색·조합 캠페인(오른쪽)을 한 줄에 둔다. 제목·보기 전환·캠페인 등록은
                  CrmShell 머리로 올렸다 — 종전의 조작 전용 줄은 빈 줄로 남아 지웠다. 실행 보드(진행·칸반)
                  에선 검색·조합 캠페인이 보드의 빠른 필터 줄 오른쪽으로 가므로 이 줄을 그리지 않는다. */}
              {showFilterRow ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {!lockedStageFilter ? (
                    <StageFilterBar
                      currentFilter={effectiveStageFilter}
                      onFilterChange={setStageFilter}
                      counts={stageFilterCounts}
                    />
                  ) : null}
                  {useExecutionKanban ? null : pipelineControls}
                </div>
              ) : null}

              {showActiveFilterRow ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border/80 bg-white/70 px-3.5 py-3 md:flex-row md:items-center md:justify-between">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {activeFilterLabels.map((label) => (
                      <span
                        key={label}
                        className="rounded-lg border border-border bg-white px-2.5 py-1 text-xs text-foreground"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-lg px-2 text-xs text-muted-foreground"
                    onClick={resetPipelineFilters}
                  >
                    전체 필터 초기화
                  </Button>
                </div>
              ) : null}

              {showOutOfFilterNotice ? (
                <div className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50/80 px-3.5 py-3 text-sm text-amber-950 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="font-medium">현재 선택한 캠페인이 필터 결과 밖에 있습니다.</div>
                    <div className="text-xs text-amber-900/80">
                      상세 패널은 유지되고 있으며, 목록에서 다시 보려면 필터를 초기화하면 됩니다.
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-amber-300 bg-white text-amber-950 hover:bg-amber-100"
                      onClick={resetPipelineFilters}
                    >
                      필터 초기화
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-amber-950 hover:bg-amber-100"
                      onClick={() => setPanelOpen(false)}
                    >
                      패널 닫기
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            ) : null}

            {/* Main content area: Kanban or Table view */}
            {/* 실행 보드는 검색칸을 보드 안에 들고 있어 빈 결과에도 보드를 그대로 둔다 — 빈 안내로 바꾸면 입력 중인
                검색칸이 사라졌다 다른 자리에 나타나 화면이 튄다. 초기화는 위 「전체 필터 초기화」 줄이 맡는다. */}
            {filteredRows.length === 0 && hasActiveFilters && !useExecutionKanban ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[#f8fafc] px-6 py-16 text-center">
                <p className="text-sm text-muted-foreground">
                  필터 조건에 맞는 캠페인 없음
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg"
                  onClick={resetPipelineFilters}
                >
                  전체 필터 초기화
                </Button>
              </div>
            ) : viewMode === "kanban" ? (
              <div className="min-h-0 flex-1 overflow-auto bg-[#f8fafc] p-4">
                {useExecutionKanban ? (
                  <ExecutionKanbanBoard
                    campaigns={executionRows}
                    onRowOpen={openCampaign}
                    onRowDelete={setPendingDelete}
                    onRowDuplicate={duplicateCampaign}
                    onStatusChange={handleStatusChange}
                    onAddCampaign={allowCreate ? openCreationSheet : undefined}
                    toolbarEnd={pipelineControls}
                  />
                ) : (
                  <StageKanbanBoard
                    campaigns={filteredRows}
                    stageFilter={effectiveStageFilter}
                    onRowOpen={openCampaign}
                    onRowDelete={setPendingDelete}
                    onRowDuplicate={duplicateCampaign}
                    onStatusChange={handleStatusChange}
                    onAddCampaign={allowCreate ? openCreationSheet : undefined}
                  />
                )}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto bg-[#f8fafc]">
                <GroupedTableView
                  campaigns={filteredRows}
                  stageFilter={effectiveStageFilter}
                  onRowOpen={openCampaign}
                  onRowDelete={setPendingDelete}
                  onRowDuplicate={duplicateCampaign}
                  onStatusChange={(campaignId, status) => {
                    // ℹ️ 이 prop 은 `GroupedTableView` 의 인터페이스에만 있고 아직
                    // 호출되지 않는다(2026-08-07 실측) — 즉 지금은 도달하지 않는다.
                    // 그래도 catch 를 붙여 두는 이유: 이 표는 칸반과 달리 낙관적 이동이
                    // 없어 롤백용 catch 가 생길 일이 없으므로, 나중에 배선될 때
                    // 실패가 미처리 rejection 으로 조용히 사라지기 딱 좋은 자리다.
                    // 실패 토스트의 소유자는 여기다(칸반 3종은 자기 catch 가 소유).
                    handleStatusChange(campaignId, status).catch((err: unknown) => {
                      toast.error(
                        err instanceof Error && err.message ? err.message : STATUS_CHANGE_ERROR,
                      );
                    });
                  }}
                />
              </div>
            )}
            </div>
          </section>
        )}
      </CrmShell>

      <CampaignCreationSheet
        data={initialData}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(campaign) => {
          prependCampaignRow(campaign);
          // 표면 ⓑ — 단건 생성 직후 겹치는 그룹이 있으면 지속 토스트로 합류 제안.
          void maybeSuggestGroupJoin(campaign, {
            onJoined: async (campaignIds) => {
              // ⛔ 실패를 삼키지 말 것 — 합류는 이미 끝났으므로 이건 「실패」가 아니라
              // 「보드가 낡았다」다. 조용히 두면 방금 묶인 캠페인이 안 묶인 것처럼 보이고,
              // 기존 멤버의 배지 숫자도 하나 모자란 채로 남는다.
              const failed = await refreshCampaignRows(campaignIds, replaceCampaignRow);
              if (failed > 0) toast.warning(LIST_REFRESH_FAILED_MESSAGE);
            },
          });
        }}
        defaultStatus={createSheetDefaultStatus}
        lockStatus={lockedStageFilter === "PROGRESS"}
      />

      {allowCreate ? (
        <BulkComboCampaignDialog
          data={initialData}
          open={comboOpen}
          onOpenChange={setComboOpen}
          defaultStatus={preferredCreateDefaultStatus}
          onCreated={(created) => {
            if (created.length === 0) return;
            setRows((previous) => [...created, ...previous]);
            openCampaign(created[0]);
          }}
        />
      ) : null}

      <DeleteConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
        entityType="캠페인"
        entityName={pendingDelete ? [pendingDelete.dealName, pendingDelete.sellerName].filter(Boolean).join(" - ") || pendingDelete.campaignName || "이름 없는 캠페인" : ""}
        onConfirm={async () => {
          if (pendingDelete) await deleteCampaign(pendingDelete);
        }}
        loading={deleting}
      />

      <CampaignSidePanel
        campaign={selected}
        logs={initialData.apiCallLogs}
        assets={initialData.assets}
        storage={initialData.storage}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        onCampaignUpdated={(campaign) => {
          replaceCampaignRow(campaign);
        }}
        onNavigateToCampaign={openCampaignById}
        workspaceFilter={lockedStageFilter}
        onCampaignDeleted={(campaignId) => {
          removeCampaignRow(campaignId, true);
        }}
      />

      {/* 모바일 전용 조회 상세 시트 — 데스크탑에서는 렌더되지 않는다(P5). */}
      {isMobile ? (
        <MobileCampaignDetailSheet
          open={mobileDetailOpen}
          onOpenChange={setMobileDetailOpen}
          // 조합 캠페인 멤버면 그룹 상세(`group:${groupId}`)로 승격해 연다 — 그룹
          // 멤버 판정은 필터와 무관하게 전체 rows 기준(멤버 1건이면 개별 상세 폴백).
          campaign={mobileDetailCampaign ? campaignRowsToGroupDetailData(rows, mobileDetailCampaign) : null}
          campaignRow={mobileDetailCampaign}
        />
      ) : null}
    </>
  );
}
