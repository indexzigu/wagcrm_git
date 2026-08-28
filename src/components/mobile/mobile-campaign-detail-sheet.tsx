"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  LayersIcon,
  PackageIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShoppingCartIcon,
  UserRoundIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/crm/status-badge";
import { MobileSheetCloseChip } from "./mobile-sheet-close-chip";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateWithWeekday } from "@/lib/format";
import {
  MONEY_DIRECTION_ICON,
  MONEY_DIRECTION_TEXT,
  MONEY_ROW_SETTLED_MUTED,
} from "@/lib/money-direction";
import {
  MobileSheetCard,
  MobileSheetRow,
} from "./mobile-sheet-card";
import { extractCommonItemPrefix } from "@/lib/item-name-prefix";
import { toYmd } from "@/lib/mobile-schedule-grid";
import type { CampaignRow, CampaignStatus, SalesChannel } from "@/lib/crm-types";
import {
  resolveCampaignMoneySlots,
  resolveMoneySlotEffectiveDate,
  type CampaignMoneySlot,
  type MoneySlotAmountDisplay,
} from "@/lib/tax-filing-board";
import { moneySlotAmountDisplay, representativeStatus } from "@/lib/calendar-entities";
import { sumGroupManualGoodsCost } from "@/lib/goods-cost";
import type {
  CampaignDailyPoint,
  CampaignItemSales,
  CampaignStatusBreakdown,
  MobileCampaignSalesResponse,
} from "@/lib/mobile-campaign-sales";
import {
  interpretRefreshResponse,
  type MobileOrderRefreshResponse,
} from "@/lib/mobile-order-refresh";
import { PULL_THRESHOLD_PX, usePullToRefresh } from "@/hooks/use-pull-to-refresh";

export type MobileCampaignDetailData = {
  id: string;
  kind?: "campaign" | "group";
  groupId?: string | null;
  dealName: string;
  sellerName: string;
  roundNumber: number | null;
  status: string;
  /**
   * 대금 줄 구성의 판정 입력 — 슬롯 SSOT `resolveCampaignMoneySlots`.
   *
   * ⛔ **선택 필드(`?:`)로 되돌리지 말 것, `| null` 도 붙이지 말 것.** 2026-08-25 실사고:
   * 이 세 필드가 선택이던 동안 **생산자와 소비자를 서로 다른 PR 이 나눠 가져** 연결 누락이
   * 타입에 안 걸렸다 — 캘린더 홈의 매핑이 채널을 안 넘겨 자사몰 캠페인이 **있지도 않은
   * 입금 줄을 세우고 공급사 지급 줄을 잃었다**(크래시가 아닌 조용한 오표시라 실렌더에서만
   * 보였다). `| null` 로 남기면 절반만 막힌다: `resolveTaxFilingChannelGroup` 은
   * `UNSPECIFIED` 를 셀러몰로 떨어뜨리는 것이 **의도된 동작**이라 `null`·`""` 과 「진짜
   * 미지정」이 원리적으로 구분되지 않는다. ⛔ 그 접힘을 없애려고 `resolveCampaignMoneySlots`
   * 쪽을 고치지 말 것 — 거기서 던지거나 기본값을 바꾸면 미지정 캠페인의 대금 칸이 전
   * 표면에서 사라진다. 막는 자리는 **여기(호출부가 빈 값을 못 만들게)** 다.
   */
  salesChannel: SalesChannel;
  startDate: string;
  endDate: string;
  expectedDepositDate: string | null;
  expectedPayoutDate: string | null;
  expectedSupplierPayoutDate: string | null;
  /**
   * 실제로 오간 날 — 완료된 줄은 이 날짜를 단다(`resolveMoneySlotEffectiveDate`).
   * ⛔ 선택 필드로 되돌리지 말 것: 위 채널 필드와 **같은 사고**가 여기 그대로 걸린다
   * (생산자가 빠뜨려도 타입이 안 잡고, 화면은 완료 줄에 예정일을 계속 단다).
   */
  depositReceivedAt: string | null;
  payoutCompletedAt: string | null;
  supplierPayoutCompletedAt: string | null;
  settlementSales: number | null;
  actualSales: number | null;
  sellerExpense: number | null;
  actualPayoutAmount: number | null;
  /**
   * 수기 물품대금 — 공급사 지급 줄의 근거(T-057). 그룹이면 **부분 합산 금지** 규약으로
   * 접힌 값이다(`sumGroupManualGoodsCost`) — 아래 그룹 빌더 참조.
   */
  settlementGoodsCost: number | null;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  isSupplierPayoutCompleted: boolean;
  members?: MobileCampaignDetailMember[];
};

export type MobileCampaignDetailMember = {
  id: string;
  dealName: string;
  sellerName: string;
  roundNumber: number | null;
  status: string;
  startDate: string;
  endDate: string;
  settlementSales: number | null;
  actualSales: number | null;
  sellerExpense: number | null;
  actualPayoutAmount: number | null;
};

/**
 * 상세 시트가 실제로 소비하는 최소 필드 집합(CampaignRow의 구조적 supertype).
 * 전체 CampaignRow(데스크톱)와 MobileSettlementCampaign(모바일 경량 스냅샷, #149 리뷰)
 * 양쪽이 그대로 대입된다.
 */
export type CampaignDetailSource = Pick<
  CampaignRow,
  | "id"
  | "groupId"
  | "dealName"
  | "sellerName"
  | "roundNumber"
  | "status"
  | "salesChannel"
  | "startDate"
  | "endDate"
  | "expectedDepositDate"
  | "expectedPayoutDate"
  | "expectedSupplierPayoutDate"
  | "depositReceivedAt"
  | "payoutCompletedAt"
  | "supplierPayoutCompletedAt"
  | "settlementSales"
  | "actualSales"
  | "sellerExpense"
  | "actualPayoutAmount"
  | "settlementGoodsCost"
  | "isDepositReceived"
  | "isPayoutCompleted"
  | "isSupplierPayoutCompleted"
>;

