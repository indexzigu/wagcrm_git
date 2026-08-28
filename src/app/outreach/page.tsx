"use client";

import { useEffect, useRef, useState, useMemo, useCallback, createContext, useContext } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Archive,
  ExternalLink,
  FileText,
  ChevronDown,
  ChevronUp,
  Plus,
  Search,
  Megaphone,
  ListTodo,
  CircleCheckBig,
  XCircle,
  Kanban,
  LayoutList,
  BellRing,
  Check,
  Upload,
  Link2,
  Target,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CrmShell } from "@/components/crm/crm-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EntityIdentity } from "@/components/crm/entity-identity";
import { SellerIdentityInfo } from "@/components/crm/seller-identity-info";
import { getDealIdentityParts } from "@/lib/deal-display";
import { OutreachList, OutreachCardContent, type OutreachRow } from "@/components/crm/outreach-list";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { KanbanDragOverlay } from "@/components/crm/kanban-drag-overlay";
import { InlineDataGrid, type GridColumn } from "@/components/crm/inline-data-grid";
import { MobileOutreachView } from "@/components/mobile/mobile-outreach-view";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { OutreachCreateForm } from "@/components/crm/outreach-create-form";
import { RecampaignAlertsCard } from "@/components/crm/recampaign-alerts-card";
import { LinkSearchDialog } from "@/components/crm/link-search-dialog";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { formatDate } from "@/lib/format";
import { formatBytes } from "@/lib/format";
import type { OutreachStatus } from "@/lib/validations/outreach";
import type { AssetSection } from "@/lib/crm-types";
import { assetSectionLabels } from "@/lib/crm-types";
import { queryKeys } from "@/lib/query-keys";

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * 드래그로 카드를 놓을 수 있는(=드롭 대상) 상태 컬럼. 오너 확정 매트릭스:
 * - 4개 작업 컬럼: 자유 이동 → handleStatusChange
 * - DROPPED: 드롭 허용하되 사유 입력 모달(handleDropTask)로 라우팅(조용한 PATCH 금지)
 * - CONVERTED: 제외 — 전환은 캠페인 생성(handleCreateCampaign)을 수반하므로 드래그 금지
 */
const DRAG_DROPPABLE_STATUSES: ReadonlySet<OutreachStatus> = new Set<OutreachStatus>([
  "PROPOSED",
  "NEGOTIATION",
  "TESTING",
  "PENDING_APPROVAL",
  "DROPPED",
]);

