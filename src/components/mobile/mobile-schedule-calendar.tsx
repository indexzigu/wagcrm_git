"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import React, { useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
import { MONEY_DIRECTION_STROKE } from "@/lib/money-direction";
import type { MobileCalendarCampaign } from "@/lib/mobile-calendar-data";
import { buildMobileCalendarItems, type MobileCalendarItem } from "@/lib/mobile-calendar-groups";
import {
  resolveMoneySlotEffectiveDate,
  resolveMoneySlotsForChannels,
} from "@/lib/tax-filing-board";
import {
  getMonthGridWeeks,
  getWeekSpanUnion,
  parseYmdLocal,
  toYmd,
  type MobileCalendarEvent,
  type MonthGridDay,
} from "@/lib/mobile-schedule-grid";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/**
 * 입금(초록)·지급(빨강) 링 색 — 상태 배지 스킴과 별개인 **자금 전용 의미축**이다
 * (지급은 "위험"이 아니라서 --status-urgent 에 흡수할 수 없다).
 *
 * 규칙 SSOT 는 lib/money-direction. 링은 **비텍스트 표면(3:1)** 이라 `-text` 변형이 아닌
 * 원본 토큰(`--money-in` 3.77:1)을 쓴다 — 텍스트·아이콘 표면의 MONEY_DIRECTION_TEXT 와
 * 다른 맵이다. 이 링을 `-text` 쌍으로 "통일"하지 말 것(둘은 다른 대비 기준을 만족한다).
 *
 * export 인 이유: 테스트가 링을 색 리터럴(`circle[stroke="#059669"]`)로 집으면
 * 색을 바꾸는 순간 동작이 그대로여도 테스트가 깨진다. 테스트는 "입금 링"을 의미로
 * 집어야 하므로 이 상수를 import 한다.
 */
export const MONEY_DEPOSIT = MONEY_DIRECTION_STROKE.in;
export const MONEY_PAYOUT = MONEY_DIRECTION_STROKE.out;
// 예정(미완료)은 점선, 완료는 실선으로 구분(오너 피드백 2026-07-15).
const PENDING_DASH = "3 2.6";

/**
 * 하루의 자금 이벤트 집계 — 입금·지급 각각 예정(미완료)/완료 건수를 보존한다.
 * 구 boolean 맵은 "여러 건"과 "완료 여부"를 뭉개 표시 구분이 불가능했다.
 */
type MoneyStatus = {
  depPending: number;
  depDone: number;
  payPending: number;
  payDone: number;
};

/** 링 렌더 — 단일 유형은 원, 입금·지급 동시면 상(입금)·하(지급) 반원. 예정=점선/완료=실선, 2건+ 배지. */
function MoneyRing({ status }: { status: MoneyStatus }) {
  const depTotal = status.depPending + status.depDone;
  const payTotal = status.payPending + status.payDone;
  const total = depTotal + payTotal;
  if (total === 0) return null;

  const both = depTotal > 0 && payTotal > 0;
  // 같은 유형에 예정·완료가 섞이면 예정(주의 필요)을 우선해 점선으로 표기한다.
  const depDash = status.depPending > 0 ? PENDING_DASH : undefined;
  const payDash = status.payPending > 0 ? PENDING_DASH : undefined;

  return (
    <>
      <svg
        className="absolute inset-0 w-full h-full overflow-visible"
        viewBox="0 0 36 36"
        aria-hidden="true"
      >
        {both ? (
          <>
            <path d="M 4 18 A 14 14 0 0 1 32 18" fill="none" stroke={MONEY_DEPOSIT} strokeWidth="2.2" strokeLinecap="round" strokeDasharray={depDash} />
            <path d="M 4 18 A 14 14 0 0 0 32 18" fill="none" stroke={MONEY_PAYOUT} strokeWidth="2.2" strokeLinecap="round" strokeDasharray={payDash} />
          </>
        ) : depTotal > 0 ? (
          <circle cx="18" cy="18" r="14" fill="none" stroke={MONEY_DEPOSIT} strokeWidth="2.2" strokeLinecap="round" strokeDasharray={depDash} />
        ) : (
          <circle cx="18" cy="18" r="14" fill="none" stroke={MONEY_PAYOUT} strokeWidth="2.2" strokeLinecap="round" strokeDasharray={payDash} />
        )}
      </svg>
      {total > 1 ? (
        <span
          className="absolute -top-0.5 -right-0.5 z-20 flex h-[13px] min-w-[13px] items-center justify-center rounded-full px-[3px] text-[8.5px] font-extrabold leading-none text-white tabular-nums ring-[1.5px] ring-white"
          style={{ backgroundColor: payTotal > depTotal ? MONEY_PAYOUT : MONEY_DEPOSIT }}
        >
          {total}
        </span>
      ) : null}
    </>
  );
}

