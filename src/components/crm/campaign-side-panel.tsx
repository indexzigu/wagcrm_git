"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Activity, Building2, Copy, DollarSign, ExternalLink, FileText, ImageDown, Info, Link2, MessageSquareTextIcon, Pencil, SendHorizonal, Trash2, TrendingUp, UserRound, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  formatCampaignActionDate,
  getCampaignAction,
} from "@/lib/campaign-actions";
import { campaignStatusLabels, salesChannelLabels } from "@/lib/crm-types";
import type { SalesChannel } from "@/lib/crm-types";
import { type ZoneViewMode } from "@/lib/zone-config";
import type { ApiCallLogRow, AssetRow, CampaignRow, StorageSummary } from "@/lib/crm-types";
import { Badge } from "@/components/ui/badge";
import { CampaignLaunchReadinessSection } from "./campaign-launch-readiness-section";
import { CampaignShortLinkCard } from "./campaign-short-link-card";
import { resolveCampaignLinkSurface } from "@/lib/campaign-link-surface";
import { patchCampaign } from "@/lib/campaign-patch";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  resolveProfitTone,
  PROFIT_TONE_TEXT,
  PROFIT_TONE_TEXT_DENSE,
} from "@/lib/profit-tone";
import { toast } from "sonner";
import { AssetManager } from "./asset-manager";
import { ContentOrderTimeline } from "./content-order-timeline";
import { CampaignTaskChecklist, type CampaignTaskChecklistItem } from "./campaign-task-checklist";
import { StatusStepper } from "./status-stepper";
import { CampaignGroupSection } from "./campaign-group-section";
import { DealLinkSection } from "./deal-link-section";
import { SellerLinkSection } from "./seller-link-section";
import { LinkSearchDialog } from "./link-search-dialog";
import { CampaignDealsTable } from "./campaign-deals-table";
import { SettlementSection } from "./settlement-section";
import { HelpPopover } from "./help-popover";
import { TaxInvoiceHelperDialog } from "./tax-invoice-helper-dialog";
import { WithholdingHelperDialog } from "./withholding-helper-dialog";
import { resolveTaxFilingChannelGroup } from "@/lib/tax-filing-board";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import {
  GOODS_COST_CONSOLIDATED_LABEL,
  resolveGoodsCost,
  resolveGoodsCostContribution,
} from "@/lib/goods-cost";
import { resolveBrandSettlementTotal } from "@/lib/settlement-brand-total";
import { fetchGroupDetail } from "@/lib/campaign-group-client";
import type { CampaignGroupMemberRow } from "@/lib/crm-types";
import { isIndividualSeller } from "@/lib/seller-tax-utils";
import {
  SETTLEMENT_COUNTERPARTIES,
  SETTLEMENT_COUNTERPARTY_LABEL,
  SETTLEMENT_INVOICE_MODES,
  SETTLEMENT_INVOICE_MODE_LABEL,
  groupSettlementItemsByZone,
  hasProfitAdjustment,
  normalizeSettlementItemMode,
  resolveAdjustedOperatingProfit,
  resolveSellerFeeBasis,
  resolveSellerZoneTotals,
  resolveSettlementItemSignedAmount,
  sumBrandPaidItems,
  sumInternalItems,
  type SettlementCounterparty,
  type SettlementInvoiceMode,
  type SettlementItemRow,
} from "@/lib/settlement-items";
import { RETURN_PERIOD_DAYS, SETTLEMENT_CHECK_DAYS } from "@/lib/settlement-stage";
import { buildNaverTrackingLink } from "@/lib/tracking";
import { computeNetMarginRate } from "@/lib/margin-calc";
import {
  buildSettlementStatementFileName,
  buildSettlementStatementHtml,
  buildSettlementStatementPrintDoc,
  buildSettlementStatementText,
  renderSettlementStatementPng,
} from "@/lib/settlement-statement";
import type { CampaignStatus } from "@/lib/crm-types";
import type { StageFilter } from "@/hooks/use-stage-filter";

// --- Inline Edit Helpers for CampaignSidePanel ---

const SALES_CHANNEL_OPTIONS: { value: string; label: string }[] = (
  Object.entries(salesChannelLabels) as [SalesChannel, string][]
).map(([value, label]) => ({ value, label }));

const SELLER_TAX_TYPE_LABELS: Record<string, string> = {
  BUSINESS: "사업자 세금계산서",
  INDIVIDUAL: "개인 원천징수",
};

/** Validate that endDate >= startDate */
export function validateEndDateNotBeforeStart(endDate: string, startDate: string): string | null {
  if (!endDate || !startDate) return null;
  if (endDate < startDate) {
    return "마감일은 시작일 이후여야 합니다";
  }
  return null;
}

/** Validate that target sales is within the accepted range: 0 ≤ value ≤ 9,999,999,999 */
export function validateTargetSales(value: number): string | null {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return "목표 매출은 정수여야 합니다";
  }
  if (value < 0 || value > 9_999_999_999) {
    return "목표 매출은 0 이상 9,999,999,999 이하여야 합니다";
  }
  return null;
}

/** Save a campaign field via PATCH API */
async function saveCampaignField(
  campaignId: string,
  field: string,
  value: string | number
): Promise<{ success: boolean; data?: CampaignRow; error?: string }> {
  const result = await patchCampaign<CampaignRow>(campaignId, { [field]: value }, { preferServerError: true });
  if (!result.ok) {
    return { success: false, error: result.error };
  }
  return { success: true, data: result.data };
}

// --- Inline Edit Sub-Components ---



type InlineDateEditProps = {
  value: string; // ISO date string (YYYY-MM-DD)
  field: "startDate" | "endDate";
  campaignId: string;
  /** For endDate validation: the current startDate */
  startDate?: string;
  /** For startDate validation: the current endDate */
  endDate?: string;
  onSaved: (updated: CampaignRow) => void;
};

