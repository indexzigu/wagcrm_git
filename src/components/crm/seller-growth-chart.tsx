"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  type ChartConfig,
  ChartTooltip,
} from "@/components/ui/chart";

import { Separator } from "@/components/ui/separator";
import { TrendingUp, TrendingDown, Users, Image as ImageIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// PALETTE_IMPL_SPEC.md (오너 승인, 2026-07-09): 팔로워/게시물 라인을 chart-growth
// 토큰 계열로 통일 — "성장"이라는 하나의 의미에 하나의 색.
const growthChartConfig = {
  followersTrend: {
    label: "팔로워",
    color: "var(--chart-growth)",
  },
  postsTrend: {
    label: "게시물",
    color: "var(--chart-growth-soft)",
  },
} satisfies ChartConfig;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GrowthTrendChartProps = {
  data: Array<{ date: string; followers: number; posts?: number | null }>;
  growthRate?: number | null;
};

type FilterType = "7D" | "1M" | "3M" | "ALL";

type DeltaPoint = {
  date: string;
  delta: number;
  followers: number;
  posts?: number | null;
  prevFollowers: number;
  weeklyRate: number;
};

type TrendPoint = DeltaPoint & {
  followersTrend: number;
  postsTrend?: number | null;
};

// ---------------------------------------------------------------------------
// Animated Counter Hook
// ---------------------------------------------------------------------------

function useAnimatedCount(target: number, duration = 600): number {
  const [display, setDisplay] = useState(target);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<{ value: number; time: number } | null>(null);

  useEffect(() => {
    const from = display;
    if (from === target) return;

    startRef.current = { value: from, time: performance.now() };

    function tick(now: number) {
      if (!startRef.current) return;
      const elapsed = now - startRef.current.time;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(
        startRef.current.value + (target - startRef.current.value) * eased,
      );
      setDisplay(current);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return display;
}

// ---------------------------------------------------------------------------
// Custom Tooltip
// ---------------------------------------------------------------------------

function normalizeRange(value: number, min: number, max: number): number {
  if (max === min) return 50;
  return ((value - min) / (max - min)) * 100;
}

function DeltaTooltipContent({ active, payload }: { active?: boolean; payload?: Array<{ payload: TrendPoint }> }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const isPositive = point.delta >= 0;

  return (
    <div className="min-w-[160px] rounded-lg border border-border/50 bg-background px-3 py-2.5 text-xs shadow-overlay">
      <div className="mb-1.5 font-medium text-foreground">
        {point.date.replace(/-/g, ".")}
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">주간 증가</span>
          <span
            className={`font-mono font-semibold tabular-nums ${
              isPositive ? "text-emerald-600" : "text-rose-500"
            }`}
          >
            {isPositive ? "+" : ""}
            {point.delta.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">증가율</span>
          <span
            className={`font-mono font-medium tabular-nums ${
              isPositive ? "text-emerald-600" : "text-rose-500"
            }`}
          >
            {isPositive ? "+" : ""}
            {point.weeklyRate.toFixed(1)}%
          </span>
        </div>
        <Separator className="my-1" />
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">총 팔로워</span>
          <span className="font-mono font-medium tabular-nums text-foreground">
            {point.followers.toLocaleString()}
          </span>
        </div>
        {point.posts != null && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">게시물 수</span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {point.posts.toLocaleString()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom Active Dot
// ---------------------------------------------------------------------------

function AnimatedActiveDot(props: {
  cx?: number;
  cy?: number;
  payload?: TrendPoint;
}) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return null;
  const isPositive = (payload?.delta ?? 0) >= 0;
  // PALETTE_IMPL_SPEC.md (2026-07-09): positive branch → chart-growth token (same
  // family as the followers line). Negative branch is an unrelated red hue, out of
  // this pass's scope — left as-is.
  const color = isPositive ? "var(--chart-growth)" : "hsl(0, 75%, 55%)";

  return (
    <g>
      {/* Outer glow ring */}
      <circle
        cx={cx}
        cy={cy}
        r={10}
        fill={color}
        opacity={0.15}
      />
      {/* Mid ring */}
      <circle
        cx={cx}
        cy={cy}
        r={6}
        fill="white"
        stroke={color}
        strokeWidth={2}
      />
      {/* Inner dot */}
      <circle cx={cx} cy={cy} r={3} fill={color} />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function SellerGrowthChart({ data }: GrowthTrendChartProps) {
  const [filter, setFilter] = useState<FilterType>("3M");
  const [animKey, setAnimKey] = useState(0);

  const handleFilterChange = useCallback((t: FilterType) => {
    setFilter(t);
    setAnimKey((k) => k + 1);
  }, []);

  // Sort chronologically
  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  // Apply time filter
  const filteredData = useMemo(() => {
    if (sortedData.length < 2) return sortedData;
    const lastDateStr = sortedData[sortedData.length - 1].date;
    const lastDate = new Date(lastDateStr);

    const threshold = new Date(lastDate);
    if (filter === "7D") {
      threshold.setDate(threshold.getDate() - 7);
      return sortedData.filter((d) => new Date(d.date) >= threshold);
    } else if (filter === "1M") {
      threshold.setMonth(threshold.getMonth() - 1);
      return sortedData.filter((d) => new Date(d.date) >= threshold);
    } else if (filter === "3M") {
      threshold.setMonth(threshold.getMonth() - 3);
      return sortedData.filter((d) => new Date(d.date) >= threshold);
    }
    return sortedData;
  }, [sortedData, filter]);

  // Compute delta data points — first point is baseline (delta=0) so the oldest
  // snapshot is always visible in the chart.
  const deltaData = useMemo<DeltaPoint[]>(() => {
    if (filteredData.length < 2) return [];
    const first = filteredData[0];
    const baseline: DeltaPoint = {
      date: first.date,
      delta: 0,
      followers: first.followers,
      posts: first.posts,
      prevFollowers: first.followers,
      weeklyRate: 0,
    };
    const rest = filteredData.slice(1).map((point, i) => {
      const prev = filteredData[i];
      const delta = point.followers - prev.followers;
      const weeklyRate = prev.followers === 0 ? 0 : (delta / prev.followers) * 100;
      return {
        date: point.date,
        delta,
        followers: point.followers,
        posts: point.posts,
        prevFollowers: prev.followers,
        weeklyRate,
      };
    });
    return [baseline, ...rest];
  }, [filteredData]);

  // Growth rate for selected period
  const dynamicGrowthRate = useMemo(() => {
    if (filteredData.length < 2) return null;
    const startVal = filteredData[0].followers;
    const endVal = filteredData[filteredData.length - 1].followers;
    if (startVal === 0) return 0;
    return ((endVal - startVal) / startVal) * 100;
  }, [filteredData]);

  const trendData = useMemo<TrendPoint[]>(() => {
    if (deltaData.length < 1) return [];

    const deltaValues = deltaData.map((point) => point.delta);
    const minDelta = Math.min(...deltaValues);
    const maxDelta = Math.max(...deltaValues);

    const postValues = filteredData
      .map((point) => point.posts)
      .filter((value): value is number => typeof value === "number");
    const minPosts = postValues.length > 0 ? Math.min(...postValues) : null;
    const maxPosts = postValues.length > 0 ? Math.max(...postValues) : null;

    return deltaData.map((point) => ({
      ...point,
      followersTrend: normalizeRange(point.delta, minDelta, maxDelta),
      postsTrend:
        typeof point.posts === "number" && minPosts != null && maxPosts != null
          ? normalizeRange(point.posts, minPosts, maxPosts)
          : null,
    }));
  }, [deltaData, filteredData]);

  // Current total followers (latest data point)
  const currentFollowers = sortedData.length > 0 ? sortedData[sortedData.length - 1].followers : 0;
  const animatedFollowers = useAnimatedCount(currentFollowers);

  // Period net change
  const periodNetChange = useMemo(() => {
    if (filteredData.length < 2) return 0;
    return filteredData[filteredData.length - 1].followers - filteredData[0].followers;
  }, [filteredData]);

  const latestPosts = useMemo(() => {
    return [...filteredData]
      .reverse()
      .find((point) => typeof point.posts === "number")?.posts ?? null;
  }, [filteredData]);

  const postGrowthRate = useMemo(() => {
    const points = filteredData.filter((point): point is typeof point & { posts: number } => typeof point.posts === "number");
    if (points.length < 2) return null;
    const startVal = points[0].posts;
    const endVal = points[points.length - 1].posts;
    if (startVal === 0) return 0;
    return ((endVal - startVal) / startVal) * 100;
  }, [filteredData]);

  const isGrowthPositive = (dynamicGrowthRate ?? 0) >= 0;
  const isPostGrowthPositive = (postGrowthRate ?? 0) >= 0;

  // ---------- Insufficient data state ----------
  if (sortedData.length < 2) {
    return (
      <div className="flex h-[224px] flex-col space-y-3 rounded-lg border border-border/70 bg-card p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-foreground">팔로워 성장 추이</h3>
        </div>
        <Separator />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-muted-foreground">충분한 팔로워 데이터가 없습니다 (최소 2일 필요)</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[314px] flex-col rounded-lg border border-border/70 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-4">
          <h3 className="text-[13px] font-semibold text-foreground">셀러 성장 추이</h3>
          
          <div className="flex flex-row flex-wrap items-center gap-x-6 gap-y-2">
            {/* Followers (Main) */}
            <div className="flex items-center gap-2">
              <Users className="size-4 text-muted-foreground" />
              <span className="text-sm font-bold tabular-nums tracking-tight text-foreground">
                {animatedFollowers.toLocaleString()}
              </span>
              {dynamicGrowthRate !== null && (
                <span
                  className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    isGrowthPositive
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-rose-50 text-rose-700"
                  }`}
                >
                  {isGrowthPositive ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                  {periodNetChange > 0 ? "+" : ""}
                  {periodNetChange.toLocaleString()}
                </span>
              )}
            </div>

            {/* Posts */}
            <div className="flex items-center gap-2">
              <ImageIcon className="size-4 text-muted-foreground" />
              <span className="text-sm font-semibold tabular-nums text-foreground">
                {latestPosts != null ? latestPosts.toLocaleString() : "-"}
              </span>
              {postGrowthRate !== null && (() => {
                const startPosts = filteredData.find((p) => typeof p.posts === "number")?.posts ?? 0;
                const netPostChange = latestPosts != null ? latestPosts - startPosts : 0;
                return (
                  <span
                    className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      isPostGrowthPositive ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
                    }`}
                  >
                    {isPostGrowthPositive ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                    {netPostChange > 0 ? "+" : ""}
                    {netPostChange.toLocaleString()}
                  </span>
                );
              })()}
            </div>
          </div>
        </div>

        <div className="flex flex-col items-end gap-3">
          <div className="flex shrink-0 rounded-lg border border-border/50 bg-muted p-0.5">
            {(["ALL", "7D", "1M", "3M"] as FilterType[]).map((t) => (
              <button
                key={t}
                onClick={() => handleFilterChange(t)}
                className={`rounded-[5px] px-2 py-0.5 text-[10px] font-medium transition-[color,background-color,box-shadow] duration-200 ${
                  filter === t
                    ? "bg-background text-foreground shadow-soft-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "7D" ? "1주" : t === "1M" ? "1개월" : t === "3M" ? "3개월" : "전체"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {trendData.length < 1 ? (
        <div className="mt-4 flex h-[160px] items-center justify-center rounded-lg border border-dashed border-border/50 bg-white/50">
          <p className="text-xs text-muted-foreground">해당 기간의 데이터가 부족합니다.</p>
        </div>
      ) : (
        <ChartContainer
          key={animKey}
          config={growthChartConfig}
          className="mt-4 h-[160px] min-h-[160px] w-full overflow-hidden rounded-lg border border-border/60 bg-white"
        >
          <AreaChart
            accessibilityLayer
            data={trendData}
            margin={{ top: 20, right: 18, left: 18, bottom: 0 }}
          >
            {/* PALETTE_IMPL_SPEC.md (2026-07-09): gradients repointed to chart-growth /
                chart-growth-soft tokens; stop structure/opacity untouched. Grid stroke
                moved to muted-foreground — it's chrome, not a data series, so it
                shouldn't carry the growth hue. */}
            <defs>
              <linearGradient id={`followersGradient-${animKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-growth)" stopOpacity={0.52} />
                <stop offset="70%" stopColor="var(--chart-growth)" stopOpacity={0.24} />
                <stop offset="100%" stopColor="var(--chart-growth)" stopOpacity={0.08} />
              </linearGradient>
              <linearGradient id={`postsGradient-${animKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-growth-soft)" stopOpacity={0.72} />
                <stop offset="70%" stopColor="var(--chart-growth-soft)" stopOpacity={0.36} />
                <stop offset="100%" stopColor="var(--chart-growth-soft)" stopOpacity={0.08} />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={true}
              horizontal={true}
              strokeDasharray="2 4"
              stroke="var(--muted-foreground)"
              strokeOpacity={0.25}
            />
            <XAxis 
              dataKey="date" 
              hide={false}
              tickLine={false} 
              axisLine={false} 
              tickMargin={8} 
              minTickGap={20}
              tickFormatter={(value) => {
                const date = new Date(value);
                return `${date.getMonth() + 1}/${date.getDate()}`;
              }}
              style={{ fontSize: "10px", fill: "var(--muted-foreground)" }}
            />
            <YAxis hide domain={[-5, 105]} />
            <ChartTooltip
              cursor={{
                stroke: "var(--muted-foreground)",
                strokeWidth: 1,
                strokeDasharray: "4 4",
                strokeOpacity: 0.4,
              }}
              content={<DeltaTooltipContent />}
            />
            <Area
              type="monotone"
              dataKey="postsTrend"
              stroke="var(--chart-growth-soft)"
              strokeWidth={1.5}
              fill={`url(#postsGradient-${animKey})`}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="followersTrend"
              stroke="var(--chart-growth)"
              strokeWidth={1.5}
              fill={`url(#followersGradient-${animKey})`}
              dot={false}
              activeDot={<AnimatedActiveDot />}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  );
}
