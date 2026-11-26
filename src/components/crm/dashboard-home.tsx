"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { useReducedMotion } from "motion/react";

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { cn } from "@/lib/utils";
import { CrmShell } from "./crm-shell";
import { ScheduleCoverageHeatmap } from "./schedule-gap-briefing-card";
import { UpcomingScheduleBody, CalendarSyncBadge } from "./upcoming-schedule-card";
import { DataIntegrityBody } from "./data-integrity-card";
import { usePriceOverview, PriceDefenseBody, PriceDefenseLegend } from "./price-defense-card";
import { TaxableRevenueCard } from "./taxable-revenue-card";
import { TodayWorkCard } from "./today-work-card";
import { resolveOrderSyncState } from "@/lib/order-converter/order-work-buckets";
import { buildTodayWorkRows, DATA_CHECK_ANCHOR } from "@/lib/today-work";
import { useOrderWorkSummary } from "@/hooks/useOrderWorkSummary";
import { useApprovalInbox } from "@/hooks/useApprovalInbox";
import { useWaitingAutomationIncidents } from "@/hooks/useAutomationIncidents";
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

/**
 * WAG CRM 대시보드 — 4줄 구조(2026-11-26 「대시보드 느낌」 되살림)
 *
 * 1줄 data-band="kpi-strip": 진한 청록 목표 판(이번 달 거래액 · 연간 매출 누적 · 지난 두 달) + 흰 지표 2칸
 *   (예상 매출총이익 · 월 환산 캠페인 수). 목표 판만 shadow-soft-lg — 화면의 단일 초점.
 * 2줄 data-band="ops-core": 거래액 추이 차트(왼쪽) · 일정 커버리지 → 오늘 처리할 일(오른쪽)
 * 3줄 data-band="schedule-checks": 다가올 14일 일정 · 점검(데이터 점검 / 최저가 2탭)
 * 4줄 data-band="aux-metrics": 과세기준매출 · 최근 90일 영업 전환(탭 없이 항상 노출)
 *
 * 표면은 전부 `ui/Card` 가 아니라 평범한 요소다 — Card 는 shadow-soft-md + hover 그림자를 주입하고 `cn` 은
 * 그 그림자를 지우지 못해(shadow-none 이 먹지 않았다) 흰 패널이 목표 판과 같은 높이로 떴다. 흰 패널 = PANEL.
 */

/** 흰 패널 표면 — sm 그림자 + 헤어라인(P8 Elevation Ladder: 화면에 여러 개 = sm). */
const PANEL = "rounded-2xl border border-border bg-card shadow-soft-sm overflow-hidden text-sm text-card-foreground";
/** 2~4줄 공통 좌우 비율 — 줄마다 세로 이음매가 같은 x 에 선다. */
const SEAM = "lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]";

const chartConfig = {
  revenue: { label: "총거래액", color: "var(--chart-1)" },
  expectedMargin: { label: "매출총이익", color: "var(--fill-teal-1)" },
  goal: { label: "거래액 목표", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

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
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-soft-md text-xs min-w-[150px]">
      <p className="text-[11px] font-semibold text-primary mb-1">
        {label ? `${parseInt(String(label).slice(5), 10)}월` : ""}
      </p>
      {revenue != null && (
        <div className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-[2px]" style={{ backgroundColor: "var(--chart-1)" }} />
            총거래액
          </span>
          <span className="font-semibold text-foreground tabular-nums">{formatCurrency(revenue)}</span>
        </div>
      )}
      {margin != null && (
        <div className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="size-2 rounded-[2px] border"
              style={{ backgroundColor: "var(--fill-teal-1)", borderColor: "var(--chart-2)" }}
            />
            매출총이익
          </span>
          <span className="font-semibold text-foreground tabular-nums">{formatCurrency(margin)}</span>
        </div>
      )}
      {marginRate != null && (
        <div className="flex items-center justify-between gap-4 py-0.5 mt-0.5 border-t border-slate-100 pt-1">
          <span className="text-muted-foreground">매출총이익률</span>
          <span className="font-semibold text-foreground tabular-nums">{marginRate.toFixed(1)}%</span>
        </div>
      )}
    </div>
  );
}

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
          <span
            aria-hidden="true"
            className="h-2.5 w-2 rounded-[2px] border"
            style={{ backgroundColor: "var(--fill-teal-1)", borderColor: "var(--chart-2)" }}
          />
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

