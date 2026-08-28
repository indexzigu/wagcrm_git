"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowDownCircle,
  ArrowUp,
  Boxes,
  CalendarRange,
  ExternalLink,
  Plus,
  UserRound,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusBadge, statusBarClassName } from "@/components/crm/status-badge";
import { MONEY_DIRECTION_ICON } from "@/lib/money-direction";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";
import { formatDateRange } from "@/lib/date-utils";
import { campaignStatusLabels, type CampaignStatus } from "@/lib/crm-types";
import {
  buildCalendarEntities,
  buildGapUrgencyByDate,
  collectMoneyMarkersByDate,
  foldGroupMoney,
  moneySlotAmountDisplay,
  sumMoneySlotAmounts,
  toMoneySlotAmountDisplay,
  type CalendarCampaignInput,
  type CalendarEntity,
  type MoneyMarkerEvent,
} from "@/lib/calendar-entities";
import {
  resolveCampaignMoneySlots,
  resolveMoneySlotEffectiveDate,
  type CampaignMoneySlot,
  type MoneySlotAmountDisplay,
} from "@/lib/tax-filing-board";
import type { ScheduleGap } from "@/lib/schedule-gap-briefing";
import {
  assignMonthLanes,
  getMonthGridWeeks,
  getWeekLaneSegments,
  toYmd,
  type MobileCalendarEvent,
  type MonthGridDay,
} from "@/lib/mobile-schedule-grid";

/** 캘린더 입력 = 월 캠페인(자금 필드 포함). calendar-entities의 입력 타입 재사용. */
export type CalendarCampaign = CalendarCampaignInput;

type CalendarViewProps = {
  campaigns: CalendarCampaign[];
  month: string; // YYYY-MM
  onCampaignClick?: (campaignId: string) => void;
  /** 매출 공백 구간(getScheduleGapBriefing) — DANGER/URGENT 날짜에 셀 배경 틴트. */
  gaps?: ScheduleGap[];
  /** 날짜 셀에서 예비 일정 생성 진입(YYYY-MM-DD 프리필). 미제공 시 어포던스 미노출. */
  onCreateDraft?: (ymd: string) => void;
};

const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

// 데스크톱은 세로 여유가 있어 레인을 넉넉히 — 실 캠페인을 숨기지 않는다(P3 역방향).
const DESKTOP_MAX_LANES = 20;
const BAR_HEIGHT = 24; // px per lane
const BAR_GAP = 4;
const BARS_PADDING = 4;
// 스팬바 좌우 거터(px). ⚠️ margin 으로 주지 말 것 — 폭이 %라 margin 이 그대로
// 더해져 마지막 열까지 닿는 바가 컨테이너를 2px 넘친다(실측). 폭에서 빼서
// 안쪽으로 넣는다. 계약: calendar-view.test.tsx "스팬바 가로 기하".
const BAR_GUTTER = 2;
const MIN_BARS_HEIGHT = 2 * (BAR_HEIGHT + BAR_GAP) + BARS_PADDING * 2;

// 고정 양력 공휴일 (MM-DD) + 연도별 음력 공휴일 (YYYY-MM-DD)
const SOLAR_HOLIDAYS: Record<string, string> = {
  "01-01": "신정",
  "03-01": "삼일절",
  "05-05": "어린이날",
  "06-06": "현충일",
  "08-15": "광복절",
  "10-03": "개천절",
  "10-09": "한글날",
  "12-25": "성탄절",
};

const LUNAR_HOLIDAYS: Record<string, string> = {
  "2025-01-28": "설 연휴",
  "2025-01-29": "설날",
  "2025-01-30": "설 연휴",
  "2025-05-05": "어린이날·부처님오신날",
  "2025-05-06": "대체휴일",
  "2025-10-05": "추석 연휴",
  "2025-10-06": "추석",
  "2025-10-07": "추석 연휴",
  "2025-10-08": "대체휴일",
  "2026-02-16": "설 연휴",
  "2026-02-17": "설날",
  "2026-02-18": "설 연휴",
  "2026-05-24": "부처님오신날",
  "2026-05-25": "대체휴일",
  "2026-09-24": "추석 연휴",
  "2026-09-25": "추석",
  "2026-09-26": "추석 연휴",
};