export function campaignRowToDetailData(row: CampaignDetailSource): MobileCampaignDetailData {
  return {
    id: row.id,
    kind: "campaign",
    groupId: row.groupId ?? null,
    dealName: row.dealName,
    sellerName: row.sellerName,
    roundNumber: row.roundNumber ?? null,
    status: row.status,
    salesChannel: row.salesChannel,
    startDate: row.startDate,
    endDate: row.endDate,
    expectedDepositDate: row.expectedDepositDate ?? null,
    expectedPayoutDate: row.expectedPayoutDate ?? null,
    expectedSupplierPayoutDate: row.expectedSupplierPayoutDate ?? null,
    depositReceivedAt: row.depositReceivedAt ?? null,
    payoutCompletedAt: row.payoutCompletedAt ?? null,
    supplierPayoutCompletedAt: row.supplierPayoutCompletedAt ?? null,
    settlementSales: row.settlementSales ?? null,
    actualSales: row.actualSales ?? null,
    sellerExpense: row.sellerExpense ?? null,
    actualPayoutAmount: row.actualPayoutAmount ?? null,
    settlementGoodsCost: row.settlementGoodsCost ?? null,
    isDepositReceived: Boolean(row.isDepositReceived),
    isPayoutCompleted: Boolean(row.isPayoutCompleted),
    isSupplierPayoutCompleted: Boolean(row.isSupplierPayoutCompleted),
    members: undefined,
  };
}

function sumNullable(values: Array<number | null | undefined>): number | null {
  const numeric = values.filter((value): value is number => value != null);
  if (numeric.length === 0) return null;
  return numeric.reduce((sum, value) => sum + value, 0);
}

function minIso(values: string[]): string {
  return values.reduce((min, value) => (value < min ? value : min), values[0]);
}

function maxIso(values: string[]): string {
  return values.reduce((max, value) => (value > max ? value : max), values[0]);
}

export function campaignRowsToGroupDetailData(
  rows: CampaignRow[],
  selectedRow: CampaignRow,
): MobileCampaignDetailData {
  const groupId = selectedRow.groupId ?? null;
  if (!groupId) return campaignRowToDetailData(selectedRow);

  const members = rows
    .filter((row) => row.groupId === groupId)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.dealName.localeCompare(b.dealName, "ko"));
  if (members.length < 2) return campaignRowToDetailData(selectedRow);

  const first = members[0];
  return {
    id: `group:${groupId}`,
    kind: "group",
    groupId,
    dealName: `${first.dealName} 외 ${members.length - 1}`,
    sellerName: first.sellerName,
    roundNumber: null,
    status: representativeStatus(members.map((member) => member.status as CampaignStatus)),
    // 채널은 대표 멤버 것 — 그룹은 딜 분할이라 실무상 같다(desktop-dashboard 의 그룹
    // 이벤트와 같은 규약: 갈릴 때 조용히 두 채널의 칸을 합치지 않는다).
    salesChannel: first.salesChannel,
    startDate: minIso(members.map((member) => member.startDate)),
    endDate: maxIso(members.map((member) => member.endDate)),
    expectedDepositDate: first.expectedDepositDate ?? null,
    expectedPayoutDate: first.expectedPayoutDate ?? null,
    expectedSupplierPayoutDate: first.expectedSupplierPayoutDate ?? null,
    // 그룹은 대표 멤버가 곧 그룹 값이다 — `toCampaignRow` 가 그룹 스칼라를 오버레이한다.
    depositReceivedAt: first.depositReceivedAt ?? null,
    payoutCompletedAt: first.payoutCompletedAt ?? null,
    supplierPayoutCompletedAt: first.supplierPayoutCompletedAt ?? null,
    // ⛔ 여기서 금액을 합산하지 말 것 — 기준이 채널마다 다르고 뺄셈 기준은 멤버별로
    // 계산한 뒤 합산해야 한다. 대금 줄은 아래 `members` 를 그대로 쓴다.
    settlementSales: first.settlementSales ?? null,
    actualSales: first.actualSales ?? null,
    sellerExpense: first.sellerExpense ?? null,
    actualPayoutAmount: sumNullable(members.map((member) => member.actualPayoutAmount)),
    // ⛔ **`sumNullable` 로 접지 말 것** — 그룹은 매입 계산서 **한 장**이라 입력된 멤버만
    //    더하면 「일부만 반영된 합계」가 실물 총액인 것처럼 보인다. 판정은 SSOT 에 위임한다
    //    (한 멤버라도 미입력이면 그룹 전체가 「미정」). 합산 이관 멤버의 `0` 은 미입력이
    //    아니므로 그대로 통과한다.
    settlementGoodsCost: sumGroupManualGoodsCost(members),
    isDepositReceived: members.every((member) => Boolean(member.isDepositReceived)),
    isPayoutCompleted: members.every((member) => Boolean(member.isPayoutCompleted)),
    isSupplierPayoutCompleted: members.every((member) => Boolean(member.isSupplierPayoutCompleted)),
    members: members.map((member) => ({
      id: member.id,
      dealName: member.dealName,
      sellerName: member.sellerName,
      roundNumber: member.roundNumber ?? null,
      status: member.status,
      startDate: member.startDate,
      endDate: member.endDate,
      settlementSales: member.settlementSales ?? null,
      actualSales: member.actualSales ?? null,
      sellerExpense: member.sellerExpense ?? null,
      actualPayoutAmount: member.actualPayoutAmount ?? null,
    })),
  };
}

export type SettlementDisplayLabel = {
  label: "예정" | "확정" | "지급완료";
  overdue: boolean;
};

/**
 * 한 칸의 표시 라벨 — 완료면 방향별 완료어(입금 = 확정 · 지급 = 지급완료), 아니면 예정 +
 * 예정일 경과 시 지연.
 *
 * ⛔ 입금·지급용 함수를 따로 두지 말 것(종전 `getDepositDisplayLabel`/
 * `getPayoutDisplayLabel`). 자사몰은 칸이 [공급사 지급, 셀러 지급] 둘 다 지급이라 함수
 * 이름으로 칸을 가르는 순간 공급사 레그가 갈 자리가 없다 — 판정 입력은 **슬롯**이다.
 */
export function getSlotDisplayLabel(
  slot: CampaignMoneySlot,
  data: MoneySlotValues,
  todayYmd: string,
): SettlementDisplayLabel {
  if (data[slot.flagField]) {
    return { label: slot.kind === "DEPOSIT" ? "확정" : "지급완료", overdue: false };
  }
  const due = data[slot.expectedField]?.slice(0, 10) ?? null;
  return { label: "예정", overdue: due != null && due < todayYmd };
}

/** 슬롯이 읽는 값들 — 상세 데이터에서 이 부분만 떼어낸 구조적 계약. */
export type MoneySlotValues = {
  [K in CampaignMoneySlot["expectedField"]]?: string | null;
} & {
  [K in CampaignMoneySlot["completedAtField"]]?: string | null;
} & {
  [K in CampaignMoneySlot["flagField"]]?: boolean;
};