/** 링 상태를 스크린리더용 문구로 — 색/점선만으로 전달되는 정보의 텍스트 대안(WCAG 1.4.1). */
function moneyAriaLabel(status: MoneyStatus | undefined): string {
  if (!status) return "";
  const parts: string[] = [];
  const depTotal = status.depPending + status.depDone;
  const payTotal = status.payPending + status.payDone;
  if (depTotal > 0) {
    const state = status.depPending > 0 ? "예정" : "완료";
    parts.push(`입금 ${state}${depTotal > 1 ? ` ${depTotal}건` : ""}`);
  }
  if (payTotal > 0) {
    const state = status.payPending > 0 ? "예정" : "완료";
    parts.push(`지급 ${state}${payTotal > 1 ? ` ${payTotal}건` : ""}`);
  }
  return parts.length ? `, ${parts.join(", ")}` : "";
}

type MobileScheduleCalendarProps = {
  year: number;
  monthIndex: number;
  campaigns: MobileCalendarCampaign[];
  selectedYmd: string;
  todayYmd: string;
  onSelectDate: (ymd: string) => void;
  onMonthChange: (delta: number) => void;
};

function toBarEvents(
  campaigns: MobileCalendarItem[],
  year: number,
  monthIndex: number,
): MobileCalendarEvent[] {
  const monthStart = new Date(year, monthIndex, 1).getTime();
  const monthEnd = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999).getTime();
  return campaigns
    .filter((campaign) => {
      const start = new Date(campaign.startDate).getTime();
      const end = new Date(campaign.endDate).getTime();
      return start <= monthEnd && end >= monthStart;
    })
    .map((campaign) => ({
      id: campaign.key,
      startDate: campaign.startDate.slice(0, 10),
      endDate: campaign.endDate.slice(0, 10),
    }));
}

function collectMoneyStatus(campaigns: MobileCalendarItem[]): Map<string, MoneyStatus> {
  const map = new Map<string, MoneyStatus>();
  const ensure = (ymd: string): MoneyStatus => {
    let st = map.get(ymd);
    if (!st) {
      st = { depPending: 0, depDone: 0, payPending: 0, payDone: 0 };
      map.set(ymd, st);
    }
    return st;
  };
  for (const campaign of campaigns) {
    // 완료 건도 이제 표시한다(예정=점선/완료=실선) — 구현은 예정만 표시했었다.
    // ⛔ 입금·지급 두 필드를 손으로 읽지 말 것 — 어느 필드가 몇 개인지는 채널이
    // 정한다(슬롯 SSOT). 자사몰은 지급 레그가 둘이라 같은 날 겹치면 `payPending`
    // 이 2가 되고 링에 "2건" 배지가 선다(방향축 집계라 상대는 여기서 구분하지
    // 않는다 — 상대별 구분은 날짜 목록이 맡는다).
    for (const slot of resolveMoneySlotsForChannels(campaign.salesChannels)) {
      // ⛔ 예정일을 직접 읽지 말 것 — 완료된 칸은 **실제로 오간 날**에 선다(슬롯 SSOT).
      const { date: effective } = resolveMoneySlotEffectiveDate(slot, campaign);
      if (!effective) continue;
      const st = ensure(effective.slice(0, 10));
      const done = campaign[slot.flagField];
      if (slot.kind === "DEPOSIT") {
        if (done) st.depDone += 1;
        else st.depPending += 1;
      } else if (done) st.payDone += 1;
      else st.payPending += 1;
    }
  }
  return map;
}

