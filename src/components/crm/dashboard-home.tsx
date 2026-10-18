"use client";

import Link from "next/link";
import {
  CalendarDays,
  Settings2,
  Target,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";

import { Card, CardContent } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useReducedMotion } from "motion/react";
import { CrmShell } from "./crm-shell";
import { ScheduleGapBriefingBody } from "./schedule-gap-briefing-card";
import { UpcomingScheduleBody, UpcomingScheduleCard, CalendarSyncBadge } from "./upcoming-schedule-card";
import { DataIntegrityBody } from "./data-integrity-card";
import { usePriceOverview, PriceDefenseBody, PriceDefenseLegend } from "./price-defense-card";
import { SegmentedTabCard, type SegmentedTab } from "./segmented-tab-card";
import { TaxableRevenueCard } from "./taxable-revenue-card";
import { TodayWorkCard } from "./today-work-card";
import { resolveOrderSyncState } from "@/lib/order-converter/order-work-buckets";
import { buildTodayWorkRows, DATA_CHECK_ANCHOR } from "@/lib/today-work";
import { useOrderWorkSummary } from "@/hooks/useOrderWorkSummary";
import { useApprovalInbox } from "@/hooks/useApprovalInbox";
import type { DesktopDashboardData } from "@/lib/desktop-dashboard";
import { DASHBOARD_PAGE_SCOPE_CAPTION } from "@/lib/dashboard-scope";
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  resolveGoalBand,
  goalBarWidth,
  GOAL_BAND_TEXT_ON_NAVY,
  GOAL_BAND_FILL_ON_NAVY,
  GOAL_BAND_TEXT_UNSET_ON_NAVY,
} from "@/lib/goal-band";

import { useState, useEffect } from "react";
import { AnimatedNumber } from "@/components/ui/animated-number";