export function formatAxisWon(value: number): string {
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
  if (!targetSet) return "월 목표 미등록";
  if (achievementRate == null) return "";
  if (achievementRate >= 100) return "선행 영업 준비 착수";
  if (achievementRate >= 80) return "파이프라인 점검";
  if (achievementRate >= 50) return "현재 페이스 유지";
  return "영업 파이프라인 가속 필요";
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
  const colorClass = isUp ? "text-[var(--status-success)]" : "text-[var(--status-caution)]";
  const sign = isUp ? "▲" : "▼";
  const absChange = Math.abs(change);
  const diffText = isCurrency ? formatCurrency(absChange) : (Number.isInteger(absChange) ? String(absChange) : absChange.toFixed(1));
  const absPercent = Math.abs(percent).toFixed(1);
  const percentText = `(${isUp ? "+" : "-"}${absPercent}%)`;

  return (
    <span
      className={cn("min-w-0 max-w-full truncate whitespace-nowrap text-[10px] font-semibold", colorClass)}
      title={`${sign} ${diffText}${suffix} ${percentText}`}
    >
      {sign} {diffText}{suffix} <span className="opacity-70">{percentText}</span>
    </span>
  );
}

const SPARK_FOCUS_MONTHS = 3;

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
  const focusFrom = Math.max(0, points.length - SPARK_FOCUS_MONTHS);
  const zeroLine = hasNegative ? (
    <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke="var(--chart-5)" strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />
  ) : null;

  const axis = (
    <div className="mt-0.5 flex" data-slot="spark-axis" aria-hidden="true">
      {months.map((m, i) => {
        const isFocus = i >= focusFrom;
        return (
          <span
            key={m}
            className={cn(
              "flex-1 text-center text-[8px] leading-none tabular-nums",
              isFocus ? "font-bold text-[var(--primary)]" : "text-muted-foreground"
            )}
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
  const contextPts = points.slice(0, focusFrom + 1).map((p, i) => coord(p, i)).join(" ");
  const focusPts = points.slice(focusFrom).map((p, i) => coord(p, focusFrom + i)).join(" ");
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

interface AgendaItem {
  id: string;
}

interface AgendaData {
  tasks: AgendaItem[];
  settlements: AgendaItem[];
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
    <div className="inline-grid grid-cols-[24px_72px_10px_65px_auto] items-baseline gap-x-1.5">
      <span className="text-[11px] text-white/60 shrink-0">{monthLabel(monthKey)}</span>
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

export function DashboardHome({ initialData }: { initialData: DesktopDashboardData }) {
  const [agendaData, setAgendaData] = useState<AgendaData>({ tasks: [], settlements: [] });
  const [agendaLoading, setAgendaLoading] = useState(true);
  const [agendaError, setAgendaError] = useState<string | null>(null);

  const [chartTab, setChartTab] = useState<"recent6" | "annual">("recent6");
  // 영업 전환·과세기준은 탭에서 나와 맨 아래 줄에 항상 보인다 — 점검 카드의 탭은 데이터 점검 / 최저가 둘뿐.
  const [auxTab, setAuxTab] = useState<"integrity" | "price">("integrity");

  const priceOverview = usePriceOverview();
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

  useEffect(() => {
    if (typeof window === "undefined") return;

    const checkHash = () => {
      if (window.location.hash === `#${DATA_CHECK_ANCHOR}`) {
        setAuxTab("integrity");
      }
    };

    checkHash();
    window.addEventListener("hashchange", checkHash);

    const handleDocClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement | null)?.closest('a[href$="#data-check"]');
      if (target) {
        setAuxTab("integrity");
      }
    };
    document.addEventListener("click", handleDocClick);

    return () => {
      window.removeEventListener("hashchange", checkHash);
      document.removeEventListener("click", handleDocClick);
    };
  }, []);

  const orderWork = useOrderWorkSummary();
  const approvals = useApprovalInbox("PENDING_APPROVAL");
  const automationWaiting = useWaitingAutomationIncidents();

  const todayRows = buildTodayWorkRows({
    orders: orderWork.data,
    agenda: {
      tasks: agendaData.tasks.length,
      settlements: agendaData.settlements.length,
      overdueSettlementIds: agendaData.settlements.map((item) => item.id),
    },
    approvalsPending: approvals.count,
    automationWaiting: automationWaiting.data,
    dataCheck: initialData.dataIntegrityIssues.length,
  });

  const todayFailedSources = [
    orderWork.isError ? "주문" : null,
    agendaError ? "영업·정산" : null,
    approvals.isError ? "승인대기" : null,
    automationWaiting.isError ? "자동화 작업 조치대기" : null,
  ].filter((name): name is string => name != null);

  const retryTodayWork = () => {
    if (orderWork.isError) void orderWork.refetch();
    if (agendaError) void fetchAgenda();
    if (approvals.isError) void approvals.refetch();
    if (automationWaiting.isError) void automationWaiting.refetch();
  };

  const orderSync = orderWork.data ? resolveOrderSyncState(orderWork.data, orderWork.dataUpdatedAt) : null;

  const monthRate = rate(initialData.goals.monthActual, initialData.goals.monthTarget);
  const annualRate = rate(initialData.goals.ytdActual, initialData.goals.annualTarget);

  const monthBand = resolveGoalBand(monthRate);
  const annualBand = resolveGoalBand(annualRate);

  // 목표 판은 진한 청록 표면이다 — 흰 카드용 색(--status-urgent·primary)은 거기서 대비가 안 나온다(P8 §5).
  const monthBandTextClass = monthBand ? GOAL_BAND_TEXT_ON_NAVY[monthBand] : GOAL_BAND_TEXT_UNSET_ON_NAVY;
  const annualBandTextClass = annualBand ? GOAL_BAND_TEXT_ON_NAVY[annualBand] : GOAL_BAND_TEXT_UNSET_ON_NAVY;
  // 미설정이면 fill 클래스를 아예 주지 않는다(모바일 히어로와 같은 처리). "미설정인데 normal
  // 색을 칠하고 너비 0으로 가린다"로 두면, 이 클래스가 폭과 분리된 곳에 재사용될 때 되살아난다.
  const monthFillClass = monthBand ? GOAL_BAND_FILL_ON_NAVY[monthBand] : "";
  const annualFillClass = annualBand ? GOAL_BAND_FILL_ON_NAVY[annualBand] : "";

  const currentMonthKey = initialData.selectedMonth;
  const year = currentMonthKey.slice(0, 4);

  // 목표 판 아래 줄: 지난 두 달. 연간 누적 맥락이라 같은 해의 달만 보인다(1월이면 줄이 없다).
  const prevDate = new Date(`${currentMonthKey}-01T00:00:00Z`);
  prevDate.setUTCMonth(prevDate.getUTCMonth() - 1);
  const prevMonthKey = prevDate.toISOString().slice(0, 7);

  const prevPrevDate = new Date(`${currentMonthKey}-01T00:00:00Z`);
  prevPrevDate.setUTCMonth(prevPrevDate.getUTCMonth() - 2);
  const prevPrevMonthKey = prevPrevDate.toISOString().slice(0, 7);

  const showPrevYtd = prevMonthKey.startsWith(year);
  const showPrevPrevYtd = prevPrevMonthKey.startsWith(year);

  const priceTabAvailable =
    priceOverview.loading || priceOverview.error || (priceOverview.data != null && priceOverview.data.monitoredCount > 0);
  // 최저가 탭을 골랐는데 그 탭이 사라졌으면(감시 상품 0) 데이터 점검을 보인다 — 빈 탭 본문을 남기지 않는다.
  const shownAuxTab = auxTab === "price" && !priceTabAvailable ? "integrity" : auxTab;
  const currentYtd = initialData.goals.ytdActual;

  const chartYValues = [
    ...initialData.trend.flatMap((t) => [t.revenue, t.expectedMargin, t.goal ?? 0]),
    ...initialData.yearlyTrend.flatMap((t) => [t.revenue, t.expectedMargin, t.goal ?? 0]),
  ];
  const chartYRaw = Math.max(1, ...chartYValues);
  const chartYStep = chartYRaw > 200_000_000 ? 50_000_000 : chartYRaw > 50_000_000 ? 20_000_000 : 10_000_000;
  const chartYMax = Math.ceil(chartYRaw / chartYStep) * chartYStep;

  // 당월 경과일 비율 (KST: UTC + 9h 기준 통일)
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const kstYear = kst.getUTCFullYear();
  const kstMonth = kst.getUTCMonth();
  const kstDate = kst.getUTCDate();

  const daysInMonth = new Date(Date.UTC(kstYear, kstMonth + 1, 0)).getUTCDate();
  const monthElapsedPct = Math.min(100, Math.max(0, Math.round((kstDate / daysInMonth) * 100)));

  // 연중 경과 비율 (KST)
  const startOfYear = Date.UTC(kstYear, 0, 1);
  const currentKstMidnight = Date.UTC(kstYear, kstMonth, kstDate);
  const dayOfYear = Math.floor((currentKstMidnight - startOfYear) / 86400000) + 1;
  const isLeap = new Date(Date.UTC(kstYear, 1, 29)).getUTCMonth() === 1;
  const daysInYear = isLeap ? 366 : 365;
  const yearElapsedPct = Math.min(100, Math.max(0, Math.round((dayOfYear / daysInYear) * 100)));

  const remainingAnnual =
    initialData.goals.annualTarget != null ? Math.max(0, initialData.goals.annualTarget - currentYtd) : null;

  // 이번 주 / 다음 주 라벨
  const currentDayOfWeek = now.getDay();
  const distanceToMonday = currentDayOfWeek === 0 ? 6 : currentDayOfWeek - 1;
  const thisWeekMonday = new Date(now);
  thisWeekMonday.setDate(now.getDate() - distanceToMonday);
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

  // 스파크라인 적자 달 체크
  const focusPoints = initialData.trend.slice(-SPARK_FOCUS_MONTHS).map((t) => t.expectedMargin);
  const focusMonths = initialData.trend.slice(-SPARK_FOCUS_MONTHS).map((t) => t.month);
  const lossMonths = focusMonths.filter((_, i) => focusPoints[i] < 0);

  return (
    <CrmShell>
      <main className="min-h-full bg-slate-50 px-5 pb-8 pt-5 md:px-8">
        <div className="space-y-6">
          {/* 최상단 캡션: DASHBOARD_PAGE_SCOPE_CAPTION (<p> 정확히 1회) */}
          <p className="mb-3 text-[11px] text-muted-foreground">{DASHBOARD_PAGE_SCOPE_CAPTION}</p>

          {/* =========================================================================
             ROW 1: 목표 판(진한 청록) + 흰 지표 2칸 (data-band="kpi-strip")
             숫자 4개 한 줄 훑기를 유지하되, 왼쪽 두 칸(거래액·연간 누적)만 진한 청록 한 덩어리로
             묶어 화면의 단일 초점(shadow-soft-lg, 페이지당 1개)으로 띄운다. xl 미만에서는 판과
             지표가 위아래로 쌓인다(1024~1279 도 정식 배치).
             ========================================================================= */}
          <section
            data-band="kpi-strip"
            aria-label="핵심 실적 요약"
            className="grid gap-4 items-stretch xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
          >
            <div
              data-slot="goal-hero"
              className="flex flex-col rounded-2xl bg-hero-deep text-white shadow-soft-lg overflow-hidden"
            >
              <div className="grid flex-1 grid-cols-1 sm:grid-cols-2">
                {/* 이번 달 거래액 */}
                <div data-slot="card" data-goal="month" className="flex flex-col gap-2.5 px-5 pt-4 pb-3.5">
                  <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-white/90">이번 달 거래액</h2>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="text-[28px] font-bold leading-none tracking-[-0.025em] tabular-nums">
                      <AnimatedNumber value={initialData.goals.monthActual} format="currency" />
                    </span>
                    <span
                      data-slot="goal-rate"
                      className={cn("text-2xl font-bold leading-none tabular-nums", monthBandTextClass)}
                    >
                      {monthRate == null ? (
                        "미설정"
                      ) : (
                        <AnimatedNumber value={monthRate} format="percent" decimalPlaces={1} fallback="미설정" />
                      )}
                    </span>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-white/10" title={`오늘 경과 ${monthElapsedPct}%`}>
                    <div
                      data-slot="goal-fill"
                      className={cn("h-full rounded-full animate-grow-x", monthFillClass)}
                      style={{ width: `${goalBarWidth(monthRate)}%` }}
                    />
                    <div
                      className="absolute top-[-3px] bottom-[-3px] w-[1.5px] bg-white rounded-full cursor-default"
                      style={{ left: `${monthElapsedPct}%` }}
                      title={`오늘 경과 ${monthElapsedPct}%`}
                    />
                  </div>
                  <div className="flex items-baseline justify-between gap-2 text-[11px] text-white/60">
                    <span className="tabular-nums">
                      목표 {initialData.goals.monthTarget == null ? "미설정" : formatCurrency(initialData.goals.monthTarget)}
                      <Link
                        href="/settings/operations?section=goals"
                        className="ml-1 underline text-white/70 hover:text-white rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                      >
                        설정
                      </Link>
                    </span>
                    <span className="leading-none text-white/80">
                      {monthlyActionHint(monthRate, initialData.goals.monthTarget != null)}
                    </span>
                  </div>
                </div>

                {/* 연간 매출 누적 */}
                <div
                  data-slot="card"
                  data-goal="annual"
                  className="flex flex-col gap-2.5 px-5 pt-4 pb-3.5 border-t border-white/10 sm:border-t-0 sm:border-l"
                >
                  <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-white/90">연간 매출 누적</h2>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="text-[28px] font-bold leading-none tracking-[-0.025em] tabular-nums">
                      <AnimatedNumber value={currentYtd} format="currency" />
                    </span>
                    <span
                      data-slot="goal-rate"
                      className={cn("text-2xl font-bold leading-none tabular-nums", annualBandTextClass)}
                    >
                      {annualRate == null ? (
                        "미설정"
                      ) : (
                        <AnimatedNumber value={annualRate} format="percent" decimalPlaces={1} fallback="미설정" />
                      )}
                    </span>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-white/10" title={`연간 목표 대비 ${displayRate(annualRate)}`}>
                    <div
                      data-slot="goal-fill"
                      className={cn("h-full rounded-full animate-grow-x", annualFillClass)}
                      style={{ width: `${goalBarWidth(annualRate)}%` }}
                    />
                    {initialData.ytdHistory && initialData.goals.annualTarget && initialData.ytdHistory.slice(0, -1).map((h) => {
                      const p = (h.ytd / initialData.goals.annualTarget!) * 100;
                      if (p <= 0 || p >= 100) return null;
                      return (
                        <div
                          key={h.month}
                          className="absolute top-0 bottom-0 w-0.5 bg-white/50 cursor-default"
                          style={{ left: `${p}%` }}
                          title={`${monthLabel(h.month)} 누적: ${formatCurrency(h.ytd)}`}
                        />
                      );
                    })}
                    <div
                      className="absolute top-[-3px] bottom-[-3px] w-[1.5px] bg-white rounded-full cursor-default"
                      style={{ left: `${yearElapsedPct}%` }}
                      title={`연중 경과 ${yearElapsedPct}%`}
                    />
                  </div>
                  <div className="flex items-baseline justify-between gap-2 text-[11px] text-white/60">
                    <span className="tabular-nums">
                      1월~{parseInt(currentMonthKey.slice(5, 7), 10)}월 누적 (목표 {initialData.goals.annualTarget == null ? "미설정" : formatCurrency(initialData.goals.annualTarget)})
                    </span>
                    <span className="font-medium text-white/90 tabular-nums">
                      {remainingAnnual !== null ? `잔여 ${formatCurrency(remainingAnnual)}` : ""}
                    </span>
                  </div>
                </div>
              </div>

              {/* 지난 두 달 실적 · 목표 대비 부족/초과 · 달성률 — 같은 해일 때만(연간 누적 맥락) */}
              {showPrevYtd || showPrevPrevYtd ? (
                <div
                  data-slot="goal-history"
                  className="flex flex-wrap items-baseline gap-x-8 gap-y-1 border-t border-white/10 px-5 py-2.5"
                >
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
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* 예상 매출총이익 */}
              <div data-slot="card" className={`${PANEL} p-4 flex flex-col gap-2`}>
                <div className="flex items-center justify-between">
                  <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                    예상 매출총이익
                  </h2>
                </div>
                <div data-slot="metric-current-row" className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-1">
                    <span className="text-[22px] font-semibold tracking-[-0.025em] tabular-nums text-foreground">
                      <AnimatedNumber value={initialData.profitability.expectedMargin} format="currency" />
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-auto flex-row-reverse flex-wrap items-baseline justify-start gap-x-1.5">
                    <StockTrendIndicator
                      current={initialData.profitability.expectedMargin}
                      previous={initialData.profitability.prevExpectedMargin}
                      isCurrency={true}
                    />
                  </div>
                </div>
                <div className="mt-auto flex items-end justify-between gap-2 xl:flex-col xl:items-stretch xl:gap-1.5">
                  <div className="text-[11px] tabular-nums text-muted-foreground leading-tight">
                    {lossMonths.length > 0 ? (
                      <span className="font-semibold text-status-urgent-text">
                        {lossMonths.map(monthLabel).join("·")} 적자
                      </span>
                    ) : (
                      <>
                        <span>진행 중 판단용 추정치</span>
                        <br />
                        <span>전월 {formatCurrency(initialData.profitability.prevExpectedMargin)}</span>
                      </>
                    )}
                  </div>
                  <div className="w-[120px] shrink-0 xl:order-first xl:w-full">
                    <Sparkline
                      points={initialData.trend.map((t) => t.expectedMargin)}
                      months={initialData.trend.map((t) => t.month)}
                      type="line"
                    />
                  </div>
                </div>
              </div>

              {/* 월 환산 캠페인 수 */}
              <div data-slot="card" className={`${PANEL} p-4 flex flex-col gap-2`}>
                <div className="flex items-center justify-between">
                  <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                    월 환산 캠페인 수
                  </h2>
                </div>
                <div data-slot="metric-current-row" className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-1">
                    <span className="text-[22px] font-semibold tracking-[-0.025em] tabular-nums text-foreground">
                      <AnimatedNumber
                        value={initialData.scale.weightedCampaignCount}
                        format="raw"
                        suffix="건"
                        decimalPlaces={1}
                      />
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-auto flex-row-reverse flex-wrap items-baseline justify-start gap-x-1.5">
                    <StockTrendIndicator
                      current={initialData.scale.weightedCampaignCount}
                      previous={initialData.scale.prevWeightedCampaignCount}
                      suffix="건"
                    />
                  </div>
                </div>
                <div className="mt-auto flex items-end justify-between gap-2 xl:flex-col xl:items-stretch xl:gap-1.5">
                  <div className="text-[11px] tabular-nums text-muted-foreground leading-tight">
                    <span>전월 {initialData.scale.prevWeightedCampaignCount.toFixed(1)}건</span>
                    <br />
                    <span className="text-[10px] text-muted-foreground">조합 1건 집계</span>
                  </div>
                  <div className="w-[120px] shrink-0 xl:order-first xl:w-full">
                    <Sparkline
                      points={initialData.trend.map((t) => t.campaignCount)}
                      months={initialData.trend.map((t) => t.month)}
                      type="bars"
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* =========================================================================
             ROW 2: 거래액 추이(왼쪽 넓게) + 일정 커버리지·오늘 처리할 일(오른쪽) (data-band="ops-core")
             items-stretch 라 차트가 오른쪽 열 높이를 흡수한다 — 오늘 처리할 일이 길어지면 차트가
             같이 길어져 빈 바닥이 생기지 않는다. 오늘 처리할 일 카드 자체는 늘리지 않는다.
             ========================================================================= */}
          <section data-band="ops-core" className={`grid gap-4 items-stretch ${SEAM}`}>
            {/* 좌측: 거래액 추이 (최근 6개월 / 연간 월별) */}
            <div data-band="sales-chart" className={`${PANEL} flex min-w-0 flex-col`}>
              <div className="px-4 pt-3.5 pb-0">
                <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                  거래액 추이
                </h2>
              </div>
              <div className="flex items-center gap-4 px-4 border-b border-slate-100 mt-1" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={chartTab === "recent6"}
                  onClick={() => setChartTab("recent6")}
                  className={cn(
                    "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    chartTab === "recent6"
                      ? "text-foreground font-semibold after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  최근 6개월
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={chartTab === "annual"}
                  onClick={() => setChartTab("annual")}
                  className={cn(
                    "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    chartTab === "annual"
                      ? "text-foreground font-semibold after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  연간 월별
                </button>
              </div>

              {chartTab === "recent6" ? (
                <div className="p-4 flex flex-1 flex-col">
                  <SalesChartCaption
                    caption="월별 추이 · 목표 대비"
                    showGoal={initialData.trend.some((t) => t.goal != null)}
                  />
                  <div className="relative flex-1 min-h-[262px]">
                    <ChartContainer config={chartConfig} className="absolute inset-0 aspect-auto h-full w-full">
                      <ComposedChart data={initialData.trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="month" tickFormatter={(value) => `${parseInt(value.slice(5), 10)}월`} tickLine={false} axisLine={false} />
                        <YAxis domain={[0, chartYMax]} tickFormatter={formatAxisWon} width={58} tickLine={false} axisLine={false} />
                        <ChartTooltip content={<TrendTooltip />} />
                        <Bar
                          dataKey="revenue"
                          fill="var(--color-revenue)"
                          radius={[4, 4, 0, 0]}
                          maxBarSize={32}
                          isAnimationActive={!reducedMotion}
                          animationDuration={450}
                          animationEasing="ease-out"
                        />
                        <Bar dataKey="expectedMargin"
                          fill="var(--color-expectedMargin)"
                          stroke="var(--chart-2)" strokeWidth={1}
                          radius={[4, 4, 0, 0]}
                          maxBarSize={20}
                          isAnimationActive={!reducedMotion}
                          animationDuration={450}
                          animationEasing="ease-out"
                        />
                        <Line dataKey="goal" stroke="var(--color-goal)" strokeDasharray="4 4" dot={false} legendType="none" isAnimationActive={false} />
                      </ComposedChart>
                    </ChartContainer>
                  </div>
                </div>
              ) : (
                <div className="p-4 flex flex-1 flex-col">
                  <SalesChartCaption
                    caption="연간 월별"
                    showGoal={initialData.yearlyTrend.some((t) => t.goal != null)}
                  />
                  <div className="relative flex-1 min-h-[262px]">
                    <ChartContainer config={chartConfig} className="absolute inset-0 aspect-auto h-full w-full">
                      <ComposedChart data={initialData.yearlyTrend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="month" tickFormatter={(value) => `${parseInt(value.slice(5), 10)}월`} tickLine={false} axisLine={false} />
                        <YAxis domain={[0, chartYMax]} tickFormatter={formatAxisWon} width={58} tickLine={false} axisLine={false} />
                        <ChartTooltip content={<TrendTooltip />} />
                        <Bar
                          dataKey="revenue"
                          fill="var(--color-revenue)"
                          radius={[4, 4, 0, 0]}
                          maxBarSize={28}
                          isAnimationActive={!reducedMotion}
                          animationDuration={450}
                          animationEasing="ease-out"
                        />
                        <Bar dataKey="expectedMargin"
                          fill="var(--color-expectedMargin)"
                          stroke="var(--chart-2)" strokeWidth={1}
                          radius={[4, 4, 0, 0]}
                          maxBarSize={18}
                          isAnimationActive={!reducedMotion}
                          animationDuration={450}
                          animationEasing="ease-out"
                        />
                        <Line dataKey="goal" stroke="var(--color-goal)" strokeDasharray="4 4" dot={false} legendType="none" isAnimationActive={false} />
                      </ComposedChart>
                    </ChartContainer>
                  </div>
                </div>
              )}
            </div>

            {/* 우측: 일정 커버리지(높이 고정 — 오늘 처리할 일이 불러와져도 움직이지 않게 먼저) → 오늘 처리할 일 */}
            <div className="flex min-w-0 flex-col gap-4">
              {initialData.scheduleGapBriefing ? (
                <div data-slot="card" className={`${PANEL} p-4`}>
                  <div className="flex items-center justify-between pb-2.5">
                    <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                      일정 커버리지
                    </h2>
                  </div>
                  <ScheduleCoverageHeatmap data={initialData.scheduleGapBriefing} />
                </div>
              ) : null}
              <TodayWorkCard
                rows={todayRows}
                loading={orderWork.isLoading || agendaLoading || approvals.isLoading || automationWaiting.isLoading}
                failedSources={todayFailedSources}
                onRetry={retryTodayWork}
                orderSync={orderSync}
              />
            </div>
          </section>

          {/* =========================================================================
             ROW 3: 다가올 14일 일정 + 점검(데이터 점검 / 최저가) (data-band="schedule-checks")
             ========================================================================= */}
          <section data-band="schedule-checks" className={`grid gap-4 items-stretch ${SEAM}`}>
            <div data-band="schedule" className={`${PANEL} flex min-w-0 flex-col`}>
              <div className="p-4 flex flex-1 flex-col">
                <div className="flex items-center justify-between pb-2">
                  <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                    다가올 14일 일정
                  </h2>
                </div>
                <UpcomingScheduleBody
                  events={initialData.upcomingEvents}
                  thisWeekLabel={thisWeekLabel}
                  nextWeekLabel={nextWeekLabel}
                />
              </div>

              <div className="mt-auto flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-xs text-muted-foreground">
                <CalendarSyncBadge connected={initialData.googleCalendarConnected} />
                <Link
                  href="/calendar"
                  className="text-xs text-primary hover:underline font-medium rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  전체 일정 보기
                </Link>
              </div>
            </div>

            {/* 우측: 점검 (data-band="checks", id={DATA_CHECK_ANCHOR}) — 「오늘 처리할 일」 데이터 점검 행의 목적지 */}
            <div
              data-band="checks"
              id={DATA_CHECK_ANCHOR}
              className={`${PANEL} flex min-w-0 flex-col scroll-mt-20`}
            >
              <div className="px-4 pt-3.5 pb-0">
                <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                  점검
                </h2>
              </div>
              <div className="flex items-center gap-4 px-4 border-b border-slate-100 mt-1" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={shownAuxTab === "integrity"}
                  onClick={() => setAuxTab("integrity")}
                  className={cn(
                    "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    shownAuxTab === "integrity"
                      ? "text-foreground font-semibold after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  데이터 점검{" "}
                  {initialData.dataIntegrityIssues.length > 0 ? (
                    <span className="tabular-nums font-semibold text-status-caution-text">
                      {initialData.dataIntegrityIssues.length}
                    </span>
                  ) : null}
                </button>
                {priceTabAvailable ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={shownAuxTab === "price"}
                    onClick={() => setAuxTab("price")}
                    className={cn(
                      "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                      shownAuxTab === "price"
                        ? "text-foreground font-semibold after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    최저가{" "}
                    {(priceOverview.data?.counts.violated ?? 0) > 0 ? (
                      <span className="tabular-nums font-semibold text-status-urgent-text">
                        {priceOverview.data?.counts.violated}
                      </span>
                    ) : null}
                  </button>
                ) : null}
              </div>

              {shownAuxTab === "integrity" ? (
                <div className="p-4 flex-1 overflow-y-auto">
                  <DataIntegrityBody issues={initialData.dataIntegrityIssues} />
                </div>
              ) : null}

              {shownAuxTab === "price" ? (
                <div className="p-4 flex-1 flex flex-col min-h-0">
                  {priceOverview.data && (
                    <div className="mb-2 shrink-0">
                      <PriceDefenseLegend counts={priceOverview.data.counts} />
                    </div>
                  )}
                  <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable] pr-1">
                    <PriceDefenseBody {...priceOverview} />
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          {/* =========================================================================
             ROW 4: 과세기준매출 + 최근 90일 영업 전환 — 탭 뒤에 숨기지 않고 항상 보인다 (data-band="aux-metrics")
             ========================================================================= */}
          <section data-band="aux-metrics" className={`grid gap-4 items-stretch ${SEAM}`}>
            <TaxableRevenueCard tracker={initialData.taxableRevenueTracker} />

            <div data-slot="card" className={`${PANEL} p-4 flex flex-col`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-2 mb-3 border-b border-slate-100">
                <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">최근 90일 영업 전환</h2>
                <p
                  className="min-w-[8rem] flex-1 break-keep text-[11px] text-muted-foreground"
                  title={`확정 ${initialData.outreach90d.confirmed}건 · 확정률 ${ratioText(initialData.outreach90d.confirmed, initialData.outreach90d.total)}`}
                >
                  확정 {initialData.outreach90d.confirmed}건 · 확정률 {ratioText(initialData.outreach90d.confirmed, initialData.outreach90d.total)}
                </p>
              </div>
              <div className="flex flex-1 flex-col justify-center gap-3">
                {[
                  { label: "접촉", count: initialData.outreach90d.total, base: initialData.outreach90d.total, strong: false, showRate: false },
                  { label: "응답", count: initialData.outreach90d.responded, base: initialData.outreach90d.total, strong: false, showRate: true },
                  { label: "전환", count: initialData.outreach90d.converted, base: initialData.outreach90d.total, strong: true, showRate: true },
                ].map((row, i) => (
                  <div key={row.label} className="flex items-center gap-2.5">
                    <span className="w-[28px] shrink-0 text-xs font-medium text-muted-foreground">{row.label}</span>
                    <div className="flex-1 h-2.5 rounded-full bg-slate-300 overflow-hidden">
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
                    <span className="w-[36px] shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                      {row.showRate ? ratioText(row.count, row.base) : ""}
                    </span>
                    <span className="w-[32px] shrink-0 text-right text-xs font-semibold text-foreground tabular-nums">
                      {row.count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </main>
    </CrmShell>
  );
}