function getHoliday(ymd: string): string | null {
  if (LUNAR_HOLIDAYS[ymd]) return LUNAR_HOLIDAYS[ymd];
  const mmdd = ymd.slice(5);
  return SOLAR_HOLIDAYS[mmdd] ?? null;
}

/** 셀러 단위로 겹치는 서로 다른 엔티티를 충돌로 표시(그룹은 병합돼 있어 그룹 내부는 충돌 아님). */
function detectConflicts(entities: CalendarEntity[]): Map<string, string[]> {
  const conflicts = new Map<string, string[]>();
  const bySeller = new Map<string, CalendarEntity[]>();
  for (const e of entities) {
    const list = bySeller.get(e.sellerId) ?? [];
    list.push(e);
    bySeller.set(e.sellerId, list);
  }
  for (const [, group] of bySeller) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.startDate <= b.endDate && b.startDate <= a.endDate) {
          const aList = conflicts.get(a.key) ?? [];
          if (!aList.includes(b.label)) aList.push(b.label);
          conflicts.set(a.key, aList);
          const bList = conflicts.get(b.key) ?? [];
          if (!bList.includes(a.label)) bList.push(a.label);
          conflicts.set(b.key, bList);
        }
      }
    }
  }
  return conflicts;
}

function parseMonth(month: string): { year: number; monthIndex: number } {
  const [year, m] = month.split("-").map(Number);
  return { year, monthIndex: m - 1 };
}

// ── 자금 마커 ────────────────────────────────────────────────────────
function MoneyMarkerIcon({ event }: { event: MoneyMarkerEvent }) {
  const isDeposit = event.direction === "deposit";
  if (event.state === "completed") {
    const Arrow = isDeposit ? ArrowDown : ArrowUp;
    return (
      <span className="flex size-3.5 items-center justify-center rounded-full bg-status-success">
        <Arrow className="size-2.5 text-white" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  const Icon = MONEY_DIRECTION_ICON[isDeposit ? "in" : "out"];
  return (
    <Icon
      className={cn(
        "size-3.5",
        event.state === "overdue" ? "text-status-urgent" : "text-status-caution",
      )}
      aria-hidden="true"
    />
  );
}

function moneyStateLabel(state: MoneyMarkerEvent["state"]): string {
  return state === "completed" ? "완료" : state === "overdue" ? "지연" : "예정";
}

/**
 * 대금 일정 한 줄. **슬롯이 라벨·아이콘·읽을 필드를 전부 들고 온다** — 여기서
 * 채널이나 방향을 다시 분기하면 정산 카드·목록과 어휘가 갈린다.
 */
function MoneyRow({
  slot,
  date,
  done,
  amount,
  todayStr,
}: {
  slot: CampaignMoneySlot;
  date?: string | null;
  done?: boolean;
  /**
   * ⚠️ 숫자가 아니라 **판정**을 받는다 — 합산 이관은 금액이 아니라 상태라
   * `₩0` 으로 적으면 「확인된 0원」으로 읽힌다(`MoneySlotAmountDisplay`).
   */
  amount: MoneySlotAmountDisplay;
  todayStr: string;
}) {
  const Icon = MONEY_DIRECTION_ICON[slot.kind === "DEPOSIT" ? "in" : "out"];
  // 자사몰은 지급 줄이 둘이라 상대를 붙이지 않으면 두 줄이 구분되지 않는다.
  const label = `${slot.verb}(${slot.counterpartLabel})`;
  if (!date) {
    return (
      <div className="flex items-center gap-1 text-muted-foreground/70">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {label} 미정
      </div>
    );
  }
  const overdue = !done && date.slice(0, 10) < todayStr;
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 font-medium",
        done
          ? "text-status-success"
          : overdue
            ? "text-status-urgent"
            : "text-status-caution",
      )}
    >
      {/* `whitespace-nowrap` 은 구조적 재발 차단이다(#454 정산 목록과 같은 처방) —
          상대 라벨이 붙어 문구가 길어졌으므로, 폭이 다시 빠듯해져도 날짜·상태가
          줄바꿈으로 흩어지지 않게 한다. `tabular-nums` 는 두 줄의 날짜 자릿수를
          세로로 맞춘다. */}
      <span className="flex items-center gap-1 whitespace-nowrap">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {label} <span className="tabular-nums">{formatDate(date)}</span>
        <span className="text-[10px] font-normal">
          {done ? "완료" : overdue ? "지연" : "예정"}
        </span>
      </span>
      {/* ⛔ 「미정」은 줄을 만들지 않는다(종전 동작 보존) — 이 팝오버는 폭이 빠듯해
          알맹이 없는 줄을 늘리지 않는다. 상태 문구는 숫자가 아니므로 tabular-nums 를 빼고,
          같은 사실을 말하는 재무 카드와 **같은 문자열**을 쓴다(SSOT). */}
      {amount.kind === "AMOUNT" && (
        <span className="pl-[18px] text-[11px] tabular-nums text-foreground">
          ₩{formatCurrency(amount.amount)}
        </span>
      )}
      {amount.kind === "STATE" && (
        <span className="pl-[18px] text-[11px] text-muted-foreground">{amount.text}</span>
      )}
    </div>
  );
}

