"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { useReducedMotion } from "motion/react";

import { Card, CardContent } from "@/components/ui/card";
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
import { resolveGoalBand, goalBarWidth, type GoalBand } from "@/lib/goal-band";

/**
 * WAG CRM 대시보드 v5 (확정안 3-Zone 구조)
 *
 * Zone 1: data-band="kpi-strip" (단일 연속 원장 바 — 이번 달 거래액 · 연간 매출 누적 · 예상 매출총이익 · 진행 캠페인)
 * Zone 2: data-band="ops-core" (운영 코어 — 오늘 처리할 일 Style B · 일정 커버리지 Heatmap + 14일 일정)
 * Zone 3: data-band="analytics" (분석 및 점검 — 거래액 추이 ComposedChart · 보조 지표 및 점검 4탭)
 */

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

const GOAL_BAND_TEXT_ON_WHITE: Record<GoalBand, string> = {
  achieved: "text-primary",
  normal: "text-foreground",
  missed: "text-status-urgent-text",
};

export function DashboardHome({ initialData }: { initialData: DesktopDashboardData }) {
  const [agendaData, setAgendaData] = useState<AgendaData>({ tasks: [], settlements: [] });
  const [agendaLoading, setAgendaLoading] = useState(true);
  const [agendaError, setAgendaError] = useState<string | null>(null);

  const [chartTab, setChartTab] = useState<"recent6" | "annual">("recent6");
  const [auxTab, setAuxTab] = useState<"funnel" | "tax" | "integrity" | "price">("funnel");

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

  const monthBandTextClass = monthBand ? GOAL_BAND_TEXT_ON_WHITE[monthBand] : "text-muted-foreground";
  const annualBandTextClass = annualBand ? GOAL_BAND_TEXT_ON_WHITE[annualBand] : "text-muted-foreground";

  const monthFillClass =
    monthBand === "missed"
      ? "bg-[var(--status-urgent)]"
      : monthBand
      ? "bg-primary"
      : "";
  const annualFillClass =
    annualBand === "missed"
      ? "bg-[var(--status-urgent)]"
      : annualBand
      ? "bg-primary"
      : "";

  const currentMonthKey = initialData.selectedMonth;
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
             ZONE 1: Unified Continuous Ledger Bar (data-band="kpi-strip")
             ========================================================================= */}
          <section
            data-band="kpi-strip"
            aria-label="핵심 실적 요약"
            className="rounded-lg border border-border bg-card shadow-soft-sm grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-[1.25fr_1.25fr_1fr_0.9fr] divide-y sm:divide-y-0 xl:divide-x divide-slate-100"
          >
            {/* 1칸: 이번 달 거래액 */}
            <div data-slot="card" className="p-4 flex flex-col justify-between gap-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                  이번 달 거래액
                </h2>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-1">
                  <span className="text-[22px] font-semibold tracking-[-0.025em] tabular-nums text-foreground">
                    <AnimatedNumber value={initialData.goals.monthActual} format="currency" />
                  </span>
                </div>
                <span className={cn("text-xs font-semibold tabular-nums", monthBandTextClass)}>
                  {displayRate(monthRate)}
                </span>
              </div>
              <div className="flex flex-col gap-1.5 mt-auto">
                <div className="relative h-1.5 rounded-full bg-slate-100" title={`오늘 경과 ${monthElapsedPct}%`}>
                  <div
                    className={cn("h-full rounded-full animate-grow-x", monthFillClass)}
                    style={{ width: `${goalBarWidth(monthRate)}%` }}
                  />
                  <div
                    className="absolute top-[-3px] bottom-[-3px] w-[1.5px] bg-slate-900/60 rounded-full cursor-default"
                    style={{ left: `${monthElapsedPct}%` }}
                    title={`오늘 경과 ${monthElapsedPct}%`}
                  />
                </div>
                <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    목표 {initialData.goals.monthTarget == null ? "미설정" : formatCurrency(initialData.goals.monthTarget)}
                    <Link
                      href="/settings/operations?section=goals"
                      className="ml-1 text-muted-foreground hover:text-primary underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      설정
                    </Link>
                  </span>
                  <span className="text-[11px] leading-none">
                    {monthlyActionHint(monthRate, initialData.goals.monthTarget != null)}
                  </span>
                </div>
              </div>
            </div>

            {/* 2칸: 연간 매출 누적 */}
            <div data-slot="card" className="p-4 flex flex-col justify-between gap-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                  연간 매출 누적
                </h2>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-1">
                  <span className="text-[22px] font-semibold tracking-[-0.025em] tabular-nums text-foreground">
                    <AnimatedNumber value={currentYtd} format="currency" />
                  </span>
                </div>
                <span className={cn("text-xs font-semibold tabular-nums", annualBandTextClass)}>
                  {annualRate == null ? (
                    "미설정"
                  ) : (
                    <AnimatedNumber value={annualRate} format="percent" decimalPlaces={1} fallback="미설정" />
                  )}
                </span>
              </div>
              <div className="flex flex-col gap-1.5 mt-auto">
                <div className="relative h-1.5 rounded-full bg-slate-100" title={`연간 목표 대비 ${displayRate(annualRate)}`}>
                  <div
                    className={cn("h-full rounded-full animate-grow-x", annualFillClass)}
                    style={{ width: `${goalBarWidth(annualRate)}%` }}
                  />
                  {initialData.ytdHistory && initialData.goals.annualTarget && initialData.ytdHistory.slice(0, -1).map((h) => {
                    const p = (h.ytd / initialData.goals.annualTarget!) * 100;
                    if (p <= 0 || p >= 100) return null;
                    return (
                      <div 
                        key={h.month} 
                        className="absolute top-0 bottom-0 w-0.5 bg-slate-200 cursor-default" 
                        style={{ left: `${p}%` }} 
                        title={`${monthLabel(h.month)} 누적: ${formatCurrency(h.ytd)}`} 
                      />
                    );
                  })}
                  <div
                    className="absolute top-[-3px] bottom-[-3px] w-[1.5px] bg-slate-900/60 rounded-full cursor-default"
                    style={{ left: `${yearElapsedPct}%` }}
                    title={`연중 경과 ${yearElapsedPct}%`}
                  />
                </div>
                <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    1월~{parseInt(currentMonthKey.slice(5, 7), 10)}월 누적 (목표 {initialData.goals.annualTarget == null ? "미설정" : formatCurrency(initialData.goals.annualTarget)})
                  </span>
                  <span className="tabular-nums font-medium text-foreground">
                    {remainingAnnual !== null ? `잔여 ${formatCurrency(remainingAnnual)}` : ""}
                  </span>
                </div>
              </div>
            </div>

            {/* 3칸: 예상 매출총이익 */}
            <div data-slot="card" className="p-4 flex flex-col justify-between gap-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                  예상 매출총이익
                </h2>
              </div>
              <div data-slot="metric-current-row" className="flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-1">
                  <span className="text-[22px] font-semibold tracking-[-0.025em] tabular-nums text-foreground">
                    <AnimatedNumber value={initialData.profitability.expectedMargin} format="currency" />
                  </span>
                </div>
                <div className="flex min-w-0 flex-1 flex-row-reverse flex-wrap items-baseline justify-start gap-x-1.5">
                  <StockTrendIndicator
                    current={initialData.profitability.expectedMargin}
                    previous={initialData.profitability.prevExpectedMargin}
                    isCurrency={true}
                  />
                </div>
              </div>
              <div className="flex items-end justify-between gap-2 mt-auto">
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
                <div className="w-[120px] shrink-0">
                  <Sparkline
                    points={initialData.trend.map((t) => t.expectedMargin)}
                    months={initialData.trend.map((t) => t.month)}
                    type="line"
                  />
                </div>
              </div>
            </div>

            {/* 4칸: 진행 캠페인 */}
            <div data-slot="card" className="p-4 flex flex-col justify-between gap-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                  진행 캠페인
                </h2>
              </div>
              <div data-slot="metric-current-row" className="flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-1">
                  <span className="text-[22px] font-semibold tracking-[-0.025em] tabular-nums text-foreground">
                    <AnimatedNumber
                      value={initialData.scale.weightedCampaignCount}
                      suffix="건"
                      decimalPlaces={1}
                    />
                  </span>
                </div>
                <div className="flex min-w-0 flex-1 flex-row-reverse flex-wrap items-baseline justify-start gap-x-1.5">
                  <StockTrendIndicator
                    current={initialData.scale.weightedCampaignCount}
                    previous={initialData.scale.prevWeightedCampaignCount}
                    suffix="건"
                  />
                </div>
              </div>
              <div className="flex items-end justify-between gap-2 mt-auto">
                <div className="text-[11px] tabular-nums text-muted-foreground leading-tight">
                  <span>전월 {initialData.scale.prevWeightedCampaignCount.toFixed(1)}건</span>
                  <br />
                  <span className="text-[10px] text-muted-foreground">조합 1건 집계</span>
                </div>
                <div className="w-[120px] shrink-0">
                  <Sparkline
                    points={initialData.trend.map((t) => t.campaignCount)}
                    months={initialData.trend.map((t) => t.month)}
                    type="bars"
                  />
                </div>
              </div>
            </div>
          </section>

          {/* =========================================================================
             ZONE 2: Operational Core (data-band="ops-core")
             ========================================================================= */}
          <section data-band="ops-core" className="grid gap-4 xl:grid-cols-[1.28fr_1fr] items-stretch">
            {/* 좌측: 오늘 처리할 일 */}
            <div className="flex min-w-0 flex-col">
              <TodayWorkCard
                rows={todayRows}
                loading={orderWork.isLoading || agendaLoading || approvals.isLoading || automationWaiting.isLoading}
                failedSources={todayFailedSources}
                onRetry={retryTodayWork}
                orderSync={orderSync}
              />
            </div>

            {/* 우측: 단일 패널 (일정 커버리지 + 다가올 14일 일정 + 캘린더 연동 푸터) */}
            <div className="rounded-lg border border-border bg-card shadow-soft-sm flex flex-col">
              {initialData.scheduleGapBriefing ? (
                <div className="p-4 border-b border-slate-100">
                  <div className="flex items-center justify-between pb-2.5">
                    <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                      일정 커버리지
                    </h2>
                  </div>
                  <ScheduleCoverageHeatmap data={initialData.scheduleGapBriefing} />
                </div>
              ) : null}

              <div className="p-4 flex flex-1 flex-col">
                <div className="flex items-center justify-between pb-2">
                  <h3 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                    다가올 14일 일정
                  </h3>
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
          </section>

          {/* =========================================================================
             ZONE 3: Trend & Aux Checks (data-band="analytics")
             ========================================================================= */}
          <section data-band="analytics" className="grid gap-4 xl:grid-cols-[1.55fr_1fr] items-stretch">
            {/* 좌측: 거래액 추이 (최근 6개월 / 연간 월별) */}
            <div data-band="sales-chart" className="rounded-lg border border-border bg-card shadow-soft-sm flex flex-col">
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
                  <div className="flex-1 flex items-center justify-center">
                    <ChartContainer config={chartConfig} className="h-[262px] w-full">
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
                  <div className="flex-1 flex items-center justify-center">
                    <ChartContainer config={chartConfig} className="h-[262px] w-full">
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

            {/* 우측: 보조 지표 및 점검 (data-band="checks", id={DATA_CHECK_ANCHOR}) */}
            <div
              data-band="checks"
              id={DATA_CHECK_ANCHOR}
              className="rounded-lg border border-border bg-card shadow-soft-sm flex flex-col scroll-mt-20"
            >
              <div className="px-4 pt-3.5 pb-0">
                <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                  보조 지표 및 점검
                </h2>
              </div>
              <div className="flex items-center gap-4 px-4 border-b border-slate-100 mt-1" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={auxTab === "funnel"}
                  onClick={() => setAuxTab("funnel")}
                  className={cn(
                    "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    auxTab === "funnel"
                      ? "text-foreground font-semibold after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  영업 전환
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={auxTab === "tax"}
                  onClick={() => setAuxTab("tax")}
                  className={cn(
                    "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    auxTab === "tax"
                      ? "text-foreground font-semibold after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  과세기준
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={auxTab === "integrity"}
                  onClick={() => setAuxTab("integrity")}
                  className={cn(
                    "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    auxTab === "integrity"
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
                {priceOverview.loading || priceOverview.error || (priceOverview.data && priceOverview.data.monitoredCount > 0) ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={auxTab === "price"}
                    onClick={() => setAuxTab("price")}
                    className={cn(
                      "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                      auxTab === "price"
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

              {auxTab === "funnel" ? (
                <div className="p-4 flex flex-1 flex-col justify-center">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-2 mb-3 border-b border-slate-100">
                    <span className="text-xs font-semibold text-foreground">최근 90일 영업 전환</span>
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
              ) : null}

              {auxTab === "tax" ? (
                <div className="p-4 flex-1 flex flex-col justify-center">
                  <TaxableRevenueCard
                    tracker={initialData.taxableRevenueTracker}
                    className="border-0 shadow-none bg-transparent"
                  />
                </div>
              ) : null}

              {auxTab === "integrity" ? (
                <div className="p-4 flex-1 overflow-y-auto">
                  <DataIntegrityBody issues={initialData.dataIntegrityIssues} />
                </div>
              ) : null}

              {auxTab === "price" ? (
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
        </div>
      </main>
    </CrmShell>
  );
}
