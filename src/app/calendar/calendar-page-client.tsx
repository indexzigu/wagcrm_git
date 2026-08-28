"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { z } from "zod";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Loader2,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CalendarView, type CalendarCampaign } from "@/components/crm/calendar-view";
import {
  CalendarFilterBar,
  type CalendarSellerOption,
} from "@/components/crm/calendar-filter-bar";
import { DraftCampaignDialog } from "@/components/crm/draft-campaign-dialog";
import { ScheduleGapSummaryStrip } from "@/components/crm/schedule-gap-summary-strip";
import type { CampaignStatus } from "@/lib/crm-types";
import type { DraftCampaignResult } from "@/lib/mobile-draft-campaign";
import type { ScheduleGapBriefing } from "@/lib/schedule-gap-briefing";

const calendarCampaignSchema = z.object({
  id: z.string(),
  dealName: z.string(),
  sellerName: z.string(),
  sellerId: z.string(),
  // CG-3: 같은 그룹 멤버는 CalendarView가 그룹 바 1개로 병합한다.
  groupId: z.string().nullable().optional(),
  roundNumber: z.number().nullable().optional(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.enum([
    "PROPOSAL",
    "PREPARATION",
    "ACTIVE",
    "CLOSED",
    "SETTLEMENT_WAIT",
    "SETTLEMENT_IN_PROGRESS",
    "COMPLETED",
    "DROPPED",
  ]),
  // 자금 마커/상세 팝오버 — API(getCalendarMonthCampaigns)는 이미 반환 중이나
  // 과거 스키마가 선언하지 않아 .parse()가 조용히 걷어냈다(그래서 도트가 안 보임).
  // ⚠️ **같은 함정이 신규 필드에도 그대로 적용된다** — 여기 선언하지 않으면 API 가
  // 보내도 파서가 걷어내고, 화면은 "채널 미상"으로 접혀 자사몰 공급사 지급 마커가
  // 조용히 사라진다. 필드를 늘릴 때 이 스키마를 반드시 함께 늘린다.
  salesChannel: z.string().nullable().optional(),
  expectedDepositDate: z.string().nullable().optional(),
  expectedPayoutDate: z.string().nullable().optional(),
  expectedSupplierPayoutDate: z.string().nullable().optional(),
  // 완료된 칸이 서는 **실제로 오간 날**(`resolveMoneySlotEffectiveDate`). 위 경고가 그대로
  // 걸린다 — 여기 없으면 파서가 걷어내고 완료 건이 예정일에 그대로 남는다.
  depositReceivedAt: z.string().nullable().optional(),
  payoutCompletedAt: z.string().nullable().optional(),
  supplierPayoutCompletedAt: z.string().nullable().optional(),
  // ⚠️ 금액 필드에는 `.optional()` 을 붙이지 않는다 — 금액이 빠지면 화면이 조용히
  // 「미정」이 되는데 크래시가 없어 아무도 모른다(그 상태로 오래 방치된 전례가 이 필드의
  // 이력이다). 파서가 여기서 막아 API 와 화면이 갈리는 것을 즉시 드러낸다.
  // 값을 모르면 `null`.
  settlementSales: z.number().nullable(),
  actualSales: z.number().nullable(),
  sellerExpense: z.number().nullable(),
  actualPayoutAmount: z.number().nullable(),
  // 공급사 지급 칸의 근거(수기 물품대금, T-057). ⚠️ `0` 은 「합산 이관」 마커라
  // **null 로 접지 말 것** — 파서가 둘을 구분해 넘겨야 게이트 문구가 갈린다.
  settlementGoodsCost: z.number().nullable(),
  isDepositReceived: z.boolean().optional(),
  isPayoutCompleted: z.boolean().optional(),
  isSupplierPayoutCompleted: z.boolean().optional(),
});

const calendarResponseSchema = z.object({
  campaigns: z.array(calendarCampaignSchema),
});

function currentMonthStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function todayYmd(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number);
  const d = new Date(year, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return `${year}년 ${m}월`;
}

export function CalendarPageClient({
  briefing,
}: {
  /** 매출 공백 브리핑(서버 스냅샷) — 요약 스트립 + 그리드 틴트. */
  briefing?: ScheduleGapBriefing;
}) {
  const router = useRouter();
  const [month, setMonth] = useState<string>(currentMonthStr);
  const [campaigns, setCampaigns] = useState<CalendarCampaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // 예비 일정 생성 다이얼로그 — 날짜 셀/헤더 어포던스에서 진입, 클릭일 프리필.
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftYmd, setDraftYmd] = useState<string>(todayYmd);

  // 필터(null = 전체). 월 이동에도 유지 — 페이지 소유 state라 loadCampaigns와 독립.
  const [selectedSellerIds, setSelectedSellerIds] = useState<Set<string> | null>(null);
  const [selectedStatuses, setSelectedStatuses] = useState<Set<CampaignStatus> | null>(null);

  const sellersInMonth = useMemo<CalendarSellerOption[]>(() => {
    const map = new Map<string, CalendarSellerOption>();
    for (const c of campaigns) {
      const entry = map.get(c.sellerId) ?? { id: c.sellerId, name: c.sellerName, count: 0 };
      entry.count += 1;
      map.set(c.sellerId, entry);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [campaigns]);

  const filteredCampaigns = useMemo(
    () =>
      campaigns.filter(
        (c) =>
          (!selectedSellerIds || selectedSellerIds.has(c.sellerId)) &&
          (!selectedStatuses || selectedStatuses.has(c.status)),
      ),
    [campaigns, selectedSellerIds, selectedStatuses],
  );

  const hasActiveFilters = selectedSellerIds !== null || selectedStatuses !== null;

  function toggleSeller(id: string) {
    setSelectedSellerIds((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next.size === 0 ? null : next; // 마지막 해제 = "전체" 복귀(0건 필터 아님)
    });
  }

  function toggleStatus(status: CampaignStatus) {
    setSelectedStatuses((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next.size === 0 ? null : next;
    });
  }

  function resetFilters() {
    setSelectedSellerIds(null);
    setSelectedStatuses(null);
  }

  function openDraftDialog(ymd: string) {
    setDraftYmd(ymd);
    setDraftOpen(true);
  }

  function handleDraftCreated(draft: DraftCampaignResult) {
    const draftMonth = draft.startDate.slice(0, 7);
    if (draftMonth !== month) {
      // 다른 달에 만들었으면 그 달로 이동 — effect가 새 캠페인 포함 재로드.
      setMonth(draftMonth);
    } else {
      void loadCampaigns(month);
    }
    // 공백 스트립/틴트는 서버 스냅샷 — 공백을 메우는 행위가 이 기능의 목적이므로
    // 생성 즉시 서버 컴포넌트를 재실행해 브리핑을 갱신한다.
    router.refresh();
  }

  const loadCampaigns = useCallback(async (targetMonth: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/campaigns/calendar?month=${targetMonth}`);
      if (!res.ok) throw new Error(`캘린더 데이터를 불러오지 못했습니다 (${res.status})`);
      const data = calendarResponseSchema.parse(await res.json());
      setCampaigns(data.campaigns);
    } catch (error) {
      console.error("[calendar] 캠페인 로드 실패:", error);
      toast.error(error instanceof Error ? error.message : "캘린더 데이터를 불러오지 못했습니다.");
      setCampaigns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCampaigns(month);
  }, [month, loadCampaigns]);

  async function handleFullSync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/integrations/google-calendar/sync", {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(data.message ?? "구글 캘린더 동기화가 완료되었습니다.");
      } else if (res.status === 401) {
        toast.error(
          data.error ?? "구글 캘린더가 연결되어 있지 않습니다. 설정 > 외부 연동 진단에서 연동하세요.",
        );
      } else {
        toast.error(data.error ?? "동기화에 실패했습니다.");
      }
    } catch (error) {
      console.error("[calendar] 전체 동기화 실패:", error);
      toast.error(error instanceof Error ? error.message : "동기화 요청에 실패했습니다.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-6">
      {/* 헤더 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="rounded-xl border border-blue-100 bg-blue-50 p-2 dark:border-blue-900/20 dark:bg-blue-950/10">
            <CalendarDays className="size-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-50">캠페인 캘린더</h1>
            <p className="text-xs text-muted-foreground">
              캠페인 기간과 입금/지급 예정일을 한눈에 확인하고 구글 캘린더로 동기화합니다.
            </p>
          </div>
        </div>

        <Button
          onClick={handleFullSync}
          disabled={syncing}
          className="h-9 gap-1.5 rounded-lg bg-primary px-3.5 text-xs text-white hover:bg-primary/90"
        >
          {syncing ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <CloudUpload className="size-3.5 shrink-0" />
          )}
          {syncing ? "동기화 중..." : "구글 캘린더 전체 동기화"}
        </Button>
      </div>

      {/* 매출 공백 요약 스트립 (오늘부터 롤링 — 월 이동 무관) */}
      {briefing && (
        <ScheduleGapSummaryStrip briefing={briefing} onJumpToMonth={setMonth} />
      )}

      {/* 월 네비게이션 */}
      <div className="flex items-center justify-between rounded-xl border border-border/60 bg-white/80 px-3 py-2 dark:bg-slate-900/40">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-xs"
          onClick={() => setMonth((prev) => shiftMonth(prev, -1))}
        >
          <ChevronLeft className="size-4" />
          이전
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-slate-800 dark:text-slate-100">
            {formatMonthLabel(month)}
          </span>
          {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          {month !== currentMonthStr() && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setMonth(currentMonthStr())}
            >
              오늘
            </Button>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-xs"
          onClick={() => setMonth((prev) => shiftMonth(prev, 1))}
        >
          다음
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {/* 필터 바 + 예비 일정 생성(키보드 접근 베이스라인 — 셀 hover 어포던스와 병행) */}
      <div className="flex flex-wrap items-center gap-2">
        <CalendarFilterBar
          sellers={sellersInMonth}
          selectedSellerIds={selectedSellerIds}
          onSellerToggle={toggleSeller}
          selectedStatuses={selectedStatuses}
          onStatusToggle={toggleStatus}
          hasActiveFilters={hasActiveFilters}
          onReset={resetFilters}
        />
        <Button
          size="sm"
          className="ml-auto h-8 gap-1.5 rounded-lg bg-primary px-3 text-xs text-white hover:bg-primary/90"
          onClick={() => openDraftDialog(todayYmd())}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          예비 일정 추가
        </Button>
      </div>

      {/* 달력 */}
      <CalendarView
        campaigns={filteredCampaigns}
        month={month}
        gaps={briefing?.gaps}
        onCreateDraft={openDraftDialog}
      />

      {filteredCampaigns.length === 0 &&
        !loading &&
        (campaigns.length > 0 ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border py-4 text-xs text-muted-foreground">
            선택한 필터에 해당하는 캠페인이 없습니다.
            <button
              type="button"
              onClick={resetFilters}
              className="font-medium text-primary hover:underline"
            >
              필터 초기화
            </button>
          </div>
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            이 달에 진행되는 캠페인이 없습니다.
          </p>
        ))}

      {/* 예비 일정 생성 다이얼로그 — 클릭일 프리필 */}
      <DraftCampaignDialog
        open={draftOpen}
        onOpenChange={setDraftOpen}
        initialStartYmd={draftYmd}
        onCreated={handleDraftCreated}
      />
    </div>
  );
}
