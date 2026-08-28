"use client";

// ER(인게이지먼트율) 추이 차트 (§11-3) — SellersHistory의 er 파생 스칼라를 소비한다.
// 팔로워 추이(seller-growth-chart)와 분리된 이유: 팔로워는 규모, ER은 반응 밀도로
// 판단 축이 다르다 (반응이 식는 중인지 / 살아나는 중인지 → 협업·재계약 판단).
// 점은 수집 크론(GRAPH_ER — 매일 돌며 셀러별 7일 경과분만 적립)·수동 분석(AI_ANALYZE)이
// 적립하며, 2개 미만이면 적립 안내만 노출.

import { useMemo, useState, useCallback } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  type ChartConfig,
  ChartTooltip,
} from "@/components/ui/chart";
import { Separator } from "@/components/ui/separator";
import { Activity, TrendingUp, TrendingDown } from "lucide-react";

// PALETTE_IMPL_SPEC.md (오너 승인, 2026-07-09): ER 라인 색을 chart-growth 토큰으로
// 통일(팔로워 성장 차트와 동일 계열, "성장/반응"류 지표=한 색). 원래 hsl(222,72%,55%)는
// 블루 계열이었지만 이 컴포넌트의 유일한 시리즈 색 하드코딩이라 스펙이 지목한 대상이 맞다.
const erChartConfig = {
  erTrend: {
    label: "ER",
    color: "var(--chart-growth)",
  },
} satisfies ChartConfig;

type ErPoint = {
  date: string;
  /** (평균 좋아요+평균 댓글)/팔로워 — 원 비율 (0.023 = 2.3%) */
  er: number;
  avgLikes?: number | null;
  avgComments?: number | null;
};

type SellerErChartProps = {
  data: Array<{ date: string; er?: number | null; avgLikes?: number | null; avgComments?: number | null }>;
};

type FilterType = "1M" | "3M" | "ALL";

function formatErPercent(er: number): string {
  return `${(er * 100).toFixed(2)}%`;
}

function ErTooltipContent({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ErPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  return (
    <div className="min-w-[160px] rounded-lg border border-border/50 bg-background px-3 py-2.5 text-xs shadow-overlay">
      <div className="mb-1 font-medium text-foreground">{point.date}</div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">ER</span>
        <span className="font-mono font-medium tabular-nums text-foreground">
          {formatErPercent(point.er)}
        </span>
      </div>
      {point.avgLikes != null && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">평균 좋아요</span>
          <span className="font-mono font-medium tabular-nums text-foreground">
            {Math.round(point.avgLikes).toLocaleString()}
          </span>
        </div>
      )}
      {point.avgComments != null && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">평균 댓글</span>
          <span className="font-mono font-medium tabular-nums text-foreground">
            {Math.round(point.avgComments).toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}

export function SellerErChart({ data }: SellerErChartProps) {
  const [filter, setFilter] = useState<FilterType>("3M");
  const [animKey, setAnimKey] = useState(0);

  const handleFilterChange = useCallback((t: FilterType) => {
    setFilter(t);
    setAnimKey((k) => k + 1);
  }, []);

  // ER이 적립된 스냅샷만 — 팔로워-only 스냅샷(er null)은 ER 선의 점이 아니다
  const erPoints = useMemo<ErPoint[]>(() => {
    return data
      .filter((d): d is typeof d & { er: number } => typeof d.er === "number" && isFinite(d.er))
      .map((d) => ({ date: d.date, er: d.er, avgLikes: d.avgLikes, avgComments: d.avgComments }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  const filteredData = useMemo(() => {
    if (erPoints.length < 2 || filter === "ALL") return erPoints;
    const lastDate = new Date(erPoints[erPoints.length - 1].date);
    const threshold = new Date(lastDate);
    threshold.setMonth(threshold.getMonth() - (filter === "1M" ? 1 : 3));
    return erPoints.filter((d) => new Date(d.date) >= threshold);
  }, [erPoints, filter]);

  const latestEr = erPoints.length > 0 ? erPoints[erPoints.length - 1].er : null;

  // 기간 내 변화 (시작 대비 종료, %p)
  const periodChangePp = useMemo(() => {
    if (filteredData.length < 2) return null;
    return (filteredData[filteredData.length - 1].er - filteredData[0].er) * 100;
  }, [filteredData]);

  // ---------- 적립 대기 상태 ----------
  if (erPoints.length < 2) {
    return (
      <div className="flex h-[120px] flex-col space-y-3 rounded-lg border border-border/70 bg-card p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-foreground">ER(참여율) 추이</h3>
          {latestEr != null && (
            <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
              {formatErPercent(latestEr)}
            </span>
          )}
        </div>
        <Separator />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-muted-foreground">
            스냅샷 적립 중 ({erPoints.length}/2): 주간 수집·AI 분석 시 자동으로 쌓입니다
          </p>
        </div>
      </div>
    );
  }

  const isPositive = (periodChangePp ?? 0) >= 0;

  return (
    <div className="flex h-[260px] flex-col rounded-lg border border-border/70 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <h3 className="text-[13px] font-semibold text-foreground">ER(참여율) 추이</h3>
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            <span className="text-sm font-bold tabular-nums tracking-tight text-foreground">
              {latestEr != null ? formatErPercent(latestEr) : "-"}
            </span>
            {periodChangePp !== null && (
              <span
                className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  isPositive ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
                }`}
              >
                {isPositive ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                {periodChangePp > 0 ? "+" : ""}
                {periodChangePp.toFixed(2)}%p
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 rounded-lg border border-border/50 bg-muted p-0.5">
          {(["ALL", "1M", "3M"] as FilterType[]).map((t) => (
            <button
              key={t}
              onClick={() => handleFilterChange(t)}
              className={`rounded-[5px] px-2 py-0.5 text-[10px] font-medium transition-[color,background-color,box-shadow] duration-200 ${
                filter === t
                  ? "bg-background text-foreground shadow-soft-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "1M" ? "1개월" : t === "3M" ? "3개월" : "전체"}
            </button>
          ))}
        </div>
      </div>

      {filteredData.length < 2 ? (
        <div className="mt-4 flex h-[140px] items-center justify-center rounded-lg border border-dashed border-border/50 bg-white/50">
          <p className="text-xs text-muted-foreground">해당 기간의 데이터가 부족합니다.</p>
        </div>
      ) : (
        <ChartContainer
          key={animKey}
          config={erChartConfig}
          className="mt-4 h-[140px] min-h-[140px] w-full overflow-hidden rounded-lg border border-border/60 bg-white"
        >
          <AreaChart
            accessibilityLayer
            data={filteredData}
            margin={{ top: 16, right: 18, left: 18, bottom: 0 }}
          >
            <defs>
              <linearGradient id="erFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-erTrend)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="var(--color-erTrend)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(0, 0%, 92%)" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tick={{ fontSize: 10 }}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis
              hide
              domain={["dataMin", "dataMax"]}
              padding={{ top: 8, bottom: 8 }}
            />
            <ChartTooltip cursor={false} content={<ErTooltipContent />} />
            <Area
              dataKey="er"
              type="monotone"
              fill="url(#erFill)"
              stroke="var(--color-erTrend)"
              strokeWidth={2}
              dot={{ r: 3, strokeWidth: 2, fill: "white" }}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  );
}
