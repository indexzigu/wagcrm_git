"use client";

import { useEffect, useMemo, useState, cloneElement } from "react";
import {
  KanbanIcon,
  LayoutListIcon,
  PlusIcon,
  SearchIcon,
  TrendingUp,
  Wallet,
  Download,
  PiggyBank,
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
import { getZoneForStatus, type ZoneViewMode } from "@/lib/zone-config";
import { getZoneCounts } from "@/lib/zone-config";
import { loadZoneViewMode } from "@/lib/zone-settings";
import { applyPipelineFilters } from "@/lib/pipeline-filters";
import { patchCampaign } from "@/lib/campaign-patch";
import { toast } from "sonner";
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
import { CrmShell } from "./crm-shell";
import { DataSourceBanner } from "./data-source-banner";
import { ExecutionKanbanBoard } from "./execution-kanban-board";
import { StageFilterBar } from "./stage-filter-bar";
import { StageKanbanBoard } from "./stage-kanban-board";
import { GroupedTableView } from "./grouped-table-view";

interface ViewSwitcherProps {
  viewMode: "kanban" | "table" | "report";
  onViewModeChange: (mode: "kanban" | "table" | "report") => void;
  enableReportView?: boolean;
}

function ViewSwitcher({ viewMode, onViewModeChange, enableReportView }: ViewSwitcherProps) {
  return (
    <div
      className="flex items-center rounded-2xl border border-border/70 bg-white/80 p-0.5 shadow-soft-sm"
      role="group"
      aria-label="뷰 전환"
    >
      <button
        type="button"
        onClick={() => onViewModeChange("kanban")}
        aria-pressed={viewMode === "kanban"}
        className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-[color,background-color,box-shadow] ${
          viewMode === "kanban"
            ? "bg-white shadow-soft-sm text-foreground"
            : "text-muted-foreground hover:bg-slate-50 hover:text-foreground"
        }`}
        title="칸반 뷰"
      >
        <KanbanIcon className="size-3.5" />
        <span>칸반</span>
      </button>
      <button
        type="button"
        onClick={() => onViewModeChange("table")}
        aria-pressed={viewMode === "table"}
        className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-[color,background-color,box-shadow] ${
          viewMode === "table"
            ? "bg-white shadow-soft-sm text-foreground"
            : "text-muted-foreground hover:bg-slate-50 hover:text-foreground"
        }`}
        title="테이블 뷰"
      >
        <LayoutListIcon className="size-3.5" />
        <span>테이블</span>
      </button>
      {enableReportView && (
        <button
          type="button"
          onClick={() => onViewModeChange("report")}
          aria-pressed={viewMode === "report"}
          className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-[color,background-color,box-shadow] ${
            viewMode === "report"
              ? "bg-white shadow-soft-sm text-foreground"
              : "text-muted-foreground hover:bg-slate-50 hover:text-foreground"
          }`}
          title="리포트 뷰"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-line-chart"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
          <span>리포트</span>
        </button>
      )}
    </div>
  );
}

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
  enableReportView?: boolean;
  reportViewComponent?: React.ReactNode;
  /** 모바일 전용(v3.2) — "진행 캠페인"(active) vs "업무 처리"(tasks) 뷰. 데스크탑 무영향. */
  mobilePipelineMode?: "active" | "tasks";
};

export function CrmDashboard({
  initialData,
  lockedStageFilter,
  allowCreate = true,
  createDefaultStatus: preferredCreateDefaultStatus,
  enableReportView,
  reportViewComponent,
  mobilePipelineMode = "active",
}: CrmDashboardProps) {
  const isMobile = useIsMobile();
  const [rows, setRows] = useState(initialData.campaigns);
  const [selected, setSelected] = useState<CampaignRow | null>(rows[0] ?? null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [comboOpen, setComboOpen] = useState(false);
  const [createSheetDefaultStatus, setCreateSheetDefaultStatus] = useState<CampaignStatus | undefined>(undefined);
  const [zoneViewMode] = useState<ZoneViewMode>(() => loadZoneViewMode());
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

  function replaceCampaignRow(nextCampaign: CampaignRow) {
    setRows((previous) =>
      previous.map((row) => (row.id === nextCampaign.id ? nextCampaign : row)),
    );
    setSelected((previous) =>
      previous?.id === nextCampaign.id ? nextCampaign : previous,
    );
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

  async function deleteCampaign(row: CampaignRow) {
    const response = await fetch(`/api/campaigns/${row.id}`, {
      method: "DELETE",
    });
    if (!response.ok) return;
    removeCampaignRow(row.id, selected?.id === row.id);
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

  const kanbanSummary = useMemo(() => {
    let sumTotal = 0;
    let sumRevenue = 0;
    let sumFee = 0;
    let sumProfit = 0;
    
    const rowsToSum = useExecutionKanban ? executionRows : filteredRows;
    rowsToSum.forEach(camp => {
      if (camp.status === "DROPPED" || camp.status === "SETTLEMENT_IN_PROGRESS" || camp.status === "COMPLETED") return;
      const actual = camp.actualSales || 0;
      const revenue = Math.floor(actual * (camp.totalMarginRate || 0) / 100);
      const fee = Math.floor(actual * (camp.sellerMarginRate || 0) / 100);
      const profit = revenue - fee;
      
      sumTotal += actual;
      sumRevenue += revenue;
      sumFee += fee;
      sumProfit += profit;
    });
    
    return { sumTotal, sumRevenue, sumFee, sumProfit };
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

  return (
    <>
      <CrmShell variant="focus">
        {isMobile ? (
          <MobilePipelineView
            campaigns={filteredRows}
            stageFilter={effectiveStageFilter}
            setStageFilter={setStageFilter}
            counts={stageFilterCounts}
            isStageLocked={Boolean(lockedStageFilter)}
            mode={mobilePipelineMode}
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
            {/* Summary Bar */}
            <div className="mb-4 flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200/60 bg-white/80 px-4 py-2.5 text-xs text-slate-600 shadow-soft-sm backdrop-blur-sm">
              <div className="flex shrink-0 items-center gap-1.5">
                <TrendingUp className="size-3.5 text-muted-foreground" />
                <span className="font-medium">총거래액:</span>
                <span className="font-semibold text-slate-800">{kanbanSummary.sumTotal.toLocaleString()}원</span>
              </div>
              <span className="hidden text-slate-200 md:inline">|</span>
              <div className="flex shrink-0 items-center gap-1.5">
                <Wallet className="size-3.5 text-muted-foreground" />
                <span className="font-medium">영업수익:</span>
                <span className="font-semibold text-slate-800">{kanbanSummary.sumRevenue.toLocaleString()}원</span>
              </div>
              <span className="hidden text-slate-200 md:inline">|</span>
              <div className="flex shrink-0 items-center gap-1.5">
                <Download className="size-3.5 text-muted-foreground" />
                <span className="font-medium">판매대행비:</span>
                <span className="font-semibold text-slate-800">{kanbanSummary.sumFee.toLocaleString()}원</span>
              </div>
              <span className="hidden text-slate-200 md:inline">|</span>
              <div className="flex shrink-0 items-center gap-1.5">
                <PiggyBank className="size-3.5 text-muted-foreground" />
                <span className="font-medium">영업이익:</span>
                <span className="font-semibold text-slate-800">{kanbanSummary.sumProfit.toLocaleString()}원</span>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
            {initialData.dataSource === "mock" && initialData.dataSourceMessage ? (
               <div className="px-5 pt-5">
                 <DataSourceBanner message={initialData.dataSourceMessage} />
               </div>
            ) : null}
            <div className="flex flex-col gap-4 border-b border-border/70 px-5 py-4">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-[15px] font-bold text-slate-900">판매 관리</h2>
                    <p className="mt-0.5 text-xs font-medium text-slate-500">
                      캠페인의 실제 판매 진행 상황과 지표를 관리합니다.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex w-full items-center gap-2 md:w-auto">
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
                    </div>
                    <ViewSwitcher
                      viewMode={viewMode}
                      onViewModeChange={setViewMode}
                    />
                    {allowCreate ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9 rounded-lg border-primary/30 bg-white px-3.5 text-xs text-primary hover:bg-primary/5"
                          onClick={() => setComboOpen(true)}
                          title="한 셀러에게 여러 딜을 같은 기간으로 한 번에 올립니다."
                        >
                          <Boxes className="mr-1 size-3.5" />
                          조합 캠페인
                        </Button>
                        <Button
                          variant="default"
                          size="sm"
                          className="h-9 rounded-lg bg-primary px-3.5 text-xs text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/95"
                          onClick={() => openCreationSheet(preferredCreateDefaultStatus)}
                        >
                          <PlusIcon className="mr-1 size-3.5" />
                          캠페인 등록
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Stage Filter Bar */}
              {!lockedStageFilter ? (
                <StageFilterBar
                  currentFilter={effectiveStageFilter}
                  onFilterChange={setStageFilter}
                  counts={stageFilterCounts}
                />
              ) : null}

              {hasActiveFilters ? (
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

              {panelOpen && selected && !selectedInFilteredRows ? (
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

            {/* Main content area: Kanban or Table view */}
            {filteredRows.length === 0 && hasActiveFilters ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[#f8fafc] px-6 py-16 text-center">
                <p className="text-sm text-muted-foreground">
                  필터 조건에 맞는 캠페인이 없습니다.
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
            ) : viewMode === "report" && enableReportView && reportViewComponent ? (
              <div className="flex-1 overflow-auto bg-[#f8fafc]">
                {cloneElement(reportViewComponent as React.ReactElement<{
                  teamFilter: string | null;
                  searchQuery: string;
                  onRowOpenById: (id: string) => Promise<void>;
                }>, {
                  teamFilter,
                  searchQuery,
                  onRowOpenById: openCampaignById
                })}
              </div>
            ) : viewMode === "kanban" ? (
              <div className="min-h-0 flex-1 overflow-auto bg-[#f8fafc] p-4">
                {useExecutionKanban ? (
                  <ExecutionKanbanBoard
                    campaigns={executionRows}
                    onRowOpen={openCampaign}
                    onRowDelete={deleteCampaign}
                    onRowDuplicate={duplicateCampaign}
                    onStatusChange={handleStatusChange}
                    onAddCampaign={allowCreate ? openCreationSheet : undefined}
                  />
                ) : (
                  <StageKanbanBoard
                    campaigns={filteredRows}
                    stageFilter={effectiveStageFilter}
                    onRowOpen={openCampaign}
                    onRowDelete={deleteCampaign}
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
                  onRowDelete={deleteCampaign}
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
                        { duration: 5000 },
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
            onJoined: async (campaignId) => {
              try {
                const res = await fetch(`/api/campaigns/${campaignId}`, { cache: "no-store" });
                if (res.ok) replaceCampaignRow((await res.json()) as CampaignRow);
              } catch {
                // 비차단 — 배지 동기화 실패해도 합류는 성공.
              }
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

      <CampaignSidePanel
        campaign={selected}
        logs={initialData.apiCallLogs}
        assets={initialData.assets}
        storage={initialData.storage}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        onActualSalesSaved={(campaign) => {
          replaceCampaignRow(campaign);
        }}
        onCampaignUpdated={(campaign) => {
          replaceCampaignRow(campaign);
        }}
        onNavigateToCampaign={openCampaignById}
        workspaceFilter={lockedStageFilter}
        viewMode={zoneViewMode}
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
