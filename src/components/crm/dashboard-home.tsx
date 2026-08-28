"use client";

import Link from "next/link";
import {
  CalendarDays,
  Settings2,
  Target,
  TrendingUp,
  UsersRound,
  ChevronRight,
  Loader2,
  Sparkles,
  Globe,
} from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import { CrmShell } from "./crm-shell";
import { ScheduleGapBriefingBody } from "./schedule-gap-briefing-card";
import { UpcomingScheduleBody, UpcomingScheduleCard, CalendarSyncBadge } from "./upcoming-schedule-card";
import { DataIntegrityBody } from "./data-integrity-card";
import { usePriceOverview, PriceDefenseBody, PriceDefenseLegend } from "./price-defense-card";
import { SegmentedTabCard, SegmentedTabBar, type SegmentedTab } from "./segmented-tab-card";
import { SystemRadarCard } from "./system-radar-card";
import type { DesktopDashboardData } from "@/lib/desktop-dashboard";
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  resolveGoalBand,
  goalBarWidth,
  GOAL_BAND_TEXT_ON_NAVY,
  GOAL_BAND_FILL_ON_NAVY,
  GOAL_BAND_TEXT_UNSET_ON_NAVY,
} from "@/lib/goal-band";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { QuickSettlementModal } from "./quick-settlement-modal";
import { useState, useEffect, useId } from "react";
import { formatDistanceToNow } from "date-fns";
import { ko } from "date-fns/locale";
import { toast } from "sonner";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { badgeSizeClassName } from "@/components/ui/badge";


// WAG CRM 팔레트 스펙(오너 승인, 2026-07-09) — 차트라인/기준선 하드코딩 색 → 토큰 수렴
const chartConfig = {
  revenue: { label: "실제 매출", color: "var(--chart-1)" },
  expectedMargin: { label: "예상 순마진", color: "var(--chart-4)" },
  goal: { label: "월 목표", color: "var(--muted-foreground)" },
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
            매출
          </span>
          <span className="font-semibold text-[#1F2A30] tabular-nums">{formatCurrency(revenue)}</span>
        </div>
      )}
      {margin != null && (
        <div className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-[2px]" style={{ backgroundColor: "var(--chart-4)" }} />
            순마진
          </span>
          <span className="font-semibold text-[#1F2A30] tabular-nums">{formatCurrency(margin)}</span>
        </div>
      )}
      {marginRate != null && (
        <div className="flex items-center justify-between gap-4 py-0.5 mt-0.5 border-t border-slate-100 pt-1">
          <span className="text-muted-foreground">마진율</span>
          <span className="font-semibold text-[#1F2A30] tabular-nums">{marginRate.toFixed(1)}%</span>
        </div>
      )}
    </div>
  );
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