function formatMd(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${m}.${d}`;
}

function formatDateLabel(iso: string | null): string {
  if (!iso) return "예정일 미정";
  return formatDateWithWeekday(iso);
}

/*
 * 🪦 `formatDeadlineLabel`(「마감 D-7」·「마감 D-day」·「마감 지남」) 은 제거됐다 —
 * 오너 지시 2026-08-26: *"디데이가 필요한 곳에서는 사용을 하는데 **판매 마감에 대해서는
 * 디데이를 할 필요 없다**는 취지야"*. 소비처 2곳(헤더 설명 줄 · 일정·정산 카드의
 * 「판매 기간」 행)에서 함께 걷었다.
 *
 * ⛔ **D-day 표기 방식 자체가 폐기된 것이 아니다** — 원천세 신고 절차 카드의 D-day
 * (`formatDDay`·`getDDayLevel`, `src/lib/tax-filing-log.ts`)는 **그대로 쓴다**. 법정 신고
 * 기한은 놓치면 가산세가 붙는 마감이지만, 캠페인 판매 종료일은 그런 성격이 아니라는
 * 것이 오너 판단이다. 그 둘을 "같은 D-day"로 묶어 되살리지 말 것.
 */

function formatHm(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm} 기준`;
}

const STATUS_SEGMENTS: {
  key: keyof CampaignStatusBreakdown;
  label: string;
  tone: string;
  dot: string;
}[] = [
  { key: "newOrderBefore", label: "주문확인 전", tone: "bg-primary", dot: "bg-primary" },
  { key: "newOrderAfter", label: "주문확인 후", tone: "bg-primary/80", dot: "bg-primary/80" },
  { key: "pending", label: "배송대기", tone: "bg-primary/60", dot: "bg-primary/60" },
  { key: "shipping", label: "배송중", tone: "bg-primary/35", dot: "bg-primary/35" },
  { key: "completed", label: "배송완료", tone: "bg-slate-300", dot: "bg-slate-300" },
];

type PulseFetchState = "loading" | "done" | "error";

type MobileCampaignDetailSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaign: MobileCampaignDetailData | null;
  campaignRow?: CampaignRow | null;
  todayYmd?: string;
};