function InlineDateEdit({ value, field, campaignId, startDate, endDate, onSaved }: InlineDateEditProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [flashError, setFlashError] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayValue = optimistic ?? value;

  // Format for display: YYYY-MM-DD → YYYY.MM.DD
  const displayFormatted = displayValue
    ? displayValue.replace(/-/g, ".")
    : "-";

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const handleSave = useCallback(
    async (newValue: string) => {
      setIsEditing(false);
      if (newValue === displayValue || !newValue) return;

      // Validate end >= start
      if (field === "endDate" && startDate) {
        const err = validateEndDateNotBeforeStart(newValue, startDate);
        if (err) {
          setErrorMsg(err);
          setFlashError(true);
          toast.error(err);
          setTimeout(() => setFlashError(false), 1500);
          return;
        }
      }
      if (field === "startDate" && endDate) {
        const err = validateEndDateNotBeforeStart(endDate, newValue);
        if (err) {
          setErrorMsg("시작일은 마감일 이전이어야 합니다");
          setFlashError(true);
          toast.error("시작일은 마감일 이전이어야 합니다");
          setTimeout(() => setFlashError(false), 1500);
          return;
        }
      }

      setOptimistic(newValue);
      setErrorMsg(null);

      const result = await saveCampaignField(campaignId, field, newValue);
      if (!result.success) {
        setOptimistic(null);
        setFlashError(true);
        setErrorMsg(result.error ?? "저장 실패");
        toast.error(result.error ?? "날짜 저장 실패");
        setTimeout(() => setFlashError(false), 1500);
        return;
      }

      setOptimistic(null);
      // 그룹 캠페인은 일정이 통합 운영되므로 이 저장이 형제 멤버에도 함께 반영된다
      // (`fanOutMemberSchedule`). 되돌릴 수 없는 변경이라 몇 건이 함께 바뀌었는지 고지한다.
      const baseMessage =
        field === "startDate" ? "시작일이 변경되었습니다" : "마감일이 변경되었습니다";
      const syncedCount = result.data?.groupScheduleSyncedCount ?? 0;
      toast.success(
        syncedCount > 0
          ? `${baseMessage} · 같은 그룹 ${syncedCount}건도 함께 반영`
          : baseMessage,
      );
      if (result.data) onSaved(result.data);

      // Recalculate reminders when endDate changes (Requirement 1.1, 1.2, 1.3)
      if (field === "endDate") {
        try {
          await fetch(`/api/campaigns/${campaignId}/reminders/recalculate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
        } catch {
          // Reminder recalculation failure is non-blocking (Requirement 1.4)
          // endDate save already succeeded — user sees success toast
          console.warn("[CampaignSidePanel] Reminder recalculation failed silently");
        }
      }
    },
    [displayValue, field, campaignId, startDate, endDate, onSaved]
  );

  if (isEditing) {
    return (
      <div className="relative">
        <input
          ref={inputRef}
          type="date"
          defaultValue={displayValue}
          onBlur={(e) => handleSave(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setIsEditing(false);
            }
          }}
          className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs shadow-none outline-none focus:border-slate-300 focus:ring-0"
        />
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setErrorMsg(null);
          setIsEditing(true);
        }}
        className={cn(
          "flex w-full items-center gap-1 truncate rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-slate-100",
          flashError && "border border-red-400 bg-red-50 text-red-700"
        )}
      >
        <span>{displayFormatted}</span>
        <Pencil className="ml-auto size-3 text-muted-foreground opacity-0 group-hover/date:opacity-100 transition-opacity" />
      </button>
      {errorMsg && flashError && (
        <span className="absolute -bottom-4 left-2 text-[10px] text-red-500 whitespace-nowrap">
          {errorMsg}
        </span>
      )}
    </div>
  );
}

const GUEST_ACTOR = "guest@wag-crm.internal";
const GUEST_NAME = "게스트";
const PROGRESS_WORKSPACE_STATUSES: CampaignStatus[] = [
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
];

function useDesktop() {
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return isDesktop;
}


type CampaignSidePanelProps = {
  campaign: CampaignRow | null;
  logs: ApiCallLogRow[];
  assets: AssetRow[];
  storage: StorageSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 이 패널과 그 자식의 저장·갱신 통지가 모이는 **단일 창구**.
   * 🪤 **어느 자리가 이걸 부르는지 주석에 열거하지 말 것** — 패널 본문과 자식을 합쳐
   * 호출부가 수십 곳이라 목록은 태어나는 순간 낡는다(`codebase-map.md` 「낡은 주석이
   * 오진의 출발점이 된다」). 실제 호출부는 `onCampaignUpdated(` 로 직접 센다.
   * ⛔ **「실매출 저장 전용」 같은 두 번째 통지 prop 을 다시 만들지 말 것**(T-103) —
   * 종전에 `onActualSalesSaved` 가 정확히 그 모양으로 있었는데 패널이 **한 번도 부르지
   * 않았다.** 타입은 「prop 이 있는가」만 보고 결함은 「부르는가」 쪽에 있어 tsc·eslint 가
   * 전부 초록이었고, 소비처 둘은 살아 있어 보이는 핸들러를 계속 넘기고 있었다.
   */
  onCampaignUpdated: (campaign: CampaignRow) => void;
  /** CG-1: 그룹 섹션에서 형제 멤버로 패널을 스왑(미제공 시 멤버 행은 조회 전용). */
  onNavigateToCampaign?: (campaignId: string) => void;
  onCampaignDuplicated?: (campaign: CampaignRow) => void;
  workspaceFilter?: StageFilter;
  viewMode?: ZoneViewMode;
  onCampaignDeleted?: (campaignId: string) => void;
  title?: string;
  description?: string;
  settlementWorkspace?: boolean;
};

export function CampaignSidePanel({
  campaign,
  logs,
  assets,
  storage,
  open,
  onOpenChange,
  onCampaignUpdated,
  onNavigateToCampaign,
  workspaceFilter,
  viewMode,
  onCampaignDeleted,
  title = "판매 관리 캠페인 상세 페이지",
  description,
  settlementWorkspace = false,
}: CampaignSidePanelProps) {
  const isDesktop = useDesktop();
  const [noteContent, setNoteContent] = useState("");
  const [isSellerSearchOpen, setIsSellerSearchOpen] = useState(false);
  const [isDealSearchOpen, setIsDealSearchOpen] = useState(false);
  const [isSubmittingNote, setIsSubmittingNote] = useState(false);
  const [localNotesState, setLocalNotesState] = useState<{
    campaignId: string | null;
    notes: CampaignRow["notes"];
  }>({
    campaignId: null,
    notes: [],
  });
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const [checklistItems, setChecklistItems] = useState<CampaignTaskChecklistItem[]>([]);
  const [checklistSummary, setChecklistSummary] = useState<{
    checkedCount: number;
    totalCount: number;
    requiredCheckedCount: number;
    requiredTotalCount: number;
    nextItemLabel: string | null;
    isComplete: boolean;
  } | null>(null);
  const [localCampaignStatus, setLocalCampaignStatus] = useState<CampaignStatus | null>(null);
  // CG-1 표면 ⓑ: 날짜 수정 이벤트마다 증가. 그룹 섹션은 이 값이 오를 때만 합류 제안을 재조회.
  const [groupSuggestNonce, setGroupSuggestNonce] = useState(0);

  // 캠페인이 바뀌면(패널 오픈·형제 이동) 제안 nonce를 리셋 — 오픈만으로는 제안하지 않는다.
  useEffect(() => {
    setGroupSuggestNonce(0);
  }, [campaign?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange]);

  useEffect(() => {
    if (!campaign || !open) return;
    let cancelled = false;
    const activeCampaign = campaign;

    async function fetchChecklist() {
      try {
        const response = await fetch(`/api/campaigns/${activeCampaign.id}/checklist`);
        if (response.ok) {
          const data = await response.json();
          if (!cancelled) {
            setLocalCampaignStatus(data.status);
            setChecklistSummary(data.summary ?? null);
            setChecklistItems(data.items ?? []);
          }
        } else {
          if (!cancelled) {
            setLocalCampaignStatus(activeCampaign.status);
            setChecklistSummary(null);
            setChecklistItems([]);
          }
        }
      } catch {
        if (!cancelled) {
          setLocalCampaignStatus(activeCampaign.status);
          setChecklistSummary(null);
          setChecklistItems([]);
        }
      }
    }

    void fetchChecklist();
    return () => {
      cancelled = true;
    };
  }, [campaign, open]);

  if (!campaign) return null;
  const action = getCampaignAction(campaign);
  const providerLogs = (logs ?? [])
    .filter((log) => log.provider === campaign.snsType || log.provider === "NAVER")
    .slice(0, 5);
  const timelineItems = [
    {
      label: "상태 변경",
      value: formatDate(campaign.updatedAt),
      detail: campaignStatusLabels[campaign.status],
    },
    {
      label: "캠페인 시작",
      value: formatCampaignActionDate(campaign.startDate) ?? campaign.startDate,
      detail: campaign.sellerName,
    },
    {
      label: "캠페인 마감",
      value: formatCampaignActionDate(campaign.endDate) ?? campaign.endDate,
      detail: campaign.partnerName,
    },
    ...(action.dueDate
      ? [
          {
            label: action.label,
            value: formatCampaignActionDate(action.dueDate) ?? action.dueDate,
            detail: action.isStagnant
              ? `${action.stagnantDays}d stagnant`
              : action.tone,
          },
        ]
      : []),
  ];
  const notes =
    localNotesState.campaignId === campaign.id ? localNotesState.notes : (campaign.notes ?? []);
  const isProgressWorkspace = workspaceFilter === "PROGRESS";


  const showHistoryInsights = !isProgressWorkspace;
  const panelDescription = isProgressWorkspace
    ? "현재 단계 작업, 매출 입력, 링크와 운영 메모를 관리합니다."
    : description ?? "수수료, 링크, 팔로워 지표와 API 로그를 확인합니다.";

  async function refreshCampaignSnapshot(campaignId: string) {
    const response = await fetch(`/api/campaigns/${campaignId}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Campaign refresh failed");
    }
    return (await response.json()) as CampaignRow;
  }

  async function refreshChecklistSnapshot(campaignId: string) {
    const response = await fetch(`/api/campaigns/${campaignId}/checklist`);
    if (!response.ok) {
      throw new Error("Checklist refresh failed");
    }
    return await response.json();
  }

  async function submitNote() {
    if (!campaign || !noteContent.trim() || isSubmittingNote) return;
    setIsSubmittingNote(true);
    const response = await fetch(`/api/campaigns/${campaign.id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: noteContent.trim(),
        actor: GUEST_ACTOR,
        actorName: GUEST_NAME,
      }),
    });
    if (response.ok) {
      const newNote = await response.json();
      setLocalNotesState((prev) => ({
        campaignId: campaign.id,
        notes:
          prev.campaignId === campaign.id
            ? [newNote, ...prev.notes]
            : [newNote, ...(campaign.notes ?? [])],
      }));
      setNoteContent("");
    }
    setIsSubmittingNote(false);
  }

  async function deleteNote(noteId: string) {
    if (!campaign) return;
    const response = await fetch(
      `/api/campaigns/${campaign.id}/notes?noteId=${noteId}`,
      { method: "DELETE" },
    );
    if (response.ok) {
      setLocalNotesState((prev) => ({
        campaignId: campaign.id,
        notes:
          prev.campaignId === campaign.id
            ? prev.notes.filter((n) => n.id !== noteId)
            : (campaign.notes ?? []).filter((n) => n.id !== noteId),
      }));
    }
  }

  async function handleDropCampaign() {
    if (!campaign || campaign.status === "DROPPED") return;
    const reason = window.prompt("드랍 사유를 입력해주세요.");
    if (!reason?.trim()) return;

    const result = await patchCampaign<CampaignRow>(
      campaign.id,
      { status: "DROPPED", dropReason: reason.trim() },
      { fallbackError: "드랍 처리에 실패했습니다", networkError: "드랍 처리에 실패했습니다" },
    );

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    toast.success("캠페인을 드랍 처리했습니다");
    onCampaignUpdated(result.data);
  }

  async function handleDeleteCampaign() {
    if (!campaign) return;
    if (!window.confirm("정말로 이 캠페인을 삭제하시겠습니까?")) return;
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}`, {
        method: "DELETE",
      });
      if (response.ok) {
        toast.success("캠페인이 삭제되었습니다");
        onOpenChange(false);
        if (onCampaignDeleted) {
          onCampaignDeleted(campaign.id);
        }
      } else {
        toast.error("캠페인 삭제에 실패했습니다");
      }
    } catch {
      toast.error("네트워크 오류로 삭제에 실패했습니다");
    }
  }

  async function handleStartSettlement() {
    if (!campaign || campaign.status !== "SETTLEMENT_WAIT") return;
    const result = await patchCampaign<CampaignRow>(
      campaign.id,
      { status: "SETTLEMENT_IN_PROGRESS" },
      { fallbackError: "정산 진행 전환에 실패했습니다", networkError: "정산 진행 전환에 실패했습니다" },
    );

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    toast.success("정산 관리로 이관했습니다");
    onCampaignUpdated(result.data);
  }





  async function handleChecklistToggle(itemId: string, checked: boolean) {
    const response = await fetch(`/api/campaign-checklist/items/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isChecked: checked }),
    });

    if (!response.ok) {
      throw new Error("Toggle failed");
    }

    const data = await response.json();
    const checklistSnapshot = await refreshChecklistSnapshot(campaign!.id);
    setLocalCampaignStatus(checklistSnapshot.status);
    setChecklistSummary(checklistSnapshot.summary ?? null);
    setChecklistItems(checklistSnapshot.items ?? []);

    if (data.campaignStatus && data.campaignStatus !== campaign!.status) {
      try {
        const refreshed = await refreshCampaignSnapshot(campaign!.id);
        onCampaignUpdated(refreshed);
      } catch {
        onCampaignUpdated({ ...campaign!, status: data.campaignStatus });
      }
    }
  }

  async function handleChecklistAddItem(label: string) {
    const response = await fetch(`/api/campaigns/${campaign!.id}/checklist/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label,
        status: localCampaignStatus ?? campaign!.status,
        isRequired: false,
      }),
    });

    if (!response.ok) {
      throw new Error("Add item failed");
    }

    const checklistSnapshot = await refreshChecklistSnapshot(campaign!.id);
    setLocalCampaignStatus(checklistSnapshot.status);
    setChecklistSummary(checklistSnapshot.summary ?? null);
    setChecklistItems(checklistSnapshot.items ?? []);
  }

  const body = (
    /* Radix ScrollArea 대신 네이티브 스크롤 — Radix 는 네이티브 스크롤바를 숨겨
       비오버레이 스크롤바(Windows) 환경에서 "잘렸는데 스크롤바 없는" 상태가 된다
       (PR #57 근본원인). 상세 Sheet 는 side=right 라 h-full(확정 높이)이므로 이
       h-full 스크롤러가 정상 해소된다(seller-detail-content 의 검증된 패턴). */
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="space-y-6 overflow-hidden p-1 pr-3">

        {/* [캠페인정보] 캠페인명, 차수(배지) + 연결된 딜/셀러 통합 카드 */}
        <div className="space-y-4 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
          <div className="flex items-center justify-between gap-4 min-w-0">
            <h3 className="flex items-center text-sm font-semibold text-foreground shrink-0">
              <Info className="mr-2 size-4 text-muted-foreground" />
              캠페인 정보
            </h3>

          </div>

          <div className="grid grid-cols-2 gap-4 border-t border-border/50 pt-4">
              <div className="rounded-xl border border-slate-100 bg-white p-3">
                <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-slate-500">
                  <Info className="size-3" />
                  캠페인명
                </div>
                <div className="flex min-h-10 items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-3 text-xs font-semibold text-slate-800">
                  <span className="truncate">
                    {[campaign.dealName, campaign.sellerName].filter(Boolean).join(" - ") || campaign.campaignName || "이름 없음"}
                  </span>
                  {/* 회차는 범주다(P8 색 원칙 4) — 3차가 1차보다 급하거나 좋을 일이 없다.
                      자매 표면인 `campaign-card.tsx` 의 회차 배지가 이미 이 무채색 형태이고
                      컴포넌트도 `Badge` 다 — 같은 걸 두 방식으로 그리던 걸 여기서 수렴한다. */}
                  {campaign.roundNumber ? (
                    <Badge
                      variant="secondary"
                      // `border-0`(폭)이지 `border-none`(스타일)이 아닌 이유: tailwind-merge 는
                      // 둘을 다른 그룹으로 봐서 border-none 은 Badge 베이스의 `border` 를 대체하지
                      // 못하고 죽은 클래스만 남긴다(실측). 시각 결과는 같지만 border-0 이 정확하다.
                      className="h-4 shrink-0 rounded border-0 bg-slate-100 px-1 text-[8px] leading-none font-semibold text-slate-600 select-none"
                    >
                      {campaign.roundNumber}차
                    </Badge>
                  ) : null}
                </div>
              </div>
              <div className="rounded-xl border border-slate-100 bg-white p-3">
                <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-slate-500">
                  <Link2 className="size-3" />
                  판매 채널
                </div>
                <div className="flex min-h-10 items-center rounded-lg border border-slate-100 bg-slate-50/60 px-1">
                  <Select
                    value={campaign.salesChannel}
                    onValueChange={async (value) => {
                      const result = await saveCampaignField(campaign.id, "salesChannel", value);
                      if (!result.success) {
                        throw new Error(result.error ?? "저장 실패");
                      }
                      if (result.data) onCampaignUpdated(result.data);
                    }}
                  >
                    <SelectTrigger className="h-8 w-full border-transparent bg-transparent px-2 text-xs font-semibold text-slate-800 shadow-none focus:ring-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {SALES_CHANNEL_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          

          {/* 연결된 딜, 연결된 셀러 (1행 2열 배치) */}
          <div className="grid grid-cols-2 gap-4">
            <DealLinkSection
              dealId={campaign.dealId}
              dealName={campaign.dealName}
              brandName={campaign.deal?.brandName ?? null}
              dealStatus={campaign.deal?.status ?? null}
              onLinkDeal={() => setIsDealSearchOpen(true)}
            />
            <SellerLinkSection
              sellerId={campaign.sellerId}
              sellerName={campaign.sellerName}
              snsType={campaign.snsType}
              snsHandle={campaign.snsHandle}
              currentFollowers={campaign.currentFollowers ?? null}
              fitLevel={campaign.fitLevel}
              onLinkSeller={() => setIsSellerSearchOpen(true)}
            />
          </div>

          {/* Removed commission basis and seller tax type */}
        

          {/* 캠페인 일정 (가로 배치) */}
          <div className="border-t border-border/50 pt-4 mt-4">
            <div className="space-y-2 rounded-2xl border border-border/70 bg-white/90 p-4">
              <div className="text-xs font-semibold text-foreground">캠페인 일정</div>
              <div className="grid grid-cols-2 gap-4">
                <div className="group/date flex items-center justify-between gap-2 rounded-md bg-white border border-slate-100 hover:bg-accent/30 px-3 py-1.5 shadow-soft-sm">
                  <span className="text-xs font-medium text-slate-600 shrink-0">시작일</span>
                  <div className="w-28 shrink-0">
                    <InlineDateEdit
                      value={campaign.startDate}
                      field="startDate"
                      campaignId={campaign.id}
                      endDate={campaign.endDate}
                      onSaved={(updated) => {
                        onCampaignUpdated(updated);
                        setGroupSuggestNonce((n) => n + 1);
                      }}
                    />
                  </div>
                </div>
                <div className="group/date flex items-center justify-between gap-2 rounded-md bg-white border border-slate-100 hover:bg-accent/30 px-3 py-1.5 shadow-soft-sm">
                  <span className="text-xs font-medium text-slate-600 shrink-0">마감일</span>
                  <div className="w-28 shrink-0">
                    <InlineDateEdit
                      value={campaign.endDate}
                      field="endDate"
                      campaignId={campaign.id}
                      startDate={campaign.startDate}
                      onSaved={(updated) => {
                        onCampaignUpdated(updated);
                        setGroupSuggestNonce((n) => n + 1);
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
</div>

        {/* [그룹] CG-1 표면 ⓒ — 캠페인 정보 직후·진행 단계 앞(정체성/구조 정보) */}
        {/* key 접두사 필수 — 아래 CampaignLaunchReadinessSection 과 같은 부모의 형제라
            맨 campaign.id 를 쓰면 키가 중복돼 React 가 "두 자식이 같은 키" 경고를 낸다
            (자식이 중복·누락될 수 있는 미지원 상태다). 캠페인 전환 시 리마운트라는
            원래 의도는 접두사를 붙여도 그대로다. */}
        <CampaignGroupSection
          key={`group-${campaign.id}`}
          campaign={campaign}
          onNavigateToCampaign={onNavigateToCampaign}
          onGroupMembershipChanged={onCampaignUpdated}
          suggestNonce={groupSuggestNonce}
        />

        {/* [오픈 준비] 표현·오퍼·세팅 판정 집계(C2 M4b). 진행 단계 바로 위 —
            "지금 열어도 되나"는 단계를 넘기기 전에 보는 정보다.
            정산 워크스페이스에서는 이미 끝난 캠페인이라 의미가 없어 접는다. */}
        {!settlementWorkspace && (
          <CampaignLaunchReadinessSection key={`readiness-${campaign.id}`} campaignId={campaign.id} />
        )}

        {/* [진행단계] 프로세스 */}
        <div className="space-y-3 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
          <div className="flex items-center gap-2">
            <h3 className="flex items-center text-sm font-semibold text-foreground">
              <Activity className="mr-2 size-4 text-muted-foreground" />
              진행 단계
            </h3>
          </div>
          <StatusStepper
            currentStatus={campaign.status}
            campaignId={campaign.id}
            onStatusChanged={onCampaignUpdated}
            viewMode={viewMode}
            showDropButton={isProgressWorkspace && PROGRESS_WORKSPACE_STATUSES.includes(campaign.status) || campaign.status === "DROPPED"}
            onDrop={isProgressWorkspace ? () => void handleDropCampaign() : undefined}
          />

          {action.isStagnant && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 mt-2">
              <div className="text-xs font-semibold text-amber-950">진행 지연 경고</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                이 캠페인은 현재 상태에서 {action.stagnantDays}일 이상 변동이 없습니다.
              </p>
            </div>
          )}

          {isProgressWorkspace && campaign.status === "SETTLEMENT_WAIT" && (
            <SettlementWaitPanel
              campaign={campaign}
              onStartSettlement={handleStartSettlement}
            />
          )}

        </div>

        {settlementWorkspace ? (
          <>
            <CampaignDealsTable
              campaign={campaign}
              onCampaignUpdated={onCampaignUpdated}
            />
            <SettlementFinancialSummary campaign={campaign} onCampaignUpdated={onCampaignUpdated} />
            <SettlementInfo campaign={campaign} onCampaignUpdated={onCampaignUpdated} />
            <SettlementSection
              campaign={campaign}
              onCampaignUpdated={onCampaignUpdated}
            />
          </>
        ) : null}

        
        {!settlementWorkspace && (
          <>
            <CampaignDealsTable
              campaign={campaign}
              onCampaignUpdated={onCampaignUpdated}
            />

            {/* 배송비 설정 (카드 스타일) */}
            <div className="rounded-xl border border-slate-200 bg-white shadow-soft-sm mt-4 p-4">
              <div className="mb-3 text-sm font-semibold text-foreground">배송비 설정</div>
              <div className="grid min-h-9 grid-cols-2 gap-3">
                <label className="grid h-10 min-w-0 grid-cols-[minmax(0,1fr)_80px] items-center gap-2 rounded-lg bg-slate-50 border border-slate-100 px-3 py-1 shadow-soft-sm">
                  <div className="min-w-0 truncate text-[11px] font-medium text-slate-500">배송비 (원)</div>
                  <input
                    type="number"
                    defaultValue={campaign.shippingFee ?? 0}
                    onBlur={async (e) => {
                      const newFee = Number(e.target.value);
                      if (newFee === (campaign.shippingFee ?? 0)) return;
                      const result = await patchCampaign<CampaignRow>(
                        campaign.id,
                        { shippingFee: newFee },
                        { fallbackError: "배송비 저장에 실패했습니다", networkError: "배송비 저장에 실패했습니다" },
                      );
                      if (!result.ok) {
                        toast.error(result.error);
                        return;
                      }
                      onCampaignUpdated(result.data);
                    }}
                    className="h-7 w-20 justify-self-end rounded-md border border-slate-200 bg-white px-2 text-right text-xs font-semibold tabular-nums text-slate-700 outline-none focus:border-primary focus:ring-1 focus:ring-focus-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </label>

                <label className="grid h-10 min-w-0 grid-cols-[minmax(0,1fr)_80px] items-center gap-2 rounded-lg bg-slate-50 border border-slate-100 px-3 py-1 shadow-soft-sm">
                  <div className="min-w-0 truncate text-[11px] font-medium text-slate-500">무료배송 조건 (원)</div>
                  <input
                    type="number"
                    defaultValue={campaign.freeShippingThreshold ?? 0}
                    onBlur={async (e) => {
                      const newThreshold = Number(e.target.value);
                      if (newThreshold === (campaign.freeShippingThreshold ?? 0)) return;
                      const result = await patchCampaign<CampaignRow>(
                        campaign.id,
                        { freeShippingThreshold: newThreshold },
                        {
                          fallbackError: "무료배송 조건 저장에 실패했습니다",
                          networkError: "무료배송 조건 저장에 실패했습니다",
                        },
                      );
                      if (!result.ok) {
                        toast.error(result.error);
                        return;
                      }
                      onCampaignUpdated(result.data);
                    }}
                    className="h-7 w-20 justify-self-end rounded-md border border-slate-200 bg-white px-2 text-right text-xs font-semibold tabular-nums text-slate-700 outline-none focus:border-primary focus:ring-1 focus:ring-focus-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </label>
              </div>
            </div>

            {/* 정산 수수료율 설정 (카드 스타일) */}
            <div className="rounded-xl border border-slate-200 bg-white shadow-soft-sm mt-4 p-4">
              <div className="mb-3 text-sm font-semibold text-foreground">정산 및 수수료 설정</div>
              <div className="grid min-h-9 grid-cols-3 gap-3">
                <label className="grid h-10 min-w-0 grid-cols-[minmax(0,1fr)_72px] items-center gap-2 rounded-lg bg-slate-50 border border-slate-100 px-3 py-1 shadow-soft-sm">
                  <div className="min-w-0 truncate text-[11px] font-medium text-slate-500">총 수수료율 (%)</div>
                  <input
                    type="number"
                    defaultValue={campaign.totalMarginRate ?? 0}
                    onBlur={async (e) => {
                      const newTotal = Number(e.target.value);
                      if (newTotal === (campaign.totalMarginRate ?? 0)) return;
                      const newNet = computeNetMarginRate(newTotal, campaign.sellerMarginRate ?? 0);
                      const result = await patchCampaign<CampaignRow>(
                        campaign.id,
                        { totalMarginRate: newTotal, netMarginRate: newNet },
                        {
                          fallbackError: "총 수수료율 저장에 실패했습니다",
                          networkError: "총 수수료율 저장에 실패했습니다",
                        },
                      );
                      if (!result.ok) {
                        toast.error(result.error);
                        return;
                      }
                      onCampaignUpdated(result.data);
                    }}
                    className="h-7 w-16 justify-self-end rounded-md border border-slate-200 bg-white px-2 text-right text-xs font-semibold tabular-nums text-slate-700 outline-none focus:border-primary focus:ring-1 focus:ring-focus-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </label>

                <label className="grid h-10 min-w-0 grid-cols-[minmax(0,1fr)_72px] items-center gap-2 rounded-lg bg-slate-50 border border-slate-100 px-3 py-1 shadow-soft-sm">
                  <div className="min-w-0 truncate text-[11px] font-medium text-slate-500">셀러 수수료율 (%)</div>
                  <input
                    type="number"
                    defaultValue={campaign.sellerMarginRate ?? 0}
                    onBlur={async (e) => {
                      const newSeller = Number(e.target.value);
                      if (newSeller === (campaign.sellerMarginRate ?? 0)) return;
                      const newNet = computeNetMarginRate(campaign.totalMarginRate ?? 0, newSeller);
                      const result = await patchCampaign<CampaignRow>(
                        campaign.id,
                        { sellerMarginRate: newSeller, netMarginRate: newNet },
                        {
                          fallbackError: "셀러 수수료율 저장에 실패했습니다",
                          networkError: "셀러 수수료율 저장에 실패했습니다",
                        },
                      );
                      if (!result.ok) {
                        toast.error(result.error);
                        return;
                      }
                      onCampaignUpdated(result.data);
                    }}
                    className="h-7 w-16 justify-self-end rounded-md border border-slate-200 bg-white px-2 text-right text-xs font-semibold tabular-nums text-slate-700 outline-none focus:border-primary focus:ring-1 focus:ring-focus-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </label>

                <div className="grid h-10 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg bg-slate-50 border border-slate-100 px-3 py-1 shadow-soft-sm">
                  <div className="min-w-0 truncate text-[11px] font-medium text-slate-500">영업이익율 (%)</div>
                  <div className="justify-self-end text-right text-sm font-bold text-primary">
                    {campaign.netMarginRate ?? 0}%
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* [체크리스트] */}
        <CampaignTaskChecklist
          items={checklistItems}
          summary={checklistSummary}
          onToggle={handleChecklistToggle}
          onAddItem={handleChecklistAddItem}
          campaignStatus={localCampaignStatus ?? campaign.status}
        />

        {!settlementWorkspace && (
          <>

            {/* [자료관리] (제안 3 수용: 체크리스트 아래로 상향 재배치) */}
            <div className="rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
              <AssetManager
                key={campaign.id}
                campaign={campaign}
                initialAssets={assets}
                storage={storage}
                onCampaignUpdated={onCampaignUpdated}
              />
            </div>

            {/* [콘텐츠×주문 타임라인] — 발행 시점과 주문 반응을 함께 본다(오너 2026-07-25) */}
            <section className="space-y-4 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
              <ContentOrderTimeline key={campaign.id} campaignId={campaign.id} />
            </section>

            {/* [셀러 배포용 링크] — 판매채널에 따라 단축링크 / nt_* 중 하나를 편다 */}
            {/* key 필수 — 없으면 A 에서 펼친 대체 표면이 B 로 넘어가 "한 화면에 하나만"
                이 깨진다(형제 AssetManager·ContentOrderTimeline 과 같은 이유). */}
            <CampaignLinkSection
              key={campaign.id}
              campaign={campaign}
              onCampaignUpdated={onCampaignUpdated}
            />
          </>
        )}

        {/* 영업활동/정산 회계 노트 */}
        <div className="space-y-3 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
          <div className="flex items-center gap-2">
            <h3 className="flex items-center text-sm font-semibold text-foreground">
              <MessageSquareTextIcon className="mr-2 size-4 text-muted-foreground" />
              {settlementWorkspace ? "정산 회계 노트" : "영업 활동 타임라인"}
            </h3>
            <span className="text-[11px] text-muted-foreground">{notes.length}개</span>
          </div>

          {notes.length > 0 ? (
            <div className="space-y-3">
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="group relative rounded-[20px] border border-border/70 bg-background px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div
                        className="flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                        style={{
                          backgroundColor: note.actor.includes("@")
                            ? `hsl(${Math.abs(note.actor.split("").reduce((h, c) => h * 31 + c.charCodeAt(0), 0)) % 360}, 60%, 50%)`
                            : "#6366f1",
                        }}
                      >
                        {(note.actorName ?? note.actor).charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="text-xs font-medium text-foreground">
                          {note.actorName ?? note.actor}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {formatDate(note.createdAt)}
                        </div>
                      </div>
                    </div>
                    <button
                      className="ml-1 flex size-7 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                      onClick={() => deleteNote(note.id)}
                      title="노트 삭제"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-[13px] leading-6 text-foreground">
                    {note.content}
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          <div className="rounded-[20px] border border-border/70 bg-background p-3">
            <Textarea
              ref={noteInputRef}
              placeholder={
                settlementWorkspace
                  ? "정산 관련 노트를 입력하세요... (Shift+Enter로 줄바꿈)"
                  : "노트를 입력하세요... (Shift+Enter로 줄바꿈)"
              }
              value={noteContent}
              onChange={(e) => setNoteContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitNote();
                }
              }}
              className="min-h-[120px] resize-none border-0 bg-transparent px-0 py-0 text-[13px] shadow-none focus-visible:ring-0"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">
                {settlementWorkspace
                  ? "정산 변동 내역과 메모를 기록합니다."
                  : "다음 액션과 담당자 메모를 기록합니다."}
              </span>
              <Button
                size="sm"
                disabled={!noteContent.trim() || isSubmittingNote}
                onClick={() => void submitNote()}
                className="rounded-2xl"
              >
                <SendHorizonal data-icon="inline-start" />
                추가
              </Button>
            </div>
          </div>
        </div>

        {/* 연동 로그 */}
        {!settlementWorkspace ? (
        <div className="rounded-[24px] border border-border/70 bg-white/90 px-4 py-2 shadow-soft-sm">
          <Accordion type="single" collapsible defaultValue="timeline">
            <AccordionItem value="timeline">
              <AccordionTrigger>타임라인</AccordionTrigger>
              <AccordionContent className="flex flex-col gap-1.5">
                {timelineItems.map((item, index) => (
                  <HistoryRow
                    key={`${item.label}-${item.value}`}
                    label={item.label}
                    value={item.value}
                    detail={item.detail}
                    highlight={index === 0}
                  />
                ))}
              </AccordionContent>
            </AccordionItem>
            {showHistoryInsights ? (
              <AccordionItem value="logs">
                <AccordionTrigger>연동 로그</AccordionTrigger>
                <AccordionContent className="flex flex-col gap-1.5">
                  {providerLogs.length > 0 ? (
                    providerLogs.map((log) => (
                      <div key={log.id} className="rounded-lg border p-3 text-xs">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium">{log.provider}</span>
                          <span
                            className={
                              log.success ? "text-foreground" : "font-bold text-destructive"
                            }
                          >
                            {log.statusCode}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-muted-foreground">
                          {log.permissionScope ?? "internal"} · {log.endpoint}
                        </p>
                        <p className="mt-1 text-muted-foreground">
                          {formatDate(log.calledAt)}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      이 캠페인에 매칭되는 연동 로그가 없습니다.
                    </p>
                  )}
                </AccordionContent>
              </AccordionItem>
            ) : null}
          </Accordion>
        </div>
        ) : null}

        {/* [캠페인 삭제] 버튼 (본문 맨 하단 배치) */}
        <div className="pt-4 border-t border-slate-100 flex justify-center">
          <Button
            variant="destructive"
            size="sm"
            className="w-full max-w-xs gap-1.5 rounded-xl h-9"
            onClick={() => void handleDeleteCampaign()}
          >
            <Trash2 className="size-4" />
            캠페인 삭제
          </Button>
        </div>

      </div>
    </div>
  );


  if (isDesktop) {
    return (
      <>
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent
            showCloseButton={false}
            style={{ width: "min(720px, 96vw)", maxWidth: "min(720px, 96vw)" }}
            className="flex flex-col overflow-hidden border-l border-border/70 bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0"
          >
            <SheetHeader className="shrink-0 border-b border-border/70 px-6 py-5">
              <div className="flex items-start justify-between gap-4">
              <div>
                <SheetTitle>{title}</SheetTitle>
                <SheetDescription>
                  {panelDescription}
                </SheetDescription>
              </div>
              </div>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-hidden px-6 py-5">
              {body}
            </div>
          </SheetContent>
        </Sheet>
        <LinkSearchDialog
          open={isDealSearchOpen}
          onOpenChange={setIsDealSearchOpen}
          entityType="deal"
          searchEndpoint="/api/search/deals"
          onSelect={async (item) => {
            const result = await saveCampaignField(campaign.id, "dealId", item.id);
            if (!result.success) {
              toast.error(result.error ?? "딜 변경 실패");
            } else {
              toast.success("딜이 변경되었습니다");
              if (result.data) onCampaignUpdated(result.data);
            }
          }}
          title="딜 검색"
        />
        <LinkSearchDialog
          open={isSellerSearchOpen}
          onOpenChange={setIsSellerSearchOpen}
          entityType="seller"
          searchEndpoint="/api/search/sellers"
          onSelect={async (item) => {
            const result = await saveCampaignField(campaign.id, "sellerId", item.id);
            if (!result.success) {
              toast.error(result.error ?? "셀러 변경 실패");
            } else {
              toast.success("셀러가 변경되었습니다");
              if (result.data) onCampaignUpdated(result.data);
            }
          }}
          title="셀러 검색"
        />
      </>
    );
  }

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[88vh] px-5 pb-5 duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]">
          <DrawerHeader className="flex-row items-center justify-between px-0">
            <div>
              <DrawerTitle>{title}</DrawerTitle>
              <DrawerDescription>
                {panelDescription}
              </DrawerDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                onClick={() => void handleDeleteCampaign()}
                title="캠페인 삭제"
              >
                <Trash2 className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
                <X />
              </Button>
            </div>
          </DrawerHeader>
          {body}
        </DrawerContent>
      </Drawer>
      <LinkSearchDialog
        open={isDealSearchOpen}
        onOpenChange={setIsDealSearchOpen}
        entityType="deal"
        searchEndpoint="/api/search/deals"
        onSelect={async (item) => {
          const result = await saveCampaignField(campaign.id, "dealId", item.id);
          if (!result.success) {
            toast.error(result.error ?? "딜 변경 실패");
          } else {
            toast.success("딜이 변경되었습니다");
            if (result.data) onCampaignUpdated(result.data);
          }
        }}
        title="딜 검색"
      />
      <LinkSearchDialog
        open={isSellerSearchOpen}
        onOpenChange={setIsSellerSearchOpen}
        entityType="seller"
        searchEndpoint="/api/search/sellers"
        onSelect={async (item) => {
          const result = await saveCampaignField(campaign.id, "sellerId", item.id);
          if (!result.success) {
            toast.error(result.error ?? "셀러 변경 실패");
          } else {
            toast.success("셀러가 변경되었습니다");
            if (result.data) onCampaignUpdated(result.data);
          }
        }}
        title="셀러 검색"
      />
    </>
  );
}

function formatSettlementMoney(value: number | null | undefined) {
  if (value == null) return "-";
  return `${Math.round(Number(value)).toLocaleString()}원`;
}

function formatSettlementExpense(value: number | null | undefined) {
  if (value == null) return "-";
  const amount = Math.round(Number(value));
  return amount > 0 ? `-${amount.toLocaleString()}원` : `${Math.abs(amount).toLocaleString()}원`;
}

// 이 파일에 있던 `buildSettlementStatementText` 는 제거했다 — 클립보드 text/plain 에
// `■ 재무 정산 상세(영업이익·순이익)` + `■ 정산 수수료율(자사 순수수료율)` 을 실어
// **셀러에게 보내는 메일에 자사 마진을 태우고 있었다**(P0 Seller-Facing Data Exposure).
// HTML 은 정산 목록과 같은 셀러용 명세서였는데 평문만 내부 서식이라 눈에 안 띄었고,
// 오너가 "목록은 정상인데 상세만 다르게 작동"으로 발견했다.
// 이제 두 표면 모두 `@/lib/settlement-statement` 의 `buildSettlementStatementText` 를
// 공유한다 — 갈라지면 또 새는 쪽이 생긴다.

// 이 자리에 있던 `escapeSvgText` · `buildSettlementSummarySvg` · `renderSettlementSummaryPng` 은
// 제거했다 — 명세서를 SVG 로 **손수 다시 그리던** 코드이고, 그 SVG 는 내부 문서였다
// (영업 수익·영업이익 ×2·제세공과금·운영비 + 하단에 `총 수수료율 · 셀러 수수료율 · 영업이익율`).
// 오너 확정(2026-07-16): 이미지도 **셀러에게 보낸다** → P0 Seller-Facing Data Exposure 였다.
//
// 더 깊은 문제는 그게 명세서의 **세 번째 표현**(html·text·svg)이었다는 것이다. 표현이
// 갈라지면 하나만 내부용으로 남는다 — 이 파일이 겪은 사고가 정확히 그것이다.
// 이제 `@/lib/settlement-statement` 의 `renderSettlementStatementPng` 이 **정본 HTML 을
// 오프스크린에 렌더해 찍는다**(정산 목록이 이미 쓰던 옳은 패턴). 이메일·PDF·이미지가
// 자동으로 같은 문서가 된다.

function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

type SettlementFinancialPatch = {
  settlementSupplyCost?: number | null;
  settlementGoodsCost?: number | null;
  settlementSales?: number | null;
  sellerExpense?: number | null;
  operatingExpense?: number | null;
  taxExpense?: number | null;
  miscExpense?: number | null;
  totalMarginRate?: number;
  sellerMarginRate?: number;
  netMarginRate?: number;
  isManualSettlementSales?: boolean;
  isManualSellerExpense?: boolean;
  isManualTaxExpense?: boolean;
  settlementItems?: Array<{
    invoiceMode: SettlementInvoiceMode;
    counterparty: SettlementCounterparty;
    amount: number;
    note: string | null;
  }>;
};

/** 편집 중인 부가 항목 1행 — 금액은 입력 도중 상태를 보존해야 해서 문자열로 든다. */
type SettlementItemDraft = {
  /** 리액트 key 전용 로컬 id. 저장은 전체 교체라 서버로 보내지 않는다. */
  key: string;
  invoiceMode: SettlementInvoiceMode;
  counterparty: SettlementCounterparty;
  note: string;
  amount: string;
};

let settlementItemDraftSeq = 0;
function nextSettlementItemKey() {
  settlementItemDraftSeq += 1;
  return `draft-${settlementItemDraftSeq}`;
}

function toSettlementItemDrafts(items: SettlementItemRow[] | undefined): SettlementItemDraft[] {
  return (items ?? []).map((item) => ({
    key: item.id,
    invoiceMode: item.invoiceMode,
    counterparty: item.counterparty,
    note: item.note ?? "",
    amount: String(item.amount),
  }));
}

/**
 * 부가 항목 편집 행 — **1행 컴팩트**(오너 확정 7·8·10차).
 *
 * 컨트롤 자체의 padding·height 를 좁혀 밀도를 높이고 **컨트롤 사이 gap 은 유지**한다
 * (오너 10차: "블록 간 간격은 유지하되 블록의 크기를 줄여달라"). 부호 인디케이터·
 * 미리보기 줄은 두지 않는다 — 조건부로 나타났다 사라지는 요소가 레이아웃을 흔든다.
 */
function SettlementItemEditRow({
  item,
  onChange,
  onRemove,
}: {
  item: SettlementItemDraft;
  onChange: (next: SettlementItemDraft) => void;
  onRemove: () => void;
}) {
  // 대상=자사면 계산서 방식이 NO_INVOICE 로 고정된다 — 상대 없는 계산서는 성립하지
  // 않는다. 오류로 잡는 대신 **만들 수 없게** 한다(오너 8차): 자동 전환 + 비활성.
  const modeLocked = item.counterparty === "INTERNAL";

  return (
    <div className="flex items-center gap-1.5 px-2 py-1">
      <select
        aria-label="계산서 방식"
        value={item.invoiceMode}
        disabled={modeLocked}
        onChange={(event) =>
          onChange({ ...item, invoiceMode: event.target.value as SettlementInvoiceMode })
        }
        className="h-6 w-[74px] shrink-0 rounded-md border border-slate-200 bg-white px-1 text-[11px] text-slate-700 outline-none focus:border-primary focus:ring-1 focus:ring-focus-ring disabled:bg-slate-50 disabled:text-slate-400"
      >
        {SETTLEMENT_INVOICE_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {SETTLEMENT_INVOICE_MODE_LABEL[mode]}
          </option>
        ))}
      </select>
      <select
        aria-label="정산 대상"
        value={item.counterparty}
        onChange={(event) => {
          const counterparty = event.target.value as SettlementCounterparty;
          onChange({
            ...item,
            counterparty,
            invoiceMode: normalizeSettlementItemMode(counterparty, item.invoiceMode),
          });
        }}
        className="h-6 w-[62px] shrink-0 rounded-md border border-slate-200 bg-white px-1 text-[11px] text-slate-700 outline-none focus:border-primary focus:ring-1 focus:ring-focus-ring"
      >
        {SETTLEMENT_COUNTERPARTIES.map((counterparty) => (
          <option key={counterparty} value={counterparty}>
            {SETTLEMENT_COUNTERPARTY_LABEL[counterparty]}
          </option>
        ))}
      </select>
      <input
        aria-label="비고"
        value={item.note}
        placeholder="비고"
        onChange={(event) => onChange({ ...item, note: event.target.value })}
        className="h-6 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1.5 text-[11px] text-slate-800 outline-none focus:border-primary focus:ring-1 focus:ring-focus-ring"
      />
      <input
        aria-label="금액(VAT 포함)"
        title="VAT 포함 금액"
        placeholder="VAT포함"
        type="number"
        value={item.amount}
        onChange={(event) => onChange({ ...item, amount: event.target.value })}
        className="h-6 w-[76px] shrink-0 rounded-md border border-slate-200 bg-white px-1 text-right text-[11px] tabular-nums text-slate-800 outline-none placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-focus-ring"
      />
      <button
        type="button"
        aria-label="부가 항목 삭제"
        onClick={onRemove}
        className="shrink-0 rounded p-0.5 text-slate-400 transition-colors hover:text-status-urgent-text"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * 부가 항목 읽기 행 — **서브텍스트 없이 단일 행**(오너 확정 9차).
 *
 * 대상은 이미 구간(브랜드사/셀러/자사) 배치로 드러나므로 서브텍스트의 대상 표기가
 * 중복이었다. 그래서 다른 재무 행과 완전히 같은 `FinancialLine` 문법을 쓴다 —
 * 주 라벨은 비고이고, 방식·대상 원본값은 편집 모드 Select 에 그대로 복원된다.
 */
function SettlementItemLine({ item, muted = false }: { item: SettlementItemRow; muted?: boolean }) {
  const signed = resolveSettlementItemSignedAmount(item);
  return (
    <FinancialLine
      label={item.note?.trim() || "부가 항목"}
      value={formatSettlementSignedMoney(signed)}
      muted={muted}
      danger={!muted && signed < 0}
    />
  );
}

/**
 * 부호를 명시해 보여준다 — 방향이 곧 이 항목의 성격이라 `+`/`−` 가 라벨 역할을 한다.
 * 0 에는 부호를 붙이지 않는다 — 「+0원」은 받을 돈이 있다는 뜻으로 잘못 읽힌다.
 */
function formatSettlementSignedMoney(value: number) {
  const rounded = Math.round(value);
  if (rounded === 0) return "0원";
  // 음수 글리프는 이 카드의 기존 관례(`formatSettlementExpense`)와 같은 하이픈을 쓴다 —
  // 한 카드 안에서 「-60,000원」과 「−60,000원」이 섞이면 다른 종류의 값처럼 보인다.
  const sign = rounded < 0 ? "-" : "+";
  return `${sign}${Math.abs(rounded).toLocaleString()}원`;
}

/**
 * 구간 헤더 — 구분은 색이 아니라 **구조**다(P8: 범주는 색을 받지 않는다).
 * 아이콘은 무채색이고 구간별 hue 를 배정하지 않는다. 카드 안 섹션이라 서브카드·
 * 그림자를 새로 얹지 않는다(elevation 사다리).
 */
function SettlementZoneHeader({
  icon: Icon,
  title,
}: {
  icon: typeof Building2;
  title: string;
}) {
  return (
    <div className="mt-2 flex items-center gap-1.5 border-t border-slate-200/60 px-2 pb-1 pt-3 first:mt-0 first:border-t-0 first:pt-0">
      <Icon className="size-3.5 text-slate-400" />
      <span className="text-sm font-semibold text-foreground">{title}</span>
    </div>
  );
}

/**
 * 구간 총액 — 「기준 vs 총액」을 **캐리어 비대칭**으로 가른다: 총액은 박스,
 * 기준액은 박스 없이 태그 하나(`FinancialLine` 의 `tag`). 도트·퍼센트 필은
 * 이 레포에서 이미 기각된 표현이라 쓰지 않는다(P8).
 *
 * 부호는 고정하지 않고 값에서 파생한다 — 채널·부가 항목 조합에 따라 브랜드사
 * 총액이 받을 돈일 수도 낼 돈일 수도 있다.
 */
function SettlementZoneTotal({
  label,
  amount,
  hint = null,
}: {
  label: string;
  amount: number;
  hint?: string | null;
}) {
  return (
    <div className="mt-1 grid min-h-8 grid-cols-[minmax(0,1fr)_84px_244px] items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-semibold text-slate-800">
      <span className="min-w-0 truncate">
        {label}
        {hint ? <span className="ml-1.5 font-normal text-[10px] text-slate-500">{hint}</span> : null}
      </span>
      <span aria-hidden="true" />
      <span
        className={cn(
          "justify-self-end text-right tabular-nums",
          // 0 은 방향이 없으므로 색도 얹지 않는다 — 초록(받을 돈)으로 칠하면 부호 없는
          // 0 과 색이 어긋나 "받을 게 있다"로 읽힌다.
          amount === 0 ? "text-slate-800" : amount < 0 ? "text-money-out" : "text-money-in-text",
        )}
      >
        {formatSettlementSignedMoney(amount)}
      </span>
    </div>
  );
}

/**
 * 한 구간의 부가 항목 편집 목록 — 평소 0행이 정상이라(항상 발생하는 비용이 아니다)
 * 빈 상태에는 「+ 항목 추가」만 둔다.
 *
 * 새 행의 기본 계산서 방식은 구간에 따라 다르다: 브랜드사·셀러는 매입계산서 수취
 * (가장 흔한 「우리가 내는」 경우), 자사는 계산서 없음 고정.
 */
function SettlementItemEditor({
  zone,
  items,
  onItemsChange,
}: {
  zone: SettlementCounterparty;
  items: SettlementItemDraft[];
  onItemsChange: (next: SettlementItemDraft[]) => void;
}) {
  const zoneItems = items.filter((item) => item.counterparty === zone);

  const handleAdd = () => {
    onItemsChange([
      ...items,
      {
        key: nextSettlementItemKey(),
        invoiceMode: zone === "INTERNAL" ? "NO_INVOICE" : "PURCHASE_RECEIVE",
        counterparty: zone,
        note: "",
        amount: "",
      },
    ]);
  };

  return (
    <div className="grid gap-0.5">
      {zoneItems.map((item) => (
        <SettlementItemEditRow
          key={item.key}
          item={item}
          onChange={(next) =>
            onItemsChange(items.map((candidate) => (candidate.key === item.key ? next : candidate)))
          }
          onRemove={() => onItemsChange(items.filter((candidate) => candidate.key !== item.key))}
        />
      ))}
      <button
        type="button"
        onClick={handleAdd}
        className="mx-2 rounded-md border border-dashed border-slate-300 py-1 text-[11px] text-slate-500 transition-colors hover:border-slate-400 hover:text-slate-700"
      >
        + 항목 추가
      </button>
    </div>
  );
}

async function saveSettlementFinancialFields(
  campaignId: string,
  patch: SettlementFinancialPatch,
): Promise<CampaignRow> {
  const result = await patchCampaign<CampaignRow>(campaignId, patch, {
    fallbackError: "재무 정보 저장 실패",
    preferServerError: true,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.data;
}

function SettlementFinancialSummary({
  campaign,
  onCampaignUpdated,
}: {
  campaign: CampaignRow;
  onCampaignUpdated: (campaign: CampaignRow) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraft] = useState(() => ({
    settlementSupplyCost: String(
      campaign.settlementSupplyCost ??
        (Number(campaign.actualSales ?? 0) > 0 ? Math.round(Number(campaign.actualSales ?? 0) / 1.1) : ""),
    ),
    // ⚠️ 공급가액과 달리 기본값을 계산하지 않는다 — 빈칸("")=미입력이 유효 상태다
    //   (미입력이면 세무 대조가 공식 폴백을 쓴다. 추정값을 미리 채우면 그것이 관측값처럼
    //   저장되는 사고가 이 필드를 만든 이유와 정확히 반대다).
    settlementGoodsCost: campaign.settlementGoodsCost == null ? "" : String(campaign.settlementGoodsCost),
    settlementSales: String(campaign.settlementSales ?? 0),
    sellerExpense: String(campaign.sellerExpense ?? 0),
    taxExpense: String(campaign.taxExpense ?? 0),
    operatingExpense: String(campaign.operatingExpense ?? 0),
    miscExpense: String(campaign.miscExpense ?? 0),
    totalMarginRate: String(campaign.totalMarginRate ?? 0),
    sellerMarginRate: String(campaign.sellerMarginRate ?? 0),
    isManualSettlementSales: campaign.isManualSettlementSales ?? false,
    isManualSellerExpense: campaign.isManualSellerExpense ?? false,
    isManualTaxExpense: campaign.isManualTaxExpense ?? false,
    shippingFee: campaign.shippingFee ?? null,
    freeShippingThreshold: campaign.freeShippingThreshold ?? null,
  }));
  const [itemDrafts, setItemDrafts] = useState<SettlementItemDraft[]>(() =>
    toSettlementItemDrafts(campaign.settlementItems),
  );
  const grossSales = Number(campaign.actualSales ?? 0);
  const computedSupplyCost = grossSales > 0 ? Math.round(grossSales / 1.1) : null;
  const currentSupplyCost = campaign.settlementSupplyCost ?? computedSupplyCost;
  const grossCommission = Number(campaign.settlementSales ?? 0);
  const sellerFee = Number(campaign.sellerExpense ?? 0);
  // 매출총이익 — 영업수익에서 판매대행비만 뺀 중간값. ⚠️ 이 값의 라벨은 한때
  // 최종 「영업이익」과 **동명**이었다(같은 카드에 같은 이름의 다른 숫자 두 개).
  // 부가 항목이 붙으면 오독이 배가되므로 이번에 개명했다(ss-ux 지적).
  const grossProfit = grossCommission - sellerFee;
  const operatingExpense = Number(campaign.operatingExpense ?? 0);
  const taxExpense = Number(campaign.taxExpense ?? 0);
  const miscExpense = Number(campaign.miscExpense ?? 0);
  const operatingProfit =
    campaign.operatingProfit ??
    grossProfit - operatingExpense - taxExpense - miscExpense;
  const netProfitRate = grossSales > 0 ? (operatingProfit / grossSales) * 100 : 0;

  // 부가 항목 — 판정·합계는 전부 `settlement-items.ts` SSOT 에 위임한다(화면이
  // 부호·구간 규칙을 다시 쓰면 명세서·손익과 갈린다).
  const settlementItems = campaign.settlementItems ?? [];
  const itemsByZone = groupSettlementItemsByZone(settlementItems);
  const brandPaidTotal = sumBrandPaidItems(settlementItems);
  const internalItemsTotal = sumInternalItems(settlementItems);
  const adjustedOperatingProfit = resolveAdjustedOperatingProfit(operatingProfit, settlementItems);
  const showProfitAdjustment = hasProfitAdjustment(settlementItems);

  const isIndividual = isIndividualSeller(campaign);
  // 원천세·지급 총액의 기준은 **판매대행비**다(부가 항목이 몇 건이든 변하지 않는다 —
  // 화면이 그 사실을 「고정」 태그로 말한다).
  const sellerBaseAmount = sellerFee;
  // 「정산 기준액」에 **찍는 값**은 그 판매대행비가 아니라 **그것을 계산할 때 곱하는
  // 매출액**이다(오너 정정 2026-08-27 — 종전엔 두 줄이 같은 숫자였다).
  // ⛔ 기준을 화면에서 유도하지 말 것 — 세무 유형이 기준을 가르므로(개인=공급가액 ·
  // 사업자=총 거래액) 금액과 그 이름을 lib SSOT `resolveSellerFeeBasis` 가 함께 낸다.
  // 화면이 그 판정 함수를 직접 부르는 것도 계약(`settlement-statement-text.test.ts`)이
  // 막는다 — 기준·세율 계산은 lib 소관이다.
  const sellerFeeBasis = resolveSellerFeeBasis(grossSales, isIndividual);
  // 원천세는 판매대행비 + 셀러 지급 부가 항목을 **합산해 한 줄로** 공제한다(오너 확정).
  // 계산은 lib SSOT 가 소유한다 — 화면이 세율을 직접 쓰면 명세서와 갈린다
  // (`settlement-statement-text.test.ts` 가 그 금지를 소스 스캔으로 고정).
  const { withholdingTax: sellerWithholdingTax, payoutTotal: sellerPayoutTotal } =
    resolveSellerZoneTotals({ sellerBaseAmount, items: settlementItems, isIndividual });

  // 물품대금 행이 쓰는 3-상태 판정 — 표시(라벨·「합산 이관」 문구)가 이 값을 그대로 읽는다.
  // ⛔ 판정을 여기서 손으로 다시 쓰지 말 것: 이 화면이 재구현했다가 `0`(합산 이관 마커)을
  //    `null`(미입력)과 같이 취급해, 항목 행은 「합산 이관 (계산서 없음)」이라는데 아래
  //    포커스 총액은 공식 추정치를 확정값처럼 보여주는 상태가 됐다(교차 검증에서 적발).
  const goodsCost = resolveGoodsCost({
    manualGoodsCost: campaign.settlementGoodsCost,
    actualSales: grossSales,
    settlementSales: grossCommission,
  });
  const goodsCostForTotal = resolveGoodsCostContribution(goodsCost);
  // 브랜드사 정산 총액 — 판정 SSOT 는 `resolveBrandSettlementTotal` 하나다. 정산 목록의
  // 선택 바가 **같은 금액을 여러 건 합산해** 보여주므로, 두 화면이 각자 계산하면 한 캠페인이
  // 두 자리에서 다른 금액을 말한다.
  const brandTotal = resolveBrandSettlementTotal(campaign);
  const brandNetTotal = brandTotal.amount;
  const brandTotalIsEstimated = brandTotal.isEstimated;
  // 총액 라벨이 **방향을 직접 말한다**(오너 지시 2026-08-27 — 종전 「주고받을 총액」은
  // 나가는 돈인지 들어오는 돈인지를 뭉갰다). 방향 판정(부호 우선, 0 이면 채널 기본)은
  // 위 SSOT 가 소유한다.
  const brandTotalLabel = brandTotal.weReceive ? "브랜드사에서 받을 총액" : "브랜드사에 지급할 총액";

  const resetDraft = () => {
    setDraft({
      settlementSupplyCost: String(currentSupplyCost ?? ""),
      settlementGoodsCost: campaign.settlementGoodsCost == null ? "" : String(campaign.settlementGoodsCost),
      settlementSales: String(campaign.settlementSales ?? 0),
      sellerExpense: String(campaign.sellerExpense ?? 0),
      taxExpense: String(campaign.taxExpense ?? 0),
      operatingExpense: String(campaign.operatingExpense ?? 0),
      miscExpense: String(campaign.miscExpense ?? 0),
      totalMarginRate: String(campaign.totalMarginRate ?? 0),
      sellerMarginRate: String(campaign.sellerMarginRate ?? 0),
      isManualSettlementSales: campaign.isManualSettlementSales ?? false,
      isManualSellerExpense: campaign.isManualSellerExpense ?? false,
      isManualTaxExpense: campaign.isManualTaxExpense ?? false,
      shippingFee: campaign.shippingFee ?? null,
      freeShippingThreshold: campaign.freeShippingThreshold ?? null,
    });
    setItemDrafts(toSettlementItemDrafts(campaign.settlementItems));
  };

  const toNumber = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const draftSettlementSales = toNumber(draft.settlementSales);
  const draftSellerExpense = toNumber(draft.sellerExpense);
  const draftTaxExpense = toNumber(draft.taxExpense);
  const draftOperatingExpense = toNumber(draft.operatingExpense);
  const draftMiscExpense = toNumber(draft.miscExpense);
  const draftNetCommission = draftSettlementSales - draftSellerExpense;
  const draftOperatingProfit =
    draftNetCommission - draftTaxExpense - draftOperatingExpense - draftMiscExpense;
  // 편집 중에도 같은 규칙 — 입력하다 적자로 넘어가면 즉시 색이 바뀐다(profit-tone SSOT).
  const summaryProfitTone = resolveProfitTone(isEditing ? draftOperatingProfit : operatingProfit);
  const draftNetMarginRate = computeNetMarginRate(
    toNumber(draft.totalMarginRate),
    toNumber(draft.sellerMarginRate),
  );

  const updateDraft = <K extends keyof typeof draft>(field: K, value: typeof draft[K]) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  const handleEdit = () => {
    resetDraft();
    setIsEditing(true);
  };

  const handleCancel = () => {
    resetDraft();
    setIsEditing(false);
  };

  const buildStatementHtml = () => buildSettlementStatementHtml([campaign]);

  const handleCopyStatement = async () => {
    try {
      const htmlString = buildStatementHtml();
      const textString = buildSettlementStatementText([campaign]);

      if (navigator.clipboard.write && "ClipboardItem" in window) {
        const ClipboardItemCtor = window.ClipboardItem;
        await navigator.clipboard.write([
          new ClipboardItemCtor({
            "text/html": new Blob([htmlString], { type: "text/html" }),
            "text/plain": new Blob([textString], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(htmlString);
      }

      toast.success("정산 명세서가 이메일 본문용 HTML로 복사되었습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "정산 명세서 복사 실패");
    }
  };

  const handlePrintStatement = () => {
    try {
      // 조각이 아니라 인쇄용 완전 문서를 쓴다 — 크롬 기본 머리말/꼬리말/쪽번호/문서제목을
      // 없애는 `@page{margin:0}`+빈 `<title>` 이 이 래퍼에 있다(정본 SSOT, 세 인쇄 경로 공용).
      const htmlString = buildSettlementStatementPrintDoc([campaign]);
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      document.body.appendChild(iframe);

      const doc = iframe.contentWindow?.document || iframe.contentDocument;
      if (!doc) {
        throw new Error("인쇄 창을 생성하지 못했습니다.");
      }

      let didPrint = false;
      const printFrame = () => {
        if (didPrint) return;
        didPrint = true;
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
        setTimeout(() => iframe.remove(), 1000);
      };

      iframe.onload = printFrame;
      doc.open();
      doc.write(htmlString);
      doc.close();
      setTimeout(printFrame, 150);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "PDF 인쇄 준비 실패");
    }
  };

  const handleSaveImage = async () => {
    try {
      // 파일명도 목록과 **같은 SSOT** 를 쓴다 — 이 자리의 `settlement-{id}.png` 가
      // "같은 버튼인데 상세에서만 이름이 다르다"의 정체였다(T-023).
      const filename = buildSettlementStatementFileName([campaign]);
      // 이미지는 이메일·PDF 와 **같은 정본 HTML** 을 렌더해서 찍는다 — 셋이 같은 문서다.
      // 이전엔 화면(`financialCardRef`)을 html2canvas 로 캡처했는데, 그 패널은 내부 문서라
      // 영업이익(자사 순수익)·정산 수수료율이 그대로 셀러에게 갔다(P0).
      const dataUrl = await renderSettlementStatementPng([campaign]);
      downloadDataUrl(dataUrl, filename);
      toast.success("정산 명세서 이미지를 저장했습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "이미지 저장 실패");
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const patch: SettlementFinancialPatch = {};
      const sameNumber = (left: number | null | undefined, right: number | null | undefined) =>
        Number(left ?? 0) === Number(right ?? 0);
      const draftSupplyCost = draft.settlementSupplyCost === "" ? null : toNumber(draft.settlementSupplyCost);
      const draftTotalMarginRate = toNumber(draft.totalMarginRate);
      const draftSellerMarginRate = toNumber(draft.sellerMarginRate);
      const settlementModeChanged =
        draft.isManualSettlementSales !== (campaign.isManualSettlementSales ?? false);
      const sellerModeChanged =
        draft.isManualSellerExpense !== (campaign.isManualSellerExpense ?? false);
      const taxModeChanged =
        draft.isManualTaxExpense !== (campaign.isManualTaxExpense ?? false);
      const totalRateChanged = !sameNumber(draftTotalMarginRate, campaign.totalMarginRate);
      const sellerRateChanged = !sameNumber(draftSellerMarginRate, campaign.sellerMarginRate);

      if (!sameNumber(draftSupplyCost, currentSupplyCost)) {
        patch.settlementSupplyCost = draftSupplyCost;
      }
      // ⚠️ sameNumber 를 쓰지 않는다 — 그 비교는 null 을 0 으로 접는데, 이 필드는
      //   null(미입력→공식 폴백)과 0(합산 이관→기대 건 억제)이 **다른 상태**다.
      // ⚠️ toNumber(NaN→0) 도 쓰지 않는다 — 다른 필드에서 0 은 무해하지만 여기서 0 은
      //   「기대 건 억제」 마커라, 입력 중간 상태("-" 등)가 저장 시점에 남아 있으면
      //   조용히 억제 마커가 박힌다. 숫자로 못 읽는 값은 패치에서 제외한다(기존값 유지).
      const goodsCostRaw = draft.settlementGoodsCost.trim();
      const goodsCostParsed = goodsCostRaw === "" ? null : Number(goodsCostRaw);
      if (goodsCostParsed === null || Number.isFinite(goodsCostParsed)) {
        if (goodsCostParsed !== (campaign.settlementGoodsCost ?? null)) {
          patch.settlementGoodsCost = goodsCostParsed;
        }
      }
      if (!sameNumber(draftOperatingExpense, campaign.operatingExpense)) {
        patch.operatingExpense = draftOperatingExpense;
      }
      if (!sameNumber(draftMiscExpense, campaign.miscExpense)) {
        patch.miscExpense = draftMiscExpense;
      }
      if (totalRateChanged) {
        patch.totalMarginRate = draftTotalMarginRate;
      }
      if (sellerRateChanged) {
        patch.sellerMarginRate = draftSellerMarginRate;
      }
      if (totalRateChanged || sellerRateChanged) {
        patch.netMarginRate = draftNetMarginRate;
      }
      if (settlementModeChanged) {
        patch.isManualSettlementSales = draft.isManualSettlementSales;
      }
      if (draft.isManualSettlementSales && !sameNumber(draftSettlementSales, campaign.settlementSales)) {
        patch.settlementSales = draftSettlementSales;
        patch.isManualSettlementSales = true;
      }
      if (sellerModeChanged) {
        patch.isManualSellerExpense = draft.isManualSellerExpense;
      }
      if (draft.isManualSellerExpense && !sameNumber(draftSellerExpense, campaign.sellerExpense)) {
        patch.sellerExpense = draftSellerExpense;
        patch.isManualSellerExpense = true;
      }
      if (taxModeChanged) {
        patch.isManualTaxExpense = draft.isManualTaxExpense;
      }
      if (draft.isManualTaxExpense && !sameNumber(draftTaxExpense, campaign.taxExpense)) {
        patch.taxExpense = draftTaxExpense;
        patch.isManualTaxExpense = true;
      }

      // 부가 항목 — 전체 교체. 비고·금액이 모두 빈 행은 사용자가 추가만 하고 안 채운
      // 것이므로 저장에서 제외한다(빈 행이 0원짜리 유령 항목으로 굳지 않게).
      const nextItems = itemDrafts
        .filter((item) => item.note.trim() !== "" || item.amount.trim() !== "")
        .map((item) => ({
          invoiceMode: normalizeSettlementItemMode(item.counterparty, item.invoiceMode),
          counterparty: item.counterparty,
          amount: Number.isFinite(Number(item.amount)) ? Number(item.amount) : 0,
          note: item.note.trim() ? item.note.trim() : null,
        }));
      const prevItems = (campaign.settlementItems ?? []).map((item) => ({
        invoiceMode: item.invoiceMode,
        counterparty: item.counterparty,
        amount: item.amount,
        note: item.note,
      }));
      if (JSON.stringify(nextItems) !== JSON.stringify(prevItems)) {
        patch.settlementItems = nextItems;
      }

      if (Object.keys(patch).length === 0) {
        setIsEditing(false);
        return;
      }

      const updated = await saveSettlementFinancialFields(campaign.id, patch);
      onCampaignUpdated(updated);
      setIsEditing(false);
      toast.success("재무 정산 내역이 저장되었습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "재무 정보 저장 실패");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="space-y-4 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <DollarSign className="size-4 text-slate-500" />
          재무 정산 내역
        </h3>
        {/* 내보내기 3형제(이메일·PDF·이미지)는 같은 성격의 액션인데 각각 인디고·에메랄드·
            블루였다 — 색이 뜻한 건 "파일 형식"이라 범주다(P8 색 원칙 4). 게다가 PDF 의
            에메랄드는 바로 이 패널에서 흑자를 뜻하는 색이라 hue 어휘가 오염돼 있었다.
            1차 액션(편집·저장)이 이미 `bg-primary` 네이비라 무채색화해도 위계 손실은 없다. */}
        <div className="grid grid-cols-[88px_72px_82px_56px_56px] items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-8 rounded-lg px-2.5 text-[11px] font-semibold disabled:pointer-events-none disabled:opacity-45"
            onClick={handleCopyStatement}
            disabled={isEditing || isSaving}
          >
            <Copy className="mr-1 size-3.5" />
            이메일
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-8 rounded-lg px-2.5 text-[11px] font-semibold disabled:pointer-events-none disabled:opacity-45"
            onClick={handlePrintStatement}
            disabled={isEditing || isSaving}
          >
            <FileText className="mr-1 size-3.5" />
            PDF
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-8 rounded-lg px-2.5 text-[11px] font-semibold disabled:pointer-events-none disabled:opacity-45"
            onClick={() => {
              void handleSaveImage();
            }}
            disabled={isEditing || isSaving}
          >
            <ImageDown className="mr-1 size-3.5" />
            이미지
          </Button>
          {isEditing ? (
            <>
              <Button
                type="button"
                size="xs"
                className="h-8 rounded-lg px-3 text-[11px]"
                onClick={() => {
                  void handleSave();
                }}
                disabled={isSaving}
              >
                저장
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-8 rounded-lg px-3 text-[11px]"
                onClick={() => {
                  handleCancel();
                }}
                disabled={isSaving}
              >
                취소
              </Button>
            </>
          ) : (
            <>
              <span aria-hidden="true" />
              <Button
                type="button"
                size="xs"
                className="h-8 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-soft-sm transition-colors hover:bg-primary/95"
                onClick={handleEdit}
              >
                편집
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {/* 판매대행비 = 실제로 나가는 돈 → 자금 방향축 토큰(값은 rose-600 과 동일 #E11D48) */}
        <div className="flex min-h-9 min-w-0 items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50/40 px-3 py-2 text-xs">
          <div className="min-w-0 truncate text-[11px] font-semibold text-money-out">판매대행비 (셀러 정산금)</div>
          <div className="shrink-0 text-right text-sm tabular-nums text-money-out">
            {formatSettlementMoney(isEditing ? draftSellerExpense : sellerFee)}
          </div>
        </div>
        {/* 영업이익 숫자는 부호를 따른다(profit-tone SSOT) — 이전엔 text-primary 고정이라
            적자 캠페인도 네이비로 떴다. 라벨은 네이비 유지(제목 역할).
            셸은 인디고였다 — #178 이 숫자를 부호색으로 바꾼 뒤로는 그 색과 경쟁하는 껍데기만
            남았다. 무채색으로 내리면 **이미 있는 색이 드러난다**(빼기가 아니라 노출).
            정렬 대상은 이 파일 아래 원장 하단 요약 박스의 `border-slate-200 bg-slate-50` 이다.
            네이비로 바꾸지 않는 이유: 라벨이 이미 `text-primary` 라 셸까지 네이비면 동어반복. */}
        <div className="flex min-h-9 min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
          <div className="min-w-0 truncate text-[11px] font-semibold text-primary">영업이익 (자사 순수익)</div>
          <div className={cn("shrink-0 text-right text-sm font-bold tabular-nums", summaryProfitTone ? PROFIT_TONE_TEXT[summaryProfitTone] : "text-primary")}>
            {formatSettlementMoney(isEditing ? draftOperatingProfit : operatingProfit)}
          </div>
        </div>
      </div>

      {/*
        돈의 흐름 순서대로 3구간(브랜드사 → 셀러 → 자사 손익)으로 나눈다(오너 확정).
        구간 구분은 **색이 아니라 구조**다 — 헤더 + 섹션 경계선 + 여백만 쓰고 구간별
        hue 를 배정하지 않는다(P8: 범주는 색을 받지 않는다). 색은 방향축(money-out)·
        판정축(profit-tone)을 타는 초점 값에만 완전 강도로 얹는다.

        ⛔ 계산서 발행·수취 상태는 이 카드에 넣지 않는다(오너 확정) — 요약 칩이라도
           실으면 「정산 및 회계 일정」 카드와 같은 상태를 두 곳이 말하다 갈라진다.
      */}
      {isEditing ? (
        <div className="grid gap-2 text-xs">
          <SettlementZoneHeader icon={Building2} title="브랜드사 정산" />
          <FinancialEditInput label="총 거래액" value={String(grossSales)} readOnly />
          <FinancialEditInput
            label="공급가액"
            value={draft.settlementSupplyCost}
            onChange={(value) => updateDraft("settlementSupplyCost", value)}
          />
          <FinancialEditInput
            label="물품대금 (계산서 대조)"
            value={draft.settlementGoodsCost}
            mode={draft.settlementGoodsCost.trim() === "" ? "자동" : "수동"}
            // 자동 = RS 기반 공식 폴백(필드 null), 수동 = 실물 계산서 총액 직접 입력.
            // 새 플래그를 만들지 않고 **null 여부가 곧 모드**다 — 세무 대조 엔진의
            // 기존 3-상태 계약(미입력=공식 / 0=합산 이관 / 양수=그 금액)과 그대로 맞물린다.
            onModeChange={(mode) =>
              updateDraft(
                "settlementGoodsCost",
                mode === "자동" ? "" : String(Math.max(grossSales - grossCommission, 0)),
              )
            }
            onChange={(value) => updateDraft("settlementGoodsCost", value)}
          />
          {/* text-xs = P8 폼 타이포 4단 사다리의 도움말 티어(ss-ux 검토 반영 — 10px 신설 금지) */}
          <p className="px-2 text-xs leading-relaxed text-slate-500">
            자동은 요율 기반 공식(총 거래액 − 영업 수익) 추정이고, 수동은 이 캠페인 앞으로 온
            매입 계산서 합계(VAT 포함)입니다. <span className="font-semibold">0</span>은 다른
            캠페인 계산서에 합산된 건이라는 표시입니다. 손익 계산에는 쓰이지 않습니다.
          </p>
          <FinancialEditInput
            label="영업 수익"
            value={draft.settlementSales}
            readOnly={!draft.isManualSettlementSales}
            mode={draft.isManualSettlementSales ? "수동" : "자동"}
            onModeChange={(mode) => updateDraft("isManualSettlementSales", mode === "수동")}
            onChange={(value) => updateDraft("settlementSales", value)}
          />
          <SettlementItemEditor
            zone="BRAND"
            items={itemDrafts}
            onItemsChange={setItemDrafts}
          />

          <SettlementZoneHeader icon={UserRound} title="셀러 정산" />
          <FinancialEditInput
            label="판매대행비"
            value={draft.sellerExpense}
            readOnly={!draft.isManualSellerExpense}
            mode={draft.isManualSellerExpense ? "수동" : "자동"}
            onModeChange={(mode) => updateDraft("isManualSellerExpense", mode === "수동")}
            onChange={(value) => updateDraft("sellerExpense", value)}
          />
          <SettlementItemEditor
            zone="SELLER"
            items={itemDrafts}
            onItemsChange={setItemDrafts}
          />

          <SettlementZoneHeader icon={TrendingUp} title="자사 손익" />
          <FinancialEditInput label="매출총이익" value={String(draftNetCommission)} readOnly />
          <FinancialEditInput
            label="제세공과금 (부가세 + 원천세)"
            value={draft.taxExpense}
            readOnly={!draft.isManualTaxExpense}
            mode={draft.isManualTaxExpense ? "수동" : "자동"}
            onModeChange={(mode) => updateDraft("isManualTaxExpense", mode === "수동")}
            onChange={(value) => updateDraft("taxExpense", value)}
          />
          <FinancialEditInput
            label="공동 운영 비용"
            value={draft.operatingExpense}
            onChange={(value) => updateDraft("operatingExpense", value)}
          />
          <FinancialEditInput
            label="기타 조정 비용"
            value={draft.miscExpense}
            onChange={(value) => updateDraft("miscExpense", value)}
          />
          <SettlementItemEditor
            zone="INTERNAL"
            items={itemDrafts}
            onItemsChange={setItemDrafts}
          />
          <div className="mt-2 grid min-h-8 grid-cols-[minmax(0,1fr)_84px_244px] items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-semibold text-slate-800">
            <span className="min-w-0 truncate">영업이익</span>
            <span aria-hidden="true" />
            <span className="justify-self-end text-right tabular-nums text-primary">
              <span className="mr-2 rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600">
                이익율 {grossSales > 0 ? ((draftOperatingProfit / grossSales) * 100).toFixed(1) : "0.0"}%
              </span>
              {formatSettlementMoney(draftOperatingProfit)}
            </span>
          </div>
        </div>
      ) : (
        <div className="grid gap-2 text-xs">
          <SettlementZoneHeader icon={Building2} title="브랜드사 정산" />
          <FinancialLine label="총 거래액" value={formatSettlementMoney(grossSales)} />
          <FinancialLine label="공급가액" value={formatSettlementMoney(currentSupplyCost)} muted />
          {/* 라벨·값 모두 위 `goodsCost`(SSOT 판정)에서 파생한다 — 여기서 필드를 다시
              보고 3-상태를 유도하면 이 행과 아래 총액이 갈린다(그 드리프트가 실제로 났다). */}
          <FinancialLine
            label={goodsCost.kind === "FORMULA" ? "물품대금 (추정)" : "물품대금"}
            value={
              // 합산 이관은 금액이 아니라 상태라 문구로 말한다. 미입력은 공식 추정치를
              // 보여주되 라벨로 추정임을 밝힌다 — 종전엔 줄 자체를 감춰서 브랜드사에 낼
              // 가장 큰 금액이 화면에서 통째로 빠져 있었다.
              // ⛔ 리터럴로 되돌리지 말 것 — 대금 칸(캘린더·모바일)이 같은 문구를 쓴다.
              //    갈리면 같은 사실을 두 화면이 다르게 말한다(T-057).
              goodsCost.kind === "CONSOLIDATED"
                ? GOODS_COST_CONSOLIDATED_LABEL
                : formatSettlementMoney(goodsCostForTotal)
            }
            muted
          />
          <FinancialLine label="영업 수익" value={formatSettlementMoney(grossCommission)} />
          {itemsByZone.BRAND.map((item) => (
            <SettlementItemLine key={item.id} item={item} />
          ))}
          <SettlementZoneTotal
            label={brandTotalLabel}
            amount={brandNetTotal}
            hint={brandTotalIsEstimated ? "추정 포함" : null}
          />

          <SettlementZoneHeader icon={UserRound} title="셀러 정산" />
          <FinancialLine
            label="정산 기준액"
            value={formatSettlementMoney(sellerFeeBasis.amount)}
            tag="고정"
            // ⛔ 「기준액 × 수수료율 = 판매대행비」 라고 단정하지 말 것 — 판매대행비는
            //    저장값이라 수동 수정·요율 변경 이력에 따라 곱셈이 딱 안 맞을 수 있다.
            //    이 줄은 **무엇을 기준으로 삼는가**만 말한다.
            hint={`판매대행비 기준 · ${sellerFeeBasis.label}`}
          />
          <FinancialLine label="판매대행비" value={formatSettlementMoney(sellerFee)} danger />
          {itemsByZone.SELLER.map((item) => (
            <SettlementItemLine key={item.id} item={item} />
          ))}
          {isIndividual && (
            // 원천세는 판매대행비 + 셀러 지급 부가 항목을 **합산해 한 줄로** 공제한다 —
            // 항목마다 세후로 쪼개면 실제로 이체할 원천세 합계를 어디서도 못 읽는다.
            <FinancialLine
              label="원천세 3.3% (판매대행비 + 부가 항목 합산)"
              value={formatSettlementExpense(sellerWithholdingTax)}
              muted
            />
          )}
          <SettlementZoneTotal label="셀러 지급 총액" amount={-sellerPayoutTotal} />

          <SettlementZoneHeader icon={TrendingUp} title="자사 손익" />
          <FinancialLine label="매출총이익" value={formatSettlementMoney(grossProfit)} accent strong amount={grossProfit} />
          <FinancialLine label="부가세" value={formatSettlementExpense(taxExpense)} danger />
          <FinancialLine label="공동 운영 비용" value={formatSettlementExpense(operatingExpense)} danger />
          <FinancialLine label="기타 조정 비용" value={formatSettlementExpense(miscExpense)} danger />
          {itemsByZone.INTERNAL.map((item) => (
            <SettlementItemLine key={item.id} item={item} />
          ))}
          {brandPaidTotal !== 0 && (
            // A안(오너 선택) — 브랜드사에 낸 부대비용을 muted 참조 1줄로 둔다. 편집·소유는
            // 브랜드사 구간 한 곳이고 여기선 읽기 전용이다. ⚠️ 이 줄이 없으면 아래
            // 「조정 후 손익」 숫자의 출처가 화면에서 사라진다(상계는 양쪽 다리가 다
            // 있어야 성립한다 — 잡이익만 더하면 그만큼 손익이 과대표시된다).
            <FinancialLine
              label="매입 부대비용 (브랜드사 정산 참조)"
              value={formatSettlementExpense(brandPaidTotal)}
              muted
            />
          )}
          <div className="mt-2 grid min-h-8 grid-cols-[minmax(0,1fr)_84px_244px] items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-semibold text-slate-800">
            <span className="min-w-0 truncate">영업이익</span>
            <span aria-hidden="true" />
            <span className="justify-self-end text-right tabular-nums text-primary">
              <span className="mr-2 rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600">
                이익율 {netProfitRate.toFixed(1)}%
              </span>
              {formatSettlementMoney(operatingProfit)}
            </span>
          </div>
          {showProfitAdjustment && (
            // 저장 파생식(operatingProfit)은 그대로 두고 조정만 표시한다 — 저장값을
            // 바꾸면 isManual* 오버라이드 체계와 기존 캠페인과의 비교가 흔들린다.
            <div className="px-2 text-[11px] text-slate-500">
              부가 항목 반영 후 {formatSettlementMoney(adjustedOperatingProfit)}
              {internalItemsTotal !== 0 && brandPaidTotal !== 0 && adjustedOperatingProfit === operatingProfit
                ? " (상계)"
                : ""}
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border border-slate-100 bg-slate-50/40 p-3 text-xs mb-4">
        <div className="mb-2 font-semibold text-slate-700">배송비 설정</div>
        <div className="grid min-h-9 grid-cols-2 gap-2">
          {isEditing ? (
            <>
              <FinancialValueInput
                label="배송비 (원)"
                value={draft.shippingFee}
                onChange={(value) => updateDraft("shippingFee", value ? Number(value) : null)}
              />
              <FinancialValueInput
                label="무료배송 조건 (원)"
                value={draft.freeShippingThreshold}
                onChange={(value) => updateDraft("freeShippingThreshold", value ? Number(value) : null)}
              />
            </>
          ) : (
            <>
              <FinancialValueLabel label="배송비" value={campaign.shippingFee} />
              <FinancialValueLabel label="무료배송 조건" value={campaign.freeShippingThreshold} />
            </>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-slate-100 bg-slate-50/40 p-3 text-xs">
        <div className="mb-2 font-semibold text-slate-700">정산 수수료율 설정</div>
        <div className="grid min-h-9 grid-cols-3 gap-2">
          {isEditing ? (
            <>
              <FinancialRateInput
                label="총 수수료율 (%)"
                value={draft.totalMarginRate}
                onChange={(value) => updateDraft("totalMarginRate", value)}
              />
              <FinancialRateInput
                label="셀러 수수료율 (%)"
                value={draft.sellerMarginRate}
                onChange={(value) => updateDraft("sellerMarginRate", value)}
              />
              <FinancialRate label="영업이익율 (%)" value={draftNetMarginRate} />
            </>
          ) : (
            <>
              <FinancialRate label="총 수수료율 (%)" value={campaign.totalMarginRate} />
              <FinancialRate label="셀러 수수료율 (%)" value={campaign.sellerMarginRate} />
              <FinancialRate label="영업이익율 (%)" value={campaign.netMarginRate} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function FinancialEditInput({
  label,
  value,
  onChange,
  readOnly = false,
  mode,
  onModeChange,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  mode?: "자동" | "수동";
  onModeChange?: (mode: "자동" | "수동") => void;
}) {
  const inputId = useId();

  return (
    <div className="grid min-h-8 grid-cols-[minmax(0,1fr)_84px_244px] items-center gap-3 px-2 py-0.5">
      <label htmlFor={inputId} className="min-w-0 truncate text-xs font-medium text-slate-700">
        {label}
      </label>
      {mode ? (
        <div className="inline-flex w-[84px] justify-self-end rounded-md bg-slate-100 p-0.5 text-[10px] font-semibold">
          {(["자동", "수동"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={cn(
                "min-w-0 flex-1 whitespace-nowrap rounded px-1 py-0.5 transition-colors",
                mode === item ? "bg-white text-primary shadow-soft-sm" : "text-slate-500",
              )}
              onClick={() => onModeChange?.(item)}
            >
              {item}
            </button>
          ))}
        </div>
      ) : (
        <span aria-hidden="true" />
      )}
      <input
        id={inputId}
        type="number"
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        className={cn(
          "h-7 w-full min-w-0 rounded-lg border px-2 text-right text-xs tabular-nums outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-focus-ring",
          readOnly
            ? "border-slate-100 bg-slate-50 text-slate-500"
            : "border-slate-200 bg-white text-slate-800",
        )}
      />
    </div>
  );
}

function FinancialRateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid h-9 min-w-0 grid-cols-[minmax(0,1fr)_64px] items-center gap-2 rounded-lg bg-white px-3 py-1">
      <div className="min-w-0 truncate text-[10px] text-muted-foreground">{label}</div>
      <input
        type="number"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 w-16 justify-self-end rounded-md border border-slate-100 bg-slate-50 px-2 text-right text-xs font-semibold tabular-nums text-slate-700 outline-none focus:border-primary focus:ring-1 focus:ring-focus-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </label>
  );
}

function FinancialValueInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid h-9 min-w-0 grid-cols-[minmax(0,1fr)_80px] items-center gap-2 rounded-lg bg-white px-3 py-1">
      <div className="min-w-0 truncate text-[10px] text-muted-foreground">{label}</div>
      <input
        type="number"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 w-20 justify-self-end rounded-md border border-slate-100 bg-slate-50 px-2 text-right text-xs font-semibold tabular-nums text-slate-700 outline-none focus:border-primary focus:ring-1 focus:ring-focus-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </label>
  );
}

function FinancialValueLabel({
  label,
  value,
}: {
  label: string;
  value: number | null | undefined;
}) {
  return (
    <div className="grid h-9 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg bg-white px-3 py-1">
      <div className="min-w-0 truncate text-[10px] text-muted-foreground">{label}</div>
      <div className="text-right text-xs font-semibold tabular-nums text-slate-700">
        {value != null ? formatSettlementMoney(value) : "-"}
      </div>
    </div>
  );
}

/**
 * 정산 정보 섹션 — [셀러]/[공급사] 탭 (2026-08-27 개편, 구 「셀러 정산 정보」).
 *
 * 공급사 탭이 생긴 이유: 공급사(거래처) 계좌를 입력·확인할 자리가 정산 화면에 없어
 * 값이 비어 있었고, 구글 캘린더 대금 이벤트(`google-calendar-sync`)가 그 값을 읽어
 * "미등록"으로 내보내고 있었다. 계좌는 **거래처(`Partner.bankAccount`)에 저장**되므로
 * 여기서 고치면 같은 공급사의 다른 캠페인·캘린더에도 함께 반영된다.
 *
 * 방향 문구(발행/수취·입금/지급)는 오너 확정 의무표 파생 SSOT
 * (`resolveCampaignInvoiceSlots`·`resolveCampaignMoneySlots`)에서 온다 —
 * ⛔ 채널 분기를 여기서 다시 손으로 쓰지 말 것(2026-08-07 셀러몰 정정 때 갈라진 선례).
 */
function SettlementInfo({
  campaign,
  onCampaignUpdated,
}: {
  campaign: CampaignRow;
  onCampaignUpdated: (campaign: CampaignRow) => void;
}) {
  const [isSavingTaxType, setIsSavingTaxType] = useState(false);
  const [helperOpen, setHelperOpen] = useState(false);
  const [withholdingHelperOpen, setWithholdingHelperOpen] = useState(false);
  // Finding 2(2026-08-04 재검토) — 정산 그룹 소속이면 「신고자료출력」 금액을 보드와
  // 똑같이(멤버 전원 합산) 내야 한다. 패널 진입 시점엔 형제 멤버의 매출·수수료를
  // 모르므로, 다이얼로그를 열 때만 그룹 상세를 조회한다(매번 그룹 섹션과 중복 조회해도
  // GET 하나뿐이라 비용이 낮고, 두 컴포넌트 상태를 엮지 않는 편이 단순하다).
  const [groupMembers, setGroupMembers] = useState<CampaignGroupMemberRow[] | null>(null);
  const groupId = campaign.groupId ?? null;

  useEffect(() => {
    if (!helperOpen || !groupId) return;
    let cancelled = false;
    void fetchGroupDetail(groupId)
      .then((detail) => {
        if (!cancelled) setGroupMembers(detail.members);
      })
      .catch(() => {
        // 조회 실패해도 다이얼로그는 캠페인 단독 금액으로 정상 동작한다(fail-safe) —
        // 그룹 합산을 못 보여줄 뿐 잘못된 숫자를 보여주지는 않는다.
        if (!cancelled) setGroupMembers(null);
      });
    return () => {
      cancelled = true;
    };
  }, [helperOpen, groupId]);

  const taxTypeLabel = campaign.sellerTaxType
    ? SELLER_TAX_TYPE_LABELS[campaign.sellerTaxType] ?? campaign.sellerTaxType
    : "-";
  const recipientName =
    campaign.sellerCompanyName ||
    campaign.sellerName ||
    "-";
  const representativeName =
    campaign.sellerCompanyCeoName ||
    campaign.sellerName ||
    "-";
  const account =
    campaign.sellerCompanyBankAccount ||
    campaign.sellerPersonalBankAccount ||
    "-";
  const email = campaign.sellerCompanyEmail || "-";
  // ⛔ 채널 게이트(2026-08-04 실사고) — 「신고자료출력」은 "우리가 셀러에게 세금계산서를
  // 발행하는" 캠페인에서만 뜬다. 스펙 「⛔ 채널별 세금계산서 거래 구조」표(오너 확정)상
  // 이 방향(ISSUE·상대 SELLER)이 존재하는 채널은 셀러몰뿐이다 — 우리몰은 우리가 발행하는
  // 계산서가 아예 없고, 브랜드몰의 발행 상대는 공급사(브랜드)라 셀러가 공급받는자로
  // 나오면 안 된다. `!isIndividualSeller` 하나만으로는 이 구분이 안 돼(개인 셀러가
  // 아니면서도 우리몰·브랜드몰인 캠페인이 있다) 버튼이 두 채널에서도 잘못 노출됐었다.
  // 판정은 `resolveTaxFilingChannelGroup`(tax-filing-board.ts, campaign-checklist.ts와
  // 바이트 단위로 동일해야 하는 채널 분기)을 그대로 재사용한다 — 여기서 분기를 다시
  // 손으로 쓰면 두 번째 사본이 생겨 다시 어긋난다.
  const isSellerMallInvoiceChannel = resolveTaxFilingChannelGroup(campaign.salesChannel) === "SELLER_MALL";
  // 개인 셀러는 세금계산서를 주고받지 않는다 — 수수료에서 3.3%를 원천징수해 지급하고
  // 우리가 그 원천세를 직접 신고한다. 이 의무는 셀러 수수료를 지급하는 모든 채널에서
  // 발생하므로(`buildWithholdingReport`가 채널로 걸러내지 않는 것과 동일 원칙),
  // 위 세금계산서 게이트(`isSellerMallInvoiceChannel`)를 여기서 재사용하지 않는다 —
  // 재사용하면 우리몰·브랜드몰의 개인 셀러가 도우미를 못 열게 된다.
  const isIndividualWithholdingSubject = isIndividualSeller(campaign);

  // ⛔ 채널별 방향 문구(「공급사 계산서 수취 · 공급사 지급」)를 이 섹션에 되살리지 말 것 —
  // 오너 지시로 제거했다(2026-08-27). 같은 사실을 바로 아래 「정산 및 회계 일정」 카드가
  // 체크박스·날짜 칸으로 이미 말하고 있어 중복이었다(그 카드가 의무표 SSOT 의 소비처다).

  const handleSupplierAccountSave = async (raw: string) => {
    if (!campaign.partnerId) return;
    const next = raw.trim();
    const res = await fetch(`/api/partners/${campaign.partnerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankAccount: next }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(
        typeof data?.error === "string" ? data.error : "계좌번호 저장에 실패했습니다",
      );
    }
    // 캠페인 행에도 반영해 화면·캘린더 동기화 근거가 어긋나지 않게 한다.
    onCampaignUpdated({ ...campaign, partnerBankAccount: next || null });
  };

  const handleTaxTypeChange = async (value: string) => {
    setIsSavingTaxType(true);
    try {
      const result = await saveCampaignField(campaign.id, "sellerTaxType", value);
      if (!result.success) {
        toast.error(result.error ?? "세무 유형 저장 실패");
        return;
      }
      if (result.data) {
        onCampaignUpdated(result.data);
      }
      toast.success("세무 유형이 저장되었습니다");
    } finally {
      setIsSavingTaxType(false);
    }
  };

  return (
    <section className="space-y-4 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <UserRound className="size-4 text-slate-500" />
          정산 정보
        </h3>
        {/* 「신고자료출력」 버튼(h-8)의 **자리 예약** — 세무 유형을 「개인 원천징수」로
            바꾸면 이 버튼이 나타나는데, 예약이 없으면 헤더 줄이 33px↔45px 로 뛰며
            카드 전체가 출렁인다(오너 지적 2026-08-27, P8 Layout Stability
            「조건부 필드는 마운트/언마운트로 높이를 바꾸지 말고 자리를 예약한다」).
            ⛔ 헤더에 `min-h-*` 를 거는 것으로 대체하지 말 것 — `min-height` 는 패딩·
            테두리를 포함하므로(box-border) 버튼 높이를 그대로 예약하지 못한다(실측:
            `min-h-8` 을 걸고도 12px 차이가 그대로 남았다). 빈 슬롯을 두는 쪽이 정확하다. */}
        <div data-slot="settlement-info-header-action" className="flex h-8 shrink-0 items-center">
          {isIndividualWithholdingSubject ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-8 gap-1 rounded-lg px-2.5 text-[11px] font-semibold"
              onClick={() => setWithholdingHelperOpen(true)}
            >
              <FileText className="size-3.5" />
              신고자료출력
            </Button>
          ) : isSellerMallInvoiceChannel ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-8 gap-1 rounded-lg px-2.5 text-[11px] font-semibold"
              onClick={() => setHelperOpen(true)}
            >
              <FileText className="size-3.5" />
              신고자료출력
            </Button>
          ) : null}
        </div>
      </div>

      <Tabs defaultValue="seller">
        <TabsList className="w-full">
          <TabsTrigger value="seller" className="flex-1 text-xs">셀러</TabsTrigger>
          <TabsTrigger value="supplier" className="flex-1 text-xs">공급사</TabsTrigger>
        </TabsList>

        {/* ⛔ 두 탭의 칸 개수·모양을 다르게 만들지 말 것 — 탭을 오갈 때 섹션 높이가
            흔들린다(오너 지시 2026-08-27). 규칙은 `SETTLEMENT_INFO_GRID` 가 소유한다:
            2열 × 행 하한 고정에 같은 모양의 칸 4개. 값은 전부 한 줄 말줄임이라
            (`InfoCell`) 내용 길이가 행 높이를 바꾸지 않는다. */}
        <TabsContent value="seller" className={SETTLEMENT_INFO_GRID}>
          <InfoCell label="세무 유형">
            <select
              value={campaign.sellerTaxType ?? ""}
              disabled={isSavingTaxType}
              onChange={(event) => void handleTaxTypeChange(event.target.value)}
              className="h-6 w-full min-w-0 rounded-md border border-slate-200 bg-white px-1.5 text-xs font-medium text-slate-700 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-focus-ring disabled:opacity-60"
              aria-label="세무 유형"
            >
              <option value="" disabled>{taxTypeLabel}</option>
              <option value="BUSINESS">{SELLER_TAX_TYPE_LABELS.BUSINESS}</option>
              <option value="INDIVIDUAL">{SELLER_TAX_TYPE_LABELS.INDIVIDUAL}</option>
            </select>
          </InfoCell>
          <InfoCell label="대행사명 / 대표자명">
            <CellValue value={`${recipientName} / ${representativeName}`} />
          </InfoCell>
          <InfoCell label="정산 계좌">
            <CellValue value={account} copyable={account !== "-"} />
          </InfoCell>
          <InfoCell label="세무 이메일">
            <CellValue value={email} />
          </InfoCell>
        </TabsContent>

        <TabsContent value="supplier" className={SETTLEMENT_INFO_GRID}>
          {campaign.partnerId ? (
            <>
              <InfoCell label="공급사명 / 대표자명">
                <CellValue
                  value={`${campaign.partnerName || "-"} / ${campaign.partnerCeoName || "-"}`}
                />
              </InfoCell>
              <InfoCell label="사업자번호">
                <CellValue
                  value={campaign.partnerBusinessNumber || "-"}
                  copyable={Boolean(campaign.partnerBusinessNumber)}
                />
              </InfoCell>
              {/* 배경을 다른 칸의 틴트로 덮지 않는다 — 흰 배경이 "이 칸만 편집 가능"을
                  알리는 정지 상태 신호다(ss-ux 검토 P1). */}
              <EditableAccountCell
                label="정산 계좌"
                description="거래처에 저장됩니다. 같은 공급사의 다른 캠페인·구글 캘린더 대금 일정에도 함께 반영됩니다."
                value={campaign.partnerBankAccount ?? ""}
                onSave={handleSupplierAccountSave}
              />
              <InfoCell label="세무 이메일">
                <CellValue value={campaign.partnerEmail || "-"} />
              </InfoCell>
            </>
          ) : (
            <p className="col-span-2 row-span-2 flex items-center justify-center rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2.5 text-center text-muted-foreground">
              연결된 거래처가 없습니다. 딜에 거래처를 연결하면 공급사 정산 정보가 여기에 표시됩니다.
            </p>
          )}
        </TabsContent>
      </Tabs>
      <TaxInvoiceHelperDialog
        campaign={campaign}
        groupMembers={groupId ? groupMembers ?? undefined : undefined}
        open={helperOpen}
        onOpenChange={setHelperOpen}
      />
      <WithholdingHelperDialog
        campaign={campaign}
        open={withholdingHelperOpen}
        onOpenChange={setWithholdingHelperOpen}
      />
    </section>
  );
}

/**
 * 정산 정보 탭의 그리드 — **탭 간 높이 고정의 실제 장치**다(오너 지시 2026-08-27).
 *
 * 2열 × 행 **하한을 고정**한 2행이라, 어느 탭이 열려 있든(칸 4개든, 거래처 미연결
 * 안내 한 장이든) 패널 높이가 `66×2 + gap` 으로 같다. ⛔ `grid-rows-2`(=1fr 2행)로
 * 되돌리지 말 것 — 1fr 은 **내용이 정하는** 높이라 안내문 한 줄만 있는 빈 상태에서
 * 패널이 줄어든다(그게 이 값을 박은 이유다).
 *
 * `minmax(66px, auto)` 인 것도 의도다 — 하한은 지키되 언젠가 두 줄짜리 칸이 생기면
 * 잘리는 대신 늘어난다(고정 `66px` 이면 트랙 밖으로 넘친다, ss-ux 검토 P2).
 * 66px 의 출처는 `InfoCell` 의 구조다: 라벨 줄 16 + 간격 4 + 값 줄 24 + 패딩 20 + 테두리 2.
 * 칸 구조를 바꾸면 이 숫자도 함께 고쳐야 하고, 실렌더 계측이 그 짝을 확인한다.
 */
const SETTLEMENT_INFO_GRID =
  "grid grid-cols-2 grid-rows-[minmax(66px,auto)_minmax(66px,auto)] gap-2.5 text-xs";

/**
 * 정산 정보 탭의 **칸 한 개**(구 `InfoBox` 의 그리드판).
 *
 * 높이를 픽셀로 박지 않고 `라벨 1줄 + 값 1줄(min-h-6)` 구조로 고정한다 — 두 탭이 같은
 * 모양의 칸을 같은 개수 놓으면 높이가 자동으로 같아진다. 값은 항상 한 줄 말줄임이라
 * (`CellValue`) 긴 이메일·계좌가 행 높이를 밀어 올리지 못한다.
 */
function InfoCell({
  label,
  className,
  labelAction,
  children,
}: {
  label: string;
  className?: string;
  /** 라벨 옆 보조 컨트롤(설명 툴팁 등). */
  labelAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      data-slot="settlement-info-cell"
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2.5",
        className,
      )}
    >
      {/* 라벨 줄 높이를 h-4 로 **고정**한다 — 설명 아이콘(14px)이 글자 줄(13.33px)보다
          커서, 고정하지 않으면 아이콘이 있는 칸만 0.67px 높아지고 그만큼 탭 전환 때
          섹션이 움직인다(실측 1.34px). */}
      <div className="mb-1 flex h-4 items-center gap-1">
        <span className="truncate text-[10px] font-semibold text-muted-foreground">{label}</span>
        {labelAction}
      </div>
      <div className="flex min-h-6 items-center justify-between gap-1.5">{children}</div>
    </div>
  );
}

/** 칸의 읽기 전용 값 + 선택적 복사 버튼. */
function CellValue({ value, copyable = false }: { value: string; copyable?: boolean }) {
  return (
    <>
      <span className="min-w-0 truncate font-medium text-slate-700" title={value}>
        {value}
      </span>
      {copyable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast.success("클립보드에 복사되었습니다");
          }}
          title="복사"
        >
          <Copy className="size-3.5" />
        </Button>
      ) : null}
    </>
  );
}

/**
 * 공급사 정산 계좌 칸 — 읽기 칸과 **같은 모양**을 유지한 채 그 자리에서 편집한다.
 *
 * ⛔ 공용 `InlineEditField` 를 쓰지 않는 이유: 그쪽은 `h-9` 한 줄에 라벨·값을 좌우로
 * 놓는 형태라, 이 그리드의 칸(라벨 위·값 아래)과 높이도 골격도 어긋나 탭 간 높이 고정이
 * 깨진다. 대신 그 컴포넌트의 **계약은 그대로 승계한다** — 커밋은 blur·Enter(입력 중
 * 저장 금지, `InlineDateField` 교훈) · 성공 무음 + 실패만 토스트(P2 Toast Ownership,
 * `withMutationFeedback` 위임) · 실패 시 낙관값 원복.
 */
function EditableAccountCell({
  label,
  description,
  value,
  onSave,
}: {
  label: string;
  description: string;
  value: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [optimisticValue, setOptimisticValue] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const shown = optimisticValue ?? value;

  // 편집 중이 아닐 때 외부 값 변경을 초안에 반영한다(`InlineEditField` 와 같은 방어).
  // 지금은 편집 진입 클릭이 매번 초안을 다시 채우지만, 프로그램적으로 편집을 여는
  // 경로가 생기면 그 순간부터 낡은 초안이 저장될 수 있다.
  useEffect(() => {
    if (!isEditing) setDraft(value);
  }, [value, isEditing]);

  const commit = async (next: string) => {
    setIsEditing(false);
    if (next === shown) return;
    setOptimisticValue(next);
    setIsSaving(true);
    try {
      await withMutationFeedback(onSave(next), undefined, "정산 계좌 저장에 실패했습니다");
    } catch {
      // 서버가 거절했으면 낙관값을 버리고 원래 값으로 돌아간다(토스트는 위에서 이미 떴다).
    } finally {
      setOptimisticValue(null);
      setIsSaving(false);
    }
  };

  return (
    <InfoCell
      label={label}
      className="bg-white"
      labelAction={
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground"
                aria-label={`${label} 설명`}
              >
                <Info className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              className="max-w-[240px] rounded-lg border-0 bg-slate-900 px-2.5 py-1.5 text-[11px] leading-normal text-white shadow-overlay"
            >
              {description}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      }
    >
      {isEditing ? (
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit(draft.trim())}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(shown);
              setIsEditing(false);
            }
          }}
          aria-label={label}
          className="h-6 w-full min-w-0 rounded-md border border-slate-200 bg-white px-1.5 text-xs font-medium text-slate-700 outline-none focus:border-primary focus:ring-1 focus:ring-focus-ring"
        />
      ) : (
        <>
          <button
            type="button"
            disabled={isSaving}
            aria-label={`${label} 수정`}
            title={shown || "미등록"}
            onClick={() => {
              setDraft(shown);
              setIsEditing(true);
            }}
            className="group/account flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
          >
            <span
              className={cn(
                "min-w-0 truncate font-medium",
                shown ? "text-slate-700" : "text-muted-foreground",
              )}
            >
              {shown || "미등록"}
            </span>
            <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/account:opacity-100" />
          </button>
          {shown ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={async () => {
                await navigator.clipboard.writeText(shown);
                toast.success("클립보드에 복사되었습니다");
              }}
              title="복사"
            >
              <Copy className="size-3.5" />
            </Button>
          ) : null}
        </>
      )}
    </InfoCell>
  );
}

/**
 * 재무 정산 내역의 한 줄.
 *
 * `danger` = 실제로 나가는 돈(판매대행비·부가세·운영비) → 자금 방향축(`--money-out`).
 * 값은 기존 `rose-600` 과 동일한 #E11D48 이라 시각 변화가 없다 — 리터럴을 토큰으로 옮긴 것.
 *
 * `amount` 를 주면 손익 줄로 취급해 **부호를 따른다**(profit-tone SSOT). 이전엔 `accent` 가
 * `text-primary` 고정이라 적자여도 네이비로 떠서 색이 아무 말도 하지 않았다. 적자에
 * `--money-out` 을 쓰지 않는 이유는 profit-tone.ts 주석 참조(방향축 ≠ 심각도축).
 */
function FinancialLine({
  label,
  value,
  strong = false,
  danger = false,
  accent = false,
  muted = false,
  amount,
  tag,
  hint,
}: {
  label: string;
  value: string;
  strong?: boolean;
  danger?: boolean;
  accent?: boolean;
  muted?: boolean;
  /** 손익 금액. 주면 부호에 따라 색이 갈린다. */
  amount?: number | null;
  /**
   * 라벨 뒤 중립 태그(예: 정산 기준액의 「고정」). 브랜드 네이비 틴트는 5개 의미축의
   * hue 가 아니라 **중립 태그 캐리어**라 P8 「축 밖은 무채색」의 허용 예외다.
   * 총액 행은 박스 캐리어를 쓰므로 이 태그와 짝이 되어 「기준 vs 총액」을 가른다.
   */
  tag?: string;
  /**
   * 값의 근거 설명 — 라벨 옆 **설명 아이콘을 눌러서 본다**(오너 지시 2026-08-28).
   * ⛔ 라벨 아래 상시 표시로 되돌리지 말 것: 원장 줄마다 두 줄이 되어 카드가 길어지고,
   *    매번 읽을 문장이 아니라 처음 한 번 확인하는 문장이다.
   */
  hint?: string;
}) {
  const tone = amount === undefined ? null : resolveProfitTone(amount);
  return (
    <div
      className={cn(
        "grid min-h-8 grid-cols-[minmax(0,1fr)_84px_244px] items-center gap-3 px-2 py-1.5",
        // accent 틴트는 인디고였다 — 강조는 의미축이 아니라 위계라 무채색이 맞다(P8 원칙 4).
        // 값 자체의 색은 아래 `tone`(profit-tone SSOT)이 전담한다.
        accent && "rounded-lg bg-slate-100 text-primary",
        muted && "text-slate-500",
      )}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate">{label}</span>
          {tag ? (
            <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {tag}
            </span>
          ) : null}
          {hint ? <HelpPopover ariaLabel={`${label} 설명`} text={hint} /> : null}
        </span>
      </span>
      <span aria-hidden="true" />
      <span
        className={cn(
          "justify-self-end text-right tabular-nums",
          strong && "text-slate-900",
          danger && "text-money-out",
          accent && "text-primary",
          // 원장 줄이라 **밀집 강도**다 — 흑자는 색을 받지 않는다. 이 표는 한 화면에
          // 열 줄 넘게 깔리므로 흑자까지 칠하면 색이 그 열의 배경이 되고 적자가 묻힌다
          // (P8 §3 "목록 행·원장 = 저강도"). 위 헤더 요약값은 패널당 1개라 초점 강도다.
          tone && PROFIT_TONE_TEXT_DENSE[tone],
        )}
      >
        {value}
      </span>
    </div>
  );
}

function FinancialRate({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="flex h-9 min-w-0 items-center justify-between gap-2 rounded-lg bg-white px-3 py-1">
      <div className="min-w-0 truncate text-[10px] text-muted-foreground">{label}</div>
      <div className="shrink-0 text-right font-semibold text-slate-700">{value ?? 0}</div>
    </div>
  );
}

function SettlementWaitPanel({
  campaign,
  onStartSettlement,
}: {
  campaign: CampaignRow;
  onStartSettlement: () => Promise<void>;
}) {
  const endDate = parseYmd(campaign.endDate);
  // 반품기간 기본값은 `settlement-stage.RETURN_PERIOD_DAYS` 가 소유한다 — 「정산 착수
  // 지연」(데이터 점검 카드)이 같은 숫자로 발화해야 이 패널과 알림이 같은 날을 가리킨다.
  const returnPeriodEndDate = campaign.returnPeriodEndDate
    ? parseYmd(campaign.returnPeriodEndDate)
    : addDays(endDate, RETURN_PERIOD_DAYS);
  const today = new Date();
  const daysAfterEnd = Math.max(0, dayDiff(endDate, today));
  const isCheckRequired = daysAfterEnd >= SETTLEMENT_CHECK_DAYS;
  const isTransferReady = daysAfterEnd >= RETURN_PERIOD_DAYS;

  return (
    <div className="space-y-3 rounded-[24px] border border-amber-200 bg-amber-50/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-amber-950">정산 대기 기준</h3>
          <p className="mt-1 text-xs leading-5 text-amber-800">
            행사 종료 후 반품기간과 정산금 입금을 확인하는 구간입니다.
          </p>
        </div>
        <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-800">
          종료 +{daysAfterEnd}일
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-white/80 px-3 py-2">
          <div className="text-muted-foreground">반품기간 종료 기준</div>
          <div className="mt-1 font-medium">{formatDate(returnPeriodEndDate.toISOString())}</div>
        </div>
        <div className="rounded-lg bg-white/80 px-3 py-2">
          <div className="text-muted-foreground">정산 확인 상태</div>
          <div className="mt-1 font-medium">
            {isTransferReady
              ? "정산 진행 시작 가능"
              : isCheckRequired
                ? "정산금 확인 필요"
                : "반품기간 대기"}
          </div>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={!isTransferReady}
        onClick={() => void onStartSettlement()}
      >
        정산 진행 시작
      </Button>
    </div>
  );
}

function parseYmd(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00`);
}

function addDays(value: Date, amount: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + amount);
  return next;
}

function dayDiff(from: Date, to: Date) {
  const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const toDay = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.floor((toDay.getTime() - fromDay.getTime()) / (24 * 60 * 60 * 1000));
}

function HistoryRow({
  label,
  value,
  detail,
  highlight = false,
}: {
  label: string;
  value: string;
  detail?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-lg border px-3 py-2",
        highlight
          ? "border-primary/20 bg-primary/5 shadow-soft-sm"
          : "bg-background",
      )}
    >
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        {detail ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
      </div>
      <div className="shrink-0 font-mono text-xs text-foreground">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CampaignLinkSection — 셀러 배포용 링크 표면 라우터
// ---------------------------------------------------------------------------

/**
 * 셀러에게 줄 링크는 한 화면에 **하나만** 편다.
 *
 * 두 방식을 나란히 놓으면 복사 버튼이 둘이 되고, 잘못 고른 사실은 캠페인이 끝나
 * 유입 데이터가 0건인 것을 볼 때까지 드러나지 않는다. 판정은
 * `resolveCampaignLinkSurface`(SSOT) 가 하고 여기서는 렌더만 한다.
 *
 * 반대 표면은 **없애지 않고 접어둔다.** 판매채널이 잘못 설정돼 있으면 분기가 틀린
 * 카드를 펴는데, 그때 손으로 갈 길이 없으면 채널을 고치기 전까지 작업이 막힌다.
 */
function CampaignLinkSection({
  campaign,
  onCampaignUpdated,
}: {
  campaign: CampaignRow;
  onCampaignUpdated: (updated: CampaignRow) => void;
}) {
  const { surface, channelUnassigned } = resolveCampaignLinkSurface(campaign.salesChannel);
  const [showAlternate, setShowAlternate] = useState(false);

  const shortLinkCard = (
    <CampaignShortLinkCard
      campaign={campaign}
      channelUnassigned={channelUnassigned}
      onCampaignUpdated={onCampaignUpdated}
    />
  );
  const naverParamsCard = (
    <MarketingLinkConverter
      sellerId={campaign.sellerId}
      snsType={campaign.snsType}
      campaignId={campaign.id}
      snsHandle={campaign.snsHandle ?? ""}
      defaultBaseUrl={campaign.baseNaverLink ?? ""}
      onCampaignUpdated={onCampaignUpdated}
    />
  );

  const isShortLinkPrimary = surface === "SHORT_LINK";

  return (
    <div className="space-y-3">
      {isShortLinkPrimary ? shortLinkCard : naverParamsCard}

      {showAlternate ? (
        isShortLinkPrimary ? naverParamsCard : shortLinkCard
      ) : (
        <button
          type="button"
          onClick={() => setShowAlternate(true)}
          className="w-full rounded-lg px-3 py-2 text-[11px] text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {/* 라벨은 펼쳐질 카드의 **실제 헤더 문구**와 같아야 한다 — 이름이 두 벌이면
              운영자가 "이게 그건가" 하고 멈춘다. */}
          {isShortLinkPrimary ? "고객 분석 링크 변환 열기" : "셀러 배포용 링크 열기"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarketingLinkConverter — 마케팅 링크 변환 컴포넌트
// ---------------------------------------------------------------------------

type MarketingLinkConverterProps = {
  sellerId: string;
  snsType: string;
  campaignId: string;
  snsHandle: string;
  defaultBaseUrl?: string;
  onCampaignUpdated: (updated: CampaignRow) => void;
};

function isValidUrl(str: string): boolean {
  try { new URL(str); return true; } catch { return false; }
}

export function MarketingLinkConverter({
  sellerId,
  snsType,
  campaignId,
  snsHandle,
  defaultBaseUrl = "",
  onCampaignUpdated,
}: MarketingLinkConverterProps) {
  const [inputUrl, setInputUrl] = useState(defaultBaseUrl);
  const [convertedUrl, setConvertedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // defaultBaseUrl 변경 시 inputUrl 동기화
  useEffect(() => {
    setInputUrl(defaultBaseUrl);
    if (!defaultBaseUrl) {
      setConvertedUrl(null);
    }
  }, [defaultBaseUrl]);

  // 최초 로드 시 defaultBaseUrl이 있으면 자동 변환 수행
  useEffect(() => {
    if (defaultBaseUrl && isValidUrl(defaultBaseUrl.trim())) {
      const result = buildNaverTrackingLink({
        baseUrl: defaultBaseUrl.trim(),
        snsType: snsType as import("@/lib/crm-types").SnsType,
        sellerId,
        campaignId,
        overrideParams: {
          nt_source: "instalink",
          nt_medium: "social",
          nt_detail: "wagcm",
          nt_keyword: snsHandle || undefined,
        },
      });
      setConvertedUrl(result);
    } else {
      setConvertedUrl(null);
    }
  }, [defaultBaseUrl, snsType, sellerId, campaignId, snsHandle]);

  async function handleConvert() {
    const trimmed = inputUrl.trim();
    if (!trimmed) {
      setError("URL을 입력해주세요");
      setConvertedUrl(null);
      return;
    }
    if (!isValidUrl(trimmed)) {
      setError("유효한 URL 형식이 아닙니다 (https:// 로 시작해야 합니다)");
      setConvertedUrl(null);
      return;
    }
    setError(null);
    setIsSaving(true);
    try {
      // DB에 마케팅 링크 저장 연동
      const result = await saveCampaignField(campaignId, "baseNaverLink", trimmed);
      if (!result.success) {
        setError(result.error ?? "마케팅 링크 저장 실패");
        setConvertedUrl(null);
        return;
      }
      
      // 트래킹 링크 생성
      const trackingResult = buildNaverTrackingLink({
        baseUrl: trimmed,
        snsType: snsType as import("@/lib/crm-types").SnsType,
        sellerId,
        campaignId,
        overrideParams: {
          nt_source: "instalink",
          nt_medium: "social",
          nt_detail: "wagcm",
          nt_keyword: snsHandle || undefined,
        },
      });
      setConvertedUrl(trackingResult);
      setCopied(false);
      toast.success("마케팅 링크가 저장 및 변환되었습니다");
      if (result.data) {
        onCampaignUpdated(result.data);
      }
    } catch {
      setError("저장 중 네트워크 오류가 발생했습니다");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCopy() {
    if (!convertedUrl) return;
    await navigator.clipboard.writeText(convertedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-4 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      <div className="flex items-center gap-2">
        <Link2 className="mr-2 size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">고객 분석 링크 변환</h3>
      </div>
      <p className="text-xs text-muted-foreground leading-5">
        마케팅 URL을 입력하면 nt_source · nt_medium · nt_detail 트래킹 파라미터가 자동으로 추가됩니다.
      </p>

      {/* 입력 + 변환 버튼 */}
      <div className="flex gap-2">
        <input
          type="url"
          value={inputUrl}
          onChange={(e) => {
            setInputUrl(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleConvert();
          }}
          placeholder="https://example.com/product/..."
          className="flex-1 h-8 rounded-md border border-border bg-background px-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-focus-ring"
        />
        <Button size="sm" onClick={() => void handleConvert()} disabled={isSaving} className="shrink-0">
          {isSaving ? "저장중..." : "변환"}
        </Button>
      </div>

      {/* 에러 */}
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {/* 변환 결과 (영역 미리 확보) */}
      <div className="space-y-2 border-t border-slate-100 pt-3">
        <p className="text-xs text-muted-foreground font-medium">변환된 트래킹 URL</p>
        {convertedUrl ? (
          <>
            <div className="flex items-start gap-2">
              <code className="flex-1 rounded-lg border bg-muted/40 px-3 py-2 text-[10px] font-mono break-all leading-relaxed text-slate-600 max-h-16 overflow-y-auto">
                {convertedUrl}
              </code>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                className="flex-1"
              >
                <Copy className="mr-1 size-3" />
                {copied ? "복사됨!" : "복사"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="flex-1"
              >
                <a href={convertedUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-1 size-3" />
                  열기
                </a>
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-dashed bg-slate-50/50 p-4 text-center">
            <span className="text-xs text-slate-500">아직 변환된 링크가 없습니다.</span>
            <span className="text-[10px] text-slate-500 leading-relaxed">
              마케팅 링크를 입력하고 변환 버튼을 클릭하면<br />
              고객 분석 트래킹 링크가 생성 및 저장됩니다.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
