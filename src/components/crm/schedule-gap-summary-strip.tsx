"use client";

import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScheduleGapBriefing } from "@/lib/schedule-gap-briefing";

/**
 * 매출 공백(확정 캠페인이 하루도 없는 구간) 요약 스트립.
 * 오늘부터 롤링 윈도우 신호라 월 이동과 무관 — 그리드 밖 헤더 영역에 상시 노출한다.
 * 가장 임박한 공백 1건을 클릭하면 그 구간이 속한 달로 점프한다.
 */
export function ScheduleGapSummaryStrip({
  briefing,
  onJumpToMonth,
}: {
  briefing: ScheduleGapBriefing;
  onJumpToMonth: (month: string) => void;
}) {
  const { gaps, summary } = briefing;

  if (summary.gapCount === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-status-success/20 bg-status-success-bg px-3.5 py-2.5 text-xs text-status-success">
        <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
        <span className="font-semibold">향후 일정에 매출 공백 없음</span>
        <span className="opacity-85">모든 기간에 확정 캠페인이 있습니다.</span>
      </div>
    );
  }

  const worst = gaps[0];
  const isRisky = summary.riskyGapCount > 0;

  return (
    <button
      type="button"
      onClick={() => onJumpToMonth(worst.startDate.slice(0, 7))}
      className={cn(
        "flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-3.5 py-2.5 text-left text-xs transition-colors",
        isRisky
          ? "border-status-urgent/25 bg-status-urgent-bg text-status-urgent-text hover:bg-status-urgent-bg/70"
          : "border-status-caution/25 bg-status-caution-bg text-status-caution hover:bg-status-caution-bg/70",
      )}
    >
      {isRisky ? (
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <CalendarClock className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span className="font-semibold">
        매출 공백 {summary.gapCount}건
        {isRisky ? ` · 긴급 ${summary.riskyGapCount}건` : ""}
      </span>
      <span className="opacity-85">
        가장 임박 {worst.label} (
        {worst.daysFromNow <= 0 ? "오늘" : `${worst.daysFromNow}일 후`})
      </span>
      {worst.actionLabel && (
        <span className="ml-auto flex shrink-0 items-center gap-1 font-semibold">
          {worst.actionLabel}
          <ArrowRight className="size-3" aria-hidden="true" />
        </span>
      )}
    </button>
  );
}