export function MobileCampaignDetailSheet({
  open,
  onOpenChange,
  campaign,
  todayYmd,
}: MobileCampaignDetailSheetProps) {
  const effectiveTodayYmd = todayYmd ?? toYmd(new Date());
  const campaignId = campaign?.id ?? null;
  const salesEndpoint =
    campaign?.kind === "group" && campaign.groupId
      ? `/api/mobile/campaign-groups/${campaign.groupId}/sales`
      : campaignId
        ? `/api/mobile/campaigns/${campaignId}/sales`
        : null;

  const [sales, setSales] = useState<MobileCampaignSalesResponse | null>(null);
  const [salesState, setSalesState] = useState<PulseFetchState>("loading");
  // 당겨서 새로고침(POST /api/mobile/order-sync) 결과에 따른 매출 GET 재조회 키.
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  // 재조회 시 스켈레톤 없이 기존 수치를 유지하기 위한 플래그(당김 재조회 전용).
  const silentReloadRef = useRef(false);
  const followUpTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open || !salesEndpoint) return;
    let cancelled = false;
    const silent = silentReloadRef.current;
    silentReloadRef.current = false;
    if (!silent) {
      setSalesState("loading");
      setRefreshNotice(null);
    }
    fetch(salesEndpoint, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`sales ${response.status}`);
        return response.json() as Promise<MobileCampaignSalesResponse>;
      })
      .then((payload) => {
        if (cancelled) return;
        setSales(payload);
        setSalesState("done");
      })
      .catch((error) => {
        console.error("mobile campaign sales fetch failed:", error);
        if (!cancelled) setSalesState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [open, salesEndpoint, refreshKey]);

  // 시트 언마운트/닫힘 시 syncing 후속 재조회 타이머 정리.
  useEffect(() => {
    if (open) return;
    if (followUpTimerRef.current != null) {
      window.clearTimeout(followUpTimerRef.current);
      followUpTimerRef.current = null;
    }
  }, [open]);
  useEffect(() => {
    return () => {
      if (followUpTimerRef.current != null) {
        window.clearTimeout(followUpTimerRef.current);
      }
    };
  }, []);

  const reloadSales = useCallback(() => {
    silentReloadRef.current = true;
    setRefreshNotice(null);
    setRefreshKey((key) => key + 1);
  }, []);

  const handleOrderRefresh = useCallback(async () => {
    try {
      const response = await fetch("/api/mobile/order-sync", { method: "POST" });
      if (response.status === 429) {
        setRefreshNotice("요청이 잦아요 · 잠시 후 다시");
        return;
      }
      if (!response.ok) {
        setRefreshNotice("동기화 실패");
        return;
      }
      const payload = (await response.json()) as MobileOrderRefreshResponse;
      const action = interpretRefreshResponse(payload);
      if (action.kind === "reload") {
        reloadSales();
        return;
      }
      if (action.kind === "reloadAfterDelay") {
        // syncing: 백그라운드 동기화 완주를 기다렸다가 1회만 재조회한다.
        if (followUpTimerRef.current != null) {
          window.clearTimeout(followUpTimerRef.current);
        }
        followUpTimerRef.current = window.setTimeout(() => {
          followUpTimerRef.current = null;
          reloadSales();
        }, action.delayMs);
        return;
      }
      // fresh 또는 synced(changed=0): 재조회 없이 캡션만.
      setRefreshNotice(action.caption);
    } catch (error) {
      console.error("mobile order refresh failed:", error);
      setRefreshNotice("동기화 실패");
    }
  }, [reloadSales]);

  const { containerRef, pullDistance, refreshing, reducedMotion } = usePullToRefresh({
    onRefresh: handleOrderRefresh,
    disabled: !open || !salesEndpoint,
  });

  if (!campaign) return null;

  // 대금 줄 구성은 채널 슬롯이 정한다 — 자사몰은 [공급사 지급, 셀러 지급] 두 줄이고
  // 입금 줄이 없다(정산 카드·정산 목록과 같은 SSOT).
  const moneySlots = resolveCampaignMoneySlots(campaign.salesChannel);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={containerRef}
        side="bottom"
        showCloseButton={false}
        className="mobile-sheet-safe-bottom top-0 gap-0 overflow-y-auto overscroll-y-contain rounded-none border-0 p-0 bg-slate-50/80 backdrop-blur-3xl"
      >
        {/* ⓪ 당겨서 새로고침 인디케이터 — 과한 모션 금지, reduced-motion 게이트 */}
        <div
          role="status"
          aria-live="polite"
          aria-label={
            refreshing
              ? "매출 동기화 중"
              : pullDistance > 0
                ? "당겨서 매출 새로고침"
                : undefined
          }
          className="flex items-center justify-center overflow-hidden text-slate-400"
          style={{
            height: refreshing ? 36 : pullDistance,
            transition:
              reducedMotion || pullDistance > 0 ? undefined : "height 150ms ease-out",
          }}
        >
          {refreshing || pullDistance > 0 ? (
            <RefreshCwIcon
              aria-hidden="true"
              className={cn("size-4", refreshing && "motion-safe:animate-spin")}
              style={
                !refreshing && !reducedMotion
                  ? {
                      transform: `rotate(${Math.min(pullDistance / PULL_THRESHOLD_PX, 1) * 180}deg)`,
                      opacity: Math.min(pullDistance / PULL_THRESHOLD_PX, 1),
                    }
                  : undefined
              }
            />
          ) : null}
        </div>

        {/* ① 헤더 — 흐름(non-sticky). 탭 상단바와 같은 언어(오너 확정 2026-07-16:
            "상단바 고정이 유의미하지 않다"). sticky·글래스·그림자를 걷어내고 본문과
            함께 스크롤한다. 닫기는 MobileSheetCloseChip(화면 고정)으로 분리 —
            유일한 탈출구라 스크롤 밖으로 내보낼 수 없다(ss-ux 판정, 칩 파일 주석 참조).
            pr-12 는 우상단에 떠 있는 칩과 제목이 겹치지 않게 하는 예약 폭. */}
        <MobileSheetCloseChip label="상세 닫기" />
        <header className="mobile-sheet-safe-top border-b border-slate-200/60 px-5 pb-4 pt-3 pr-12">
          <div className="flex items-center gap-2 mb-1.5">
            <StatusBadge status={campaign.status as CampaignStatus} className="text-[10px] h-5 px-2 shadow-soft-sm" />
          </div>
          <SheetTitle asChild>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-base font-bold text-slate-900 tracking-tight">
                {campaign.dealName}
              </span>
              <span className="inline-flex min-w-0 items-center gap-1">
                <UserRoundIcon aria-hidden="true" className="size-3.5 shrink-0 text-slate-400" />
                <span className="truncate text-[13px] font-medium text-slate-600">
                  {campaign.sellerName}
                </span>
              </span>
              {campaign.roundNumber ? (
                <Badge className="shrink-0 bg-primary/10 text-primary hover:bg-primary/10 border-0 h-5 px-1.5 text-[10px]">
                  {campaign.roundNumber}차
                </Badge>
              ) : null}
              {campaign.kind === "group" && campaign.members ? (
                <Badge className="shrink-0 bg-primary/10 text-primary hover:bg-primary/10 border-0 h-5 px-1.5 text-[10px]">
                  {campaign.members.length}개 딜
                </Badge>
              ) : null}
            </div>
          </SheetTitle>
          <SheetDescription className="mt-2 text-xs font-medium text-slate-500 flex items-center gap-2">
            {/* ⛔ 판매 마감 D-day 를 여기 되살리지 말 것(오너 지시 2026-08-26 — 위 🪦).
                기간 칩만 남는 것이 의도다. */}
            <span className="bg-slate-100 px-2 py-0.5 rounded-md">{formatMd(campaign.startDate)} ~ {formatMd(campaign.endDate)}</span>
          </SheetDescription>
        </header>

        {/* ② 매출상세현황 — 자매 섹션(일정·정산)과 같은 카드 문법으로 수렴(2026-08-02).
            종전 풀폭 흰 밴드는 시트 본문에서 유일하게 카드가 아닌 표면이었다. */}
        <div className="px-3 pt-3">
          <MobileSheetCard
            title="매출 상세 현황"
            ariaLabel="매출상세현황"
            // 칩은 "그 순간 하나의 문자열"이다 — 갱신 알림이 있으면 그것, 없으면 집계 시각.
            chip={
              refreshNotice ??
              (salesState === "done" && sales
                ? sales.source === "live" && sales.asOf
                  ? formatHm(sales.asOf)
                  : sales.source === "cached"
                    ? "최종 집계"
                    : undefined
                : undefined)
            }
          >
            {/* 이 카드의 children 은 행이 아니라 자유 콘텐츠라 본문 좌우 여백을 여기서 준다 —
                자매 카드는 전부 MobileSheetRow 라 행이 자기 px-6 을 갖고 있다. */}
            <div className="px-6 pb-5">
              {salesState === "loading" ? (
                <div
                  aria-busy="true"
                  aria-label="매출상세현황 불러오는 중"
                  className="flex flex-col gap-3"
                >
                  <div className="h-6 w-2/3 animate-pulse rounded-md bg-slate-100" />
                  <div className="h-3 w-full animate-pulse rounded-full bg-slate-100 mt-2" />
                  <div className="h-12 w-full animate-pulse rounded-md bg-slate-100 mt-4" />
                </div>
              ) : salesState === "error" || !sales ? (
                // 카드 안이라 테두리를 빼고 틴트로만 묶는다(카드 속 카드 금지).
                // 색은 raw red 팔레트 대신 status-urgent tint 페어 — StatusBadge 2-tier 규칙과 같은 짝.
                <div className="rounded-xl bg-status-urgent-bg p-3 text-center">
                  <p className="text-[12px] font-medium text-status-urgent-text">데이터를 불러오지 못했습니다</p>
                </div>
              ) : sales.source === "none" ? (
                <div className="rounded-xl bg-slate-50 p-4 text-center">
                  <p className="text-[12px] font-medium text-slate-500">판매 데이터가 연동되지 않았습니다.</p>
                </div>
              ) : (
                <SalesDetailBody sales={sales} todayYmd={effectiveTodayYmd} />
              )}
            </div>
          </MobileSheetCard>
        </div>

        {/* ③ 일정 · 정산 — 구 ③일정 + ④정산 상태를 카드 1장으로 통합(오너 목업 §4).
            상태 배지가 행 안으로 흡수돼 별도 "정산 상태" 섹션은 없다. */}
        <div className="px-3 py-3">
          <MobileSheetCard title="일정 · 정산" ariaLabel="일정 · 정산">
            {/* ⛔ **SUPERSEDED (2026-08-26)** — 종전 주석은 *"D-day 를 이 행에 함께 쓴다
                (오너 확정 2026-07-16). 이전 결정('헤더에만, 여기 금지')의 전제가 '헤더가
                sticky 라 항상 보인다'였는데 헤더가 흐름으로 바뀌면서 무너졌다 — 스크롤 후에는
                이 행이 유일한 마감 참조점이다"* 였다. 그 조문은 **D-day 를 어디에 둘 것인가**를
                정한 것이고, 오너 지시(*"판매 마감에 대해서는 디데이를 할 필요 없다"*)가 그
                상위 전제 자체를 없앴다 — 「어디에」가 아니라 「두지 않는다」다.
                ⛔ 저 낡은 조문("여기가 유일한 마감 참조점")을 근거로 되살리지 말 것. */}
            <MobileSheetRow
              icon={<CalendarIcon aria-hidden="true" className="size-4 shrink-0 text-slate-400" />}
              label="판매 기간"
              value={`${formatDateLabel(campaign.startDate)} → ${formatDateLabel(campaign.endDate)}`}
            />
            {/* 방향 색은 규칙 SSOT(lib/money-direction) — 구 리터럴 emerald-500 은 2.54:1 로
                비텍스트 3:1 도 미달이었다. 이 파일 아래쪽 취소·반품 rose(ClaimsSummary)는
                방향이 아니라 별개 신호라 이 축이 아니다 — 함께 묶지 말 것. */}
            {moneySlots.map((slot) => {
              const display = getSlotDisplayLabel(slot, campaign, effectiveTodayYmd);
              const settled = Boolean(campaign[slot.flagField]);
              const Icon = MONEY_DIRECTION_ICON[slot.kind === "DEPOSIT" ? "in" : "out"];
              // 완료 줄은 방향색을 걷고 무채로 내린다 — 색은 **아직 오갈 돈**에만 남긴다
              // (규칙·근거는 MONEY_ROW_SETTLED_MUTED 주석). 화살표 모양은 그대로라
              // 입금/지급 구분은 잃지 않는다. 일정탭 날짜 목록과 같은 규칙이다.
              const tone = settled
                ? MONEY_ROW_SETTLED_MUTED
                : MONEY_DIRECTION_TEXT[slot.kind === "DEPOSIT" ? "in" : "out"];
              // 자사몰은 두 줄이 모두 「지급」이라 상대를 병기해야 구분된다(정산 카드·
              // 정산 목록 배지와 같은 문법). ⛔ 종전 주석 *"금액은 셀러 축 컬럼뿐이라 공급사
              // 지급 줄은 항상 「금액 미정」"* 은 **SUPERSEDED**(T-057, 오너 승인 2026-08-27)
              // — 공급사 지급 줄은 이제 **수기 물품대금**을 읽어 입력이 있으면 금액이 뜬다.
              // 미입력일 때만 「미정」이다 — ⛔ 그때 0 으로 접지 말 것(대기 시트 slotAmount 주석).
              // ⛔ 삼항으로 되돌리지 말 것: 슬롯→금액 매핑의 정본은 `moneySlotAmount` 이고
              // 그쪽 `Record` 가 새 슬롯 키를 컴파일로 잡는다(사본은 그 가드를 우회한다).
              // 숫자가 아니라 **판정**을 받는다 — 합산 이관은 금액이 아니라 상태다.
              const amount = moneySlotAmountDisplay(campaign, slot);
              return (
                <SettlementRow
                  key={slot.flagField}
                  icon={<Icon aria-hidden="true" className={`size-4 shrink-0 ${tone}`} />}
                  // 날짜는 판정 SSOT 가 고른다 — 완료 줄에 예정일을 달면 아무 일도 없던
                  // 날을 말하게 되고, 같은 시트를 여는 캘린더와 어긋난다.
                  label={`${slot.counterpartLabel} ${slot.verb} ${
                    settled ? (slot.kind === "DEPOSIT" ? "확정" : "완료") : "예정"
                  } · ${formatDateLabel(resolveMoneySlotEffectiveDate(slot, campaign).date ?? null)}`}
                  amount={amount}
                  settled={settled}
                  display={display}
                />
              );
            })}
          </MobileSheetCard>
        </div>

        {/* ③-b 그룹 구성 캠페인 */}
        {campaign.kind === "group" && campaign.members && campaign.members.length > 1 ? (
          <GroupMembersSection members={campaign.members} />
        ) : null}

        {/* ⑤ 메모 */}
        <div className="px-5 py-8 text-center">
          <p className="text-[12px] text-slate-500">메모 및 상세 설정은 PC에서 확인할 수 있습니다.</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * 입금·지급 한 줄 — 위: "입금 예정 · 7월 20일 (월)", 아래: 금액, 우측: 상태 배지.
 *
 * 구 SettlementStatusRow(별도 섹션)를 이 행에 흡수한 결과다. 라벨 판정은 계속
 * `getSlotDisplayLabel`(슬롯 소유)이 담당한다 — 여기서는 표시만 한다.
 */
function SettlementRow({
  icon,
  label,
  amount,
  settled,
  display,
}: {
  icon: React.ReactNode;
  label: string;
  amount: MoneySlotAmountDisplay;
  /** 입금 확정·지급 완료 — 끝난 건은 아이콘·금액을 한 단계 낮은 무채 랭크로 내린다 */
  settled: boolean;
  display: SettlementDisplayLabel;
}) {
  return (
    <MobileSheetRow
      icon={icon}
      label={label}
      value={
        // 세 갈래다 — 금액 / 상태(합산 이관, 재무 카드와 같은 문구) / 미정.
        // ⛔ 상태를 `₩0` 으로 접지 말 것: 「확인된 0원」으로 읽혀 입력 실수로 오해된다.
        amount.kind === "AMOUNT"
          ? `₩${formatCurrency(amount.amount)}`
          : amount.kind === "STATE"
            ? amount.text
            : "금액 미정"
      }
      // ⛔ 웨이트를 함께 내리지 말 것(구 `font-medium text-slate-500` 리터럴) — 무게는
      // **색으로만** 낮춘다. 굵기가 갈리면 tabular-nums 로 맞춰 둔 금액 열의 광학 정렬이
      // 흔들려 "어느 숫자가 더 중요한가"를 굵기로 오독시킨다. 값도 리터럴이 아니라 토큰이다
      // (slate-500 == --muted-foreground #64748B 라 시각 변화 없음, 드리프트만 막힌다).
      valueClassName={cn("tabular-nums", settled && MONEY_ROW_SETTLED_MUTED)}
      overdue={display.overdue}
      trailing={
        // ⛔ **예정일 경과를 색·배지·서브텍스트로 표기하지 않는다** (오너 지시 2026-08-26,
        // "예정일이 지난건 색을 다르게 표시하거나 배지나 서브텍스트로 표기하지마" →
        // 범위 재확인 답 "전부 다 제거"). 종전에는 여기서 `display.overdue` 가 참이면
        // 아래 배지 자리를 「지연」 배지가 **대체**했다. 되살리지 말 것.
        //
        // `overdue` 판정 자체는 남는다 — 정산 대기 시트가 **정렬**(연체 먼저)에 쓰는
        // 축이고, 오너가 금지한 것은 표기이지 순서가 아니다.
        //
        // 완료는 `status-success` — StatusBadge 의 COMPLETED · 캘린더 도트 · #483 정산 칸과
        // 같은 **생애주기축** 어휘다(가드레일 2, 신규 hue 아님). ⛔ `status-active`(브랜드
        // 네이비)로 되돌리지 말 것: P8 §4 는 네이비 틴트를 "중립 태그 캐리어"로만 허용하고
        // **판정 의미로 쓰는 것을 명시적으로 금지**한다 — 여기서는 "끝났다/안 끝났다"라는
        // 판정을 날랐으므로 그 금지 용법이었다.
        <Badge
          variant={display.label === "예정" ? "secondary" : "status-success"}
          className="shrink-0 px-2 text-[10px] font-semibold shadow-soft-sm"
        >
          {display.label}
        </Badge>
      }
    />
  );
}

function GroupMembersSection({ members }: { members: MobileCampaignDetailMember[] }) {
  return (
    // 자매 섹션과 같은 카드 문법으로 수렴(2026-08-02). 멤버를 박스로 두고 카드로 감싸면
    // 테두리가 두 겹이 되므로(카드 속 카드), 박스를 헤어라인 행(MobileSheetRow)으로 바꾼다.
    // label/value 위계는 종전 배치를 보존한다 — 딜명이 진하고 크게, 기간이 작고 옅게.
    <div className="px-3 pt-3">
      <MobileSheetCard
        title="구성 캠페인"
        ariaLabel="그룹 구성 캠페인"
        chip={`${members.length}개 딜`}
      >
        {members.map((member) => (
          <MobileSheetRow
            key={member.id}
            icon={<LayersIcon className="size-3.5 text-slate-500" aria-hidden="true" />}
            label={`${formatMd(member.startDate)} ~ ${formatMd(member.endDate)}`}
            value={member.dealName}
            trailing={
              <span className="flex shrink-0 items-center gap-1.5">
                {member.roundNumber ? (
                  <Badge className="shrink-0 bg-primary/10 text-primary hover:bg-primary/10 text-[10px] h-5 px-1.5 border-0">
                    {member.roundNumber}차
                  </Badge>
                ) : null}
                <StatusBadge status={member.status as CampaignStatus} className="shrink-0 text-[10px] h-5 px-1.5 shadow-soft-sm" />
              </span>
            }
          />
        ))}
      </MobileSheetCard>
    </div>
  );
}


function SalesDetailBody({
  sales,
  todayYmd,
}: {
  sales: MobileCampaignSalesResponse;
  todayYmd: string;
}) {
  const { source, today, cumulative, statusBreakdown, claims, daily, items } = sales;
  const hasClaims = claims != null && claims.canceled + claims.returned + claims.exchanged > 0;

  return (
    <div className="flex flex-col gap-6">
      {/* 결과 — 오늘 판매와 누적 매출을 동일한 라벨+금액 위계로 표시(오너 피드백 2026-07-14) */}
      {/* 카드 안이라 테두리를 빼고 틴트로만 묶는다(카드 속 카드 금지) — 라디우스도 카드(2xl)보다
          한 단 낮춰 바깥 > 안 위계를 지킨다. */}
      <div className="flex flex-col gap-2 p-4 rounded-xl bg-slate-50/80">
        {source === "live" ? (
          <div className="flex flex-col pb-3 border-b border-slate-200/60">
            {/* 라벨만 primary — 라이브 수치임을 누적(확정치)과 은은하게 구분(ss 검토 P2) */}
            <span className="text-[10px] font-semibold text-primary uppercase tracking-wider mb-0.5">오늘 판매</span>
            <p className="text-[22px] font-black tabular-nums text-slate-800 tracking-tight leading-none">
              ₩{formatCurrency(today.revenue)}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
              <span className="inline-flex items-center gap-1.5" title="오늘 주문: 주문번호 기준">
                <ShoppingCartIcon aria-hidden="true" className="size-3.5 text-slate-400" />
                <span className="text-[12px] text-slate-500">주문 <span className="font-bold tabular-nums text-slate-700">{today.orders}</span>건</span>
              </span>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col">
          <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-0.5">누적 매출</span>
          <p className="text-[22px] font-black tabular-nums text-slate-800 tracking-tight leading-none">
            ₩{formatCurrency(cumulative.revenue)}
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
            <span className="inline-flex items-center gap-1.5" title="누적 주문: 주문번호 기준">
              <ShoppingCartIcon aria-hidden="true" className="size-3.5 text-slate-400" />
              <span className="text-[12px] text-slate-500">주문 <span className="font-bold tabular-nums text-slate-700">{cumulative.orders}</span>건</span>
            </span>
            <span className="inline-flex items-center gap-1.5" title="누적 수량">
              <PackageIcon aria-hidden="true" className="size-3.5 text-slate-400" />
              <span className="text-[12px] text-slate-500">수량 <span className="font-bold tabular-nums text-slate-700">{cumulative.quantity}</span>개</span>
            </span>
          </div>
        </div>
      </div>

      {/* 진행 상태 — 주문상태 분포 */}
      <StatusDistribution breakdown={statusBreakdown} />

      {/* 리스크 — 취소·반품 */}
      {claims != null ? (
        <div className={cn(
          "flex items-center gap-2 p-3 rounded-xl text-[12px]",
          hasClaims ? "bg-rose-50/50 text-rose-700" : "bg-slate-50 text-slate-500"
        )}>
          <RotateCcwIcon aria-hidden="true" className={cn("size-3.5", hasClaims ? "text-rose-500" : "text-slate-400")} />
          <span className="font-medium">
            취소 <span className={cn("tabular-nums", hasClaims && claims.canceled > 0 && "font-bold")}>{claims.canceled}</span> · 
            반품 <span className={cn("tabular-nums", hasClaims && claims.returned > 0 && "font-bold")}>{claims.returned}</span> · 
            교환 <span className={cn("tabular-nums", hasClaims && claims.exchanged > 0 && "font-bold")}>{claims.exchanged}</span>
          </span>
        </div>
      ) : null}

      {/* 흐름 — 일별 매출 추이(미니) */}
      <DailyTrend daily={daily} todayYmd={todayYmd} />

      {/* 품목별 매출 */}
      {items.length > 0 ? <ItemBreakdown items={items} /> : null}
    </div>
  );
}

type ItemSortKey = "revenue" | "quantity" | "orders" | "name";
type ItemSortDirection = "asc" | "desc";

const ITEM_TABLE_GRID = "grid-cols-[minmax(0,1fr)_3rem_3rem_5.25rem]";

function getDefaultItemSortDirection(key: ItemSortKey): ItemSortDirection {
  return key === "name" ? "asc" : "desc";
}

function sortCampaignItems(
  items: CampaignItemSales[],
  key: ItemSortKey,
  direction: ItemSortDirection,
): CampaignItemSales[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (key === "name") {
      return a.name.localeCompare(b.name, "ko-KR") * multiplier;
    }

    const primary = (a[key] - b[key]) * multiplier;
    if (primary !== 0) return primary;
    return a.name.localeCompare(b.name, "ko-KR");
  });
}

/**
 * 품목별 매출 — 기본 접힘. 기본은 매출 내림차순, 펼친 뒤 컬럼 헤더로 기준별 정렬(#130 복원).
 *
 * 표시명 앞의 공통 접두어([셀러 X 브랜드] 딜명 · 카테고리:)는 좁은 폭에서 구분값을
 * 밀어내므로, 과반이 공유하는 접두어를 상단 맥락줄 1회로 접고 각 행은 구분되는 꼬리만
 * 노출한다(extractCommonItemPrefix, #62 복원). 접두어가 다른 사은품/이종상품은 원문 유지.
 * 전체 표시명은 각 행 title 로 보존한다.
 */
function ItemBreakdown({ items }: { items: CampaignItemSales[] }) {
  const [open, setOpen] = useState(false);
  const [sortKey, setSortKey] = useState<ItemSortKey>("revenue");
  const [sortDirection, setSortDirection] = useState<ItemSortDirection>("desc");

  // 같은 품목명은 한 행으로 합산하는 방어층. 현 API(computeCampaignSalesDetailForTargets)는
  // 단일 itemMap이라 이름 유니크·orderKeys 서로소가 보장되지만, 미래에 독립 집계 결과를
  // concat하는 경로가 생기면 orders(distinct 카운트) 단순 합산은 중복 주문을 과계상할 수 있다.
  const mergedItems = useMemo(() => {
    const map = new Map<string, CampaignItemSales>();
    for (const item of items) {
      const key = item.name.trim();
      const existing = map.get(key);
      if (existing) {
        existing.orders += item.orders;
        existing.quantity += item.quantity;
        existing.revenue += item.revenue;
      } else {
        map.set(key, { ...item, name: key });
      }
    }
    return Array.from(map.values());
  }, [items]);

  const sortedItems = useMemo(
    () => sortCampaignItems(mergedItems, sortKey, sortDirection),
    [mergedItems, sortKey, sortDirection],
  );
  const { shared, labels } = useMemo(
    () => extractCommonItemPrefix(sortedItems.map((item) => item.name)),
    [sortedItems],
  );

  function handleSortChange(nextKey: ItemSortKey) {
    if (sortKey === nextKey) {
      setSortDirection((previousDirection) => (previousDirection === "desc" ? "asc" : "desc"));
      return;
    }
    setSortKey(nextKey);
    setSortDirection(getDefaultItemSortDirection(nextKey));
  }

  return (
    <div className="flex flex-col border border-slate-100 rounded-xl overflow-hidden bg-slate-50/50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className="flex min-h-11 items-center justify-between gap-2 px-4 py-3 bg-white active:bg-slate-50 transition-colors duration-150"
      >
        <span className="text-xs font-bold text-slate-700">
          품목별 매출 상세
          <span className="ml-2 bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded text-[10px] tabular-nums font-semibold">{mergedItems.length}</span>
        </span>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 text-slate-400 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="flex flex-col pt-1">
          {shared ? (
            <p
              className="truncate px-4 pb-1.5 text-[11px] text-slate-500"
              title={shared}
            >
              {shared}
            </p>
          ) : null}
          <div role="table" aria-label="품목별 매출 내역">
            <ItemSalesTableHeader
              sortKey={sortKey}
              sortDirection={sortDirection}
              onSortChange={handleSortChange}
            />
            {sortedItems.map((item, index) => (
              <div
                key={item.name}
                role="row"
                className={cn(
                  // 정적 데이터 행 — 탭 액션이 없으므로 hover/active 하이라이트를 두지 않는다
                  // (터치에서 hover 는 sticky 잔상만 남긴다).
                  "grid items-center gap-2 px-4 py-2.5 border-b border-slate-100 last:border-b-0 text-[11px]",
                  ITEM_TABLE_GRID,
                )}
              >
                <span
                  role="cell"
                  className="min-w-0 overflow-hidden font-medium text-slate-600 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
                  title={item.name}
                >
                  {labels[index]}
                </span>
                <span role="cell" className="text-right tabular-nums font-semibold text-slate-500">
                  {item.orders}
                </span>
                <span role="cell" className="text-right tabular-nums font-semibold text-slate-500">
                  {item.quantity}
                </span>
                <span role="cell" className="text-right tabular-nums font-bold text-slate-800">
                  ₩{formatCurrency(item.revenue)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ItemSalesTableHeader({
  sortKey,
  sortDirection,
  onSortChange,
}: {
  sortKey: ItemSortKey;
  sortDirection: ItemSortDirection;
  onSortChange: (key: ItemSortKey) => void;
}) {
  return (
    <div
      className={cn(
        "grid items-center gap-2 px-4 border-b border-slate-100 text-[10px] font-semibold text-slate-500 bg-slate-50/80",
        ITEM_TABLE_GRID,
      )}
      role="row"
      aria-label="품목별 매출 표 헤더"
    >
      <ItemSortHeaderCell
        label="품목명"
        sortKey="name"
        activeSortKey={sortKey}
        sortDirection={sortDirection}
        onSortChange={onSortChange}
      />
      <ItemSortHeaderCell
        label="주문"
        sortKey="orders"
        activeSortKey={sortKey}
        sortDirection={sortDirection}
        onSortChange={onSortChange}
        align="right"
      />
      <ItemSortHeaderCell
        label="수량"
        sortKey="quantity"
        activeSortKey={sortKey}
        sortDirection={sortDirection}
        onSortChange={onSortChange}
        align="right"
      />
      <ItemSortHeaderCell
        label="매출액"
        sortKey="revenue"
        activeSortKey={sortKey}
        sortDirection={sortDirection}
        onSortChange={onSortChange}
        align="right"
      />
    </div>
  );
}

function ItemSortHeaderCell({
  label,
  sortKey,
  activeSortKey,
  sortDirection,
  onSortChange,
  align = "left",
}: {
  label: string;
  sortKey: ItemSortKey;
  activeSortKey: ItemSortKey;
  sortDirection: ItemSortDirection;
  onSortChange: (key: ItemSortKey) => void;
  align?: "left" | "right";
}) {
  const active = sortKey === activeSortKey;
  const ariaSort = active ? (sortDirection === "desc" ? "descending" : "ascending") : "none";

  return (
    <div role="columnheader" aria-sort={ariaSort}>
      <button
        type="button"
        aria-pressed={active}
        aria-label={`${label} 기준 정렬`}
        onClick={() => onSortChange(sortKey)}
        className={cn(
          // 정렬 토글 버튼(onClick + aria-pressed)이라 칩이 아니라 인터랙티브 등급이다 —
          // 포커스 링이 이 라디우스를 따라 그려지므로 등급 오분류가 눈에 보였다.
          "flex min-h-11 w-full items-center gap-0.5 rounded-xl transition-colors duration-150 active:text-slate-700",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2",
          align === "right" ? "justify-end text-right" : "justify-start text-left",
          active ? "text-slate-700" : "text-slate-500",
        )}
      >
        <span>{label}</span>
        {active ? (
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 transition-transform",
              sortDirection === "asc" && "rotate-180",
            )}
          />
        ) : (
          <ChevronsUpDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-35" />
        )}
      </button>
    </div>
  );
}

function StatusDistribution({ breakdown }: { breakdown: CampaignStatusBreakdown }) {
  const total = STATUS_SEGMENTS.reduce((sum, seg) => sum + breakdown[seg.key], 0);

  if (total === 0) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-bold text-slate-800">진행 상태</span>
        <div className="h-3 w-full rounded-full bg-slate-100 shadow-inner" aria-hidden="true" />
        <p className="text-[11px] text-slate-500 font-medium">집계된 주문 없음</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-800 tracking-tight">진행 상태 현황</span>
        <span className="text-[10px] font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">총 {total}건</span>
      </div>
      <div
        role="group"
        aria-label="주문상태 분포"
        className="flex h-3 w-full divide-x divide-white overflow-hidden rounded-full bg-slate-100 shadow-inner"
      >
        {STATUS_SEGMENTS.map((seg) => {
          const value = breakdown[seg.key];
          if (value === 0) return null;
          return (
            <div
              key={seg.key}
              className={seg.tone}
              style={{ width: `${(value / total) * 100}%` }}
              title={`${seg.label} ${value}건`}
            />
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px] bg-slate-50 p-3 rounded-xl border border-slate-100">
        {STATUS_SEGMENTS.map((seg) => {
          const value = breakdown[seg.key];
          const isZero = value === 0;
          return (
            <span key={seg.key} className={cn("inline-flex items-center gap-2", isZero ? "opacity-40" : "")}>
              <span className={cn("size-2 shrink-0 rounded-full shadow-soft-sm", seg.dot)} aria-hidden="true" />
              <span className="truncate font-medium text-slate-600">{seg.label}</span>
              <span className={cn("ml-auto font-bold tabular-nums", isZero ? "text-slate-500" : "text-slate-800")}>
                {value}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

const TREND_DAYS = 7;
const TREND_BAR_HEIGHT = 48;

function formatCompactRevenue(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}억`;
  if (value >= 10_000) return `${Math.round(value / 10_000)}만`;
  if (value > 0) return formatCurrency(value);
  return "0";
}

function formatTrendDayLabel(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}`;
}

function DailyTrend({ daily, todayYmd }: { daily: CampaignDailyPoint[]; todayYmd: string }) {
  const points = daily.slice(-TREND_DAYS);
  const maxRevenue = Math.max(...points.map((p) => p.revenue), 1);
  const hasRevenue = points.some((p) => p.revenue > 0);

  if (points.length === 0 || !hasRevenue) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs font-bold text-slate-800 tracking-tight">최근 7일 판매 추이</span>
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
          <p className="text-[12px] font-medium text-slate-500">최근 판매 추이 없음</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-800 tracking-tight">최근 {points.length}일 판매 추이</span>
      </div>
      
      <div className="pt-2 pb-1">
        <div className="flex items-end gap-1.5" style={{ height: TREND_BAR_HEIGHT }}>
          {points.map((point) => {
            const barHeight = Math.max((point.revenue / maxRevenue) * TREND_BAR_HEIGHT, 4);
            const isToday = point.date === todayYmd;
            return (
              <div
                key={point.date}
                className={cn(
                  "min-w-0 flex-1 rounded-t-md transition-all",
                  isToday
                    // rgba(var(--primary),0.3) 은 무효였다 — --primary 는 RGB 트리플렛이
                    // 아니라 hex(#0A3D62)라 rgba(#0A3D62,0.3) 로 파싱 실패해 글로우가
                    // 렌더되지 않았다. Tailwind 컬러 섀도우로 토큰을 참조한다.
                    ? "bg-primary shadow-[0_0_10px] shadow-primary/30"
                    : "bg-slate-200"
                )}
                style={{ height: barHeight }}
                title={`${formatTrendDayLabel(point.date)} · ₩${formatCurrency(point.revenue)} · ${point.orders}건`}
              />
            );
          })}
        </div>
        <div className="flex gap-1.5 mt-2">
          {points.map((point) => {
            const isToday = point.date === todayYmd;
            return (
              <div key={point.date} className="flex min-w-0 flex-1 flex-col items-center leading-tight">
                <span
                  className={cn(
                    "w-full truncate text-center text-[9px] tabular-nums",
                    isToday ? "font-bold text-primary" : "font-semibold text-slate-500",
                  )}
                >
                  {formatCompactRevenue(point.revenue)}
                </span>
                <span className={cn(
                  "w-full truncate text-center text-[9px] tabular-nums mt-0.5",
                  isToday ? "font-medium text-slate-600" : "font-medium text-slate-500"
                )}>
                  {formatTrendDayLabel(point.date)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