// 핵심 업무 행의 기한 표기 — 좁은 반쪽 칸에서 toLocaleDateString()(7/21/2026)은 이름 폭을
// 잡아먹는다. 연도는 이 카드 맥락(지연·임박)에서 항상 올해 부근이라 "7.21"로 족하다.
function shortDate(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}.${d.getDate()}`;
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
    return <span className="text-muted-foreground/60 text-[10px]">변동 없음</span>;
  }

  const isUp = change > 0;
  // WAG CRM 팔레트 스펙(오너 승인, 2026-07-09) — 상태색 토큰 수렴(에메랄드→--status-success, 벽돌오렌지→--status-caution)
  const colorClass = isUp ? "text-[var(--status-success)]" : "text-[var(--status-caution)]";

  const sign = isUp ? "▲" : "▼";
  const absChange = Math.abs(change);
  const diffText = isCurrency ? formatCurrency(absChange) : (Number.isInteger(absChange) ? String(absChange) : absChange.toFixed(1));
  const absPercent = Math.abs(percent).toFixed(1);

  return (
    <span className={`inline-flex items-center text-[10px] gap-0.5 font-semibold ${colorClass}`}>
      <span>{sign}</span>
      <span>{diffText}{suffix}</span>
      <span className="opacity-70">({isUp ? "+" : "-"}{absPercent}%)</span>
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
// 1. 색은 2단계뿐 — 중립 회색(--chart-5, 맥락) + 네이비(--chart-1, 강조는 불투명도로만 2단).
//    --chart-2는 쓰지 않는다: 같은 화면의 6개월 대형 차트에서 그 파랑은 이미 "매출 vs 순마진"의
//    계열 구분 의미를 갖고 있어, 여기서 "시간적 근접"에 재사용하면 한 스와치가 두 의미를 갖는다.
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
              isFocus ? "font-bold text-[var(--primary)]" : "text-muted-foreground/60"
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
    <Card className="border-black/5 bg-white/85 shadow-soft-sm p-0">
      {/* 데이터 점검 카드 밀도 기준(오너 2026-07-10): 행 기반·타이트, 라벨 좌/값 우, 얇은 구분선. Card 기본 p-6 제거해 이중 패딩(48px) 해소 */}
      <CardContent className="px-4 py-3">
        {/* 서브텍스트는 제목 우측에 이어서(오너 2026-07-24 — 카드 폭이 넓어 별도 줄이 불필요).
            좁은 폭에서는 truncate로 잘리되 title 속성으로 전문 확인 가능.
            적자 달 경고는 note 줄을 '추가'하지 않고 같은 슬롯에서 '교체'한다(오너 결정 2026-07-15, D안):
            추가하면 카드 높이가 적자 유무에 따라 생겼다 사라져 KPI 스트립 3장이 데이터에 따라 점프한다.
            note는 매달 동일한 상용구라 적자인 달에 가려도 잃는 정보가 없다. */}
        <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
          <Icon className={`size-4 shrink-0 ${iconTones[tone]}`} />
          <p className="text-[13px] font-semibold text-[var(--primary)] tracking-tight shrink-0">{label}</p>
          {lossMonths.length > 0 ? (
            <p className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--status-caution-text)]">
              {lossMonths.map(monthLabel).join("·")} 적자
            </p>
          ) : (
            <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70" title={note}>
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
          <div className="flex items-baseline justify-between gap-2 py-1">
            <span className="text-[11px] font-semibold text-muted-foreground shrink-0">{monthLabel(currentMonthKey)}</span>
            <div className="flex items-baseline justify-end gap-1.5 min-w-0">
              {numericValue !== undefined && prevNumericValue !== undefined && (
                <StockTrendIndicator current={numericValue} previous={prevNumericValue} isCurrency={isCurrency} suffix={suffix} />
              )}
              <span className="text-[13px] font-semibold tracking-tight text-[#1F2A30] tabular-nums">
                {numericValue !== undefined ? (
                  <AnimatedNumber value={numericValue} format={isCurrency ? "currency" : "raw"} decimalPlaces={decimalPlaces} suffix={suffix} />
                ) : (
                  value
                )}
              </span>
            </div>
          </div>
          {/* 전월 행: 동일 크기·medium·뮤트 */}
          {prevValue && (
            <div className="flex items-baseline justify-between gap-2 py-1 border-t border-gray-100">
              <span className="text-[11px] text-muted-foreground/70 shrink-0">{monthLabel(prevMonthKey)}</span>
              <span className="text-[13px] font-medium text-muted-foreground tabular-nums">{prevValue}</span>
            </div>
          )}
          {/* 전전월 행: 동일 크기·normal·가장 옅은 뮤트. 증감 화살표는 당월 행에만 두어 과밀 방지 */}
          {prevPrevValue && prevPrevMonthKey && (
            <div className="flex items-baseline justify-between gap-2 py-1 border-t border-gray-100">
              <span className="text-[11px] text-muted-foreground/70 shrink-0">{monthLabel(prevPrevMonthKey)}</span>
              <span className="text-[13px] font-normal text-muted-foreground tabular-nums">{prevPrevValue}</span>
            </div>
          )}
        </div>

        {spark && spark.points.length > 1 && (
          <div className="mt-1">
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

interface AgendaItem {
  id: string;
  type: "TASK" | "SETTLEMENT";
  status: string;
  title: string;
  dueDate: string | null;
  label: string;
  badgeColor: {
    bg: string;
    text: string;
    border: string;
  };
  sellerName?: string;
  dealName?: string;
  accountNumber?: string | null;
  settlementSales?: number;
  actualPayoutAmount?: number;
  /** 지연된 칸(입금/지급 × 상대) — 서버(`agenda-settlements.ts`)가 슬롯에서 파생한다. */
  overdueSlot?: {
    kind: "DEPOSIT" | "PAYOUT";
    verb: "입금" | "지급";
    counterpartLabel: string;
    flagField: "isDepositReceived" | "isPayoutCompleted" | "isSupplierPayoutCompleted";
  };
  /** 모달이 대조할 금액. null = 금액 컬럼이 없는 칸(자사몰 공급사 지급) — 0 이 아니다. */
  targetAmount?: number | null;
  snsType?: string;
}

interface AgendaData {
  tasks: AgendaItem[];
  settlements: AgendaItem[];
}

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17z" />
      <polygon points="10 15 15 12 10 9" />
    </svg>
  );
}

const renderSnsIcon = (snsType?: string) => {
  if (!snsType) return null;
  const type = snsType.toUpperCase();
  if (type === "INSTAGRAM") {
    return <InstagramIcon className="size-3.5 text-pink-500/70 shrink-0" />;
  }
  if (type === "YOUTUBE") {
    return <YoutubeIcon className="size-3.5 text-red-500/70 shrink-0" />;
  }
  return <Globe className="size-3.5 text-slate-400/80 shrink-0" />;
};

// 핵심 업무 탭에 인라인으로 보여줄 상위 건수 — 나머지는 "더보기" 팝오버로(데이터 점검과 동일 패턴).
const AGENDA_PREVIEW_COUNT = 3;

// "더보기" 팝오버 — 데이터 점검 카드와 동일한 경량 Popover(포털·충돌회피·available-height 캡).
function AgendaMore({
  open,
  onOpenChange,
  moreCount,
  title,
  sub,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  moreCount: number;
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 shrink-0 text-center">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="crm-hit-area-wide inline-block rounded text-[11px] font-medium text-muted-foreground/50 transition-colors hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none"
          >
            + {moreCount}건 더보기
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="center"
          sideOffset={6}
          collisionPadding={12}
          className="flex w-[340px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-overlay max-h-[min(460px,var(--radix-popover-content-available-height))]"
        >
          <div className="shrink-0 border-b border-slate-100 bg-slate-50/70 px-3.5 py-2.5">
            <p className="text-[12px] font-bold text-slate-700">{title}</p>
            <p className="text-[10px] text-slate-500">{sub}</p>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto [scrollbar-gutter:stable] px-3 py-2">
            {children}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function DashboardHome({ initialData }: { initialData: DesktopDashboardData }) {
  const [agendaData, setAgendaData] = useState<AgendaData>({ tasks: [], settlements: [] });
  // 초기값 true: fetch 시작 전 첫 페인트에 빈 상태("모두 완료")가 잠깐 노출되는 플래시 방지
  // — 빈 상태 pop-in이 마운트/데이터 도착 시 이중 발화하는 원인이기도 했다.
  const [agendaLoading, setAgendaLoading] = useState(true);
  const [agendaError, setAgendaError] = useState<string | null>(null);
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [selectedSettlement, setSelectedSettlement] = useState<AgendaItem | null>(null);
  const [isSettlementModalOpen, setIsSettlementModalOpen] = useState(false);
  // 휴면 셀러 재계약 검토 팝업 — 페이지 이동 없이 대시보드에서 대상 확인(오너 2026-07-24)
  const [isDormantListOpen, setIsDormantListOpen] = useState(false);

  // 최저가 점검 데이터를 대시보드 레벨에서 fetch(오너 2026-07-24, 1순위 탭 묶음) — 위반 수를
  // 탭 배지(숨은 탭 알림)로 반응형 반영하려면 데이터가 탭 레벨에서 필요하다.
  const priceOverview = usePriceOverview();

  // 핵심 업무 탭(오너 2026-07-24 — 데이터 점검처럼 탭 방식으로 통일). 반쪽 2열은 각 행에
  // ≈200px만 남겨 딜명·셀러명이 말줄임으로 죽었다. 두 목록은 비교가 아니라 하나씩 처리하는
  // 큐라서, 밑줄 탭으로 전환하면 각 목록이 카드 전폭을 받는다.
  const [agendaTab, setAgendaTab] = useState<"tasks" | "settlements">("tasks");
  const agendaTabId = useId();

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

  // 팔로업이 비어 있고 지연 정산만 있으면 정산 탭을 첫 화면으로 — 빈 목록이 첫 인상이
  // 되는 것을 방지(재조회로 팔로업이 소진된 경우에도 동일하게 정산 쪽으로 넘어간다).
  const agendaTaskCount = agendaData.tasks.length;
  const agendaSettlementCount = agendaData.settlements.length;
  useEffect(() => {
    if (!agendaLoading && agendaTaskCount === 0 && agendaSettlementCount > 0) {
      setAgendaTab("settlements");
    }
  }, [agendaLoading, agendaTaskCount, agendaSettlementCount]);

  const handleCompleteReminder = async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    setCompletingTaskId(taskId);
    try {
      const now = new Date();
      const nextDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3일 추가
      const res = await fetch(`/api/outreach/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "PROPOSED",
          lastReminderAt: now.toISOString(),
          nextReminderAt: nextDate.toISOString(),
        }),
      });

      if (!res.ok) throw new Error("리마인드 처리 기록에 실패했습니다.");
      
      toast.success("리마인드 완료 처리되었습니다.");
      await fetchAgenda();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "오류가 발생했습니다.");
    } finally {
      setCompletingTaskId(null);
    }
  };

  const handleOpenSettlementModal = (e: React.MouseEvent, item: AgendaItem) => {
    e.stopPropagation();
    setSelectedSettlement(item);
    setIsSettlementModalOpen(true);
  };

  // 핵심 업무 탭 오버플로도 데이터 점검과 동일하게: 상위 N건만 카드에 두고 나머지는 "더보기" 팝오버로
  // 본다(오너 2026-07-24 — 스크롤 대신). N건 캡이라 카드 높이는 데이터와 무관하게 안정적이다.
  const [tasksMoreOpen, setTasksMoreOpen] = useState(false);
  const [settlementsMoreOpen, setSettlementsMoreOpen] = useState(false);

  // 행 렌더 헬퍼 — 카드 인라인(상위 N)과 더보기 팝오버(전체)가 같은 마크업을 공유한다.
  const renderTaskRow = (item: AgendaItem) => (
    <div
      key={item.id}
      className="group rounded-xl border border-slate-100 bg-slate-50/40 p-2.5 transition-[border-color,background-color,box-shadow] duration-200 hover:border-status-info/20 hover:bg-white hover:shadow-soft-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <Link
          href={`/outreach?taskId=${item.id}`}
          className="crm-hit-area min-w-0 flex-1 truncate text-xs font-semibold text-slate-700 leading-snug hover:text-status-info transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          title={item.dealName || item.title}
        >
          {item.dealName || item.title}
        </Link>
        <button
          onClick={(e) => handleCompleteReminder(e, item.id)}
          disabled={completingTaskId === item.id}
          className="crm-hit-area shrink-0 inline-flex items-center gap-0.5 rounded-md border border-status-info/20 bg-status-info/10 hover:border-status-info/40 px-1.5 py-0.5 text-[10px] font-semibold text-status-info transition-colors active:translate-y-px disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {completingTaskId === item.id ? <Loader2 className="size-3 animate-spin" /> : "연락 완료"}
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        {renderSnsIcon(item.snsType)}
        <span className="min-w-0 flex-1 truncate text-[11px] text-slate-600" title={item.sellerName || ""}>
          {item.sellerName || ""}
        </span>
        <span className={`shrink-0 inline-flex items-center ${badgeSizeClassName.compact} ${item.badgeColor.bg} ${item.badgeColor.text} ${item.badgeColor.border}`}>
          {item.label}
        </span>
        {item.dueDate && <span className="shrink-0 text-[9px] tabular-nums text-slate-500">{shortDate(item.dueDate)}</span>}
      </div>
    </div>
  );

  // 정산 행은 행 전체가 정산 확인 모달 트리거. 팝오버 안에서 누르면 팝오버를 닫고 모달을 연다(중첩 방지).
  const renderSettlementRow = (item: AgendaItem, afterClick?: () => void) => (
    <button
      key={item.id}
      type="button"
      onClick={(e) => { handleOpenSettlementModal(e, item); afterClick?.(); }}
      className="group w-full text-left rounded-xl border border-slate-100 bg-slate-50/40 p-2.5 transition-[border-color,background-color,box-shadow] duration-200 hover:border-status-urgent/20 hover:bg-white hover:shadow-soft-sm flex items-center gap-2 focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none"
      title={`${item.dealName || item.title} · ${item.sellerName || ""} 정산 확인`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-700 leading-snug group-hover:text-status-urgent-text transition-colors">
            {item.dealName || item.title}
          </span>
          {item.dueDate && <span className="shrink-0 text-[9px] tabular-nums text-slate-500">{shortDate(item.dueDate)}</span>}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          {renderSnsIcon(item.snsType)}
          <span className="min-w-0 flex-1 truncate text-[11px] text-slate-600">{item.sellerName || ""}</span>
          <span className={`shrink-0 inline-flex items-center ${badgeSizeClassName.compact} ${item.badgeColor.bg} ${item.badgeColor.text} ${item.badgeColor.border}`}>
            {item.label}
          </span>
        </div>
      </div>
      <ChevronRight className="size-3.5 shrink-0 text-slate-400 group-hover:text-status-urgent-text transition-colors" aria-hidden="true" />
    </button>
  );

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
      <main className="min-h-full bg-[radial-gradient(circle_at_top_right,_rgba(10,61,98,0.07),_transparent_30%),linear-gradient(180deg,_#F8FAFC_0%,_#F1F5F9_100%)] px-5 pb-5 pt-5 md:px-8">
        <div className="space-y-6">
          {/* items-start: 좌측 히어로가 우측 컬럼 높이에 강제로 늘어나며 카드 내부에
              빈 공백이 생기는 것을 방지 — 두 컬럼 높이 차이는 카드 밖 배경으로 흡수한다 */}
          {/* 밴드 0: 실시간 KPI 스트립 (1x3 풀폭) — 소형 지표라 상단 밴드로 분리, 각 지표가 폭 여유 확보 (오너 결정 A안, 2026-07-10) */}
          <section className="grid gap-4 sm:grid-cols-3">
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
              label="예상 순마진"
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
                <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
                  <UsersRound className="size-4 shrink-0 text-[var(--primary)]" />
                  <p className="shrink-0 text-[13px] font-semibold text-[var(--primary)] tracking-tight">최근 90일 영업 전환</p>
                  <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
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
                      <span className="w-[26px] shrink-0 text-[11px] font-medium text-muted-foreground/70">{row.label}</span>
                      <div className="flex-1 h-2.5 rounded-full bg-slate-100 overflow-hidden">
                        {/* 접촉→응답→전환 순 60ms stagger — 퍼널 순서 자체가 의미라 흐름감을 준다 */}
                        <div
                          className="h-full rounded-full animate-grow-x"
                          style={{
                            width: row.base > 0 ? `${Math.max((row.count / row.base) * 100, 2)}%` : "2%",
                            backgroundColor: row.strong ? "var(--chart-1)" : "var(--chart-2)",
                            opacity: row.strong ? 1 : 0.45,
                            animationDelay: `${i * 60}ms`,
                          }}
                        />
                      </div>
                      <span className="w-[30px] shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/60">
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

          {/* 밴드 1: 6개월 차트(좌 2fr, 폭 확보) | 매출 목표 히어로(우 1fr). items-stretch로 높이 균형,
              분할선 65%가 밴드 2(오늘의 핵심 업무)와 세로 정렬 (오너 결정 A안, 2026-07-10) */}
          <section className="grid gap-4 xl:grid-cols-[2fr_1fr] items-stretch">
            {/* 매출 차트 — 6개월 추이 · 연간 월별을 탭으로 전환(오너 2026-07-24). 좌측 앵커, 카드 높이에
                맞춰 차트가 채워진다. 두 차트 모두 h-[262px] 고정이라 탭 전환에도 높이가 안 흔들린다. */}
            <SegmentedTabCard
              className="h-full"
              tabs={[
                {
                  key: "recent6",
                  label: "최근 6개월",
                  render: () => (
                    <div className="flex flex-1 flex-col">
                      <p className="mb-2 text-[11px] text-muted-foreground/70">매출·예상 순마진 추이 및 목표 대비 달성</p>
                      {/* 오너 피드백 2026-07-10: 하단 안개 제거, 순마진은 나란한 막대, 툴팁은 매출·순마진·마진율만 */}
                      <div className="flex-1 flex items-center justify-center">
                        <ChartContainer config={chartConfig} className="h-[262px] w-full">
                          <ComposedChart data={initialData.trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                            <CartesianGrid vertical={false} strokeDasharray="3 3" />
                            <XAxis dataKey="month" tickFormatter={(value) => `${parseInt(value.slice(5), 10)}월`} tickLine={false} axisLine={false} />
                            {/* 연간 탭과 공통 domain — Y축 틀·목표선 고정(오너 2026-07-24) */}
                            <YAxis domain={[0, chartYMax]} tickFormatter={(value) => `${Math.round(value / 10000)}만`} width={58} tickLine={false} axisLine={false} />
                            <ChartTooltip content={<TrendTooltip />} />
                            {/* 마운트 애니메이션 450ms 캡. 점선 목표선은 draw 애니메이션 충돌로 비활성 */}
                            <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[4, 4, 0, 0]} maxBarSize={32} animationDuration={450} animationEasing="ease-out" />
                            <Bar dataKey="expectedMargin" fill="var(--color-expectedMargin)" radius={[4, 4, 0, 0]} maxBarSize={20} animationDuration={450} animationEasing="ease-out" />
                            <Line dataKey="goal" stroke="var(--color-goal)" strokeDasharray="4 4" dot={false} legendType="none" isAnimationActive={false} />
                          </ComposedChart>
                        </ChartContainer>
                      </div>
                    </div>
                  ),
                },
                {
                  key: "annual",
                  label: "연간 매출",
                  render: () => (
                    <div className="flex flex-1 flex-col">
                      <p className="mb-2 text-[11px] text-muted-foreground/70">{year}년 월별 매출 · 예상 순마진{initialData.yearlyTrend.some((t) => t.goal != null) ? " · 점선 = 월 목표" : ""}</p>
                      <div className="flex-1 flex items-center justify-center">
                        {/* 6개월 추이와 동일 구성(매출·순마진 막대 + 목표선) + 공통 Y축 domain 으로 틀 고정 */}
                        <ChartContainer config={chartConfig} className="h-[262px] w-full">
                          <ComposedChart data={initialData.yearlyTrend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                            <CartesianGrid vertical={false} strokeDasharray="3 3" />
                            <XAxis dataKey="month" tickFormatter={(value) => `${parseInt(value.slice(5), 10)}월`} tickLine={false} axisLine={false} />
                            <YAxis domain={[0, chartYMax]} tickFormatter={(value) => `${Math.round(value / 10000)}만`} width={58} tickLine={false} axisLine={false} />
                            <ChartTooltip content={<TrendTooltip />} />
                            <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[4, 4, 0, 0]} maxBarSize={28} animationDuration={450} animationEasing="ease-out" />
                            <Bar dataKey="expectedMargin" fill="var(--color-expectedMargin)" radius={[4, 4, 0, 0]} maxBarSize={18} animationDuration={450} animationEasing="ease-out" />
                            <Line dataKey="goal" stroke="var(--color-goal)" strokeDasharray="4 4" dot={false} legendType="none" isAnimationActive={false} />
                          </ComposedChart>
                        </ChartContainer>
                      </div>
                    </div>
                  ),
                },
              ]}
            />

            {/* 매출 목표 히어로 — 우측 (A안 수직 스택). WAG 팔레트: --hero-navy 토큰, 공유 elevation(shadow-soft-lg) */}
            <Card className="overflow-hidden border-0 bg-[var(--hero-navy)] text-white shadow-soft-lg px-6 py-3 flex flex-col h-full min-h-[312px]">
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
                        <p className="text-[10px] text-white/50">
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
                  <h2 className="text-lg font-bold">이번 달 매출</h2>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Link href="/settings/operations?section=goals" className="rounded-full bg-white/10 p-1 text-white/80 hover:bg-white/20">
                          <Settings2 className="size-3" />
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
                      <p className="text-[10px] text-white/50">목표 {initialData.goals.monthTarget == null ? "미설정" : formatCurrency(initialData.goals.monthTarget)}</p>
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

          {/* 밴드 2: 할 일(반응)·기회(셀러 모멘텀)·점검(데이터) 3렌즈 triad — 3등분, 67% seam이 밴드1과 정렬 (오너 결정 2026-07-10) */}
          {/* 트라이어드 배치(오너 2026-07-24): 스탯 카드(활성 셀러)를 좌측에, 탭 카드 2종(핵심 업무·
              데이터 점검)을 우측에 모아 같은 형태끼리 인접시킨다. xl 데스크톱에서만 order 로 재배치
              (모바일 스택은 DOM 순서 유지). */}
          <section className="grid gap-4 xl:grid-cols-3 items-stretch min-h-0">
            <Card className="border-black/5 bg-white/85 shadow-soft-sm h-full flex flex-col min-h-0 xl:order-2">
              <CardContent className="px-4 py-3 flex flex-col flex-1">
                {/* 움브렐라 제목 "오늘의 핵심 업무" 제거(오너 2026-07-24) — 데이터 점검처럼 세부항목
                    탭[영업 팔로업|지연된 정산]이 곧 카드 헤더다. 카운트는 각 탭 배지가 담당. */}
                <div className="flex flex-col flex-1 min-h-0">
                  {agendaLoading && agendaData.tasks.length === 0 && agendaData.settlements.length === 0 ? (
                    /* 캐러셀 전환으로 로딩도 단일 전폭 페인 — 2열 스켈레톤은 옛 레이아웃 잔상을 만든다 */
                    <div className="space-y-2 flex-1 min-h-0">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="rounded-xl border border-slate-100 bg-slate-50/40 p-2.5 animate-pulse">
                          <Skeleton className="h-3.5 w-2/3 bg-slate-200" />
                          <div className="mt-1.5 flex gap-2">
                            <Skeleton className="h-3 w-24 bg-slate-200" />
                            <Skeleton className="h-3 w-12 bg-slate-200" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : agendaError ? (
                    <div className="rounded-xl border border-red-100 bg-red-50/50 p-4 text-center my-auto">
                      <p className="text-xs text-red-600">{agendaError}</p>
                      <button
                        className="mt-2.5 h-7 text-[10px] inline-flex items-center justify-center px-3 border border-red-200 rounded-md bg-white hover:bg-red-50 text-red-700 transition-colors"
                        onClick={fetchAgenda}
                      >
                        다시 시도
                      </button>
                    </div>
                  ) : (agendaData.tasks.length + agendaData.settlements.length) === 0 ? (
                    <div className="flex flex-col items-center justify-center text-center gap-3 flex-1">
                      {/* 완료 보상 pop-in 1회 — agendaLoading 초기값 true라 마운트 시 이중 발화 없음 */}
                      <div className="pop-in-once flex size-9 items-center justify-center rounded-full bg-slate-50 border border-slate-100 text-slate-400">
                        <Sparkles className="size-4 text-blue-500/80" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-slate-700">오늘 할 일이 모두 완료되었습니다!</p>
                        <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
                          자동 팔로업 제안 리드나 기한이 경과된 정산 내역이 없습니다.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col flex-1 min-h-0">
                      {/* 데이터 점검처럼 밑줄 탭으로 전환(오너 2026-07-24) — 비활성 탭도 카운트 배지로
                          알림 전달(팔로업=info 리마인드, 정산=urgent 지연). 각 목록이 카드 전폭을 받아
                          딜명·셀러명이 온전히 읽힌다(반쪽 2열 잘림 해소). */}
                      <SegmentedTabBar
                        idPrefix={agendaTabId}
                        active={agendaTab}
                        onSelect={(k) => setAgendaTab(k as "tasks" | "settlements")}
                        tabs={[
                          { key: "tasks", label: "영업 팔로업", count: agendaData.tasks.length, countTone: "info" },
                          { key: "settlements", label: "지연된 정산", count: agendaData.settlements.length, countTone: "urgent" },
                        ]}
                      />
                      {/* 패널 고정 높이(데이터 점검 1순위와 동일 h-[210px]) — 정산 카드가 많아도 내부
                          스크롤로 흡수해 카드·행 높이가 커지지 않는다(오너 2026-07-24 지적 반영) */}
                      <div
                        role="tabpanel"
                        id={`${agendaTabId}-panel-${agendaTab}`}
                        aria-labelledby={`${agendaTabId}-tab-${agendaTab}`}
                        className="mt-2 flex flex-col h-[210px]"
                      >
                        {/* 스크롤 대신 상위 N건 + "더보기" 팝오버(데이터 점검과 동일, 오너 2026-07-24).
                            N건 캡이라 카드 높이가 데이터 양과 무관하게 안정적이다. */}
                        {agendaTab === "tasks" ? (
                          agendaData.tasks.length === 0 ? (
                            <div className="flex-1 flex items-center justify-center text-center text-xs text-slate-500 border border-dashed border-slate-150 rounded-xl bg-slate-50/30">
                              팔로업할 영업 리드가 없습니다.
                            </div>
                          ) : (
                            <>
                              {/* stagger-cascade: fetch 후 도착하는 리스트만 순차 등장(ss-motion use-case 정합) */}
                              <div className="stagger-fade-in space-y-2">
                                {agendaData.tasks.slice(0, AGENDA_PREVIEW_COUNT).map(renderTaskRow)}
                              </div>
                              {agendaData.tasks.length > AGENDA_PREVIEW_COUNT && (
                                <AgendaMore
                                  open={tasksMoreOpen}
                                  onOpenChange={setTasksMoreOpen}
                                  moreCount={agendaData.tasks.length - AGENDA_PREVIEW_COUNT}
                                  title={`영업 팔로업 ${agendaData.tasks.length}건`}
                                  sub="자동 팔로업 제안 리드"
                                >
                                  {agendaData.tasks.map(renderTaskRow)}
                                </AgendaMore>
                              )}
                            </>
                          )
                        ) : agendaData.settlements.length === 0 ? (
                          <div className="flex-1 flex items-center justify-center text-center text-xs text-slate-500 border border-dashed border-slate-150 rounded-xl bg-slate-50/30">
                            지연된 정산 내역이 없습니다.
                          </div>
                        ) : (
                          <>
                            <div className="stagger-fade-in space-y-2">
                              {agendaData.settlements.slice(0, AGENDA_PREVIEW_COUNT).map((item) => renderSettlementRow(item))}
                            </div>
                            {agendaData.settlements.length > AGENDA_PREVIEW_COUNT && (
                              <AgendaMore
                                open={settlementsMoreOpen}
                                onOpenChange={setSettlementsMoreOpen}
                                moreCount={agendaData.settlements.length - AGENDA_PREVIEW_COUNT}
                                title={`지연된 정산 ${agendaData.settlements.length}건`}
                                sub="기한이 경과된 정산 · 행을 누르면 정산 확인"
                              >
                                {agendaData.settlements.map((item) => renderSettlementRow(item, () => setSettlementsMoreOpen(false)))}
                              </AgendaMore>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* 활성 셀러 현황(구 "셀러 베이스 모멘텀" — 알기 쉬운 한글 표기, 오너 2026-07-24)
                — 관계 기반 매출 근원의 성장/이탈 선행지표 (오너 결정 2026-07-10). 좌측 배치(order-1) */}
            <Card className="border-black/5 bg-white/85 shadow-soft-sm h-full flex flex-col xl:order-1">
              <CardContent className="px-4 py-3 flex flex-col flex-1">
                <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
                  <UsersRound className="size-4.5 text-[var(--primary)]" />
                  <h3 className="shrink-0 text-sm font-bold text-[var(--primary)] tracking-tight">활성 셀러 현황</h3>
                  {/* 서브텍스트는 제목 우측에 이어서(오너 2026-07-24) */}
                  <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">최근 90일 활성 · 직전 90일 대비 순증감</p>
                </div>

                {/* 대표값은 18px(카드 headline 계층) — 24px는 매출 히어로 전용이라 여기 쓰면
                    일반 카드가 히어로와 같은 크기로 충돌한다(오너 2026-07-24: 전역 숫자 위계 정리) */}
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-lg font-bold tracking-tight text-[#1F2A30]">{initialData.sellerMomentum.active}</span>
                  <span className="text-xs text-muted-foreground">명 활성</span>
                  {initialData.sellerMomentum.netChange !== 0 && (
                    <span className={`inline-flex items-center text-[11px] gap-0.5 font-semibold ${initialData.sellerMomentum.netChange > 0 ? "text-[var(--status-success)]" : "text-[var(--status-caution-text)]"}`}>
                      <span>{initialData.sellerMomentum.netChange > 0 ? "▲" : "▼"}</span>
                      <span>{Math.abs(initialData.sellerMomentum.netChange)}명</span>
                    </span>
                  )}
                </div>

                {/* 월별 활성(해당 월 캠페인 보유) 셀러 미니 막대 — 값 라벨 포함.
                    캡션 필수(오너 2026-07-10): 위 큰 숫자는 90일 창, 막대는 월 창이라 기준이 달라
                    캡션 없이는 수치 불일치(예: 활성 9 vs 월별 최대 5)로 오독됨.
                    막대는 HTML flex로 그린다(오너 2026-07-24) — 이전 SVG는 preserveAspectRatio="none"으로
                    카드 폭만큼 가로 확대돼 안에 넣은 <text> 값 라벨의 글자가 늘어나 보였다(스파크라인과 같은 함정). */}
                <div className="mt-2">
                  <p className="text-[9px] font-medium text-muted-foreground/70 mb-0.5">월별 활성 셀러 (해당 월 캠페인 보유)</p>
                  {(() => {
                    const pts = initialData.trend.map((t) => t.activeSellers);
                    const max = Math.max(...pts, 1);
                    return (
                      <div className="flex items-end gap-1.5 h-[44px]">
                        {pts.map((p, i) => {
                          const barH = Math.max(4, (p / max) * 30);
                          const last = i === pts.length - 1;
                          return (
                            <div key={i} className="flex flex-1 flex-col items-center justify-end">
                              <span className={`mb-0.5 text-[9px] leading-none tabular-nums ${last ? "font-bold text-[var(--chart-1)]" : "font-medium text-muted-foreground/70"}`}>
                                {Math.round(p)}
                              </span>
                              <div
                                className="w-full rounded-[2px] animate-grow-y"
                                style={{ height: `${barH}px`, backgroundColor: last ? "var(--chart-1)" : "var(--chart-2)", opacity: last ? 1 : 0.35, animationDelay: `${i * 25}ms` }}
                              />
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                  <div className="mt-1 flex gap-1.5">
                    {initialData.trend.map((t) => (
                      <span key={t.month} className="flex-1 text-center text-[9px] text-muted-foreground/60">{parseInt(t.month.slice(5), 10)}월</span>
                    ))}
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 pt-2 border-t border-black/5">
                  <div className="flex justify-between items-baseline border-r border-black/5 pr-1.5">
                    <span className="text-[10px] text-muted-foreground/70">신규 (이번 달)</span>
                    <span className="text-xs font-bold text-[var(--status-success)]">+{initialData.sellerMomentum.newThisMonth}</span>
                  </div>
                  <div className="flex justify-between items-baseline pl-1.5">
                    <span className="text-[10px] text-muted-foreground/70">휴면</span>
                    <span className="text-xs font-bold text-[var(--status-caution-text)]">{initialData.sellerMomentum.dormant}명</span>
                  </div>
                </div>

                {initialData.sellerMomentum.dormant > 0 && (
                  /* 페이지 이동 대신 팝업으로 대상 확인(오너 2026-07-24) — 셀러 상세는 팝업 안 행에서 진입.
                     모달 Dialog가 아니라 다른 팝업(레이더 잡 상세 등)과 같은 경량 Popover로 표시
                     (오너 2026-07-24 2차: "팝업만 강조할 필요 없이 간단히 정보 보여주는 수준") */
                  <Popover open={isDormantListOpen} onOpenChange={setIsDormantListOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="crm-hit-area-wide mt-auto pt-3 self-start text-[11px] font-medium text-[var(--primary)] hover:underline inline-flex items-center gap-1 rounded focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none"
                      >
                        휴면 {initialData.sellerMomentum.dormant}명 재계약 검토
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      sideOffset={6}
                      collisionPadding={12}
                      className="flex w-[320px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-overlay max-h-[min(420px,var(--radix-popover-content-available-height))]"
                    >
                      <div className="shrink-0 border-b border-slate-100 bg-slate-50/70 px-3.5 py-2.5">
                        <p className="text-[12px] font-bold text-slate-700">
                          휴면 셀러 {initialData.sellerMomentum.dormant}명 · 재계약 검토
                        </p>
                        <p className="text-[10px] text-slate-500">최근 90일 활동 없음 · 최근 활동순</p>
                      </div>
                      <ul className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] divide-y divide-slate-100 px-3.5">
                        {initialData.sellerMomentum.dormantList.map((seller) => (
                          <li key={seller.id} className="flex items-center justify-between gap-3 py-2">
                            <Link
                              href={`/sellers/${seller.id}`}
                              className="crm-hit-area-wide min-w-0 truncate text-[13px] font-medium text-slate-800 hover:text-[var(--primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                            >
                              {seller.name}
                            </Link>
                            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                              마지막 캠페인{" "}
                              <span className="font-medium text-slate-600">
                                {formatDistanceToNow(new Date(seller.lastCampaignAt), { addSuffix: true, locale: ko })}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </PopoverContent>
                  </Popover>
                )}
              </CardContent>
            </Card>

            {/* 트라이어드 3번째 칸 = 예외 알림 계열 탭 묶음(오너 2026-07-24): 데이터 점검 + 최저가 점검.
                둘 다 "확인 필요 N건"이라 카운트 배지 탭으로 묶으면 자리 1칸에 알림 2개가 산다.
                #101이 최저가를 풀폭으로 뒀던 것을 오너 지시로 이 트라이어드 칸에 흡수(풀폭 밴드 제거).
                카드 높이는 트라이어드 items-stretch로 형제 칸에 고정되고, 패널은 flex-1 내부 스크롤이라
                탭 전환·데이터 증감에도 카드 높이가 흔들리지 않는다(오너 요구). 우측 배치(order-3) */}
            <div className="h-full min-h-0 xl:order-3">
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
          </section>

          {/* 밴드 3: 일정 계열 탭 묶음(오너 2026-07-24, 2순위) — 같은 시간축의 조감(12주 커버리지)·
              상세(14일). 두 풀폭 밴드를 한 프레임에 묶어 세로 한 밴드를 절약한다. 일정 커버리지가
              없으면 14일만 단독. 패널 min-h 로 탭 전환 시 높이 튐을 억제한다. */}
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
                        <span className="text-[11px] text-muted-foreground/70">진행 예정인 정산 및 주요 마일스톤</span>
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

          {/* 시스템 레이더 — 자동화 스케줄 모니터링. 판단 빈도가 낮은 관제 정보라 최하단 풀폭 스트립으로 배치 */}
          <SystemRadarCard />
        </div>
      </main>
      <QuickSettlementModal
        isOpen={isSettlementModalOpen}
        onClose={() => {
          setIsSettlementModalOpen(false);
          setSelectedSettlement(null);
        }}
        onSuccess={() => {
          fetchAgenda();
          window.location.reload();
        }}
        data={
          selectedSettlement
            ? {
                id: selectedSettlement.id,
                title: selectedSettlement.title,
                sellerName: selectedSettlement.sellerName ?? "",
                accountNumber: selectedSettlement.accountNumber ?? null,
                // ⛔ 여기서 슬롯을 다시 유도하지 말 것 — 서버가 이미 어느 칸이 지연인지
                // 판정했다. 없으면(구 배포 응답) 모달이 스스로 닫는다.
                overdueSlot: selectedSettlement.overdueSlot ?? null,
                targetAmount: selectedSettlement.targetAmount ?? null,
              }
            : null
        }
      />
    </CrmShell>
  );
}