// ── 상세 팝오버 ──────────────────────────────────────────────────────
function CampaignPopoverContent({
  member,
  todayStr,
  onCampaignClick,
}: {
  member: CalendarCampaignInput;
  todayStr: string;
  onCampaignClick?: (campaignId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h4 className="truncate text-sm font-semibold text-foreground">
              {member.dealName}
            </h4>
            {member.roundNumber && member.roundNumber > 1 ? (
              <span className="h-4 shrink-0 rounded bg-slate-100 px-1 text-[9px] font-semibold leading-4 text-slate-600">
                {member.roundNumber}차
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <UserRound className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{member.sellerName}</span>
          </div>
        </div>
        <StatusBadge status={member.status} className="shrink-0" />
      </div>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CalendarRange className="size-3.5 shrink-0" aria-hidden="true" />
        {formatDateRange(member.startDate, member.endDate)}
      </div>

      {/* ⛔ 2열 그리드로 되돌리지 말 것 — 상대 병기 후 한 줄에 필요한 폭이 155px 인데
          w-72 팝오버의 2열은 열당 113px 라 날짜·상태가 두 줄로 감긴다(실측 2026-08-25).
          자사몰은 두 칸이 「입금 vs 지급」 대칭도 아니라(둘 다 지급) 세로 나열이 의미에도
          맞는다. */}
      <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2.5 text-xs">
        {resolveCampaignMoneySlots(member.salesChannel ?? "").map((slot) => (
          <MoneyRow
            key={slot.key}
            slot={slot}
            // ⛔ `member[slot.expectedField]` 로 되돌리지 말 것 — 완료된 칸은 실제로 오간
            // 날을 말한다(도트와 같은 판정을 써야 한 화면에서 두 날짜가 어긋나지 않는다).
            date={resolveMoneySlotEffectiveDate(slot, member).date}
            done={member[slot.flagField]}
            amount={moneySlotAmountDisplay(member, slot)}
            todayStr={todayStr}
          />
        ))}
      </div>

      <Link
        href="/pipeline"
        onClick={() => onCampaignClick?.(member.id)}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-border py-1.5 text-xs font-medium text-primary hover:bg-muted"
      >
        판매 관리에서 열기
        <ExternalLink className="size-3" aria-hidden="true" />
      </Link>
    </div>
  );
}

function GroupPopoverContent({
  entity,
  todayStr,
  onCampaignClick,
}: {
  entity: CalendarEntity;
  todayStr: string;
  onCampaignClick?: (campaignId: string) => void;
}) {
  // ⛔ 대표 멤버 한 명에서 읽지 말 것 — 정산 금액은 그룹 스칼라가 **없어서**(CG-1 정산
  // 방화벽) dual-read 로 멤버에 복사되지 않는다. 대표만 읽으면 3인 조합이 1/3 로 보였다.
  // 폴딩 규약(금액=합산 · 예정일=대표 · 완료=전원 · 슬롯=채널 합집합)은 `foldGroupMoney`
  // 하나가 소유하고 모바일 묶음(`mobile-calendar-groups`)이 같은 함수를 쓴다.
  const money = foldGroupMoney(entity.members);
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <h4 className="truncate text-sm font-semibold text-foreground">
            {entity.sellerName}
          </h4>
          <span className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1 text-[9px] font-semibold leading-none text-primary">
            <Boxes className="size-2.5" aria-hidden="true" />조합 {entity.memberCount}건
          </span>
        </div>
        <StatusBadge status={entity.status} className="shrink-0" />
      </div>
      <p className="text-[10px] text-muted-foreground">
        표시된 상태는 가장 덜 진행된 멤버 기준입니다.
      </p>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CalendarRange className="size-3.5 shrink-0" aria-hidden="true" />
        {formatDateRange(entity.startDate, entity.endDate)} (롤업)
      </div>

      <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60">
        {entity.members.map((member) => (
          <button
            key={member.id}
            type="button"
            onClick={() => onCampaignClick?.(member.id)}
            className="flex w-full items-center gap-2 border-b border-border/40 px-2.5 py-1.5 text-left last:border-b-0 hover:bg-muted/60"
          >
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {member.dealName}
              {member.roundNumber && member.roundNumber > 1
                ? ` ${member.roundNumber}차`
                : ""}
            </span>
            <StatusBadge status={member.status} className="shrink-0" />
          </button>
        ))}
      </div>

      {/* ⛔ 2열 그리드로 되돌리지 말 것 — 상대 병기 후 한 줄에 필요한 폭이 155px 인데
          w-72 팝오버의 2열은 열당 113px 라 날짜·상태가 두 줄로 감긴다(실측 2026-08-25).
          자사몰은 두 칸이 「입금 vs 지급」 대칭도 아니라(둘 다 지급) 세로 나열이 의미에도
          맞는다. */}
      <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2.5 text-xs">
        {money.slots.map((slot) => (
          <MoneyRow
            key={slot.key}
            slot={slot}
            date={resolveMoneySlotEffectiveDate(slot, money).date}
            done={money[slot.flagField]}
            // 그룹 합계는 숫자다 — 합산 이관은 **캠페인 단위** 마커라 접힌 값에 대응이
            // 없다(전원 합산 이관인 조합의 합계 0 = 「이 조합에서 나갈 물품대금 없음」).
            amount={toMoneySlotAmountDisplay(sumMoneySlotAmounts(entity.members, slot))}
            todayStr={todayStr}
          />
        ))}
      </div>
      {/* 금액의 **모수**를 밝힌다 — 같은 자리에 멤버 한 건의 금액이 뜨던 때와 숫자가
          달라지므로, 이 줄이 없으면 오너가 어느 범위의 돈인지 되묻는다(P2). */}
      <p className="text-[10px] text-muted-foreground">
        일정은 조합 공유(그룹 값이 정본) · 금액은 멤버 {entity.memberCount}건 합계입니다.
      </p>
    </div>
  );
}

// ── 범례 ────────────────────────────────────────────────────────────
function CalendarLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/30 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
      {(Object.entries(campaignStatusLabels) as [CampaignStatus, string][]).map(
        ([status, label]) => (
          <span key={status} className="inline-flex items-center gap-1">
            <span
              className={cn("size-2.5 rounded-[3px]", statusBarClassName[status])}
            />
            {label}
          </span>
        ),
      )}
      <span className="mx-1 h-3 w-px bg-border" aria-hidden="true" />
      <span className="inline-flex items-center gap-1">
        <MONEY_DIRECTION_ICON.in className="size-3 text-status-caution" aria-hidden="true" />
        입금 예정
      </span>
      <span className="inline-flex items-center gap-1">
        <MONEY_DIRECTION_ICON.out className="size-3 text-status-caution" aria-hidden="true" />
        지급 예정
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="flex size-3 items-center justify-center rounded-full bg-status-success">
          <ArrowDown className="size-2 text-white" strokeWidth={3} aria-hidden="true" />
        </span>
        완료
      </span>
      <span className="inline-flex items-center gap-1">
        {/* ⚠️ 여기만 **방향축이 아니다** — 「지연」은 심각도이고 아래 화살표는 방향을
            말하려는 것이 아니라 범례 마커로 모양을 빌려 쓴 것이다. 그래서 SSOT 를
            거치지 않고 직접 import 한다(그 예외는 계약 테스트에 사유와 함께 등재). */}
        <ArrowDownCircle className="size-3 text-status-urgent" aria-hidden="true" />
        지연
      </span>
    </div>
  );
}