// WAG CRM 팔레트 스펙(오너 승인, 2026-07-09) — 차트라인/기준선 하드코딩 색 → 토큰 수렴
// 매출총이익 = 청록 면색 --fill-teal-1(2026-10-18). 종전 --chart-4 는 --status-pending(대기 주황)과 같은 값이라
// 심각도 축으로 읽혔다(P8 §1). 같은 청록 계열 중 앵커 막대(--chart-1)와 가장 잘 갈리면서 흰 카드 위 대비가
// 종전 주황(2.15)보다 떨어지지 않는 값: chart-1 대비 2.86 · 흰 카드 2.57. --chart-2 는 chart-1 과 1.56 이라
// 붙은 막대에서 안 갈린다. 계열 구분은 색 + 막대 폭(넓게·좁게) + 범례 이름 세 겹이다.
// 면색은 흰 카드 위 3:1 에 못 미치므로(2.57) 막대·범례·툴팁 견본에 --chart-2 1px 테두리를 둘러 가장자리가
// 3:1(흰 카드 대비 4.7)을 넘게 한다(2026-10-18 ss-ux P2) — 면은 그대로 청록 면색이라 계열 구분은 유지된다.
const chartConfig = {
  revenue: { label: "총거래액", color: "var(--chart-1)" },
  expectedMargin: { label: "매출총이익", color: "var(--fill-teal-1)" },
  goal: { label: "거래액 목표", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

// 6개월 차트 전용 툴팁 — 목표 매출 제외(오너 피드백 2026-07-10), 매출·순마진 + 파생 마진율만.
function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const pick = (key: string) => {
    const v = payload.find((p) => p.dataKey === key)?.value;
    return typeof v === "number" ? v : null;
  };
  const revenue = pick("revenue");
  const margin = pick("expectedMargin");
  const marginRate = revenue && revenue > 0 && margin != null ? (margin / revenue) * 100 : null;
  return (
    <div className="rounded-lg border border-black/5 bg-white px-3 py-2 shadow-soft-md text-xs min-w-[150px]">
      <p className="text-[11px] font-semibold text-[var(--primary)] mb-1">{label ? `${parseInt(String(label).slice(5), 10)}월` : ""}</p>
      {revenue != null && (
        <div className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-[2px]" style={{ backgroundColor: "var(--chart-1)" }} />
            총거래액
          </span>
          <span className="font-semibold text-[#1F2A30] tabular-nums">{formatCurrency(revenue)}</span>
        </div>
      )}
      {margin != null && (
        <div className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-[2px] border" style={{ backgroundColor: "var(--fill-teal-1)", borderColor: "var(--chart-2)" }} />
            매출총이익
          </span>
          <span className="font-semibold text-[#1F2A30] tabular-nums">{formatCurrency(margin)}</span>
        </div>
      )}
      {marginRate != null && (
        <div className="flex items-center justify-between gap-4 py-0.5 mt-0.5 border-t border-slate-100 pt-1">
          <span className="text-muted-foreground">매출총이익률</span>
          <span className="font-semibold text-[#1F2A30] tabular-nums">{marginRate.toFixed(1)}%</span>
        </div>
      )}
    </div>
  );
}

/**
 * 거래액 차트 머리 줄 — 왼쪽 범위 한 마디, 오른쪽 범례. 두 막대 계열(--chart-1 총거래액 · --fill-teal-1
 * 매출총이익)을 **색만으로 가르지 않도록**(P8) 이름을 붙이고, 견본 폭도 실제 막대 폭(넓게·좁게)을 따른다.
 * 목표선은 그 기간에 목표가 하나라도 있을 때만 범례에 올린다(없는 선을 설명하지 않는다).
 */
function SalesChartCaption({ caption, showGoal }: { caption: string; showGoal: boolean }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p className="text-[11px] text-muted-foreground">{caption}</p>
      <ul data-slot="chart-legend" aria-label="차트 범례" className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-3 rounded-[2px]" style={{ backgroundColor: "var(--chart-1)" }} />
          {chartConfig.revenue.label}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2 rounded-[2px] border" style={{ backgroundColor: "var(--fill-teal-1)", borderColor: "var(--chart-2)" }} />
          {chartConfig.expectedMargin.label}
        </li>
        {showGoal ? (
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="w-3 border-t-2 border-dashed" style={{ borderColor: "var(--muted-foreground)" }} />
            {chartConfig.goal.label}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** 차트 Y축 눈금 — 1억 이상은 「억」(「30000만」은 자릿수를 세어야 읽힌다), 그 아래는 「만」. */
export function formatAxisWon(value: number): string {
  // 소수 둘째 자리까지(눈금이 2.25억처럼 4등분에 떨어진다 — 한 자리로 반올림하면 2.3억으로 틀린 값이 된다).
  if (Math.abs(value) >= 100_000_000) return `${Number((value / 100_000_000).toFixed(2))}억`;
  return `${Math.round(value / 10000)}만`;
}

function rate(actual: number, target: number | null | undefined): number | null {
  if (target == null || target <= 0) return null;
  return Math.round((actual / target) * 1000) / 10;
}

function displayRate(value: number | null | undefined): string {
  return value == null ? "미설정" : `${value.toFixed(1)}%`;
}

function ratioText(value: number, total: number) {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "-";
}

function monthLabel(monthKey: string) {
  const m = parseInt(monthKey.slice(5, 7), 10);
  return `${m}월`;
}


function monthlyActionHint(achievementRate: number | null, targetSet: boolean): string {
  if (!targetSet) return "운영 설정에서 월 목표를 등록하세요";
  if (achievementRate == null) return "";
  if (achievementRate >= 100) return "다음 달 선행 영업 준비 착수 가능";
  if (achievementRate >= 80) return "잔여 목표 소진 후 다음 달 파이프라인 점검";
  if (achievementRate >= 50) return "현재 페이스 유지, 파이프라인 추가 확보 병행";
  return "캠페인 추가 집행 및 영업 파이프라인 가속 필요";
}

function annualActionHint(achievementRate: number | null, targetSet: boolean): string {
  if (!targetSet) return "운영 설정에서 연간 목표를 등록하세요";
  if (achievementRate == null) return "";
  if (achievementRate >= 80) return "연간 초과 달성 대비 리소스 재배분 검토";
  if (achievementRate >= 50) return "현재 흐름 유지, 하반기 캠페인 계획 수립";
  if (achievementRate >= 30) return "하반기 영업 전략 강화 및 신규 파트너 확대 필요";
  return "영업 전략 전면 재검토 및 목표 현실성 점검 필요";
}

function StockTrendIndicator({
  current,
  previous,
  isCurrency = false,
  suffix = "",
}: {
  current: number;
  previous: number | null;
  isCurrency?: boolean;
  suffix?: string;
}) {
  if (previous == null || previous === 0) return null;
  const change = current - previous;
  const percent = (change / previous) * 100;

  if (change === 0) {
    return <span className="text-muted-foreground text-[10px]">변동 없음</span>;
  }

  const isUp = change > 0;
  // WAG CRM 팔레트 스펙(오너 승인, 2026-07-09) — 상태색 토큰 수렴(에메랄드→--status-success, 벽돌오렌지→--status-caution)
  const colorClass = isUp ? "text-[var(--status-success)]" : "text-[var(--status-caution)]";

  const sign = isUp ? "▲" : "▼";
  const absChange = Math.abs(change);
  const diffText = isCurrency ? formatCurrency(absChange) : (Number.isInteger(absChange) ? String(absChange) : absChange.toFixed(1));
  const absPercent = Math.abs(percent).toFixed(1);

  const percentText = `(${isUp ? "+" : "-"}${absPercent}%)`;
  // 좁은 칸(200% 확대·좌 칸 1/3 폭)에서 값 옆에 안 들어가면 부모가 이 줄을 값 **아래**로 내린다. 그 줄마저
  // 좁으면 말줄임 + title 로 전체를 남긴다 — 겹치거나 왼쪽 월 라벨 위로 넘치지 않게(2026-10-18 리뷰 HIGH).
  return (
    <span
      className={`min-w-0 max-w-full truncate whitespace-nowrap text-[10px] font-semibold ${colorClass}`}
      title={`${sign} ${diffText}${suffix} ${percentText}`}
    >
      {sign} {diffText}{suffix} <span className="opacity-70">{percentText}</span>
    </span>
  );
}

// 카드 표(당월·전월·전전월)가 다루는 개월 수. 스파크라인의 강조 구간이 이 표와 1:1 대응한다.
const SPARK_FOCUS_MONTHS = 3;

// KPI 카드 하단 6개월 미니 그래프.
// 표는 최근 3개월의 "얼마인가"에 답하고, 이 그래프는 "그 값이 우리 기준으로 높은 편인가"에 답한다.
// 후자는 비교 대상이 3개월뿐이면 답이 안 나오므로(앞선 두 달이 마침 부진하면 당월이 평범해도
// 급등으로 보인다) 6개월을 유지하되, 표가 덮는 최근 3개월을 음영 밴드+진한 색+월 라벨로 묶어
// "6개월 중 최근 3개월을 위 표로 펼친 것"이라는 관계를 화면에 명시한다(오너 결정 2026-07-15, B안).
//
// 가드레일 두 가지:
// 1. 색은 2단계뿐 — 중립 회색(--chart-5, 맥락) + 앵커 틸(--chart-1, 강조는 불투명도로만 2단).
//    --chart-2는 쓰지 않는다: 그 중간 틸은 차트 계열 구분 색(손익 보고서의 영업이익 등)이라, 여기서 "시간적
//    근접"에 재사용하면 한 스와치가 두 의미를 갖는다. 같은 이유로 6개월 대형 차트의 매출총이익 색
//    (--fill-teal-1, 2026-10-18 교체 — 종전 기록의 "대형 차트 = chart-2"는 이미 낡아 있었다)도 빌리지 않는다.
// 2. Y축 눈금·그리드라인 금지 — max가 카드마다 독립 정규화라 카드 간 막대 높이 비교는 무의미하다.
//    눈금이 붙는 순간 "정밀 판독 가능한 계기판"으로 보여 그 비교를 유도한다. 이건 계기판이 아니라
//    라벨 붙은 타임라인 스트립이다.
// 스파크라인 y축 스케일 — 0을 항상 정의역에 포함한다(오너 결정 2026-07-15).
//
// 예상 순마진은 음수가 될 수 있다(netMarginRate에 음수 제약이 없다). 0을 넣지 않으면 적자 달의
// y가 좌표계 밖으로 나가 선이 잘려 사라진다. 0을 넣으면 적자는 0선 아래로 내려가 그대로 보인다.
//
// min~max로 꽉 채우는 대안은 기각됐다(실렌더 검증): 전부 양수인 계열(캠페인 수)에서 0이 좌표계
// 밖으로 밀려나 막대가 통째로 잘리고, 가장 낮은 달이 높이 0으로 사라져 "그 달엔 아무것도 없었다"로
// 읽힌다. 음수가 하나라도 있으면 두 공식은 어차피 동일한 좌표를 낸다 — 즉 이 스케일은 손해가 없다.
function sparkScale(points: number[], H: number) {
  const PAD = 2;
  const lo = Math.min(0, ...points);
  const hi = Math.max(0, ...points);
  const span = hi - lo || 1;
  const y = (p: number) => H - PAD - ((p - lo) / span) * (H - PAD * 2);
  return { y, zeroY: y(0), hasNegative: lo < 0 };
}

function Sparkline({ points, months, type }: { points: number[]; months: string[]; type: "bars" | "line" }) {
  const H = 22;
  const W = 120;
  const { y, zeroY, hasNegative } = sparkScale(points, H);
  // 강조 구간 시작 인덱스. 표가 3개월이므로 뒤에서 3번째부터가 focus다.
  // (음영 밴드는 오너 지시로 제거(2026-07-24) — 강조는 막대·라벨 색/무게로만 표현한다)
  const focusFrom = Math.max(0, points.length - SPARK_FOCUS_MONTHS);
  // 0선은 적자가 있을 때만 그린다 — 전부 흑자면 0선은 바닥과 같아 잉크만 늘린다.
  const zeroLine = hasNegative ? (
    <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke="var(--chart-5)" strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />
  ) : null;

  const axis = (
    // 라벨은 SVG 밖 HTML flex로 배치한다. SVG는 preserveAspectRatio="none"이라 카드 폭만큼
    // 수평 확대되므로, 안에 넣은 <text>는 글자가 가로로 뭉개진다(끝점 원을 밖으로 뺀 것과 같은 이유).
    // 6개월 라벨 전부 노출(오너 2026-07-24) — 중간 달 생략은 축이 불연속으로 오독됐다.
    <div className="mt-0.5 flex" data-slot="spark-axis" aria-hidden="true">
      {months.map((m, i) => {
        const isFocus = i >= focusFrom;
        return (
          <span
            key={m}
            className={`flex-1 text-center text-[8px] leading-none tabular-nums ${
              isFocus ? "font-bold text-[var(--primary)]" : "text-muted-foreground"
            }`}
          >
            {monthLabel(m)}
          </span>
        );
      })}
    </div>
  );

  if (type === "bars") {
    const slot = W / points.length;
    return (
      <div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[22px]" preserveAspectRatio="none" aria-hidden="true">
          {zeroLine}
          {points.map((p, i) => {
            // 막대는 0선에서 자란다 — 적자 달은 0선 아래로 매달린다.
            // 최소 2px 바닥값은 '방향을 보존한 채' 준다: 0인 달에 top=zeroY로 두고 높이만 주면
            // 막대가 0선 아래로 매달려 적자처럼 보인다. 부호로 어느 쪽에 그릴지 먼저 정한다.
            const signed = zeroY - y(p);
            const h = Math.max(2, Math.abs(signed));
            const top = signed >= 0 ? zeroY - h : zeroY;
            const isFocus = i >= focusFrom;
            const isCurrent = i === points.length - 1;
            return (
              <rect
                key={i}
                x={i * slot + 2}
                y={top}
                width={slot - 4}
                height={h}
                rx={1}
                fill={isFocus ? "var(--chart-1)" : "var(--chart-5)"}
                fillOpacity={isCurrent ? 1 : isFocus ? 0.55 : 0.35}
                className="animate-grow-y"
                // .animate-grow-y는 rect 자기 아래변(transform-origin: bottom)에서 자란다. 0선 아래로
                // 매달린 적자 막대는 아래변이 '가장 깊은 손실'이라 그대로 두면 손실 바닥에서 0선으로
                // 솟는 모션이 된다 — 하락이 성장으로 읽힌다. 적자 막대만 원점을 위(=0선)로 뒤집는다.
                style={{ animationDelay: `${i * 25}ms`, transformOrigin: p < 0 ? "top" : undefined }}
              />
            );
          })}
        </svg>
        {axis}
      </div>
    );
  }

  const step = W / (points.length - 1 || 1);
  const coord = (p: number, i: number) => `${i * step},${y(p)}`;
  // 폴리라인을 둘로 나누되 경계점(focusFrom)을 양쪽이 공유해 선이 끊겨 보이지 않게 한다.
  // 색은 선분 단위로 결정되므로 경계점의 소속을 고민할 필요가 없다 — 경계 이전 선분은 맥락,
  // 이후 선분은 강조다.
  const contextPts = points.slice(0, focusFrom + 1).map((p, i) => coord(p, i)).join(" ");
  const focusPts = points.slice(focusFrom).map((p, i) => coord(p, focusFrom + i)).join(" ");
  // 끝점(현재값) 점은 SVG 안에 두지 않는다: 라인 SVG는 preserveAspectRatio="none"으로
  // 카드 폭(~3.7배)만큼 수평 확대되므로, 그 좌표계의 <circle>은 넓은 타원으로 늘어나
  // 우측 가장자리를 넘어 잘린다. 대신 stretch를 받지 않는 절대배치 HTML 점으로 얹어
  // 항상 정원을 유지하고 카드 오른쪽 안쪽에 온전히 들어오게 한다(반응형 폭 무관).
  const lastTopPct = (y(points[points.length - 1] ?? 0) / H) * 100;
  return (
    <div>
      <div className="relative w-full h-[22px] animate-spark-reveal">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[22px]" preserveAspectRatio="none" aria-hidden="true">
          {zeroLine}
          <polyline
            points={contextPts}
            fill="none"
            stroke="var(--chart-5)"
            strokeOpacity={0.5}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
          <polyline points={focusPts} fill="none" stroke="var(--chart-1)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>
        {/* right:0 → 점의 오른쪽 끝을 컨테이너 우측에 맞춰 좌우 잘림 원천 차단.
            top은 데이터 y 비율(%)로 배치, y()의 상·하 3px 여백이 반지름 2.5px를 흡수해 세로도 안 잘림. */}
        <span
          className="absolute right-0 h-[5px] w-[5px] -translate-y-1/2 rounded-full bg-[var(--chart-1)]"
          style={{ top: `${lastTopPct}%` }}
          aria-hidden="true"
        />
      </div>
      {axis}
    </div>
  );
}

function MetricCard({
  label,
  value,
  prevValue,
  prevPrevValue,
  numericValue,
  prevNumericValue,
  currentMonthKey,
  prevMonthKey,
  prevPrevMonthKey,
  note,
  icon: Icon,
  isCurrency = false,
  suffix = "",
  tone = "navy",
  decimalPlaces = 0,
  spark,
}: {
  label: string;
  value: string;
  prevValue?: string;
  prevPrevValue?: string;
  numericValue?: number;
  prevNumericValue?: number;
  currentMonthKey: string;
  prevMonthKey: string;
  prevPrevMonthKey?: string;
  note: string;
  icon: typeof Target;
  isCurrency?: boolean;
  suffix?: string;
  tone?: "navy" | "orange";
  decimalPlaces?: number;
  spark?: { points: number[]; months: string[]; type: "bars" | "line" };
}) {
  // WAG CRM 팔레트 스펙(오너 승인, 2026-07-09) — 아이콘톤 토큰 수렴(navy=--primary 유지, orange→--status-caution)
  const iconTones = {
    navy: "text-[var(--primary)]",
    orange: "text-[var(--status-caution)]",
  };
  // 경고는 표가 덮는 최근 3개월(강조 구간)의 적자만 잡는다. 스파크라인은 6개월이지만 5개월 전
  // 적자는 지금의 행동을 바꾸지 않는다 — 그 달의 하락은 그래프에 남고, 경고 문구는 아끼는 게 맞다.
  const focusPoints = spark?.points.slice(-SPARK_FOCUS_MONTHS) ?? [];
  const lossMonths = spark?.months.slice(-SPARK_FOCUS_MONTHS).filter((_, i) => focusPoints[i] < 0) ?? [];
  return (
    // h-full: 첫 밴드에서 히어로 높이를 받아 늘어난다 — 남는 높이는 표와 스파크라인 사이(mt-auto)로 가고
    // 스파크라인은 카드 바닥에 붙는다(2026-10-18 리뷰: 좌 칸 아래가 비어 첫 줄이 기울었다).
    <Card className="h-full border-black/5 bg-white/85 shadow-soft-sm p-0">
      {/* 데이터 점검 카드 밀도 기준(오너 2026-07-10): 행 기반·타이트, 라벨 좌/값 우, 얇은 구분선. Card 기본 p-6 제거해 이중 패딩(48px) 해소 */}
      <CardContent className="flex flex-1 flex-col px-4 py-3">
        {/* 서브텍스트는 제목 우측에 이어서(오너 2026-07-24 — 카드 폭이 넓어 별도 줄이 불필요).
            좁은 폭에서는 truncate로 잘리되 title 속성으로 전문 확인 가능.
            적자 달 경고는 note 줄을 '추가'하지 않고 같은 슬롯에서 '교체'한다(오너 결정 2026-07-15, D안):
            추가하면 카드 높이가 적자 유무에 따라 생겼다 사라져 KPI 스트립 3장이 데이터에 따라 점프한다.
            note는 매달 동일한 상용구라 적자인 달에 가려도 잃는 정보가 없다. */}
        <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
          <Icon className={`size-4 shrink-0 ${iconTones[tone]}`} />
          <p className="text-[13px] font-semibold text-[var(--primary)] tracking-tight shrink-0">{label}</p>
          {lossMonths.length > 0 ? (
            <p
              className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--status-caution-text)]"
              title={`${lossMonths.map(monthLabel).join("·")} 적자`}
            >
              {lossMonths.map(monthLabel).join("·")} 적자
            </p>
          ) : (
            <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={note}>
              {note}
            </p>
          )}
        </div>

        {/* 월별 위계는 글자 '크기'가 아닌 무게·명도로 표현(오너 피드백 2026-07-14): 세 달 값 모두 13px 동일
            — 형제 카드(데이터 점검 13px 등)와 크기 통일(오너 2026-07-24, 15px bold는 KPI만 튀었음).
            당월 semibold·진한 텍스트(#1F2A30) → 전월/전전월은 동일 뮤트색(--muted-foreground, AA 4.76:1)에
            medium vs normal 무게로만 구분한다. globals.css:174 원칙대로 위계 약화에 opacity를 쓰지 않는다.
            증감(보조지표)은 당월 값 좌측에 두고 우측 정렬로 묶어, 값 컬럼의 우측 기준선을 밀지 않는다 */}
        <div className="mt-1.5">
          {/* 당월 행 */}
          {/* 값이 먼저(DOM)·증감이 뒤 + flex-row-reverse: 한 줄에 들어가면 「증감 값」 순으로 오른쪽 정렬, 안 들어가면
              증감이 값 **아래 줄**로 내려가 오른쪽에 붙는다(겹침·잘림 대신 줄바꿈 — 2026-10-18 리뷰 HIGH). */}
          <div data-slot="metric-current-row" className="flex items-baseline justify-between gap-2 py-1">
            <span className="text-[11px] font-semibold text-muted-foreground shrink-0">{monthLabel(currentMonthKey)}</span>
            <div className="flex min-w-0 flex-1 flex-row-reverse flex-wrap items-baseline justify-start gap-x-1.5">
              <span className="shrink-0 text-[13px] font-semibold tracking-tight text-[#1F2A30] tabular-nums">
                {numericValue !== undefined ? (
                  <AnimatedNumber value={numericValue} format={isCurrency ? "currency" : "raw"} decimalPlaces={decimalPlaces} suffix={suffix} />
                ) : (
                  value
                )}
              </span>
              {numericValue !== undefined && prevNumericValue !== undefined && (
                <StockTrendIndicator current={numericValue} previous={prevNumericValue} isCurrency={isCurrency} suffix={suffix} />
              )}
            </div>
          </div>
          {/* 전월 행: 동일 크기·medium·뮤트 */}
          {prevValue && (
            <div className="flex items-baseline justify-between gap-2 py-1 border-t border-gray-100">
              <span className="text-[11px] text-muted-foreground shrink-0">{monthLabel(prevMonthKey)}</span>
              <span className="text-[13px] font-medium text-muted-foreground tabular-nums">{prevValue}</span>
            </div>
          )}
          {/* 전전월 행: 동일 크기·normal·가장 옅은 뮤트. 증감 화살표는 당월 행에만 두어 과밀 방지 */}
          {prevPrevValue && prevPrevMonthKey && (
            <div className="flex items-baseline justify-between gap-2 py-1 border-t border-gray-100">
              <span className="text-[11px] text-muted-foreground shrink-0">{monthLabel(prevPrevMonthKey)}</span>
              <span className="text-[13px] font-normal text-muted-foreground tabular-nums">{prevPrevValue}</span>
            </div>
          )}
        </div>

        {spark && spark.points.length > 1 && (
          <div className="mt-auto pt-1">
            <Sparkline points={spark.points} months={spark.months} type={spark.type} />
          </div>
        )}

      </CardContent>
    </Card>
  );
}



function ShortageGridRow({
  monthKey,
  actual,
  target,
  show,
}: {
  monthKey: string;
  actual: number;
  target: number | null;
  show: boolean;
}) {
  if (!show) return null;

  const rateVal = rate(actual, target);
  const change = target ? actual - target : 0;
  const hasTarget = target != null && target > 0;

  const isUp = change > 0;
  // 색은 달성 밴드 한 곳에서만 나온다(goal-band SSOT). 이전엔 증감(isUp)과 달성률이
  // 서로 다른 규칙을 써서 초과=골드·미달=흐림으로 뒤집혀 있었다 — 조치가 필요한 쪽이
  // 방치해도 되는 쪽보다 흐렸다. 방향은 부호(▲▼)가, 심각도는 밴드 색이 맡는다.
  const band = resolveGoalBand(rateVal);
  const bandClass = band ? GOAL_BAND_TEXT_ON_NAVY[band] : GOAL_BAND_TEXT_UNSET_ON_NAVY;
  const sign = isUp ? "▲" : "▼";
  const absChange = Math.abs(change);

  return (
    <div className="grid grid-cols-[24px_72px_10px_65px_auto] items-baseline gap-x-1.5 border-t border-white/5 pt-2">
      <span className="text-[11px] text-white/40 shrink-0">{monthLabel(monthKey)}</span>
      <p className="text-xs font-medium text-white/60 text-left">{formatCurrency(actual)}</p>
      {hasTarget ? (
        <>
          <span className={`text-[10px] font-semibold text-center ${bandClass}`}>{sign}</span>
          <span className={`text-[10px] font-semibold text-right ${bandClass}`}>{formatCurrency(absChange)}</span>
        </>
      ) : (
        <>
          <span />
          <span />
        </>
      )}
      <div className="text-right">
        <p className={`text-xs font-medium ${bandClass}`}>{displayRate(rateVal)}</p>
      </div>
    </div>
  );
}

// `/api/agenda` 응답 중 홈이 읽는 부분 — 건수와 지연된 정산 id(그룹은 대표 멤버 id)뿐이다. 목록 렌더·
// 빠른 정산 창은 「오늘 처리할 일」로 흡수되며 빠졌다(2026-10-18).
interface AgendaItem {
  id: string;
}

interface AgendaData {
  tasks: AgendaItem[];
  settlements: AgendaItem[];
}

export function DashboardHome({ initialData }: { initialData: DesktopDashboardData }) {
  const [agendaData, setAgendaData] = useState<AgendaData>({ tasks: [], settlements: [] });
  // 초기값 true: fetch 시작 전 첫 페인트에 「오늘 처리할 일」 접힘 문구(「오늘 처리할 일이 없습니다」)가 잠깐
  // 보였다가 행이 들어오는 플래시 방지 — 아젠다 건수를 모르는 동안은 「없다」고 말하지 않는다.
  const [agendaLoading, setAgendaLoading] = useState(true);
  const [agendaError, setAgendaError] = useState<string | null>(null);

  // 최저가 점검 데이터를 대시보드 레벨에서 fetch(오너 2026-07-24, 1순위 탭 묶음) — 위반 수를
  // 탭 배지(숨은 탭 알림)로 반응형 반영하려면 데이터가 탭 레벨에서 필요하다.
  const priceOverview = usePriceOverview();
  // 막대 성장 애니메이션은 OS 「동작 줄이기」면 끈다(recharts 는 CSS 가드 밖이라 JS 로).
  const reducedMotion = useReducedMotion();

  const fetchAgenda = async () => {
    setAgendaLoading(true);
    setAgendaError(null);
    try {
      const res = await fetch("/api/agenda");
      if (!res.ok) throw new Error("데이터를 불러오는데 실패했습니다.");
      const json = await res.json();
      setAgendaData(json);
    } catch (err: unknown) {
      setAgendaError(err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.");
    } finally {
      setAgendaLoading(false);
    }
  };

  useEffect(() => {
    fetchAgenda();
  }, []);

  // 「오늘 처리할 일」 원천 — 카드는 fetch 하지 않고 여기서 모아 준다(today-work.ts). 주문 요약은 사이드바
  // 배지와 한 캐시(`useOrderWorkSummary`), 승인대기 수는 사이드바 `ApprovalBadge` 와 같은 쿼리키라
  // 추가 요청이 생기지 않는다. 데이터 점검 건수는 아래 「데이터 점검」 탭과 같은 배열이다.
  const orderWork = useOrderWorkSummary();
  const approvals = useApprovalInbox("PENDING_APPROVAL");
  const todayRows = buildTodayWorkRows({
    orders: orderWork.data,
    agenda: {
      tasks: agendaData.tasks.length,
      settlements: agendaData.settlements.length,
      overdueSettlementIds: agendaData.settlements.map((item) => item.id),
    },
    approvalsPending: approvals.count,
    dataCheck: initialData.dataIntegrityIssues.length,
  });
  const todayFailedSources = [
    orderWork.isError ? "주문" : null,
    agendaError ? "영업·정산" : null,
    approvals.isError ? "승인대기" : null,
  ].filter((name): name is string => name != null);
  const retryTodayWork = () => {
    if (orderWork.isError) void orderWork.refetch();
    if (agendaError) void fetchAgenda();
    if (approvals.isError) void approvals.refetch();
  };
  // 낡음 판정의 「지금」은 데이터를 받은 시각이다 — 렌더 중 Date.now() 는 순수하지 않다.
  const orderSync = orderWork.data ? resolveOrderSyncState(orderWork.data, orderWork.dataUpdatedAt) : null;

  const monthRate = rate(initialData.goals.monthActual, initialData.goals.monthTarget);
  const annualRate = rate(initialData.goals.ytdActual, initialData.goals.annualTarget);
  // 달성률 색·바 fill 은 goal-band SSOT 에서만 나온다 — 모바일 히어로와 같은 규칙.
  // 이전엔 값과 무관하게 항상 골드라 61%도 119%도 같은 색이었다(색이 값의 함수가 아니었음).
  const monthBand = resolveGoalBand(monthRate);
  const annualBand = resolveGoalBand(annualRate);
  const monthBandClass = monthBand ? GOAL_BAND_TEXT_ON_NAVY[monthBand] : GOAL_BAND_TEXT_UNSET_ON_NAVY;
  const annualBandClass = annualBand ? GOAL_BAND_TEXT_ON_NAVY[annualBand] : GOAL_BAND_TEXT_UNSET_ON_NAVY;
  // 미설정이면 fill 클래스를 아예 주지 않는다(모바일 히어로와 같은 처리). "미설정인데 normal
  // 색을 칠하고 너비 0으로 가린다"로 두면, 이 클래스가 폭과 분리된 곳에 재사용될 때 되살아난다.
  const monthFillClass = monthBand ? GOAL_BAND_FILL_ON_NAVY[monthBand] : "";
  const annualFillClass = annualBand ? GOAL_BAND_FILL_ON_NAVY[annualBand] : "";
  
  const currentMonthKey = initialData.selectedMonth;
  const year = currentMonthKey.slice(0, 4);

  // 매출 차트 두 탭(최근 6개월·연간 매출)의 공통 Y축 상한(오너 2026-07-24) — 두 시리즈의 매출·순마진·
  // 목표를 통틀어 최댓값을 잡고 보기 좋은 눈금 단위로 올림한다. 두 차트에 같은 domain 을 주면 Y축 틀이
  // 고정되고, 그 위에 얹히는 매출 목표 기준선도 탭 전환 시 흔들리지 않는다.
  const chartYValues = [
    ...initialData.trend.flatMap((t) => [t.revenue, t.expectedMargin, t.goal ?? 0]),
    ...initialData.yearlyTrend.flatMap((t) => [t.revenue, t.expectedMargin, t.goal ?? 0]),
  ];
  const chartYRaw = Math.max(1, ...chartYValues);
  const chartYStep = chartYRaw > 200_000_000 ? 50_000_000 : chartYRaw > 50_000_000 ? 20_000_000 : 10_000_000;
  const chartYMax = Math.ceil(chartYRaw / chartYStep) * chartYStep;

  const prevDate = new Date(`${currentMonthKey}-01T00:00:00Z`);
  prevDate.setUTCMonth(prevDate.getUTCMonth() - 1);
  const prevMonthKey = prevDate.toISOString().slice(0, 7);

  const prevPrevDate = new Date(`${currentMonthKey}-01T00:00:00Z`);
  prevPrevDate.setUTCMonth(prevPrevDate.getUTCMonth() - 2);
  const prevPrevMonthKey = prevPrevDate.toISOString().slice(0, 7);

  const showPrevYtd = prevMonthKey.startsWith(year);
  const showPrevPrevYtd = prevPrevMonthKey.startsWith(year);

  const currentYtd = initialData.goals.ytdActual;

  // 이번 주 / 다음 주 날짜 범위 및 주차 라벨 계산
  const today = new Date();
  const currentDay = today.getDay(); // 0: 일요일, 1: 월요일, ...
  const distanceToMonday = currentDay === 0 ? 6 : currentDay - 1;
  
  const thisWeekMonday = new Date(today);
  thisWeekMonday.setDate(today.getDate() - distanceToMonday);
  thisWeekMonday.setHours(0, 0, 0, 0);

  const nextWeekMonday = new Date(thisWeekMonday);
  nextWeekMonday.setDate(thisWeekMonday.getDate() + 7);

  const getWeekOfMonthLabel = (date: Date) => {
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const week = Math.ceil(d / 7);
    return `${m}월 ${week}주차`;
  };

  const thisWeekLabel = getWeekOfMonthLabel(thisWeekMonday);
  const nextWeekLabel = getWeekOfMonthLabel(nextWeekMonday);

  return (
    <CrmShell>
      <main className="min-h-full bg-[radial-gradient(circle_at_top_right,_rgba(15,95,103,0.07),_transparent_30%),linear-gradient(180deg,_#F8FAFC_0%,_#F1F5F9_100%)] px-5 pb-5 pt-5 md:px-8">
        <div className="space-y-6">
          {/* 범위 안내 — 이 화면의 모든 금액·개수가 같은 범위라 맨 위에 한 번만(오너 2026-10-17). 종전엔
              히어로 두 단에 짧은 캡션이 따로 붙어 같은 말이 두 번 읽혔다. mb-3 은 space-y-6 의 아래 여백(24px)을
              덮어 안내를 첫 밴드에 붙인다(Tailwind v4 space-y 는 :where() 특이성 0 의 margin-bottom). */}
          <p className="mb-3 text-[11px] text-muted-foreground">{DASHBOARD_PAGE_SCOPE_CAPTION}</p>

          {/* 밴드 1: 두 초점(애플 UI 리뉴얼 묶음 1-b, 오너 2026-10-17) — 좌 2fr 「오늘 처리할 일」(그날 손이 가야
              하는 일: 주문·영업 팔로업·정산 지연·승인대기·데이터 점검) | 우 1fr 거래액 목표 히어로(이 화면의
              단일 lg 강조). 둘 다 "지금 무엇을 보고 무엇을 할지"의 답이라 첫 줄에 나란히 둔다.
              좌 칸 아래에 실적 지표 3장을 붙여 히어로 높이를 받는다 — 일 목록만 두면 히어로(약 400px) 옆이
              비어 첫 줄이 한쪽으로 기운다. 일이 없어 「오늘 처리할 일」이 한 줄로 접혀도 늘려서
              빈 카드를 만들지 않는다(접힘 계약 승계). 줄은 items-stretch 로 히어로 높이를 좌 칸에 주고, 그 높이는
              「오늘 처리할 일」이 아니라 실적 지표 칸(flex-1)이 받는다 — 일 카드는 자기 높이 그대로라 접힘이 유지되고,
              좌 칸 아래가 비지 않는다(2026-10-18 리뷰). */}
          <section data-band="focus" className="grid gap-4 xl:grid-cols-[2fr_1fr] items-stretch">
            <div className="flex h-full min-w-0 flex-col gap-4">
              <TodayWorkCard
                rows={todayRows}
                loading={orderWork.isLoading || agendaLoading || approvals.isLoading}
                failedSources={todayFailedSources}
                onRetry={retryTodayWork}
                orderSync={orderSync}
              />

              {/* 실적 지표(1x3) — 월 환산 캠페인 수 · 매출총이익 · 최근 90일 영업 전환. 매출 히어로 옆에서 같이 읽힌다. */}
              <section data-band="metrics" className="grid flex-1 gap-4 sm:grid-cols-3">
                <MetricCard
                  label="월 환산 캠페인 수"
                  value={`${initialData.scale.weightedCampaignCount.toFixed(1)}건`}
                  prevValue={`${initialData.scale.prevWeightedCampaignCount.toFixed(1)}건`}
                  prevPrevValue={`${initialData.scale.prevPrevWeightedCampaignCount.toFixed(1)}건`}
                  numericValue={initialData.scale.weightedCampaignCount}
                  prevNumericValue={initialData.scale.prevWeightedCampaignCount}
                  currentMonthKey={currentMonthKey}
                  prevMonthKey={prevMonthKey}
                  prevPrevMonthKey={prevPrevMonthKey}
                  suffix="건"
                  decimalPlaces={1}
                  note={`조합 그룹은 1건으로 집계 · 운영일 ${formatNumber(initialData.scale.operatingDays)}일 포함 · 월 경계 일정은 비율 배분`}
                  icon={CalendarDays}
                  spark={{
                    points: initialData.trend.map((t) => t.campaignCount),
                    months: initialData.trend.map((t) => t.month),
                    type: "bars",
                  }}
                />
                <MetricCard
                  label="매출총이익"
                  value={formatCurrency(initialData.profitability.expectedMargin)}
                  prevValue={formatCurrency(initialData.profitability.prevExpectedMargin)}
                  prevPrevValue={formatCurrency(initialData.profitability.prevPrevExpectedMargin)}
                  numericValue={initialData.profitability.expectedMargin}
                  prevNumericValue={initialData.profitability.prevExpectedMargin}
                  currentMonthKey={currentMonthKey}
                  prevMonthKey={prevMonthKey}
                  prevPrevMonthKey={prevPrevMonthKey}
                  isCurrency
                  note="진행 중 판단용 추정치"
                  icon={TrendingUp}
                  tone="orange"
                  spark={{
                    points: initialData.trend.map((t) => t.expectedMargin),
                    months: initialData.trend.map((t) => t.month),
                    type: "line",
                  }}
                />

                {/* 최근 90일 영업 전환 — 형제 KPI 카드와 세로 밀도 정합(오너 피드백 2026-07-14):
                    내용을 flex로 세로 분산해 하단 여백을 없애고, 단계별 전환율을 병기해 판독 밀도를 높인다 */}
                <Card className="border-black/5 bg-white/85 shadow-soft-sm p-0 h-full flex flex-col">
                  <CardContent className="px-4 py-3 flex flex-1 flex-col">
                    {/* 서브텍스트는 제목 우측에 이어서 — 형제 KPI 카드와 형식 통일(오너 2026-07-24) */}
                    {/* flex-wrap + 부연 min-w-[8rem]: 3열이 좁아지면(640px·200% 확대) 부연이 제목 다음 줄로 내려간다. */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-2 border-b border-slate-100">
                      <UsersRound className="size-4 shrink-0 text-[var(--primary)]" />
                      <p className="shrink-0 text-[13px] font-semibold text-[var(--primary)] tracking-tight">최근 90일 영업 전환</p>
                      {/* 짧은 두 마디라 좁으면 말줄임 대신 줄을 바꾼다 — 잘린 채 읽을 방법이 없던 자리(2026-10-18 리뷰 HIGH). */}
                      <p
                        className="min-w-[8rem] flex-1 break-keep text-[11px] text-muted-foreground"
                        title={`확정 ${initialData.outreach90d.confirmed}건 · 확정률 ${ratioText(initialData.outreach90d.confirmed, initialData.outreach90d.total)}`}
                      >
                        확정 {initialData.outreach90d.confirmed}건 · 확정률 {ratioText(initialData.outreach90d.confirmed, initialData.outreach90d.total)}
                      </p>
                    </div>
                    {/* 퍼널 막대 — 접촉→응답→전환 폭 비율이 곧 전환 효율. 트랙(전체폭 기준선)+단계별 전환율 병기 */}
                    <div className="mt-3 flex flex-1 flex-col justify-center gap-3">
                      {[
                        { label: "접촉", count: initialData.outreach90d.total, base: initialData.outreach90d.total, strong: false, showRate: false },
                        { label: "응답", count: initialData.outreach90d.responded, base: initialData.outreach90d.total, strong: false, showRate: true },
                        { label: "전환", count: initialData.outreach90d.converted, base: initialData.outreach90d.total, strong: true, showRate: true },
                      ].map((row, i) => (
                        <div key={row.label} className="flex items-center gap-2.5">
                          <span className="w-[26px] shrink-0 text-[11px] font-medium text-muted-foreground">{row.label}</span>
                          {/* 트랙 = 전체폭 기준선이라 빈 구간이 보여야 비율이 읽힌다(오너 2026-10-06: slate-100 은 흰 카드
                              대비 1.09:1 로 사라져 slate-300 으로 진하게 — 과세기준매출 카드와 같은 처리).
                              약한 행(접촉·응답)은 종전 --chart-2 @.45 였는데 slate-300 위 대비가 1.58 이고 불투명으로
                              올려도 2.76 이라 3:1 에 못 닿는다. 그래서 강한 행(전환)과 같은 앵커 틸의 농도 사다리
                              (1.0 / 0.6 — 트랙 대비 7.62 / 3.06)로 바꿨다. --chart-2 중간 틸은 차트 계열
                              구분 색이라 여기서 빌려 쓰지 않는다(스파크라인 계약 테스트와 같은 이유). */}
                          <div className="flex-1 h-2.5 rounded-full bg-slate-300 overflow-hidden">
                            {/* 접촉→응답→전환 순 60ms stagger — 퍼널 순서 자체가 의미라 흐름감을 준다 */}
                            <div
                              className="h-full rounded-full animate-grow-x"
                              style={{
                                width: row.base > 0 ? `${Math.max((row.count / row.base) * 100, 2)}%` : "2%",
                                backgroundColor: "var(--chart-1)",
                                opacity: row.strong ? 1 : 0.6,
                                animationDelay: `${i * 60}ms`,
                              }}
                            />
                          </div>
                          <span className="w-[30px] shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                            {row.showRate ? ratioText(row.count, row.base) : ""}
                          </span>
                          {/* 값 크기·무게는 형제 MetricCard 당월 값(13px semibold)과 통일(오너 2026-07-24) */}
                          <span className="w-[34px] shrink-0 text-right text-[13px] font-semibold text-[#1F2A30] tabular-nums">{row.count}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </section>
            </div>

            {/* 거래액 목표 히어로 — WAG 팔레트: --hero-deep 토큰, 공유 elevation(shadow-soft-lg = 페이지당 1개) */}
            <Card className="overflow-hidden border-0 bg-[var(--hero-deep)] text-white shadow-soft-lg px-6 py-3 flex flex-col">
              {/* 1. 연간 누적 (위) */}
              <div className="space-y-3">
                <div className="flex items-start justify-between">
                  <h2 className="text-lg font-bold text-white/90">연간 누적</h2>
                  <Target className="size-4 text-white/30" />
                </div>

                <div className="mt-3 space-y-2.5">
                  {/* 당월 누적 행 */}
                  <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[11px] font-semibold text-white/60 w-[28px] shrink-0">누적</span>
                      <div>
                        <p className="text-2xl font-bold tracking-tight text-white/90">
                          <AnimatedNumber value={currentYtd} format="currency" />
                        </p>
                        <p className="text-[10px] text-white/60">
                          연 목표 {initialData.goals.annualTarget == null ? "미설정" : formatCurrency(initialData.goals.annualTarget)}
                        </p>
                      </div>
                    </div>
                    <p className={`text-2xl font-bold ${annualBandClass}`}>
                      {annualRate == null ? (
                        "미설정"
                      ) : (
                        <AnimatedNumber value={annualRate} format="percent" decimalPlaces={1} fallback="미설정" />
                      )}
                    </p>
                  </div>
                </div>

                <div className="relative h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className={`h-full rounded-full animate-grow-x ${annualFillClass}`} style={{ width: `${goalBarWidth(annualRate)}%` }} />
                  {initialData.ytdHistory && initialData.goals.annualTarget && initialData.ytdHistory.slice(0, -1).map((h) => {
                    const p = (h.ytd / initialData.goals.annualTarget!) * 100;
                    if (p <= 0 || p >= 100) return null;
                    return (
                      <div 
                        key={h.month} 
                        className="absolute top-0 bottom-0 w-0.5 bg-white/50" 
                        style={{ left: `${p}%` }} 
                        title={`${monthLabel(h.month)} 누적: ${formatCurrency(h.ytd)}`} 
                      />
                    );
                  })}
                </div>
                <p className="text-[10px] text-white/80 leading-none">{annualActionHint(annualRate, initialData.goals.annualTarget != null)}</p>
              </div>

              {/* 구분선 및 이번 달 매출 (아래) */}
              <div className="border-t border-white/10 mt-4 pt-4 space-y-3">
                <div className="flex items-start justify-between">
                  <h2 className="text-lg font-bold">이번 달 거래액</h2>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Link href="/settings/operations?section=goals" aria-label="거래액 목표 설정" className="rounded-full bg-white/10 p-1 text-white/80 hover:bg-white/20">
                          <Settings2 className="size-3" aria-hidden="true" />
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent>운영 설정에서 목표 수정 가능</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                
                {/* 당월 수치 및 진행률 */}
                <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[11px] font-semibold text-white/70 w-[28px] shrink-0">{monthLabel(currentMonthKey)}</span>
                    <div>
                      <p className="text-2xl font-bold tracking-tight">
                        <AnimatedNumber value={initialData.goals.monthActual} format="currency" />
                      </p>
                      <p className="text-[10px] text-white/60">목표 {initialData.goals.monthTarget == null ? "미설정" : formatCurrency(initialData.goals.monthTarget)}</p>
                    </div>
                  </div>
                  <p className={`text-2xl font-bold ${monthBandClass}`}>
                    {monthRate == null ? (
                      "미설정"
                    ) : (
                      <AnimatedNumber value={monthRate} format="percent" decimalPlaces={1} fallback="미설정" />
                    )}
                  </p>
                </div>

                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className={`h-full rounded-full animate-grow-x ${monthFillClass}`} style={{ width: `${goalBarWidth(monthRate)}%` }} />
                </div>
                <p className="text-[10px] text-white/80 leading-none">{monthlyActionHint(monthRate, initialData.goals.monthTarget != null)}</p>


                {/* 이전 누적 추이 행 (5월, 4월) */}
                <div className="space-y-2.5 pt-1">
                  <ShortageGridRow
                    monthKey={prevMonthKey}
                    actual={initialData.goals.prevMonthActual}
                    target={initialData.goals.prevMonthTarget}
                    show={showPrevYtd}
                  />
                  <ShortageGridRow
                    monthKey={prevPrevMonthKey}
                    actual={initialData.goals.prevPrevMonthActual}
                    target={initialData.goals.prevPrevMonthTarget}
                    show={showPrevPrevYtd}
                  />
                </div>
              </div>
            </Card>
          </section>

          {/* 밴드 2: 거래액 차트(풀폭) — 최근 6개월 · 연간 월별을 탭으로 전환(오너 2026-07-24). 두 차트 모두
              h-[262px] 고정 + 공통 Y축이라 탭 전환에 높이·틀이 안 흔들린다. 계열은 범례로 이름을 붙이고
              막대 폭(총거래액 넓게 · 매출총이익 좁게)도 달라 색만으로 가르지 않는다(P8). */}
          <section data-band="sales-chart">
            <SegmentedTabCard
              className="h-full"
              tabs={[
                {
                  key: "recent6",
                  label: "최근 6개월",
                  render: () => (
                    <div className="flex flex-1 flex-col">
                      <SalesChartCaption
                        caption="월별 추이 · 목표 대비"
                        showGoal={initialData.trend.some((t) => t.goal != null)}
                      />
                      {/* 오너 피드백 2026-07-10: 하단 안개 제거, 순마진은 나란한 막대, 툴팁은 매출·순마진·마진율만 */}
                      <div className="flex-1 flex items-center justify-center">
                        <ChartContainer config={chartConfig} className="h-[262px] w-full">
                          <ComposedChart data={initialData.trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                            <CartesianGrid vertical={false} strokeDasharray="3 3" />
                            <XAxis dataKey="month" tickFormatter={(value) => `${parseInt(value.slice(5), 10)}월`} tickLine={false} axisLine={false} />
                            {/* 연간 탭과 공통 domain — Y축 틀·목표선 고정(오너 2026-07-24) */}
                            <YAxis domain={[0, chartYMax]} tickFormatter={formatAxisWon} width={58} tickLine={false} axisLine={false} />
                            <ChartTooltip content={<TrendTooltip />} />
                            {/* 마운트 애니메이션 450ms 캡. 점선 목표선은 draw 애니메이션 충돌로 비활성 */}
                            <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[4, 4, 0, 0]} maxBarSize={32} isAnimationActive={!reducedMotion} animationDuration={450} animationEasing="ease-out" />
                            <Bar dataKey="expectedMargin" fill="var(--color-expectedMargin)" stroke="var(--chart-2)" strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={20} isAnimationActive={!reducedMotion} animationDuration={450} animationEasing="ease-out" />
                            <Line dataKey="goal" stroke="var(--color-goal)" strokeDasharray="4 4" dot={false} legendType="none" isAnimationActive={false} />
                          </ComposedChart>
                        </ChartContainer>
                      </div>
                    </div>
                  ),
                },
                {
                  key: "annual",
                  label: "연간 거래액",
                  render: () => (
                    <div className="flex flex-1 flex-col">
                      <SalesChartCaption
                        caption={`${year}년 월별`}
                        showGoal={initialData.yearlyTrend.some((t) => t.goal != null)}
                      />
                      <div className="flex-1 flex items-center justify-center">
                        {/* 6개월 추이와 동일 구성(매출·순마진 막대 + 목표선) + 공통 Y축 domain 으로 틀 고정 */}
                        <ChartContainer config={chartConfig} className="h-[262px] w-full">
                          <ComposedChart data={initialData.yearlyTrend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                            <CartesianGrid vertical={false} strokeDasharray="3 3" />
                            <XAxis dataKey="month" tickFormatter={(value) => `${parseInt(value.slice(5), 10)}월`} tickLine={false} axisLine={false} />
                            <YAxis domain={[0, chartYMax]} tickFormatter={formatAxisWon} width={58} tickLine={false} axisLine={false} />
                            <ChartTooltip content={<TrendTooltip />} />
                            <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={!reducedMotion} animationDuration={450} animationEasing="ease-out" />
                            <Bar dataKey="expectedMargin" fill="var(--color-expectedMargin)" stroke="var(--chart-2)" strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={!reducedMotion} animationDuration={450} animationEasing="ease-out" />
                            <Line dataKey="goal" stroke="var(--color-goal)" strokeDasharray="4 4" dot={false} legendType="none" isAnimationActive={false} />
                          </ComposedChart>
                        </ChartContainer>
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </section>

          {/* 밴드 3: 일정 계열 탭 묶음 — 같은 시간축의 조감(12주 커버리지)·상세(14일). 두 풀폭 밴드를
              한 프레임에 묶어 세로 한 밴드를 절약한다. 일정 커버리지가 없으면 14일만 단독. 패널 min-h 로
              탭 전환 시 높이 튐을 억제한다. 일정 공백·다가올 일정은 그날 운영 판단의 선행 정보라 점검 밴드보다
              위(오너 2026-09-24). */}
          <section data-band="schedule">
            {initialData.scheduleGapBriefing ? (
              <SegmentedTabCard
                tabs={[
                  {
                    key: "coverage",
                    label: "일정 커버리지",
                    count: initialData.scheduleGapBriefing.summary.riskyGapCount,
                    countTone: "urgent",
                    render: () => (
                      <div className="min-h-[300px]">
                        <ScheduleGapBriefingBody data={initialData.scheduleGapBriefing!} />
                      </div>
                    ),
                  },
                  {
                    key: "upcoming",
                    label: "다가올 14일 일정",
                    count: initialData.upcomingEvents.length,
                    countTone: "neutral",
                    render: () => (
                      <div className="min-h-[300px]">
                        <div className="mb-3 flex items-center gap-2 flex-wrap">
                          <CalendarSyncBadge connected={initialData.googleCalendarConnected} />
                          <span className="text-[11px] text-muted-foreground">진행 예정인 정산 및 주요 마일스톤</span>
                        </div>
                        <UpcomingScheduleBody
                          events={initialData.upcomingEvents}
                          thisWeekLabel={thisWeekLabel}
                          nextWeekLabel={nextWeekLabel}
                        />
                      </div>
                    ),
                  },
                ]}
              />
            ) : (
              <UpcomingScheduleCard
                events={initialData.upcomingEvents}
                thisWeekLabel={thisWeekLabel}
                nextWeekLabel={nextWeekLabel}
                googleCalendarConnected={initialData.googleCalendarConnected}
              />
            )}
          </section>

          {/* 밴드 4: 점검(반폭) | 과세기준(반폭). 왼쪽은 예외 알림 탭 묶음(데이터 점검 + 최저가 점검 — 둘 다
              "확인 필요 N건"이라 카운트 배지 탭 한 자리에 알림 2개, 오너 2026-07-24), 오른쪽은 네이버 판매자 등급
              과세기준매출 여유(설계 2026-09-29, 항상 표시 — 등급 갱신이 반년 단위라 매일의 판단보다 아래).
              종전 이 줄의 활성 셀러 카드는 판단을 바꾸지 않는 개수 카드라 뺐고(오너 2026-10-17), 맨 아래
              시스템 레이더는 설정 → 외부 연동 진단 → 「자동화 작업 상태」로 옮겼다. */}
          <section data-band="checks" className="grid gap-4 xl:grid-cols-2 items-stretch min-h-0">
            <div id={DATA_CHECK_ANCHOR} className="h-full min-h-0 scroll-mt-20">
              {/* bodyClassName 고정 높이(h-[210px]) — 두 탭 패널을 동일 높이·내부 스크롤로 만들어,
                  최저가 위반이 데이터 점검 5행 캡보다 많아져도 탭 전환·데이터 증감에 카드 높이가
                  흔들리지 않는다(ss-ux P0 반영). 데이터 점검은 5행+더보기라 내재적으로 유계. */}
              <SegmentedTabCard
                bodyClassName="mt-3 flex flex-col h-[210px]"
                tabs={[
                  {
                    key: "integrity",
                    label: "데이터 점검",
                    count: initialData.dataIntegrityIssues.length,
                    countTone: "caution",
                    render: () => <DataIntegrityBody issues={initialData.dataIntegrityIssues} />,
                  },
                  // 최저가 탭은 모니터링 대상이 있을 때만(로딩·오류 중엔 유지) — 대상 0이면 탭 자체를 접는다.
                  ...(priceOverview.loading || priceOverview.error || (priceOverview.data && priceOverview.data.monitoredCount > 0)
                    ? [{
                        key: "price",
                        label: "최저가 점검",
                        count: priceOverview.data?.counts.violated ?? 0,
                        countTone: "urgent" as const,
                        render: () => (
                          <div className="flex flex-1 flex-col min-h-0">
                            {priceOverview.data && (
                              <div className="mb-2 shrink-0">
                                <PriceDefenseLegend counts={priceOverview.data.counts} />
                              </div>
                            )}
                            <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable] pr-1">
                              <PriceDefenseBody {...priceOverview} />
                            </div>
                          </div>
                        ),
                      }]
                    : []) satisfies SegmentedTab[],
                ]}
              />
            </div>
            <TaxableRevenueCard tracker={initialData.taxableRevenueTracker} />
          </section>
        </div>
      </main>
    </CrmShell>
  );
}