function getDailyCampaignCounts(events: MobileCalendarEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const cursor = parseYmdLocal(event.startDate);
    const end = parseYmdLocal(event.endDate);
    while (cursor.getTime() <= end.getTime()) {
      const ymd = toYmd(cursor);
      counts.set(ymd, (counts.get(ymd) || 0) + 1);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return counts;
}

const DayCell = React.memo(function DayCell({
  day,
  isSelected,
  isToday,
  moneyStatus,
  campaignCount,
  onSelect,
}: {
  day: MonthGridDay;
  isSelected: boolean;
  isToday: boolean;
  moneyStatus?: MoneyStatus;
  campaignCount: number;
  onSelect: (ymd: string) => void;
}) {
  return (
    <button
      type="button"
      // 색 범례 제거 후에도 입금/지급 링(색+점선)만으로 정보가 전달되지 않도록
      // 텍스트 대안을 aria-label에 조건부로 덧붙인다(WCAG 1.4.1).
      aria-label={`${day.date.getMonth() + 1}월 ${day.date.getDate()}일 선택${moneyAriaLabel(moneyStatus)}`}
      aria-pressed={isSelected}
      onClick={() => onSelect(day.ymd)}
      className="relative flex flex-col items-center pt-1 transition-transform duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <div className="relative w-8 h-8 flex items-center justify-center z-10">
        <span
          className={cn(
            "z-10 transition-all duration-300",
            !day.inMonth && "text-[10px] text-slate-300",
            day.inMonth && !isSelected && !isToday && "text-[10px] font-semibold text-slate-700",
            isSelected && "flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-[hsl(var(--cal-primary))] to-blue-800 text-white font-semibold shadow-md shadow-blue-900/20 ring-1 ring-white/20 text-xs",
            // 오늘 라벨은 --cal-primary(진네이비) — 채도 상향된 스팬바 배경 위에서도
            // 13px bold 기준 4.5:1(AA)을 충족한다(blue-600은 3.9:1 미달, ss 검토 P1).
            !isSelected && isToday && "text-[13px] font-bold text-[hsl(var(--cal-primary))] tracking-tight"
          )}
        >
          {day.date.getDate()}
        </span>
        {moneyStatus && !isSelected ? <MoneyRing status={moneyStatus} /> : null}
      </div>

      <div className="h-[8px] flex items-start justify-center gap-[2px] mt-1 z-10 w-full">
        {Array.from({ length: Math.min(Math.max(campaignCount, isToday ? 1 : 0), 3) }).map((_, i) => (
          <div key={i} className={cn("w-1 h-1 rounded-full", isToday ? "bg-blue-500" : "bg-slate-400", i === 1 && "opacity-60", i === 2 && "opacity-30")} />
        ))}
      </div>
    </button>
  );
});

const WeekRow = React.memo(function WeekRow({
  week,
  barEvents,
  selectedYmd,
  todayYmd,
  moneyStatuses,
  dailyCampaignCounts,
  onSelectDate,
}: {
  week: MonthGridDay[];
  barEvents: MobileCalendarEvent[];
  selectedYmd: string;
  todayYmd: string;
  moneyStatuses: Map<string, MoneyStatus>;
  dailyCampaignCounts: Map<string, number>;
  onSelectDate: (ymd: string) => void;
}) {
  // 겹치는 일정은 union 병합 — 정렬된 비중첩 세그먼트만 렌더해 grid 자동 배치가
  // 암시적 2행(스팬 바 2겹 겹침)을 만들지 않게 한다.
  const segments = useMemo(() => getWeekSpanUnion(barEvents, week), [barEvents, week]);

  return (
    <div className="rounded-xl mb-1 relative h-[48px] pt-1">
      {/* 스팬 바 세로 중앙 정렬: 날짜 숫자 박스(32px)는 행 48px 안에서 y=8..40에
          놓이므로(overlay pt-1 + 셀 pt-1 + 32px), 바(32px)도 top 8px로 맞춰
          숫자와 같은 축에 정렬한다. 배경은 캘린더 토큰 계열(--cal-primary-soft →
          --cal-primary 8% 알파, 오너 선택안 B) — "거의 안 보임"과 "너무 진함"
          사이의 은은한 존재감. 날짜 텍스트(slate-700) 대비는 AA(4.5:1) 유지. */}
      <div className="absolute top-[8px] left-0 right-0 grid grid-cols-7 px-1 gap-1 z-0 pointer-events-none">
        {segments.map((segment, idx) => (
          <div
            key={`seg-${idx}`}
            className={cn(
              "h-[32px] bg-gradient-to-b from-[hsl(var(--cal-primary-soft))] to-[hsl(var(--cal-primary)/0.08)] shadow-soft-sm",
              segment.continuesLeft ? "rounded-l-none" : "rounded-l-xl",
              segment.continuesRight ? "rounded-r-none" : "rounded-r-xl"
            )}
            style={{ gridColumn: `${segment.colStart} / span ${segment.colSpan}` }}
          />
        ))}
      </div>
      <div className="absolute inset-0 grid grid-cols-7 gap-1 z-10 pt-1 px-1">
        {week.map((day) => (
          <DayCell
            key={day.ymd}
            day={day}
            isSelected={day.ymd === selectedYmd}
            isToday={day.ymd === todayYmd}
            moneyStatus={moneyStatuses.get(day.ymd)}
            campaignCount={dailyCampaignCounts.get(day.ymd) || 0}
            onSelect={onSelectDate}
          />
        ))}
      </div>
    </div>
  );
});

export const MobileScheduleCalendar = React.memo(function MobileScheduleCalendar({
  year,
  monthIndex,
  campaigns,
  selectedYmd,
  todayYmd,
  onSelectDate,
  onMonthChange,
}: MobileScheduleCalendarProps) {
  const weeks = useMemo(() => getMonthGridWeeks(year, monthIndex), [year, monthIndex]);
  const calendarItems = useMemo(() => buildMobileCalendarItems(campaigns), [campaigns]);
  const barEvents = useMemo(
    () => toBarEvents(calendarItems, year, monthIndex),
    [calendarItems, year, monthIndex],
  );
  const dailyCampaignCounts = useMemo(
    () => getDailyCampaignCounts(barEvents),
    [barEvents]
  );
  const moneyStatuses = useMemo(() => collectMoneyStatus(calendarItems), [calendarItems]);

  // Touch gesture handling (Swipe left/right)
  const [touchStart, setTouchStart] = React.useState<number | null>(null);
  const lastSwipeRef = React.useRef(0);
  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStart(e.targetTouches[0].clientX);
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStart === null) return;
    const touchEnd = e.changedTouches[0].clientX;
    const diff = touchStart - touchEnd;
    setTouchStart(null);

    const now = Date.now();
    if (now - lastSwipeRef.current < 300) return;

    if (diff > 50) {
      lastSwipeRef.current = now;
      onMonthChange(1); // Swiped left -> next month
    } else if (diff < -50) {
      lastSwipeRef.current = now;
      onMonthChange(-1); // Swiped right -> prev month
    }
  };

  const handleSelectDate = useCallback((ymd: string) => {
    onSelectDate(ymd);
    // Vibrate gently on select if supported
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(10);
    }
  }, [onSelectDate]);

  return (
    <section 
      className="rounded-2xl border border-white/60 bg-white/85 backdrop-blur-[20px] shadow-soft-lg px-3 pb-4 pt-3"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="flex items-center justify-between pb-2">
        <button
          type="button"
          aria-label="이전 달"
          onClick={() => onMonthChange(-1)}
          className="flex size-11 items-center justify-center rounded-xl text-slate-500 transition-colors duration-150 active:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <ChevronLeftIcon className="size-5" />
        </button>
        <div className="text-[15px] font-bold text-slate-800 tracking-tight">
          {year}년 {monthIndex + 1}월
        </div>
        <button
          type="button"
          aria-label="다음 달"
          onClick={() => onMonthChange(1)}
          className="flex size-11 items-center justify-center rounded-xl text-slate-500 transition-colors duration-150 active:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <ChevronRightIcon className="size-5" />
        </button>
      </div>

      <div className="grid grid-cols-7 mb-1">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="py-1 text-center text-[11px] font-medium text-slate-500">
            {label}
          </div>
        ))}
      </div>

      {weeks.map((week) => (
        <WeekRow
          key={week[0].ymd}
          week={week}
          barEvents={barEvents}
          selectedYmd={selectedYmd}
          todayYmd={todayYmd}
          moneyStatuses={moneyStatuses}
          dailyCampaignCounts={dailyCampaignCounts}
          onSelectDate={handleSelectDate}
        />
      ))}


    </section>
  );
});