export function CalendarView({
  campaigns,
  month,
  onCampaignClick,
  gaps = [],
  onCreateDraft,
}: CalendarViewProps) {
  const { year, monthIndex } = parseMonth(month);
  const todayStr = toYmd(new Date());

  const entities = React.useMemo(
    () => buildCalendarEntities(campaigns),
    [campaigns],
  );
  const gapByDate = React.useMemo(() => buildGapUrgencyByDate(gaps), [gaps]);
  const entityByKey = React.useMemo(
    () => new Map(entities.map((e) => [e.key, e])),
    [entities],
  );
  const conflicts = React.useMemo(() => detectConflicts(entities), [entities]);
  // ⛔ `campaigns` 를 다시 넘기지 말 것 — 마커가 바와 **다른 그룹 판정**을 갖는 순간
  // 조합 하나의 입금이 멤버 수만큼 흩어진다(이 함수가 엔티티를 받는 이유).
  const moneyByDate = React.useMemo(
    () => collectMoneyMarkersByDate(entities, todayStr),
    [entities, todayStr],
  );

  const weeks = React.useMemo(
    () => getMonthGridWeeks(year, monthIndex),
    [year, monthIndex],
  );
  const laneEvents = React.useMemo<MobileCalendarEvent[]>(
    () =>
      entities.map((e) => ({
        id: e.key,
        startDate: e.startDate.slice(0, 10),
        endDate: e.endDate.slice(0, 10),
      })),
    [entities],
  );
  const laneMap = React.useMemo(
    () => assignMonthLanes(laneEvents, year, monthIndex, DESKTOP_MAX_LANES),
    [laneEvents, year, monthIndex],
  );

  return (
    <TooltipProvider>
      <div className="overflow-hidden rounded-2xl border border-border/50 bg-white/80 shadow-soft-sm">
        <CalendarLegend />

        {/* Day of week headers */}
        <div className="grid grid-cols-7 border-b bg-muted/30">
          {DAY_LABELS.map((label, idx) => (
            <div
              key={label}
              className={cn(
                "px-2 py-3 text-center text-xs font-semibold text-muted-foreground",
                (idx === 0 || idx === 6) && "text-rose-400",
              )}
            >
              {label}
            </div>
          ))}
        </div>

        {/* Weeks */}
        {weeks.map((week) => {
          const { segments } = getWeekLaneSegments(laneEvents, laneMap, week);
          const laneCount =
            segments.length > 0
              ? Math.max(...segments.map((s) => s.lane)) + 1
              : 0;
          const barsAreaHeight = Math.max(
            MIN_BARS_HEIGHT,
            laneCount * (BAR_HEIGHT + BAR_GAP) + BARS_PADDING * 2,
          );

          return (
            <div key={week[0].ymd} className="border-b border-border/30 last:border-b-0">
              {/* Row 1: date numbers + holiday + money markers */}
              <div className="grid grid-cols-7">
                {week.map((day, cellIdx) => (
                  <DateCell
                    key={day.ymd}
                    day={day}
                    cellIdx={cellIdx}
                    todayStr={todayStr}
                    markers={moneyByDate.get(day.ymd)}
                    entityByKey={entityByKey}
                    gapUrgency={day.inMonth ? gapByDate.get(day.ymd) : undefined}
                    onCampaignClick={onCampaignClick}
                    onCreateDraft={onCreateDraft}
                  />
                ))}
              </div>

              {/* Row 2: campaign bars (lane-packed) */}
              <div
                className="relative grid grid-cols-7"
                style={{ height: `${barsAreaHeight}px` }}
              >
                {week.map((day, cellIdx) => {
                  const gapUrgency = day.inMonth ? gapByDate.get(day.ymd) : undefined;
                  return (
                    <div
                      key={day.ymd}
                      className={cn(
                        "border-r border-border/10 last:border-r-0",
                        !day.inMonth && "bg-muted/10",
                        (cellIdx === 0 || cellIdx === 6) &&
                          day.inMonth &&
                          !gapUrgency &&
                          "bg-rose-50/20",
                        gapUrgency === "DANGER" && "bg-status-urgent/[0.07]",
                        gapUrgency === "URGENT" && "bg-status-caution/[0.08]",
                      )}
                    />
                  );
                })}

                <div className="pointer-events-none absolute inset-0">
                  {segments.map((segment) => {
                    const entity = entityByKey.get(segment.event.id);
                    if (!entity) return null;
                    const lane = segment.lane;
                    const conflictNames = conflicts.get(entity.key) ?? [];
                    const hasConflict = conflictNames.length > 0;

                    const bar = (
                      <div
                        className={cn(
                          "pointer-events-auto absolute flex cursor-pointer items-center gap-1 overflow-hidden rounded-md px-1.5 text-[11px] font-medium shadow-soft-sm transition-[filter,box-shadow] duration-150 hover:brightness-105 hover:shadow-soft-md",
                          statusBarClassName[entity.status],
                          segment.continuesLeft && "rounded-l-none",
                          segment.continuesRight && "rounded-r-none",
                          hasConflict && "ring-2 ring-status-urgent/50 ring-offset-1",
                        )}
                        style={{
                          left: `calc(${((segment.colStart - 1) / 7) * 100}% + ${BAR_GUTTER}px)`,
                          width: `calc(${(segment.colSpan / 7) * 100}% - ${BAR_GUTTER * 2}px)`,
                          top: `${BARS_PADDING + lane * (BAR_HEIGHT + BAR_GAP)}px`,
                          height: `${BAR_HEIGHT}px`,
                        }}
                        title={entity.label}
                      >
                        {entity.kind === "group" && (
                          <span
                            className="inline-flex h-3.5 shrink-0 items-center gap-0.5 rounded-sm bg-current/15 px-0.5 text-[9px] font-semibold leading-none"
                          >
                            <Boxes className="size-2.5" aria-hidden="true" />
                            {entity.memberCount}
                          </span>
                        )}
                        <span className="truncate">{entity.label}</span>
                      </div>
                    );

                    const trigger = hasConflict ? (
                      <Tooltip>
                        <TooltipTrigger asChild>{bar}</TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs font-medium">일정 충돌:</p>
                          {conflictNames.map((name) => (
                            <p key={name} className="text-xs">
                              {name}
                            </p>
                          ))}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      bar
                    );

                    return (
                      <Popover key={entity.key}>
                        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
                        <PopoverContent
                          align="start"
                          sideOffset={4}
                          className={cn("p-0", entity.kind === "group" ? "w-80" : "w-72")}
                        >
                          {entity.kind === "group" ? (
                            <GroupPopoverContent
                              entity={entity}
                              todayStr={todayStr}
                              onCampaignClick={onCampaignClick}
                            />
                          ) : (
                            <CampaignPopoverContent
                              member={entity.members[0]}
                              todayStr={todayStr}
                              onCampaignClick={onCampaignClick}
                            />
                          )}
                        </PopoverContent>
                      </Popover>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

function DateCell({
  day,
  cellIdx,
  todayStr,
  markers,
  entityByKey,
  gapUrgency,
  onCampaignClick,
  onCreateDraft,
}: {
  day: MonthGridDay;
  cellIdx: number;
  todayStr: string;
  markers: MoneyMarkerEvent[] | undefined;
  /** 마커 → 엔티티 되찾기용. 조합 도트가 **바와 같은 상세**를 연다. */
  entityByKey: Map<string, CalendarEntity>;
  gapUrgency: "DANGER" | "URGENT" | undefined;
  onCampaignClick?: (campaignId: string) => void;
  onCreateDraft?: (ymd: string) => void;
}) {
  const holiday = getHoliday(day.ymd);
  const isWeekend = cellIdx === 0 || cellIdx === 6;
  const isToday = day.ymd === todayStr;
  const shown = markers?.slice(0, 3) ?? [];
  const overflow = (markers?.length ?? 0) - shown.length;

  return (
    <div
      className={cn(
        "group/cell relative border-r border-border/20 px-1.5 py-1.5 last:border-r-0 transition-colors",
        !day.inMonth && "bg-muted/20",
        day.inMonth && "hover:bg-muted/10",
        isWeekend && day.inMonth && !gapUrgency && "bg-rose-50/30",
        gapUrgency === "DANGER" && "bg-status-urgent/[0.07]",
        gapUrgency === "URGENT" && "bg-status-caution/[0.08]",
      )}
    >
      {gapUrgency && (
        <span className="sr-only">
          {gapUrgency === "DANGER"
            ? "매출 공백 위험, 즉시 확보 필요"
            : "매출 공백 주의, 이번 주 내 확보"}
        </span>
      )}
      <div className="flex min-h-[24px] items-center justify-between gap-1">
        <span
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
            isToday
              ? "bg-primary text-primary-foreground"
              : !day.inMonth
                ? "text-muted-foreground/40"
                : isWeekend
                  ? "text-rose-400"
                  : "text-muted-foreground",
          )}
        >
          {day.date.getDate()}
        </span>
        {holiday && day.inMonth && (
          <span
            className={cn(
              "truncate text-right text-[10px] font-medium leading-tight text-rose-400",
              // "+"와 우상단 슬롯을 교대 — hover 시 공휴일이 물러나고 "+"가 나온다.
              onCreateDraft && "transition-opacity group-hover/cell:opacity-0",
            )}
          >
            {holiday}
          </span>
        )}
      </div>

      {/* 예비 일정 추가 — 셀 hover 시 노출(포인터 지름길). 키보드 완전 경로는
          필터바의 상시 "예비 일정 추가" 버튼이 담당하므로 42개 셀을 탭 순서에
          끼워넣지 않는다(tabIndex=-1·aria-hidden). DANGER/URGENT 갭 셀은 idle에도
          40% 노출·셀 경고색 상속 — "공백 경고 → 그 자리에서 채우기" 연결. */}
      {onCreateDraft && day.inMonth && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation();
            onCreateDraft(day.ymd);
          }}
          className={cn(
            "absolute right-1 top-1 flex size-5 items-center justify-center rounded-full text-white shadow-soft-sm transition-opacity",
            gapUrgency === "DANGER"
              ? "bg-status-urgent opacity-40 hover:opacity-100 group-hover/cell:opacity-100"
              : gapUrgency === "URGENT"
                ? "bg-status-caution opacity-40 hover:opacity-100 group-hover/cell:opacity-100"
                : "bg-foreground/70 opacity-0 hover:opacity-100 group-hover/cell:opacity-100",
          )}
        >
          <Plus className="size-3" aria-hidden="true" />
        </button>
      )}

      {/* 자금 마커 서브로우 — 없어도 높이 유지(주 7칸 정렬).
          ⚠️ 넘침을 반드시 가둔다: 마커(14px)×3 + 간격 + "+N"은 약 58px인데 좁은
          폭에서 셀 내용 폭은 37px까지 줄어든다(375px 뷰포트). 차단이 없으면 옆
          날짜 칸으로 흘러나가 마커가 다른 날짜에 달린 것처럼 보인다(실측: 셀 밖
          15px). 공간이 부족하면 마커를 자르고 "+N"(더 있다는 신호)은 남긴다 —
          마커 래퍼만 min-w-0으로 줄고 "+N"은 shrink-0이다.
          계약: calendar-view.test.tsx "자금 마커 행은 넘침을 가둬…". */}
      <div className="mt-0.5 flex h-3.5 items-center gap-0.5 overflow-hidden">
        <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
          {shown.map((event, i) => {
            // 조합이면 바를 눌렀을 때와 **같은 상세**를 연다 — 대표 멤버 팝오버를 열면
            // 금액이 다시 1/N 로 보인다. 엔티티를 못 찾으면 대표 멤버로 폴백한다.
            const entity = entityByKey.get(event.entityKey);
            return (
              // 같은 캠페인의 두 지급이 같은 날 겹칠 수 있어 방향만으로는 키가 충돌한다.
              <Popover key={`${event.entityKey}-${event.slotKey}-${i}`}>
                <Tooltip>
                  <PopoverTrigger asChild>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="shrink-0"
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`${event.verb}(${event.counterpartLabel}) ${moneyStateLabel(event.state)} · ${event.dealLabel}`}
                      >
                        <MoneyMarkerIcon event={event} />
                      </button>
                    </TooltipTrigger>
                  </PopoverTrigger>
                  <TooltipContent>
                    <p className="text-xs">
                      {event.sellerName} · {event.dealLabel}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {event.verb}({event.counterpartLabel}) ·{" "}
                      {moneyStateLabel(event.state)}
                      {event.amount != null ? ` · ₩${formatCurrency(event.amount)}` : ""}
                      {/* 금액의 **모수**를 밝힌다 — 조합 도트는 합계라 멤버 한 건의
                          숫자와 다르다(그룹 팝오버 각주와 같은 규약, P2). */}
                      {event.amount != null && event.memberCount > 1
                        ? ` (${event.memberCount}건 합계)`
                        : ""}
                    </p>
                  </TooltipContent>
                </Tooltip>
                {/* 폭은 **콘텐츠가 정한다** — 바 트리거(위)와 같은 규칙이라 같은 조합
                    상세가 진입 경로에 따라 다른 폭으로 열리지 않는다. */}
                <PopoverContent
                  align="start"
                  sideOffset={4}
                  className={cn("p-0", entity?.kind === "group" ? "w-80" : "w-72")}
                >
                  {entity && entity.kind === "group" ? (
                    <GroupPopoverContent
                      entity={entity}
                      todayStr={todayStr}
                      onCampaignClick={onCampaignClick}
                    />
                  ) : (
                    <CampaignPopoverContent
                      member={event.member}
                      todayStr={todayStr}
                      onCampaignClick={onCampaignClick}
                    />
                  )}
                </PopoverContent>
              </Popover>
            );
          })}
        </div>
        {overflow > 0 && (
          <span className="shrink-0 text-[9px] leading-none text-muted-foreground">
            +{overflow}
          </span>
        )}
      </div>
    </div>
  );
}