export default function OutreachPage() {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<OutreachRow | null>(null);

  // Drop Dialog state
  const [dropDialogOpen, setDropDialogOpen] = useState(false);
  const [dropTargetTaskId, setDropTargetTaskId] = useState<string | null>(null);
  const [dropReasonDraft, setDropReasonDraft] = useState("");
  const [dropSubmitting, setDropSubmitting] = useState(false);

  // Memo saving state
  const [savingMemoField, setSavingMemoField] = useState<string | null>(null);

  // View state
  const [viewMode, setViewMode] = useState<"board" | "table">("board");
  const [searchQuery, setSearchQuery] = useState("");
  type OutreachStageFilter = "ALL" | "IN_PROGRESS" | "CLOSED";
  const [stageFilter, setStageFilter] = useState<OutreachStageFilter>("IN_PROGRESS");

  // Collapsed Stages state
  const [collapsedStages, setCollapsedStages] = useState<Record<string, boolean>>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("crm_outreach_collapsed_stages");
      if (saved) {
        try {
          return JSON.parse(saved) as Record<string, boolean>;
        } catch {
          // ignore
        }
      }
    }
    return {};
  });

  const toggleStage = useCallback((stageKey: string) => {
    setCollapsedStages((prev) => {
      const next = { ...prev, [stageKey]: !prev[stageKey] };
      if (typeof window !== "undefined") {
        localStorage.setItem("crm_outreach_collapsed_stages", JSON.stringify(next));
      }
      return next;
    });
  }, []);

  const tasksQuery = useQuery({
    queryKey: queryKeys.outreach(),
    queryFn: async (): Promise<OutreachRow[]> => {
      const response = await fetch("/api/outreach");
      if (!response.ok) {
        throw new Error("영업 테스크를 불러오지 못했습니다.");
      }
      const data = await response.json();
      return data.outreaches ?? [];
    },
    staleTime: 60 * 1000, // CRM_DYNAMIC_SURFACES(outreach)는 서버 캐시가 없으므로 클라에서만 짧게 SWR 처리
  });

  useEffect(() => {
    if (tasksQuery.isError) {
      toast.error("영업 테스크를 불러오지 못했습니다.");
    }
  }, [tasksQuery.isError]);

  // `?? []` 를 그냥 두면 로딩·에러 구간마다 **새 빈 배열**이 나와 이 값을 의존성으로 삼는
  // useMemo 3개·useCallback 2개가 매 렌더 전부 무효화된다(칸반 그룹핑·필터·그리드 컬럼).
  // 데이터가 있을 때는 react-query 가 같은 참조를 주므로 메모이제이션이 값 의미를 바꾸지 않는다.
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const loading = tasksQuery.isLoading;

  // 기존 fetchTasks()와 동일한 async 시그니처를 보존한다 — 소비 지점(테스크 등록 성공,
  // 인라인 그리드 저장 등)에서 그대로 await 호출한다.
  const fetchTasks = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.outreach() });
  }, [queryClient]);

  const applyTaskUpdate = useCallback((taskId: string, updated: Partial<OutreachRow>) => {
    queryClient.setQueryData<OutreachRow[]>(queryKeys.outreach(), (current) =>
      (current ?? []).map((item) =>
        item.id === taskId
          ? {
              ...item,
              ...updated,
            }
          : item
      )
    );
    setSelectedTask((current) =>
      current && current.id === taskId
        ? {
            ...current,
            ...updated,
          }
        : current
    );
  }, [queryClient]);

  const handleStatusChange = useCallback(async (id: string, newStatus: OutreachStatus) => {
    const response = await fetch(`/api/outreach/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: newStatus,
      }),
    });
    if (!response.ok) {
      toast.error("상태 변경에 실패했습니다.");
      return;
    }
    const updated = await response.json();
    applyTaskUpdate(id, updated);
  }, [applyTaskUpdate]);

  const handleCreateCampaign = useCallback(async (taskId: string) => {
    const response = await fetch(`/api/outreach/${taskId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "CONFIRMED",
        autoCreateCampaign: true,
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      toast.error(data?.error ?? "캠페인 생성에 실패했습니다.");
      return;
    }
    const updated = await response.json();
    applyTaskUpdate(taskId, updated);
    toast.success("진행 준비 캠페인을 생성했습니다.");
  }, [applyTaskUpdate]);

  const handleReminderSent = useCallback(async (taskId: string) => {
    const now = new Date();
    const response = await fetch(`/api/outreach/${taskId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "PROPOSED",
        lastReminderAt: now.toISOString(),
        nextReminderAt: addDays(now, 3).toISOString(),
      }),
    });
    if (!response.ok) {
      toast.error("리마인드 처리에 실패했습니다.");
      return;
    }
    const updated = await response.json();
    applyTaskUpdate(taskId, updated);
    toast.success("리마인드 발송 일정을 갱신했습니다.");
  }, [applyTaskUpdate]);

  const handleDropTask = useCallback(async (taskId: string, reason: string) => {
    setDropTargetTaskId(taskId);
    setDropReasonDraft(reason);
    setDropDialogOpen(true);
  }, []);

  const handleConfirmDropTask = useCallback(async () => {
    if (!dropTargetTaskId) return;
    setDropSubmitting(true);
    const response = await fetch(`/api/outreach/${dropTargetTaskId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "DROPPED",
        dropReason: dropReasonDraft.trim() || "수동 종료",
      }),
    });
    if (!response.ok) {
      toast.error("드랍 처리에 실패했습니다.");
      setDropSubmitting(false);
      return;
    }
    const updated = await response.json();
    applyTaskUpdate(dropTargetTaskId, updated);
    setDropDialogOpen(false);
    setDropTargetTaskId(null);
    setDropReasonDraft("");
    setDropSubmitting(false);
    toast.success("영업 테스크를 종료했습니다.");
  }, [dropTargetTaskId, dropReasonDraft, applyTaskUpdate]);

  // --- 칸반 드래그 앤 드롭 (판매 관리 ExecutionKanbanBoard와 동일 배선) ---
  const [activeId, setActiveId] = useState<string | null>(null);
  // DragOverlay 카드의 경과일 계산용 기준시각 — 렌더 중 Date.now() 직접 호출(비순수)을 피해 고정.
  const [boardNow] = useState(() => Date.now());

  // 포인터 8px 이동해야 드래그 시작 → 카드 클릭(시트 열기)과 드래그를 구분. 키보드 센서(a11y).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const activeTask = useMemo(
    () => (activeId ? tasks.find((t) => t.id === activeId) ?? null : null),
    [activeId, tasks],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over) return;

      const targetStatus = String(over.id) as OutreachStatus;
      // 유효한 드롭 대상 컬럼이 아니면 무시(그 외 id 방어).
      if (!DRAG_DROPPABLE_STATUSES.has(targetStatus)) return;

      const taskId = String(active.id);
      const task = tasks.find((t) => t.id === taskId);
      if (!task || task.status === targetStatus) return;

      // DROPPED는 "왜 드랍됐는지" 추적을 위해 사유 입력이 계약 — 조용한 PATCH 대신 모달을 연다.
      if (targetStatus === "DROPPED") {
        void handleDropTask(taskId, "");
        return;
      }

      // 그 외 작업 컬럼: 기존 canonical 경로(서버 확정 후 캐시 갱신 + 실패 시 에러 토스트).
      await handleStatusChange(taskId, targetStatus);
    },
    [tasks, handleDropTask, handleStatusChange],
  );

  const handleTaskFieldSave = useCallback(async (taskId: string, field: string, value: string) => {
    const currentTask = tasks.find((item) => item.id === taskId);
    if (!currentTask) return;
    setSavingMemoField(`${taskId}:${field}`);
    const response = await fetch(`/api/outreach/${taskId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        [field]: value.trim() || null,
      }),
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      toast.error(errData.error ?? "테스크 정보 저장에 실패했습니다.");
      setSavingMemoField(null);
      return;
    }
    const updated = await response.json();
    applyTaskUpdate(taskId, updated);
    setSavingMemoField(null);
    
    if (field === "sellerId") {
      toast.success("셀러가 변경되었습니다.");
    } else if (field === "dealId") {
      toast.success("딜이 변경되었습니다.");
    } else {
      toast.success("테스크 정보를 저장했습니다.");
    }
  }, [tasks, applyTaskUpdate]);

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      // 1. Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = task.sellerName.toLowerCase().includes(q);
        const matchDeal = task.dealName.toLowerCase().includes(q);
        const matchPartner = task.partnerName?.toLowerCase().includes(q);
        if (!matchName && !matchDeal && !matchPartner) return false;
      }
      
      // 2. Stage Filter
      if (stageFilter === "IN_PROGRESS") {
        if (!["PROPOSED", "NEGOTIATION", "TESTING", "PENDING_APPROVAL"].includes(task.status)) return false;
      } else if (stageFilter === "CLOSED") {
        if (!["CONVERTED", "DROPPED"].includes(task.status)) return false;
      }
      
      return true;
    });
  }, [tasks, searchQuery, stageFilter]);

  const proposedTasks = useMemo(() => {
    return filteredTasks.filter((item) => item.status === "PROPOSED");
  }, [filteredTasks]);

  const negotiationTasks = useMemo(() => {
    return filteredTasks.filter((item) => item.status === "NEGOTIATION");
  }, [filteredTasks]);

  const testingTasks = useMemo(() => {
    return filteredTasks.filter((item) => item.status === "TESTING");
  }, [filteredTasks]);

  const pendingApprovalTasks = useMemo(() => {
    return filteredTasks.filter((item) => item.status === "PENDING_APPROVAL");
  }, [filteredTasks]);

  const convertedTasks = useMemo(() => {
    return filteredTasks.filter((item) => item.status === "CONVERTED");
  }, [filteredTasks]);

  const droppedTasks = useMemo(() => {
    return filteredTasks.filter((item) => item.status === "DROPPED");
  }, [filteredTasks]);

  // Outreach Metrics — 전체 + 최근30일, 딜/셀러 전환율 높은/낮은
  const metrics = useMemo(() => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

    // 딜별 집계 (전체 + 30일)
    const dealAll: Record<string, { total: number; converted: number; name: string }> = {};
    // 셀러별 집계 (전체 + 30일)
    const sellerAll: Record<string, { total: number; converted: number; name: string }> = {};

    // 전체 카운트
    let allCompleted = 0, allConverted = 0;
    let allDaysSum = 0, allDaysCount = 0;
    // 최근30일 카운트
    let r30Completed = 0, r30Converted = 0;
    let r30DaysSum = 0, r30DaysCount = 0;

    for (const t of tasks) {
      const isTerminal = t.status === "CONVERTED" || t.status === "DROPPED";
      const isConverted = t.status === "CONVERTED";
      const proposedDate = t.proposedAt ? new Date(t.proposedAt) : null;
      const isRecent = proposedDate && proposedDate >= thirtyDaysAgo;

      // 딜별
      const dealKey = t.dealId ?? t.dealName ?? "미연결";
      const dealLabel = t.dealName ?? "미연결";
      if (!dealAll[dealKey]) dealAll[dealKey] = { total: 0, converted: 0, name: dealLabel };
      dealAll[dealKey].total++;
      if (isConverted) dealAll[dealKey].converted++;

      // 셀러별
      const sellerKey = t.sellerId ?? t.sellerName ?? "미연결";
      const sellerLabel = t.sellerName || "미연결";
      if (!sellerAll[sellerKey]) sellerAll[sellerKey] = { total: 0, converted: 0, name: sellerLabel };
      sellerAll[sellerKey].total++;
      if (isConverted) sellerAll[sellerKey].converted++;

      // 전체 전환율
      if (isTerminal) { allCompleted++; if (isConverted) allConverted++; }
      // 최근30일 전환율
      if (isTerminal && isRecent) { r30Completed++; if (isConverted) r30Converted++; }

      // 전환 소요일
      if (isConverted && t.proposedAt && t.acceptedAt) {
        const days = (new Date(t.acceptedAt).getTime() - new Date(t.proposedAt).getTime()) / (1000 * 3600 * 24);
        if (days >= 0) {
          allDaysSum += days; allDaysCount++;
          if (isRecent) { r30DaysSum += days; r30DaysCount++; }
        }
      }
    }

    // 딜 전환율 순위 (2건 이상)
    const dealRanked = Object.values(dealAll)
      .filter((d) => d.total >= 2)
      .map((d) => ({ name: d.name, rate: d.converted / d.total, total: d.total, converted: d.converted }));
    const topDeals = [...dealRanked].sort((a, b) => b.rate - a.rate || b.total - a.total).slice(0, 3);
    const bottomDeals = [...dealRanked].sort((a, b) => a.rate - b.rate || b.total - a.total).slice(0, 3);

    // 셀러 전환율 순위 (2건 이상)
    const sellerRanked = Object.values(sellerAll)
      .filter((s) => s.total >= 2)
      .map((s) => ({ name: s.name, rate: s.converted / s.total, total: s.total, converted: s.converted }));
    const topSellers = [...sellerRanked].sort((a, b) => b.rate - a.rate || b.total - a.total).slice(0, 3);
    const bottomSellers = [...sellerRanked].sort((a, b) => a.rate - b.rate || b.total - a.total).slice(0, 3);

    return {
      // 전환율
      allRate: allCompleted > 0 ? allConverted / allCompleted : 0,
      allConverted, allCompleted,
      r30Rate: r30Completed > 0 ? r30Converted / r30Completed : 0,
      r30Converted, r30Completed,
      // 전환일
      allDays: allDaysCount > 0 ? allDaysSum / allDaysCount : null,
      r30Days: r30DaysCount > 0 ? r30DaysSum / r30DaysCount : null,
      // 딜 순위
      topDeals, bottomDeals,
      // 셀러 순위
      topSellers, bottomSellers,
    };
  }, [tasks]);

  const outreachColumns = useMemo<GridColumn<OutreachRow>[]>(() => {
    return [
      {
        key: "sellerName",
        label: "셀러명",
        width: 140,
      },
      {
        key: "dealName",
        label: "연결된 딜",
        width: 160,
      },
      {
        key: "partnerName",
        label: "거래처",
        width: 120,
      },
      {
        key: "status",
        label: "진행 상태",
        width: 120,
        type: "select",
        options: [
          { value: "PROPOSED", label: "제안중" },
          { value: "NEGOTIATION", label: "협의중" },
          { value: "TESTING", label: "테스트중" },
          { value: "PENDING_APPROVAL", label: "승인대기" },
          { value: "CONVERTED", label: "전환완료" },
          { value: "DROPPED", label: "드랍" },
        ],
      },
      {
        key: "contactChannel",
        label: "채널",
        width: 100,
      },
      {
        key: "proposedAt",
        label: "제안일",
        width: 110,
        type: "date",
      },
      {
        key: "nextReminderAt",
        label: "다음 리마인드",
        width: 120,
        type: "date",
      },
    ];
  }, []);

  return (
    <>
      {isMobile ? (
        <MobileOutreachView
          tasks={tasks}
          loading={loading}
          onSelectTask={setSelectedTask}
          onReminderSent={handleReminderSent}
          onCreateCampaign={handleCreateCampaign}
          onStatusChange={handleStatusChange}
        />
      ) : (
        <CrmShell>
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
          {loading ? (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
            로딩 중...
          </div>
        ) : (
          <>
            {/* Summary Bar */}
            <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200/60 bg-white/80 px-4 py-2.5 text-xs text-slate-600 shadow-soft-sm backdrop-blur-sm dark:bg-slate-900/60 dark:border-slate-800 dark:text-slate-400 shrink-0">
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="font-medium">전체 테스크:</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">{tasks.length}개</span>
              </div>
              <span className="hidden md:inline text-slate-200 dark:text-slate-800">|</span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="font-medium">진행 중:</span>
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {negotiationTasks.length + testingTasks.length + pendingApprovalTasks.length}개
                </span>
              </div>
              <span className="hidden md:inline text-slate-200 dark:text-slate-800">|</span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="font-medium">제안 대기:</span>
                <span className="font-semibold text-amber-600 dark:text-amber-400">{proposedTasks.length}개</span>
              </div>
              <span className="hidden md:inline text-slate-200 dark:text-slate-800">|</span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="font-medium">전환 완료:</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">{convertedTasks.length}건</span>
              </div>
            </div>

            {/* F1 재캠페인 적기 — 대시보드에서 이관(§F1). 알림이 없으면 스스로 렌더하지 않는다 */}
            <RecampaignAlertsCard className="mb-4 shrink-0" />

            {/* 카드 컨테이너 */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
              <div className="flex flex-col gap-4 border-b border-border/70 px-5 py-4">
                {/* Header Title & Controls */}
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h2 className="text-[15px] font-bold text-slate-900 dark:text-white">영업 관리</h2>
                    <p className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                      셀러별 영업 진행 상태와 리마인드 일정을 관리합니다.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex w-full items-center gap-2 md:w-auto">
                      <div className="relative w-full sm:w-64">
                        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                        <Input
                          placeholder="셀러, 딜, 거래처 검색..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="pl-9 h-9 w-full text-xs bg-white shadow-soft-sm"
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center rounded-2xl border border-border/70 bg-white/80 p-0.5 shadow-soft-sm">
                        <button
                          onClick={() => setViewMode("board")}
                          className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-[color,background-color,box-shadow] ${
                            viewMode === "board"
                              ? "bg-white shadow-soft-sm text-foreground"
                              : "text-muted-foreground hover:bg-slate-50 hover:text-foreground"
                          }`}
                        >
                          <Kanban className="size-3.5" />
                          <span>칸반</span>
                        </button>
                        <button
                          onClick={() => setViewMode("table")}
                          className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-[color,background-color,box-shadow] ${
                            viewMode === "table"
                              ? "bg-white shadow-soft-sm text-foreground"
                              : "text-muted-foreground hover:bg-slate-50 hover:text-foreground"
                          }`}
                        >
                          <LayoutList className="size-3.5" />
                          <span>목록</span>
                        </button>
                      </div>
                      <Button
                        variant="default"
                        size="sm"
                        className="rounded-lg bg-primary px-3.5 text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/95 h-9 text-xs"
                        onClick={() => setCreateOpen(true)}
                      >
                        <Plus className="mr-1.5 size-4" />
                        테스크 등록
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Dashboard Metrics */}
                <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-2">
                  {/* 1. 전체 전환율 도넛 */}
                  <div className="rounded-xl border border-border/70 bg-white/70 p-4 shadow-soft-sm flex flex-col">
                    <p className="text-[11px] font-semibold text-slate-700 mb-3 flex items-center gap-1.5 shrink-0">
                      <TrendingUp className="size-3.5 text-emerald-600" />전환율
                    </p>
                    <div className="flex flex-col gap-3">
                      {/* 전체 */}
                      <div className="flex items-center gap-2.5">
                        <div className="relative size-8 shrink-0">
                          <svg viewBox="0 0 36 36" className="size-8 -rotate-90">
                            <circle cx="18" cy="18" r="15.5" fill="none" stroke="#e2e8f0" strokeWidth="3.5" />
                            <circle cx="18" cy="18" r="15.5" fill="none" stroke="#10b981" strokeWidth="3.5"
                              strokeDasharray={`${metrics.allRate * 97.4} 97.4`}
                              strokeLinecap="round" />
                          </svg>
                          <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-emerald-700 tabular-nums">
                            {(metrics.allRate * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div className="min-w-0 text-[11px] font-medium text-slate-600 flex items-center gap-1 whitespace-nowrap">
                          <span className="text-muted-foreground">전체</span>
                          <span className="tabular-nums">({metrics.allConverted}/{metrics.allCompleted})</span>
                        </div>
                      </div>
                      {/* 최근 30일 */}
                      <div className="flex items-center gap-2.5">
                        <div className="relative size-8 shrink-0">
                          <svg viewBox="0 0 36 36" className="size-8 -rotate-90">
                            <circle cx="18" cy="18" r="15.5" fill="none" stroke="#e2e8f0" strokeWidth="3.5" />
                            <circle cx="18" cy="18" r="15.5" fill="none" stroke="#059669" strokeWidth="3.5"
                              strokeDasharray={`${metrics.r30Rate * 97.4} 97.4`}
                              strokeLinecap="round" />
                          </svg>
                          <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-emerald-800 tabular-nums">
                            {(metrics.r30Rate * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div className="min-w-0 text-[11px] font-medium text-slate-600 flex items-center gap-1 whitespace-nowrap">
                          <span className="text-muted-foreground">최근30일</span>
                          <span className="tabular-nums">({metrics.r30Converted}/{metrics.r30Completed})</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 2. 평균 전환일 — 방향성 없는 서술 지표(호불호 無) → info, PALETTE_IMPL_SPEC.md 인디고 분류 2026-07-09 */}
                  <div className="rounded-xl border border-border/70 bg-white/70 p-4 shadow-soft-sm flex flex-col">
                    <p className="text-[11px] font-semibold text-slate-700 mb-3 flex items-center gap-1.5 shrink-0">
                      <Target className="size-3.5 text-status-info" />평균 전환일
                    </p>
                    <div className="flex flex-col gap-3">
                      {/* 전체 */}
                      <div className="flex items-center gap-2.5">
                        <div className="flex items-center justify-center size-8 rounded-full bg-status-info/10 shrink-0">
                          <span className="text-[12px] font-bold text-status-info tabular-nums">
                            {metrics.allDays !== null ? metrics.allDays.toFixed(0) : "—"}
                          </span>
                        </div>
                        <div className="min-w-0 text-[11px] font-medium text-slate-600 flex items-center gap-1 whitespace-nowrap">
                          <span className="text-muted-foreground">전체</span>
                          <span>평균일</span>
                        </div>
                      </div>
                      {/* 최근 30일 — 위 "전체" 행과 **같은 status-info** 다(오너 결정 2026-07-30).
                          창(전체/최근30일)은 좋고 나쁨이 없는 범주라 hue 를 받지 않는다(P8 §4): 구
                          violet 은 "최근 30일"이라는 범주만 나르고 있었고, 자매 카드 "전환율"은 이미
                          두 창을 같은 emerald 로 그리고 라벨로만 구분한다. 이 타일은 장식이 아니라
                          **값 캐리어**라 무채색화 대신 hue 통일을 택했다 — 전체만 유채색이고 최근30일만
                          회색이면 없던 위계가 생긴다. 대비: status-info on /10 틴트 = 4.86 ✅ */}
                      <div className="flex items-center gap-2.5">
                        <div className="flex items-center justify-center size-8 rounded-full bg-status-info/10 shrink-0">
                          <span className="text-[12px] font-bold text-status-info tabular-nums">
                            {metrics.r30Days !== null ? metrics.r30Days.toFixed(0) : "—"}
                          </span>
                        </div>
                        <div className="min-w-0 text-[11px] font-medium text-slate-600 flex items-center gap-1 whitespace-nowrap">
                          <span className="text-muted-foreground">최근30일</span>
                          <span>평균일</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 3. 전환율 높은 딜 */}
                  <div className="rounded-xl border border-border/70 bg-white/70 p-4 shadow-soft-sm flex flex-col">
                    <p className="text-[11px] font-semibold text-slate-800 mb-3 flex items-center gap-1.5 shrink-0 border-b border-slate-100 pb-2">
                      <TrendingUp className="size-3.5 text-emerald-600" />전환율 높은 딜
                    </p>
                    <div className="space-y-2 flex-1">
                      {metrics.topDeals.length > 0 ? metrics.topDeals.map((d) => (
                        <div key={`h-${d.name}`} className="mb-2 last:mb-0">
                          <div className="flex items-center justify-between text-[10px] mb-1">
                            <span className="text-slate-600 truncate min-w-0 mr-2">{d.name}</span>
                            <span className="shrink-0 font-bold text-emerald-600 tabular-nums">{(d.rate * 100).toFixed(0)}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-emerald-100 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500 rounded-full transition-[width]" style={{ width: `${Math.max(d.rate * 100, 2)}%` }} />
                          </div>
                        </div>
                      )) : <div className="text-[10px] text-muted-foreground mb-1">데이터 부족</div>}
                    </div>
                  </div>

                  {/* 4. 전환율 낮은 딜 */}
                  <div className="rounded-xl border border-border/70 bg-white/70 p-4 shadow-soft-sm flex flex-col">
                    <p className="text-[11px] font-semibold text-slate-800 mb-3 flex items-center gap-1.5 shrink-0 border-b border-slate-100 pb-2">
                      <TrendingDown className="size-3.5 text-rose-500" />전환율 낮은 딜
                    </p>
                    <div className="space-y-2 flex-1">
                      {metrics.bottomDeals.length > 0 ? metrics.bottomDeals.map((d) => (
                        <div key={`l-${d.name}`} className="mb-2 last:mb-0">
                          <div className="flex items-center justify-between text-[10px] mb-1">
                            <span className="text-slate-600 truncate min-w-0 mr-2">{d.name}</span>
                            <span className="shrink-0 font-bold text-rose-500 tabular-nums">{(d.rate * 100).toFixed(0)}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-rose-100 rounded-full overflow-hidden">
                            <div className="h-full bg-rose-500 rounded-full transition-[width]" style={{ width: `${Math.max(d.rate * 100, 2)}%` }} />
                          </div>
                        </div>
                      )) : <div className="text-[10px] text-muted-foreground mb-1">데이터 부족</div>}
                    </div>
                  </div>

                  {/* 5. 전환율 높은 셀러 */}
                  <div className="rounded-xl border border-border/70 bg-white/70 p-4 shadow-soft-sm flex flex-col">
                    <p className="text-[11px] font-semibold text-slate-800 mb-3 flex items-center gap-1.5 shrink-0 border-b border-slate-100 pb-2">
                      <Target className="size-3.5 text-emerald-500" />전환율 높은 셀러
                    </p>
                    <div className="space-y-2 flex-1">
                      {metrics.topSellers.length > 0 ? metrics.topSellers.map((s) => (
                        <div key={`h-${s.name}`} className="mb-2 last:mb-0">
                          <div className="flex items-center justify-between text-[10px] mb-1">
                            <span className="text-slate-600 truncate min-w-0 mr-2">{s.name}</span>
                            <span className="shrink-0 font-bold text-emerald-600 tabular-nums">{(s.rate * 100).toFixed(0)}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-emerald-100 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500 rounded-full transition-[width]" style={{ width: `${Math.max(s.rate * 100, 2)}%` }} />
                          </div>
                        </div>
                      )) : <div className="text-[10px] text-muted-foreground mb-1">데이터 부족</div>}
                    </div>
                  </div>

                  {/* 6. 전환율 낮은 셀러 */}
                  <div className="rounded-xl border border-border/70 bg-white/70 p-4 shadow-soft-sm flex flex-col">
                    <p className="text-[11px] font-semibold text-slate-800 mb-3 flex items-center gap-1.5 shrink-0 border-b border-slate-100 pb-2">
                      <Target className="size-3.5 text-rose-500" />전환율 낮은 셀러
                    </p>
                    <div className="space-y-2 flex-1">
                      {metrics.bottomSellers.length > 0 ? metrics.bottomSellers.map((s) => (
                        <div key={`l-${s.name}`} className="mb-2 last:mb-0">
                          <div className="flex items-center justify-between text-[10px] mb-1">
                            <span className="text-slate-600 truncate min-w-0 mr-2">{s.name}</span>
                            <span className="shrink-0 font-bold text-rose-500 tabular-nums">{(s.rate * 100).toFixed(0)}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-rose-100 rounded-full overflow-hidden">
                            <div className="h-full bg-rose-500 rounded-full transition-[width]" style={{ width: `${Math.max(s.rate * 100, 2)}%` }} />
                          </div>
                        </div>
                      )) : <div className="text-[10px] text-muted-foreground mb-1">데이터 부족</div>}
                    </div>
                  </div>
                </div>

                {/* Stage Filter Tabs */}
                <div className="flex items-center gap-1.5 pt-2">
                  <Button
                    variant={stageFilter === "ALL" ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setStageFilter("ALL")}
                    className={cn("rounded-lg h-8", stageFilter === "ALL" && "bg-slate-200 text-slate-900 font-semibold")}
                  >
                    전체
                    <span className={cn("ml-1 inline-flex items-center justify-center rounded-md px-1.5 text-xs tabular-nums", stageFilter === "ALL" ? "bg-slate-900/10 text-slate-700" : "bg-muted text-muted-foreground")}>
                      {tasks.length}
                    </span>
                  </Button>
                  <Button
                    variant={stageFilter === "IN_PROGRESS" ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setStageFilter("IN_PROGRESS")}
                    className={cn("rounded-lg h-8", stageFilter === "IN_PROGRESS" && "bg-slate-200 text-slate-900 font-semibold")}
                  >
                    진행중
                    <span className={cn("ml-1 inline-flex items-center justify-center rounded-md px-1.5 text-xs tabular-nums", stageFilter === "IN_PROGRESS" ? "bg-slate-900/10 text-slate-700" : "bg-muted text-muted-foreground")}>
                      {tasks.filter(t => ["PROPOSED", "NEGOTIATION", "TESTING", "PENDING_APPROVAL"].includes(t.status)).length}
                    </span>
                  </Button>
                  <Button
                    variant={stageFilter === "CLOSED" ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setStageFilter("CLOSED")}
                    className={cn("rounded-lg h-8", stageFilter === "CLOSED" && "bg-slate-200 text-slate-900 font-semibold")}
                  >
                    종료됨
                    <span className={cn("ml-1 inline-flex items-center justify-center rounded-md px-1.5 text-xs tabular-nums", stageFilter === "CLOSED" ? "bg-slate-900/10 text-slate-700" : "bg-muted text-muted-foreground")}>
                      {tasks.filter(t => ["CONVERTED", "DROPPED"].includes(t.status)).length}
                    </span>
                  </Button>
                </div>
              </div>

            {/* Content Body */}
            {viewMode === "board" ? (
              <div className="min-h-0 flex-1 overflow-x-auto bg-[#f8fafc] p-4">
                <DndContext
                  // 안정적 id — dnd-kit의 aria-describedby 모듈 카운터가 SSR/클라 하이드레이션
                  // 미스매치를 내는 것을 방지(결정론화). ExecutionKanbanBoard와 동일.
                  id="outreach-kanban-board"
                  sensors={sensors}
                  collisionDetection={pointerWithin}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragCancel={() => setActiveId(null)}
                >
                <div className="flex gap-[15px] pb-2 items-stretch h-full">
                {/* 1. 제안중 / 리마인드 큐 */}
                {(stageFilter === "ALL" || stageFilter === "IN_PROGRESS") && (
                  <>
                  <DroppableColumn status="PROPOSED">
                  <WorkspaceSection
                    title="제안중 / 리마인드 큐"
                    description="응답 대기 중이거나 제안을 보낸 셀러"
                    count={proposedTasks.length}
                    isCollapsed={collapsedStages["PROPOSED"] ?? false}
                    onCollapse={() => toggleStage("PROPOSED")}
                  >
                    <div className="flex flex-col gap-3">
                      <Button
                        onClick={() => setCreateOpen(true)}
                        variant="outline"
                        className="w-full border-dashed border-slate-200 hover:border-primary/50 hover:bg-slate-50/50 hover:text-primary transition-colors flex items-center justify-center gap-1.5 h-10 rounded-xl"
                      >
                        <Plus className="size-4" />
                        <span className="text-xs font-semibold">테스크 추가</span>
                      </Button>

                      {proposedTasks.length > 0 ? (
                        <OutreachList
                          outreaches={proposedTasks}
                          onStatusChange={handleStatusChange}
                          onReminderSent={handleReminderSent}
                          onDropTask={handleDropTask}
                          onSelectTask={setSelectedTask}
                          draggable
                        />
                      ) : (
                        <WorkspaceEmpty
                          icon={<Megaphone className="size-4" />}
                          title="제안 대기열"
                          description="제안중인 셀러가 없습니다."
                        />
                      )}
                    </div>
                  </WorkspaceSection>
                  </DroppableColumn>

                {/* 2. 협의중 */}
                  <DroppableColumn status="NEGOTIATION">
                  <WorkspaceSection
                    title="협의중"
                    description="조건을 조율하며 소통 중인 단계"
                    count={negotiationTasks.length}
                    isCollapsed={collapsedStages["NEGOTIATION"] ?? false}
                    onCollapse={() => toggleStage("NEGOTIATION")}
                  >
                    {negotiationTasks.length > 0 ? (
                      <OutreachList
                        outreaches={negotiationTasks}
                        onStatusChange={handleStatusChange}
                        onDropTask={handleDropTask}
                        onSelectTask={setSelectedTask}
                        draggable
                      />
                    ) : (
                      <WorkspaceEmpty
                        icon={<ListTodo className="size-4" />}
                        title="협의중 테스크 없음"
                        description="응답이 온 셀러와 협의를 진행합니다."
                      />
                    )}
                  </WorkspaceSection>
                  </DroppableColumn>

                {/* 3. 테스트중 */}
                  <DroppableColumn status="TESTING">
                  <WorkspaceSection
                    title="테스트중"
                    description="샘플 배송 및 피드백 대기중"
                    count={testingTasks.length}
                    isCollapsed={collapsedStages["TESTING"] ?? false}
                    onCollapse={() => toggleStage("TESTING")}
                  >
                    {testingTasks.length > 0 ? (
                      <OutreachList
                        outreaches={testingTasks}
                        onStatusChange={handleStatusChange}
                        onDropTask={handleDropTask}
                        onSelectTask={setSelectedTask}
                        draggable
                      />
                    ) : (
                      <WorkspaceEmpty
                        icon={<ListTodo className="size-4" />}
                        title="테스트중인 셀러 없음"
                        description="협의 완료 후 테스트를 시작합니다."
                      />
                    )}
                  </WorkspaceSection>
                  </DroppableColumn>

                {/* 4. 승인대기 */}
                  <DroppableColumn status="PENDING_APPROVAL">
                  <WorkspaceSection
                    title="승인대기"
                    description="캠페인 전환을 기다리는 확정 건"
                    count={pendingApprovalTasks.length}
                    isCollapsed={collapsedStages["PENDING_APPROVAL"] ?? false}
                    onCollapse={() => toggleStage("PENDING_APPROVAL")}
                  >
                    {pendingApprovalTasks.length > 0 ? (
                      <OutreachList
                        outreaches={pendingApprovalTasks}
                        onStatusChange={handleStatusChange}
                        onCreateCampaign={handleCreateCampaign}
                        onDropTask={handleDropTask}
                        onSelectTask={setSelectedTask}
                        draggable
                      />
                    ) : (
                      <WorkspaceEmpty
                        icon={<CircleCheckBig className="size-4" />}
                        title="승인대기 테스크 없음"
                        description="모든 조건이 완료되면 이관합니다."
                      />
                    )}
                  </WorkspaceSection>
                  </DroppableColumn>
                </>
                )}

                {/* 5. 전환완료 (다음 페이지로 넘겨서 배치) */}
                {(stageFilter === "ALL" || stageFilter === "CLOSED") && (
                  <>
                  <DroppableColumn status="CONVERTED" disabled>
                    <WorkspaceSection
                      title="전환완료"
                      description="캠페인으로 승인 완료된 이력"
                      count={convertedTasks.length}
                      isCollapsed={collapsedStages["CONVERTED"] ?? false}
                      onCollapse={() => toggleStage("CONVERTED")}
                    >
                      {convertedTasks.length > 0 ? (
                        <OutreachList
                          outreaches={convertedTasks}
                          onStatusChange={handleStatusChange}
                          onSelectTask={setSelectedTask}
                        />
                      ) : (
                        <WorkspaceEmpty
                          icon={<CircleCheckBig className="size-4" />}
                          title="전환완료 이력 없음"
                          description="캠페인 승인 후 자동 전환됩니다."
                        />
                      )}
                    </WorkspaceSection>
                  </DroppableColumn>

                {/* 6. 드랍 이력 */}
                  <DroppableColumn status="DROPPED">
                    <WorkspaceSection
                      title="드랍 이력"
                      description="종료된 리드"
                      count={droppedTasks.length}
                      isCollapsed={collapsedStages["DROPPED"] ?? false}
                      onCollapse={() => toggleStage("DROPPED")}
                    >
                      <OutreachList
                        outreaches={droppedTasks}
                        onStatusChange={handleStatusChange}
                        onSelectTask={setSelectedTask}
                      />
                    </WorkspaceSection>
                  </DroppableColumn>
                  </>
                )}
                </div>

                {/* 들린 카드 — 커서 중심을 따라오는 공용 오버레이(body 포털, 카드 본문 재사용) */}
                <KanbanDragOverlay>
                  {activeTask ? (
                    <OutreachCardContent
                      outreach={activeTask}
                      now={boardNow}
                      isOverlay
                    />
                  ) : null}
                </KanbanDragOverlay>
                </DndContext>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto bg-[#f8fafc]">
                <InlineDataGrid
                  columns={outreachColumns}
                  rows={filteredTasks}
                  onRowClick={setSelectedTask}
                  onPatch={async (id, patch) => {
                    const [key, value] = Object.entries(patch)[0] ?? [];
                    if (!key) return null;
                    if (key === "status") {
                      await handleStatusChange(id, value as OutreachStatus);
                    } else if (key === "nextReminderAt" || key === "contactChannel") {
                      await fetch(`/api/outreach/${id}`, {
                        method: "PATCH",
                        headers: {
                          "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                          [key]: value,
                        }),
                      });
                      await fetchTasks();
                    }
                    return tasks.find((task) => task.id === id) ?? null;
                  }}
                  disableInlineEdit={false}
                />
              </div>
            )}
            </div>
          </>
        )}
        </section>
      </CrmShell>
    )}

      {/* Sheets & Dialogs */}
      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent
          side="right"
          style={{
            width: "min(520px, 96vw)",
            maxWidth: "min(520px, 96vw)",
          }}
          className="flex flex-col overflow-hidden border-l border-border/70 bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0"
        >
          <SheetHeader className="shrink-0 border-b border-border/70 px-6 py-5">
            <SheetTitle>새 영업 테스크</SheetTitle>
            <SheetDescription>
              딜과 셀러를 연결하고 제안 발송 테스크를 만듭니다.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <OutreachCreateForm
              onSuccess={() => {
                setCreateOpen(false);
                void fetchTasks();
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={selectedTask !== null}
        onOpenChange={(open) => !open && setSelectedTask(null)}
      >
        <SheetContent
          side="right"
          style={{
            width: "min(560px, 96vw)",
            maxWidth: "min(560px, 96vw)",
          }}
          className="flex flex-col overflow-hidden border-l border-border/70 bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0"
        >
          {selectedTask ? (
            <>
              <SheetHeader className="shrink-0 border-b border-border/70 px-6 py-5">
                <SheetTitle>영업 테스크 상세 페이지</SheetTitle>
                <SheetDescription>
                  셀러 제안·협의·테스트 진행 현황을 확인하고 관리합니다.
                </SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <SalesTaskDetailPanel
                  task={selectedTask}
                  onStatusChange={handleStatusChange}
                  onReminderSent={handleReminderSent}
                  onCreateCampaign={handleCreateCampaign}
                  onDropTask={handleDropTask}
                  onSaveField={handleTaskFieldSave}
                  savingMemoField={savingMemoField}
                />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog
        open={dropDialogOpen}
        onOpenChange={(nextOpen) => {
          setDropDialogOpen(nextOpen);
          if (!nextOpen) {
            setDropTargetTaskId(null);
            setDropReasonDraft("");
            setDropSubmitting(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>영업 테스크 종료</DialogTitle>
            <DialogDescription>
              종료 사유를 남겨야 이후에 왜 드랍됐는지 추적할 수 있습니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {[
                "미응답 종료",
                "조건 불일치",
                "테스트 반려",
                "일정 불가",
                "수동 종료",
              ].map((reason) => (
                <Button
                  key={reason}
                  type="button"
                  variant={dropReasonDraft === reason ? "default" : "outline"}
                  size="xs"
                  onClick={() => setDropReasonDraft(reason)}
                >
                  {reason}
                </Button>
              ))}
            </div>
            <Textarea
              value={dropReasonDraft}
              onChange={(event) => setDropReasonDraft(event.target.value)}
              placeholder="종료 사유를 입력하세요"
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDropDialogOpen(false)}
              disabled={dropSubmitting}
            >
              취소
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleConfirmDropTask()}
              disabled={dropSubmitting}
            >
              {dropSubmitting ? "종료 중..." : "드랍 확정"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * 상태 컬럼 래퍼 — useDroppable 대상. isOver 시 컬럼 전체에 링 하이라이트.
 * disabled(=CONVERTED)면 드롭을 받지 않아 하이라이트도 없다.
 */
/**
 * 드롭 대상 활성 여부를 컬럼 하위 트리(WorkspaceSection)에 전달하는 컨텍스트.
 * DroppableColumn(=droppable ref 소유)과 WorkspaceSection(=카드 리스트 소유)이
 * 분리돼 있어 isOver를 prop drilling할 수 없으므로, 단일 boolean만 흘려보낸다.
 * 판매 관리 ExecutionColumn은 한 컴포넌트가 둘 다 소유해 이 컨텍스트가 불필요.
 */
const OutreachDropTargetContext = createContext(false);

function DroppableColumn({
  status,
  disabled = false,
  children,
}: {
  status: OutreachStatus;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled });
  const isDropTarget = isOver && !disabled;
  return (
    // 레이아웃 전용 래퍼(비가시) — 드롭 하이라이트는 실제 보이는 카드 표면
    // (WorkspaceSection)에 직접 적용한다(판매 관리 ExecutionColumn과 동일 규약).
    // 이 래퍼에 ring을 그리면 카드 바깥에 뜬 헤일로가 되어 판매 칸반과 시각적으로
    // 어긋난다.
    <div ref={setNodeRef} className="flex flex-col gap-5 w-[300px] shrink-0">
      <OutreachDropTargetContext.Provider value={isDropTarget}>
        {children}
      </OutreachDropTargetContext.Provider>
    </div>
  );
}

function WorkspaceSection({
  title,
  description,
  count,
  children,
  onAdd,
  isCollapsed,
  onCollapse,
}: {
  title: string;
  description: string;
  count: number;
  children: React.ReactNode;
  onAdd?: () => void;
  isCollapsed?: boolean;
  onCollapse?: () => void;
}) {
  // 드롭 대상 컬럼이면 카드 표면 자체를 하이라이트하고(판매 관리 ExecutionColumn과
  // 동일 규약 — border-primary/40 bg-primary/5 ring-1 ring-primary/20), 카드 리스트
  // 끝에 고스트 플레이스홀더를 표시한다. 컬럼이 비어 있으면 빈 상태(children)를
  // 숨기고 고스트만 보여 ExecutionColumn과 동일하게 중복 표시를 피한다.
  const isDropTarget = useContext(OutreachDropTargetContext);
  const isEmptyDropTarget = isDropTarget && count === 0;
  return (
    <section
      className={cn(
        "overflow-hidden rounded-2xl border shadow-soft-sm w-full min-w-0 flex flex-col h-full transition-colors",
        isDropTarget
          ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
          : "border-border/70 bg-white/80",
      )}
    >
      <div className={cn("px-5 py-4 shrink-0", !isCollapsed && "border-b border-border/70")}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-xs font-semibold text-foreground truncate">{title}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground truncate">
              {description}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {onAdd && !isCollapsed ? (
              <button
                onClick={onAdd}
                className="flex h-6 w-6 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
                title="새 테스크 추가"
              >
                <Plus className="size-3" />
              </button>
            ) : null}
            <span className="rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs text-muted-foreground">
              {count}
            </span>
            {onCollapse && (
              <button
                onClick={onCollapse}
                className="flex h-6 w-6 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground transition-colors hover:bg-slate-50 hover:text-foreground"
                title={isCollapsed ? "단계 펼치기" : "단계 접기"}
              >
                {isCollapsed ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronUp className="size-3.5" />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
      {!isCollapsed && (
        <div className="p-4 flex flex-col flex-1 overflow-y-auto">
          {isEmptyDropTarget ? null : children}
          {isDropTarget ? (
            <div
              aria-hidden
              className={cn(
                "flex shrink-0 items-center justify-center rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 px-4 py-6 text-center text-[12px] font-medium text-primary/70",
                !isEmptyDropTarget && "mt-3",
              )}
            >
              여기에 놓기
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}



function WorkspaceEmpty({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function SalesTaskDetailPanel({
  task,
  onStatusChange,
  onReminderSent,
  onCreateCampaign,
  onDropTask,
  onSaveField,
  savingMemoField,
}: {
  task: OutreachRow;
  onStatusChange: (id: string, newStatus: OutreachStatus) => Promise<void>;
  onReminderSent: (id: string) => Promise<void>;
  onCreateCampaign: (id: string) => Promise<void>;
  onDropTask: (id: string, reason: string) => Promise<void>;
  onSaveField: (id: string, field: string, value: string) => Promise<void>;
  savingMemoField: string | null;
}) {
  const [proposalDraft, setProposalDraft] = useState(task.proposalMessage ?? "");
  const [negotiationDraft, setNegotiationDraft] = useState(task.negotiationMemo ?? "");
  const [testingDraft, setTestingDraft] = useState(task.testingMemo ?? "");
  const [dropDraft, setDropDraft] = useState(task.dropReason ?? "");
  const [totalMarginRate, setTotalMarginRate] = useState(task.totalMarginRate?.toString() ?? "0");
  const [sellerMarginRate, setSellerMarginRate] = useState(task.sellerMarginRate?.toString() ?? "0");

  useEffect(() => {
    setProposalDraft(task.proposalMessage ?? "");
    setNegotiationDraft(task.negotiationMemo ?? "");
    setTestingDraft(task.testingMemo ?? "");
    setDropDraft(task.dropReason ?? "");
    setTotalMarginRate(task.totalMarginRate?.toString() ?? "0");
    setSellerMarginRate(task.sellerMarginRate?.toString() ?? "0");
  }, [task.proposalMessage, task.negotiationMemo, task.testingMemo, task.dropReason, task.totalMarginRate, task.sellerMarginRate]);

  const [isSellerSearchOpen, setIsSellerSearchOpen] = useState(false);
  const [isDealSearchOpen, setIsDealSearchOpen] = useState(false);

  const timeline = [
    {
      label: "제안 발송",
      value: task.proposedAt,
    },
    {
      label: "최근 리마인드",
      value: task.lastReminderAt ?? null,
    },
    {
      label: "다음 리마인드",
      value: task.nextReminderAt ?? null,
    },
    {
      label: "응답 확인",
      value: task.respondedAt ?? null,
    },
    {
      label: "승인대기",
      value: task.acceptedAt ?? null,
    },
    {
      label: "종료 처리",
      value: task.droppedAt ?? null,
    },
  ].filter((item) => item.value);

  const parsedTotal = parseFloat(totalMarginRate) || 0;
  const parsedSeller = parseFloat(sellerMarginRate) || 0;
  const expectedProfitRate = (parsedTotal - parsedSeller).toFixed(1);

  const showDropReason = task.status === "DROPPED" || Boolean(task.dropReason);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border/70 bg-white/80 p-4 shadow-soft-sm">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <div className="text-[10px] text-muted-foreground font-medium mb-1">연결된 셀러</div>
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                <SellerIdentityInfo
                   sellerName={task.sellerName}
                   snsType={task.snsType}
                   snsHandle={task.snsHandle}
                   variant="compact"
                   hideSns={false}
                />
                {task.sellerFollowers != null && (
                  <Badge variant="secondary" className="h-5 px-1.5 text-[9px] bg-slate-50 border-slate-200 text-slate-500 font-medium whitespace-nowrap">
                    팔로워 {task.sellerFollowers.toLocaleString()}
                  </Badge>
                )}
              </div>
            </div>
            <Button
              size="xs"
              variant="secondary"
              className="h-6 px-2 text-[10px] gap-1 shrink-0 bg-slate-100 hover:bg-slate-200 text-slate-600 font-medium border border-slate-200/60"
              onClick={() => setIsSellerSearchOpen(true)}
            >
              <Link2 className="size-3" />
              연결
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2 pt-2">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-muted-foreground font-medium mb-1">연결된 딜</div>
              <EntityIdentity
                parts={getDealIdentityParts({
                  dealName: task.dealName,
                  brandName: task.brandName,
                  partnerName: task.partnerName,
                })}
                variant="compact"
                className="w-full flex-wrap gap-x-2 gap-y-1"
              />
            </div>
            <Button
              size="xs"
              variant="secondary"
              className="h-6 px-2 text-[10px] gap-1 shrink-0 bg-slate-100 hover:bg-slate-200 text-slate-600 font-medium border border-slate-200/60"
              onClick={() => setIsDealSearchOpen(true)}
            >
              <Link2 className="size-3" />
              연결
            </Button>
          </div>
        </div>
        <div className="mt-3.5 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
          <span className="rounded-full border border-border/70 bg-background px-2.5 py-0.5 text-[10px]">
            채널 {task.contactChannel ?? "DM"}
          </span>
          {task.sellerCategory ? (
            <span className="rounded-full border border-border/70 bg-background px-2.5 py-0.5 text-[10px]">
              {task.sellerCategory}
            </span>
          ) : null}
          <span className="rounded-full border border-border/70 bg-background px-2.5 py-0.5 text-[10px]">
            제안일 {formatDate(task.proposedAt)}
          </span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
          {task.status === "PROPOSED" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void onReminderSent(task.id)}
            >
              <BellRing className="size-3" />
              리마인드 발송
            </Button>
          ) : null}
          {task.status === "PENDING_APPROVAL" && !task.linkedCampaignId ? (
            <Button
              size="xs"
              variant="outline"
              className="gap-1 font-medium bg-slate-50 border-slate-200"
              onClick={() => void onCreateCampaign(task.id)}
            >
              <Megaphone className="size-3 text-slate-500" />
              캠페인 생성 (승인)
            </Button>
          ) : null}
        </div>
      </section>

      {/* 영업 단계 스테퍼 */}
      <OutreachStageStepper
        task={task}
        onStatusChange={onStatusChange}
      />

      {/* 수수료 협의 */}
      <section className="rounded-2xl border border-border/70 bg-white/80 p-4 shadow-soft-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-semibold text-foreground">수수료 협의</h3>
          <Badge variant="secondary" className="h-5 px-1.5 text-[9px] bg-blue-50 text-blue-600 border border-blue-200">캠페인 연동</Badge>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">총수수료율 (%)</span>
            <div className="w-16">
              <Input
                type="number"
                className="h-7 text-right text-xs font-semibold"
                value={totalMarginRate}
                onChange={(e) => setTotalMarginRate(e.target.value)}
                onBlur={() => void onSaveField(task.id, "totalMarginRate", totalMarginRate)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
              />
            </div>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">셀러수수료율 (%)</span>
            <div className="w-16">
              <Input
                type="number"
                className="h-7 text-right text-xs font-semibold"
                value={sellerMarginRate}
                onChange={(e) => setSellerMarginRate(e.target.value)}
                onBlur={() => void onSaveField(task.id, "sellerMarginRate", sellerMarginRate)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
              />
            </div>
          </div>
          <div className="flex items-center justify-between text-[11px] border-t border-slate-100 pt-3">
            <span className="text-muted-foreground">예상 영업이익율</span>
            <span className="font-bold text-foreground text-xs">
              {expectedProfitRate}%
            </span>
          </div>
        </div>
        <p className="mt-4 text-[9px] text-muted-foreground leading-relaxed">
          영업 협의 단계에서 조율된 수수료율을 입력합니다. 입력된 수수료율은 캠페인 생성 승인 시점에 자동으로 반영됩니다.
        </p>
      </section>

      <section className="rounded-2xl border border-border/70 bg-white/80 p-4 shadow-soft-sm">
        <h3 className="text-xs font-semibold text-foreground">리마인드 이력</h3>
        <div className="mt-3 space-y-2">
          {timeline.length > 0 ? (
            timeline.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-background px-3 py-2 text-xs"
              >
                <span className="text-muted-foreground">{item.label}</span>
                <span className="font-medium text-foreground">
                  {formatDate(item.value!)}
                </span>
              </div>
            ))
          ) : (
            <div className="text-xs text-muted-foreground">
              기록된 일정이 없습니다.
            </div>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-white/80 p-4 shadow-soft-sm">
        <h3 className="text-xs font-semibold text-foreground">메모</h3>
        <p className="mt-1 mb-4 text-[11px] leading-5 text-muted-foreground">
          제안, 협의, 테스트 메모를 한 영역에서 단계별로 관리합니다.
        </p>
        
        <Tabs defaultValue={task.status === "TESTING" ? "testing" : task.status === "PROPOSED" ? "proposal" : "negotiation"} className="w-full">
          <TabsList className="w-full grid grid-cols-3 h-8 bg-muted/40 p-0.5 rounded-lg mb-4">
            <TabsTrigger value="proposal" className="text-[10px] h-7 rounded-md data-[state=active]:shadow-soft-sm">제안 메시지</TabsTrigger>
            <TabsTrigger value="negotiation" className="text-[10px] h-7 rounded-md data-[state=active]:shadow-soft-sm">협의 메모</TabsTrigger>
            <TabsTrigger value="testing" className="text-[10px] h-7 rounded-md data-[state=active]:shadow-soft-sm">테스트 메모</TabsTrigger>
          </TabsList>
          <TabsContent value="proposal" className="mt-0 outline-none">
            <TaskMemoSection
              title=""
              description="처음 발송한 제안 내용을 유지하거나 수정합니다."
              value={proposalDraft}
              initialValue={task.proposalMessage ?? ""}
              onChange={setProposalDraft}
              onSave={() => void onSaveField(task.id, "proposalMessage", proposalDraft)}
              saving={savingMemoField === `${task.id}:proposalMessage`}
            />
          </TabsContent>
          <TabsContent value="negotiation" className="mt-0 outline-none">
            <TaskMemoSection
              title=""
              description="러프 조건, 일정 가능 범위, 기본 합의 내용을 기록합니다."
              value={negotiationDraft}
              initialValue={task.negotiationMemo ?? ""}
              onChange={setNegotiationDraft}
              onSave={() => void onSaveField(task.id, "negotiationMemo", negotiationDraft)}
              saving={savingMemoField === `${task.id}:negotiationMemo`}
            />
          </TabsContent>
          <TabsContent value="testing" className="mt-0 outline-none">
            <TaskMemoSection
              title=""
              description="테스트 대상 적합성, 스크리닝 결과, 테스트 피드백을 기록합니다."
              value={testingDraft}
              initialValue={task.testingMemo ?? ""}
              onChange={setTestingDraft}
              onSave={() => void onSaveField(task.id, "testingMemo", testingDraft)}
              saving={savingMemoField === `${task.id}:testingMemo`}
            />
          </TabsContent>
        </Tabs>
        
        {showDropReason && (
          <div className="mt-4 pt-4 border-t border-border/50">
            <TaskMemoSection
              title="종료 사유"
              description="드랍된 경우 종료 배경을 수정하거나 보완합니다."
              value={dropDraft}
              initialValue={task.dropReason ?? ""}
              onChange={setDropDraft}
              onSave={() => void onSaveField(task.id, "dropReason", dropDraft)}
              saving={savingMemoField === `${task.id}:dropReason`}
            />
          </div>
        )}
      </section>

      {/* 첨부 자료 */}
      <TaskAssetSection taskId={task.id} />

      <LinkSearchDialog
        open={isSellerSearchOpen}
        onOpenChange={setIsSellerSearchOpen}
        entityType="seller"
        searchEndpoint="/api/search/sellers"
        onSelect={(seller) => {
          void onSaveField(task.id, "sellerId", seller.id);
        }}
        title="셀러 변경"
        placeholder="변경할 셀러 이름을 입력하세요"
      />
      <LinkSearchDialog
        open={isDealSearchOpen}
        onOpenChange={setIsDealSearchOpen}
        entityType="deal"
        searchEndpoint="/api/search/deals"
        onSelect={(deal) => {
          void onSaveField(task.id, "dealId", deal.id);
        }}
        title="딜 변경"
        placeholder="변경할 딜 또는 거래처 이름을 입력하세요"
      />

      {task.status !== "DROPPED" && (
        <Button
          variant="outline"
          className="w-full text-destructive border-destructive/20 bg-destructive/5 hover:bg-destructive/10 hover:text-destructive h-10 shadow-soft-sm"
          onClick={() => {
            const dropReason =
              task.status === "PROPOSED"
                ? "미응답 종료"
                : task.status === "PENDING_APPROVAL"
                  ? "승인 전 수동 종료"
                  : task.status === "CONVERTED"
                    ? "전환 후 수동 종료"
                    : "수동 종료";
            void onDropTask(task.id, dropReason);
          }}
        >
          <XCircle className="size-4 mr-1.5" />
          영업 테스크 보류 (드랍)
        </Button>
      )}
    </div>
  );
}

function TaskMemoSection({
  title,
  description,
  value,
  initialValue,
  onChange,
  onSave,
  saving,
}: {
  title: string;
  description: string;
  value: string;
  initialValue: string;
  onChange: (val: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const dirty = value !== initialValue;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          {title && <h3 className="text-[11px] font-semibold text-foreground mb-1">{title}</h3>}
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        <Button
          size="xs"
          variant="outline"
          className="h-6 text-[10px] px-2.5"
          onClick={onSave}
          disabled={saving || !dirty}
        >
          {saving ? "저장 중..." : dirty ? "저장" : "저장됨"}
        </Button>
      </div>
      <Textarea
        className="mt-1 min-h-[120px] text-[11px] resize-none focus-visible:ring-1 focus-visible:ring-offset-0 bg-slate-50/50"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={title ? `${title} 입력` : "내용을 입력하세요"}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// OutreachStageStepper
// ---------------------------------------------------------------------------

const OUTREACH_STAGE_ORDER: OutreachStatus[] = [
  "PROPOSED",
  "NEGOTIATION",
  "TESTING",
  "PENDING_APPROVAL",
  "CONVERTED",
];

const OUTREACH_STAGE_LABELS: Record<OutreachStatus, string> = {
  PROPOSED: "제안중",
  NEGOTIATION: "협의중",
  TESTING: "테스트중",
  PENDING_APPROVAL: "승인대기",
  CONVERTED: "전환완료",
  DROPPED: "드랍",
};

function OutreachStageStepper({
  task,
  onStatusChange,
}: {
  task: OutreachRow;
  onStatusChange: (id: string, newStatus: OutreachStatus) => Promise<void>;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<OutreachStatus | null>(null);

  const isDropped = task.status === "DROPPED";
  const currentIndex = OUTREACH_STAGE_ORDER.indexOf(task.status as OutreachStatus);

  async function handleMove(target: OutreachStatus) {
    setIsLoading(true);
    try {
      await onStatusChange(task.id, target);
    } finally {
      setIsLoading(false);
    }
  }

  function handleStepClick(target: OutreachStatus) {
    if (target === task.status || isLoading) return;
    const targetIndex = OUTREACH_STAGE_ORDER.indexOf(target);
    // 이전 단계로 이동 시 확인 다이얼로그
    if (currentIndex !== -1 && targetIndex < currentIndex) {
      setConfirmTarget(target);
      return;
    }
    void handleMove(target);
  }

  return (
    <>
      <div className="space-y-2 rounded-2xl border border-border/70 bg-white/80 p-4 shadow-soft-sm">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-foreground">영업 단계</h3>
          {isDropped && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => void handleMove("PROPOSED")}
              disabled={isLoading}
            >
              제안중으로 재시작
            </button>
          )}
        </div>

        {/* 드랍 배너 */}
        {isDropped ? (
          <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5">
            <XCircle className="size-4 text-destructive shrink-0" />
            <span className="text-xs font-medium text-destructive">드랍됨</span>
            {task.dropReason ? (
              <span className="ml-1 text-xs text-muted-foreground">· {task.dropReason}</span>
            ) : null}
          </div>
        ) : null}

        {/* 단계 버튼 목록 */}
        <div className="flex w-full gap-1.5">
          {OUTREACH_STAGE_ORDER.map((stage, index) => {
            const isCurrent = stage === task.status;
            const isPast = !isDropped && currentIndex !== -1 && index < currentIndex;
            const isFuture = isDropped || currentIndex === -1 || index > currentIndex;

            return (
              <button
                key={stage}
                type="button"
                disabled={isCurrent || isLoading || isDropped || stage === "CONVERTED"}
                onClick={() => handleStepClick(stage)}
                className={cn(
                  "relative flex flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-2.5 text-xs font-medium transition-[color,background-color,box-shadow] min-w-0 flex-1",
                  isCurrent &&
                    "bg-primary text-primary-foreground shadow-soft-sm cursor-default",
                  isPast &&
                    "bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer",
                  isFuture &&
                    !isDropped &&
                    "bg-muted/60 text-muted-foreground hover:bg-muted cursor-pointer",
                  isDropped && !isCurrent && "bg-muted/40 text-muted-foreground/50 cursor-default",
                  isLoading && "opacity-60 cursor-not-allowed",
                )}
                aria-current={isCurrent ? "step" : undefined}
              >
                <span className="flex items-center gap-0.5">
                  {isPast && <Check className="size-3 shrink-0" />}
                  <span className="truncate">{OUTREACH_STAGE_LABELS[stage]}</span>
                </span>
                {isCurrent && (
                  <span className="absolute -bottom-px left-1/2 -translate-x-1/2 h-0.5 w-4 rounded-full bg-primary-foreground/60" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 이전 단계 이동 확인 다이얼로그 */}
      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => { if (!open) setConfirmTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>단계 변경 확인</AlertDialogTitle>
            <AlertDialogDescription>
              영업 단계를 &ldquo;{confirmTarget ? OUTREACH_STAGE_LABELS[confirmTarget] : ""}&rdquo;(으)로 되돌리겠습니까?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmTarget(null)}>취소</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmTarget) void handleMove(confirmTarget);
                setConfirmTarget(null);
              }}
            >
              확인
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
// ---------------------------------------------------------------------------
// TaskAssetSection — 테스크 상세 패널 내 파일 업로드·목록 섹션
// ---------------------------------------------------------------------------

const TASK_ASSET_SECTIONS: { value: AssetSection; label: string }[] = [
  { value: "PRODUCT_INTRO", label: assetSectionLabels["PRODUCT_INTRO"] },
  { value: "PRICE_TABLE", label: assetSectionLabels["PRICE_TABLE"] },
  { value: "CONTRACT_SETTLEMENT", label: assetSectionLabels["CONTRACT_SETTLEMENT"] },
  { value: "SAMPLE_REVIEW", label: assetSectionLabels["SAMPLE_REVIEW"] },
  { value: "ETC", label: assetSectionLabels["ETC"] },
];

type AssetItem = {
  id: string;
  fileName: string;
  section: string;
  sizeBytes: number;
  externalUrl?: string | null;
  archivedAt?: string | null;
};

function TaskAssetSection({ taskId }: { taskId: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<AssetSection>("PRODUCT_INTRO");
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/assets?entityType=OUTREACH&entityId=${encodeURIComponent(taskId)}`)
      .then((r) => r.json())
      .then((data: { assets?: AssetItem[] }) => {
        if (data.assets) setAssets(data.assets);
      })
      .catch(() => undefined);
  }, [taskId]);

  async function handleUpload(file: File) {
    setBusy(true);
    setErrorMsg(null);
    const formData = new FormData();
    formData.set("entityType", "OUTREACH");
    formData.set("entityId", taskId);
    formData.set("section", section);
    formData.set("file", file);
    const res = await fetch("/api/assets", { method: "POST", body: formData });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErrorMsg((data as { error?: string }).error ?? "업로드 실패");
      return;
    }
    const typed = data as { asset?: AssetItem };
    if (typed.asset) setAssets((prev) => [typed.asset!, ...prev]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleArchive(assetId: string) {
    const res = await fetch(`/api/assets/${assetId}`, { method: "PATCH" });
    if (!res.ok) return;
    const data = (await res.json()) as { asset: AssetItem };
    setAssets((prev) => prev.map((a) => (a.id === assetId ? data.asset : a)));
  }

  async function handleOpen(assetId: string) {
    const res = await fetch(`/api/assets/${assetId}?download=1`);
    const data = (await res.json()) as { downloadUrl?: string };
    if (data.downloadUrl) window.open(data.downloadUrl, "_blank", "noreferrer");
  }

  const visibleAssets = assets.filter((a) => !a.archivedAt);

  return (
    <section className="rounded-2xl border border-border/70 bg-white/80 p-4 shadow-soft-sm">
      <h3 className="text-xs font-semibold text-foreground">첨부 자료</h3>
      <p className="mt-1 text-xs text-muted-foreground">제안서, 가격표, 계약서 등 테스크 관련 파일을 첨부합니다.</p>

      <div className="mt-3 flex gap-2">
        <div className="flex-1">
          <select
            value={section}
            onChange={(e) => setSection(e.target.value as AssetSection)}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-ring"
          >
            {TASK_ASSET_SECTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <label
          className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-input px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary ${
            busy ? "pointer-events-none opacity-50" : ""
          }`}
        >
          <Upload className="size-3.5" />
          {busy ? "업로드 중..." : "파일 선택"}
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            accept=".pdf,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.doc,.docx"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
        </label>
      </div>
      {errorMsg ? <p className="mt-1.5 text-xs text-destructive">{errorMsg}</p> : null}

      {visibleAssets.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {visibleAssets.map((asset) => (
            <li
              key={asset.id}
              className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-background px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{asset.fileName}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {assetSectionLabels[asset.section as AssetSection]} · {formatBytes(asset.sizeBytes)}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 gap-0.5">
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                  onClick={() => void handleOpen(asset.id)}
                  title="열기"
                >
                  <ExternalLink className="size-3" />
                </button>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                  onClick={() => void handleArchive(asset.id)}
                  title="보관"
                >
                  <Archive className="size-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3 rounded-xl border border-dashed border-border/60 bg-slate-50/60 py-4 text-center text-xs text-muted-foreground">
          첨부된 파일이 없습니다.
        </div>
      )}
    </section>
  );
}
