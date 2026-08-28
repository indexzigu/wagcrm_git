"use client";

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import React from "react";
import { cn } from "@/lib/utils";
import type { ScheduleGap } from "@/lib/schedule-gap-briefing";

/** 접힘 요약에 나열할 구간 라벨 수 — 초과분은 "외 N건" */
const MAX_SUMMARY_LABELS = 2;

const URGENCY_COLOR_VAR: Record<string, string> = {
  DANGER: "var(--status-urgent)",
  URGENT: "var(--status-pending)",
};

// 텍스트 전용 색 — a11y: --status-pending(#F59E0B)은 흰 배경 대비 2.16:1로 AA 미달이라
// actionLabel 텍스트에는 더 어두운 --status-caution(#B45309, 대비 4.5:1+)을 쓴다.
const URGENCY_TEXT_COLOR: Record<string, string> = {
  DANGER: "var(--status-urgent)",
  URGENT: "var(--status-caution)",
};

type MobileScheduleGapBarsProps = {
  gaps: ScheduleGap[];
  onSelectGap: (gap: ScheduleGap) => void;
};

/**
 * 확보 필요 날짜 구간 경고 (item 10 — 일 단위 빈 구간 기반, 2026-07-09).
 * 접힘: 한 줄 요약(`확보 필요 2구간 · 7/18~7/20 · 7/27~7/31`) — 시각 높이 최소.
 * 펼침: 구간별 상세(기간 일수·actionLabel), 행 탭 → 캘린더 해당 구간 시작일 선택 후 자동 접힘.
 * 위험(DANGER/URGENT) 0건이면 아무것도 렌더하지 않는다.
 * 라벨은 gap-briefing 의 gap.label("7/18~7/20")을 그대로 재사용 — 주 일부만 빈 구간도 정확히
 * 표시된다(구 주간 버킷은 한 주에 하루라도 캠페인이 있으면 그 주 전체를 OK로 삼켜 미표시).
 */
export const MobileScheduleGapBars = React.memo(function MobileScheduleGapBars({ gaps, onSelectGap }: MobileScheduleGapBarsProps) {
  const [expanded, setExpanded] = useState(false);

  const risky = gaps.filter((gap) => gap.urgency === "DANGER" || gap.urgency === "URGENT");
  if (risky.length === 0) return null;

  const hasDanger = risky.some((gap) => gap.urgency === "DANGER");
  const accentColor = hasDanger ? URGENCY_COLOR_VAR.DANGER : URGENCY_TEXT_COLOR.URGENT;
  const summaryLabels = risky.slice(0, MAX_SUMMARY_LABELS).map((gap) => gap.label);
  const hiddenCount = risky.length - summaryLabels.length;

  return (
    <div className="rounded-2xl border border-white/60 bg-white/85 backdrop-blur-md shadow-soft-sm">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`확보 필요 ${risky.length}구간: 상세 ${expanded ? "접기" : "펼치기"}`}
        onClick={() => setExpanded((previous) => !previous)}
        className="flex min-h-11 w-full items-center gap-2 py-2 px-6 text-left transition-colors duration-150 active:bg-slate-50/70"
      >
        {/* --status-* 토큰은 hex 값이라 hsl() 로 감싸면 hsl(#BF5050) = 무효 CSS 가 되어
            배경색이 통째로 무시된다(점이 안 보였다). hsl(var(--x)) 관용구는 토큰이 HSL
            성분값일 때만 성립한다 — 이 레포에서는 --cal-primary 계열이 그쪽이다. */}
        <div className="size-2 rounded-full shrink-0 shadow-soft-sm" style={{ backgroundColor: accentColor }} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
          확보 필요 <span className="font-semibold">{risky.length}구간</span>
          {summaryLabels.map((label) => (
            <span key={label} className="text-muted-foreground">
              {" "}
              · {label}
            </span>
          ))}
          {hiddenCount > 0 ? (
            <span className="text-muted-foreground"> 외 {hiddenCount}건</span>
          ) : null}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded ? (
        // 요약 헤더와 펼침 본문을 가르는 자리라 행 헤어라인이 아니라 섹션 경계다
        // (시트 헤더 밑줄과 같은 구조) — 안쪽 행-행 경계보다 진해야 중첩이 읽힌다.
        <div className="flex flex-col border-t border-slate-200/60">
          {risky.map((gap) => (
            <button
              key={gap.startDate}
              type="button"
              onClick={() => {
                onSelectGap(gap);
                setExpanded(false);
              }}
              className="flex min-h-11 w-full items-center gap-2 border-b border-slate-100 py-3 px-6 text-left transition-colors duration-150 active:bg-slate-50/70 last:border-b-0"
            >
              <div className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: URGENCY_TEXT_COLOR[gap.urgency] }} />
              <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                {gap.label} · {gap.dayCount}일 ·{" "}
                <span
                  className="font-medium"
                  style={{ color: URGENCY_TEXT_COLOR[gap.urgency] }}
                >
                  {gap.actionLabel}
                </span>
              </span>
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
