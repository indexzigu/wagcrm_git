"use client";
// 인트라데이 주문 차트(10분 버킷) — 확정 설계 v2의 메인 차트.
// 두 면적 곡선(누적 주문 · 주문 속도)을 겹쳐 그리고 휠 줌·드래그 팬·더블클릭 복귀를 지원한다.
// recharts 가 아니라 캔버스인 이유는 휠 줌·팬이다(확정 설계) — 계산 로직은 lib/intraday-chart.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ContentEvent } from "@/lib/content-order-correlation";
import { EVENT_ICON, EVENT_TYPE_LABEL } from "./content-event-icon";
import {
  BUCKET_MS,
  buildAnchoredCumulativeSeries,
  clusterMarkers,
  buildSumColumns,
  DAY_BUCKET_MS,
  densifyPoints,
  splitSegments,
  downsampleMax,
  panViewport,
  resolveCumulativeScale,
  resolveMinViewportMs,
  resolveRateScale,
  timeRatio,
  visibleIndexRange,
  zoomViewport,
  type MarkerCluster,
  type Viewport,
} from "@/lib/intraday-chart";

export type IntradayPointInput = { startMs: number; orders: number; revenue: number };

const PLOT_PADDING = { top: 10, right: 8, bottom: 20, left: 8 } as const;
const MARKER_RADIUS = 7;
/** 마커가 곡선을 가리지 않도록 띄우는 높이(플롯 상단 기준 px). */
const MARKER_TOP_OFFSET = 10;

/** KST HH:mm. */
function formatKstHm(ms: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

/** KST M.D. */
function formatKstMonthDay(ms: number): string {
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  return `${kst.getUTCMonth() + 1}.${kst.getUTCDate()}`;
}

/**
 * X축 눈금 — 구간 폭에 따라 라벨 단위를 바꾼다. 7일 뷰에서 분 단위를 찍으면 읽을 수 없고,
 * 2시간 뷰에서 날짜만 찍으면 아무 정보가 없다.
 */
export function resolveTickStepMs(spanMs: number): number {
  const HOUR = 60 * 60 * 1000;
  const candidates = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR, 7 * 24 * HOUR];
  // 눈금이 6개 안팎이 되게 고른다.
  const target = spanMs / 6;
  return candidates.find((c) => c >= target) ?? candidates[candidates.length - 1];
}

/** 눈금 라벨 — 하루 이상 폭이면 날짜, 그 아래면 시각. */
export function formatTickLabel(ms: number, spanMs: number): string {
  return spanMs >= 24 * 60 * 60 * 1000 ? formatKstMonthDay(ms) : formatKstHm(ms);
}

type Props = {
  points: IntradayPointInput[];
  events: ContentEvent[];
  /**
   * 뷰포트는 **상위가 소유한다**(controlled) — 보조뷰 히트맵이 차트와 같은 구간을 말해야
   * 하기 때문이다. 내부 상태로 두면 둘이 조용히 어긋난다.
   */
  viewport: Viewport;
  bounds: Viewport;
  /**
   * 해상도 — 10분(`BUCKET_MS`) 또는 일별(`DAY_BUCKET_MS`). **인트라데이 유무가 렌더러를
   * 바꾸지 않는다**(오너 개정 2026-08-02): 캠페인마다 차트가 다른 제품처럼 보이던 원인이
   * recharts↔캔버스 이원화였다. 이제 이 값만 다르고 그림 언어는 하나다.
   */
  bucketMs: number;
  /**
   * dateKey(YYYY-MM-DD KST) → 서버 일별 누계. 누적선의 **일 경계 정본**이다 —
   * 버킷 자체 누계는 「기록 없음」 구간의 실주문을 흘린다(P7·실결함 2026-08-02).
   */
  cumulativeByDate: ReadonlyMap<string, number>;
  /** 버킷이 아직 없는 날짜(YYYY-MM-DD KST) — 그 구간은 0 으로 채우지 않고 **끊어서** 그린다. */
  daysWithoutBuckets?: string[];
  onViewportChange: (next: Viewport) => void;
  /** 마커(또는 클러스터) 선택 — 상위가 상세 목록을 편다. */
  onSelectEvents: (events: ContentEvent[]) => void;
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** dateKey(YYYY-MM-DD KST) → 그 날 시작 UTC ms. 파싱 실패면 null. */
function kstDayStartMs(dateKey: string): number | null {
  const t = Date.parse(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(t) ? null : t - KST_OFFSET_MS;
}

/**
 * 전체 구간 = **일별 데이터의 창**이다. 버킷의 첫 점~끝 점으로 잡으면 버킷이 늦게 시작하는
 * 캠페인에서 앞 구간이 통째로 잘린다 — 실사고: 창 07-12~30 에 버킷이 07-16 부터라 콘텐츠
 * 마커 36건 중 32건과 주문 피크(07-12)가 뷰포트 밖이었다(오너 발견 2026-08-02).
 * 일별 창이 비면 버킷 점 범위로 폴백한다.
 */
export function resolveIntradayBounds(
  points: IntradayPointInput[],
  dailyDates: string[] = [],
  bucketMs: number = BUCKET_MS,
): Viewport | null {
  const dayStarts = dailyDates
    .map((d) => kstDayStartMs(d))
    .filter((v): v is number => v !== null);
  const candidates: Array<{ startMs: number; endMs: number }> = [];
  if (points.length > 0) {
    candidates.push({
      startMs: points[0].startMs,
      endMs: points[points.length - 1].startMs + bucketMs,
    });
  }
  if (dayStarts.length > 0) {
    candidates.push({
      startMs: Math.min(...dayStarts),
      endMs: Math.max(...dayStarts) + 24 * 60 * 60 * 1000,
    });
  }
  if (candidates.length === 0) return null;
  return {
    startMs: Math.min(...candidates.map((c) => c.startMs)),
    endMs: Math.max(...candidates.map((c) => c.endMs)),
  };
}

export function IntradayOrderChart({
  points,
  events,
  viewport,
  bounds,
  bucketMs,
  cumulativeByDate,
  daysWithoutBuckets,
  onViewportChange,
  onSelectEvents,
}: Props) {
  /** 일별 해상도인가 — 문구·툴팁·접근성 라벨이 이 값으로 갈린다(그림 언어는 동일). */
  const isDaily = bucketMs >= DAY_BUCKET_MS;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 240 });
  const [hover, setHover] = useState<{ x: number; index: number } | null>(null);
  // 드래그 중 여부는 커서 모양에 쓰이므로 **상태**여야 한다 — ref 를 렌더에서 읽으면
  // 리렌더가 보장되지 않아 커서가 안 바뀌고, react-hooks/refs 가 이를 에러로 잡는다.
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startViewport: Viewport } | null>(null);
  /**
   * 최신 뷰포트 거울. 휠은 한 프레임에 여러 개가 몰려 들어오는데, 핸들러가 prop 을 그대로
   * 읽으면 그 이벤트들이 **전부 같은 낡은 값**으로 계산돼 한 스텝으로 뭉갠다(트랙패드에서
   * 실제로 확대가 거의 안 먹었다). 커밋 즉시 이 ref 를 갱신해 같은 틱의 다음 이벤트가
   * 이어받게 한다.
   */
  const viewportRef = useRef(viewport);
  // 렌더 중 ref 쓰기는 금지(react-hooks/refs) — 커밋 후 effect 에서 동기화한다.
  // 같은 틱 안의 연쇄는 commitViewport 가 직접 갱신하므로 이 effect 는 외부에서 뷰포트가
  // 바뀐 경우(데이터 교체 등)를 따라잡는 용도다.
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  const commitViewport = useCallback(
    (next: Viewport) => {
      viewportRef.current = next;
      onViewportChange(next);
    },
    [onViewportChange],
  );

  // 폭 0 가드 — 숨겨진 탭·접힌 패널에서 clientWidth 가 0이면 그리지 않고 물러났다가
  // 보이는 순간 다시 그린다(확정 설계의 명시 요구).
  //
  // ⚠️ **폭 0 을 상태로 저장하지 않는다.** 저장하면 마지막으로 알던 폭을 잃어 마커·툴팁
  // 레이어가 통째로 사라지는데, 캔버스는 이전에 그린 픽셀이 남아 **차트가 멀쩡해 보인다**
  // — 즉 "얼어붙었지만 정상처럼 보이는" 상태가 된다. 실제로 이 상태에서 마커가 하나도
  // 안 그려지는 것을 실렌더 검증에서 잡았다(props 에는 이벤트 5건이 멀쩡히 들어와 있었다).
  // 0 은 "아직/지금은 못 잼"이지 "폭이 0인 화면"이 아니므로 무시하고 직전 값을 유지한다.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const apply = (width: number, height: number) => {
      if (width <= 0) return;
      setSize({ width: Math.floor(width), height: Math.floor(height) || 240 });
    };
    const rect = el.getBoundingClientRect();
    apply(rect.width, rect.height);
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) apply(box.width, box.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const plot = useMemo(
    () => ({
      x: PLOT_PADDING.left,
      y: PLOT_PADDING.top,
      width: Math.max(0, size.width - PLOT_PADDING.left - PLOT_PADDING.right),
      height: Math.max(0, size.height - PLOT_PADDING.top - PLOT_PADDING.bottom),
    }),
    [size],
  );

  // 저장은 희소(주문 있는 칸만)지만 **그리기 전에 균일 격자로 편다** — 안 그러면 주문 없는
  // 시간대가 압축돼 곡선이 시각축과 어긋나고, 이동평균이 시간 간격을 건너뛴다(dev 실측).
  const grid = useMemo(
    () => densifyPoints(points, bucketMs, daysWithoutBuckets ?? [], bounds),
    [points, bucketMs, daysWithoutBuckets, bounds],
  );
  const startMsList = useMemo(() => grid.map((p) => p.startMs), [grid]);
  // 누적의 일 경계 정본은 서버 값이다 — 버킷 자체 누계는 「기록 없음」 구간을 흘린다.
  const cumulativeAll = useMemo(
    () => buildAnchoredCumulativeSeries(grid, cumulativeByDate),
    [grid, cumulativeByDate],
  );

  const toX = useCallback(
    (timeMs: number) => plot.x + timeRatio(timeMs, viewport) * plot.width,
    [viewport, plot],
  );

  /**
   * 가시 구간·구간 분할·막대 열 — 렌더 effect 와 **툴팁이 같은 메모를 읽는다**(UX 리뷰 P0).
   * 축소하면 열 하나가 여러 버킷의 합인데, 툴팁이 원본 버킷 하나를 말하면 눈에 보이는 막대
   * 높이와 숫자가 어긋난다. 소스를 하나로 묶으면 구조적으로 어긋날 수 없다.
   */
  const view = useMemo(() => {
    const { from, to } = visibleIndexRange(startMsList, viewport);
    const visiblePoints = grid.slice(from, to);
    const visibleCumulative = cumulativeAll.slice(from, to);
    const segments = splitSegments(visiblePoints);
    const rateColumnsBySegment =
      plot.width <= 0
        ? []
        : segments.map((seg) => {
            const segPoints = visiblePoints
              .slice(seg.from, seg.to)
              .map((p) => ({ startMs: p.startMs, orders: p.orders as number }));
            const target = Math.max(
              1,
              Math.floor((plot.width * (seg.to - seg.from)) / visiblePoints.length / 3),
            );
            return buildSumColumns(segPoints, target, bucketMs);
          });
    return { visiblePoints, visibleCumulative, segments, rateColumnsBySegment };
  }, [grid, startMsList, cumulativeAll, viewport, plot.width, bucketMs]);

  const markerClusters = useMemo<MarkerCluster<ContentEvent & { timeMs: number }>[]>(() => {
    if (plot.width <= 0) return [];
    const inputs = events
      .map((e) => ({ ...e, timeMs: Date.parse(e.postedAt) }))
      .filter((e) => Number.isFinite(e.timeMs) && e.timeMs >= viewport.startMs && e.timeMs <= viewport.endMs);
    return clusterMarkers(inputs, toX);
  }, [events, viewport, plot.width, toX]);

  // ── 렌더 ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || plot.width <= 0 || plot.height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    const styles = getComputedStyle(canvas);
    const cumulativeColor = styles.getPropertyValue("--chart-1").trim() || "#0A3D62";
    const rateColor = styles.getPropertyValue("--chart-4").trim() || "#F59E0B";
    const gridColor = "rgba(100, 116, 139, 0.18)";
    const tickColor = "rgba(100, 116, 139, 0.9)";

    // 10분 계열은 **막대**다(오너 결정 2026-08-02 — 실데이터의 희소 파형에서 곡선은
    // 스파이크 울타리가 된다). 계산은 위 view 메모(툴팁과 공유).
    const { visiblePoints, visibleCumulative, segments, rateColumnsBySegment } = view;
    if (visiblePoints.length === 0) return;
    const cumulativeBySegment = segments.map((seg) => {
      const raw = visibleCumulative.slice(seg.from, seg.to).filter((v): v is number => v !== null);
      const target = Math.max(2, Math.floor((plot.width * (seg.to - seg.from)) / visiblePoints.length));
      return { seg, values: raw.length <= target ? raw : downsampleMax(raw, target) };
    });

    // 축 스케일은 **보이는 전 구간**을 함께 본다(구간마다 다른 축을 쓰면 크기 비교가 깨진다).
    const rateScale = resolveRateScale(
      rateColumnsBySegment.flatMap((cols) => cols.map((c) => c.orders)),
    );
    const cumulativeScale = resolveCumulativeScale(cumulativeBySegment.flatMap((s2) => s2.values));

    // ⚠️ X 는 **시각 기준**이다(인덱스 기준 금지). 다운샘플 후에는 인덱스와 시각이 1:1이
    // 아니므로, 구간의 열 인덱스를 그 구간의 실제 시각으로 되돌려 좌표를 잡는다.
    const segmentX = (seg: { from: number; to: number }, i: number, len: number) => {
      const startMs = visiblePoints[seg.from].startMs;
      const endMs = visiblePoints[seg.to - 1].startMs;
      const ratio = len <= 1 ? 0 : i / (len - 1);
      return plot.x + timeRatio(startMs + ratio * (endMs - startMs), viewport) * plot.width;
    };
    const seriesY = (norm: number) => plot.y + plot.height - norm * plot.height;

    // 가로 그리드 — 값 눈금은 없다(수치는 툴팁·보조뷰가 답한다). 위치 감각만 준다.
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = plot.y + (plot.height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.width, y);
      ctx.stroke();
    }

    const strokeSegments = (
      bySegment: Array<{ seg: { from: number; to: number }; values: number[] }>,
      normalize: (v: number) => number,
      color: string,
    ) => {
      for (const { seg, values } of bySegment) {
        if (values.length === 0) continue;
        const len = values.length;
        const x = (i: number) => segmentX(seg, i, len);
        ctx.beginPath();
        ctx.moveTo(x(0), seriesY(normalize(values[0])));
        for (let i = 1; i < len; i += 1) ctx.lineTo(x(i), seriesY(normalize(values[i])));
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    };

    const drawSegments = (
      bySegment: Array<{ seg: { from: number; to: number }; values: number[] }>,
      normalize: (v: number) => number,
      color: string,
      alpha: number,
    ) => {
      for (const { seg, values } of bySegment) {
        if (values.length === 0) continue;
        const len = values.length;
        const x = (i: number) => segmentX(seg, i, len);

        ctx.beginPath();
        ctx.moveTo(x(0), seriesY(normalize(values[0])));
        for (let i = 1; i < len; i += 1) ctx.lineTo(x(i), seriesY(normalize(values[i])));
        const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.height);
        gradient.addColorStop(0, withAlpha(color, alpha));
        gradient.addColorStop(1, withAlpha(color, 0.02));
        ctx.lineTo(x(len - 1), plot.y + plot.height);
        ctx.lineTo(x(0), plot.y + plot.height);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(x(0), seriesY(normalize(values[0])));
        for (let i = 1; i < len; i += 1) ctx.lineTo(x(i), seriesY(normalize(values[i])));
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    };

    // 누적(곡선) 채움을 뒤에 깔고, 막대를 얹은 뒤, 누적 **선만** 맨 위에 다시 긋는다 —
    // 막대(α0.75)가 스파이크·저누적 교차 지점에서 2px 스트로크를 지우기 때문(UX 리뷰 P1).
    drawSegments(cumulativeBySegment, cumulativeScale.normalize, cumulativeColor, 0.28);
    for (const cols of rateColumnsBySegment) {
      for (const col of cols) {
        if (col.orders <= 0) continue;
        const x0 = plot.x + timeRatio(col.startMs, viewport) * plot.width;
        const x1 = plot.x + timeRatio(col.endMs, viewport) * plot.width;
        const h = rateScale.normalize(col.orders) * plot.height;
        // 열 사이 틈은 **폭에 비례**한다 — 고정 0.5px 이면 열이 넓은 저해상도(일별 8칸 ≈ 90px)
        // 에서 막대가 서로 붙어 면적 그래프처럼 읽힌다(데모 실렌더에서 확인). 촘촘한 10분
        // 뷰에서는 0.5px 하한이 그대로 유지된다.
        const span = x1 - x0;
        const gap = Math.min(6, Math.max(0.5, span * 0.12));
        const w = Math.max(1, span - gap);
        ctx.fillStyle = withAlpha(rateColor, 0.75);
        ctx.fillRect(x0, plot.y + plot.height - h, w, h);
      }
    }
    strokeSegments(cumulativeBySegment, cumulativeScale.normalize, cumulativeColor);

    // 기록 없는 구간 — "여기는 0 이 아니라 모른다"를 그림으로도 말한다. 연속 구간(run)으로
    // 묶어 그리고, 폭이 충분하면 라벨을 얹는다(외부 캡션 한 줄에만 의존하면 큰 공백이
    // 무주문으로 오독된다 — UX 리뷰 P2).
    let runStart: number | null = null;
    const flushRun = (endIdx: number) => {
      if (runStart === null) return;
      const fromX = plot.x + timeRatio(visiblePoints[runStart].startMs, viewport) * plot.width;
      const nextMs =
        visiblePoints[endIdx]?.startMs ?? visiblePoints[endIdx - 1].startMs + bucketMs;
      const toXPx = plot.x + timeRatio(nextMs, viewport) * plot.width;
      const w = Math.max(1, toXPx - fromX);
      // 알파 0.16 — 종전 0.09 는 좁은 구멍에서 사실상 보이지 않아 "기록 없음"과 "0건"을
      // 가르는 시각 신호가 무효화됐다(UX 리뷰 P1). 이 구간엔 곡선도 막대도 없으므로
      // 진하게 해도 가릴 데이터가 없다.
      ctx.fillStyle = "rgba(100, 116, 139, 0.16)";
      ctx.fillRect(fromX, plot.y, w, plot.height);
      // 라벨은 **실제로 들어갈 때만** 그린다 — 종전 하한 64px 은 자의적이라 들어가는 폭에서도
      // 라벨이 빠져 좁은 구멍이 무신호가 됐다(UX 리뷰 P1). 글자 폭을 재서 판단하면 폰트가
      // 바뀌어도 따라간다. 안 들어가는 폭에서는 위의 회색 밴드가 신호를 담당한다.
      ctx.font = "10px system-ui, -apple-system, sans-serif";
      const label = "기록 없음";
      if (w >= ctx.measureText(label).width + 8) {
        ctx.fillStyle = tickColor;
        ctx.textAlign = "center";
        ctx.fillText(label, fromX + w / 2, plot.y + 14);
      }
      runStart = null;
    };
    for (let i = 0; i < visiblePoints.length; i += 1) {
      if (visiblePoints[i].orders === null) {
        if (runStart === null) runStart = i;
      } else {
        flushRun(i);
      }
    }
    flushRun(visiblePoints.length);

    // X축 눈금
    const span = viewport.endMs - viewport.startMs;
    const step = resolveTickStepMs(span);
    ctx.fillStyle = tickColor;
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    const firstTick = Math.ceil(viewport.startMs / step) * step;
    for (let t = firstTick; t <= viewport.endMs; t += step) {
      const x = toX(t);
      if (x < plot.x || x > plot.x + plot.width) continue;
      ctx.fillText(formatTickLabel(t, span), x, plot.y + plot.height + 14);
    }

    // 호버 세로선
    if (hover) {
      ctx.strokeStyle = "rgba(100, 116, 139, 0.45)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hover.x, plot.y);
      ctx.lineTo(hover.x, plot.y + plot.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [view, viewport, plot, size, hover, toX, bucketMs]);

  // ── 조작(휠 줌 · 드래그 팬 · 더블클릭 복귀) ───────────────────────────────
  // 버튼 줄은 두지 않는다(확정 설계 — 오너 지시). 발견성은 아래 힌트 한 줄이 담당한다.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // 확대 하한은 해상도에 따른다 — 일별에서 2일보다 좁게 들어가면 막대 1개만 남는다.
    const minSpanMs = resolveMinViewportMs(bucketMs);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const current = viewportRef.current;
      const rect = canvas.getBoundingClientRect();
      const ratio = plot.width <= 0 ? 0 : (e.clientX - rect.left - plot.x) / plot.width;
      // 가로휠·Shift+휠 = 이동, 세로휠 = 확대·축소(확정 설계).
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const delta = (e.deltaX || e.deltaY) / Math.max(1, plot.width);
        commitViewport(
          panViewport(current, bounds, delta * (current.endMs - current.startMs), minSpanMs),
        );
        return;
      }
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      commitViewport(zoomViewport(current, bounds, ratio, factor, minSpanMs));
    };

    // passive:false — preventDefault 로 페이지 스크롤을 뺏어야 휠 줌이 성립한다.
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // viewport 를 deps 에 넣지 않는다 — 최신값은 viewportRef 가 담당하고, 넣으면 휠 한 번마다
    // 리스너를 떼었다 다시 붙인다.
  }, [bounds, plot, commitViewport, bucketMs]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // 주 버튼만 드래그로 친다. 우클릭도 pointerdown 을 먼저 쏘는데 컨텍스트 메뉴가 열리면
    // 짝이 되는 pointerup 이 캔버스에 안 오는 브라우저가 있어 커서가 grabbing 으로 고착된다.
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startViewport: viewport };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const drag = dragRef.current;
    if (drag && bounds && plot.width > 0) {
      const span = drag.startViewport.endMs - drag.startViewport.startMs;
      const deltaMs = -((e.clientX - drag.startX) / plot.width) * span;
      commitViewport(
        panViewport(drag.startViewport, bounds, deltaMs, resolveMinViewportMs(bucketMs)),
      );
      return;
    }
    if (plot.width <= 0) return;
    const ratio = (x - plot.x) / plot.width;
    const timeMs = viewport.startMs + ratio * (viewport.endMs - viewport.startMs);
    const index = nearestIndex(startMsList, timeMs);
    setHover(index === -1 ? null : { x, index });
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const hoveredPoint = hover ? grid[hover.index] : null;
  const hoveredCumulative = hover ? cumulativeAll[hover.index] : null;
  // 막대와 같은 소스(view 메모의 열) — 열이 여러 버킷 합이면 시간 범위와 "합계"를 명시한다.
  const hoveredColumn =
    hover && hoveredPoint
      ? view.rateColumnsBySegment
          .flat()
          .find((c) => hoveredPoint.startMs >= c.startMs && hoveredPoint.startMs < c.endMs) ?? null
      : null;
  /** 열이 버킷 1칸보다 넓으면 그 범위의 **합계**를 말한다(막대 높이와 숫자가 어긋나지 않게). */
  const hoveredColumnIsAggregate =
    hoveredColumn !== null && hoveredColumn.endMs - hoveredColumn.startMs > bucketMs;
  const formatColumnEdge = (ms: number) => (isDaily ? formatKstMonthDay(ms) : formatKstHm(ms));

  if (points.length === 0) return null;

  return (
    <div className="space-y-2">
      <div ref={containerRef} className="relative h-[240px] w-full">
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", touchAction: "none", cursor: dragging ? "grabbing" : "crosshair" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerLeave={(e) => {
            endDrag(e);
            setHover(null);
          }}
          onDoubleClick={() => commitViewport({ ...bounds })}
          role="img"
          aria-label={
            isDaily
              ? "일별 주문 추이: 누적 주문과 일별 주문. 상세 수치는 위 일별 요약 목록을 참고하세요."
              : "10분 단위 주문 추이: 누적 주문과 10분 주문. 상세 수치는 아래 시간대 표를 참고하세요."
          }
        />

        {/* 콘텐츠 마커 — 캔버스 위 DOM 레이어. 키보드 도달과 클릭 표적을 DOM 이 담당한다
            (캔버스에 그리면 포커스도 스크린리더도 붙지 않는다). */}
        {markerClusters.map((cluster) => {
          const x = toX(cluster.timeMs);
          if (x < plot.x - MARKER_RADIUS || x > plot.x + plot.width + MARKER_RADIUS) return null;
          const extra = cluster.members.length - 1;
          // 대표 아이콘은 첫 구성원의 유형 — 일별 차트의 마커와 같은 규약이다(P8 §4:
          // 범주는 색이 아니라 아이콘). 아이콘 없이 빈 원만 두면 클릭 전에는 무슨
          // 콘텐츠인지 알 수 없다.
          const Icon = EVENT_ICON[cluster.members[0].type];
          return (
            <button
              key={`${cluster.members[0].id}-${cluster.members.length}`}
              type="button"
              className="absolute flex size-[14px] items-center justify-center rounded-full border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              style={{ left: x - MARKER_RADIUS, top: plot.y + MARKER_TOP_OFFSET }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectEvents(cluster.members);
              }}
              aria-label={`${formatKstMonthDay(cluster.timeMs)} ${formatKstHm(cluster.timeMs)} ${
                EVENT_TYPE_LABEL[cluster.members[0].type]
              } 콘텐츠 ${cluster.members.length}건`}
            >
              <Icon aria-hidden className="size-2.5 text-muted-foreground" />
              {extra > 0 && (
                <span className="absolute -right-2.5 -top-1 text-[9px] font-semibold text-muted-foreground">
                  +{extra}
                </span>
              )}
            </button>
          );
        })}

        {hoveredPoint && (
          <div
            /* 툴팁은 elevation 사다리에서 overlay 층이다(P8) — 포털이 아니라 캔버스 위
               절대위치지만 "페이지 흐름과 분리돼 항상 단독으로 뜨는 레이어"라는 정의에 부합한다. */
            className="pointer-events-none absolute top-2 rounded-lg border border-black/5 bg-white px-3 py-2 text-xs shadow-overlay"
            style={{ left: Math.min(Math.max(0, hover!.x - 60), Math.max(0, size.width - 140)) }}
          >
            <p className="mb-0.5 font-semibold text-[var(--primary)]">
              {formatKstMonthDay(hoveredPoint.startMs)}
              {isDaily ? "" : ` ${formatKstHm(hoveredPoint.startMs)}`}
            </p>
            {hoveredPoint.orders === null ? (
              // 0 건이라고 말하지 않는다 — 모르는 것과 없는 것은 다르다.
              <p className="text-muted-foreground">
                {isDaily ? "기록 없음" : "10분 단위 기록 없음"}
              </p>
            ) : (
              <>
                {/* 막대가 여러 버킷의 합이면 그 범위의 합계를 말한다 — 원본 버킷 하나를
                    말하면 눈에 보이는 막대 높이와 숫자가 어긋난다(UX 리뷰 P0). */}
                {hoveredColumnIsAggregate && hoveredColumn ? (
                  <p className="text-muted-foreground">
                    {formatColumnEdge(hoveredColumn.startMs)}~{formatColumnEdge(hoveredColumn.endMs)}{" "}
                    합계 {hoveredColumn.orders}건
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    {isDaily ? "일별" : "10분"} 주문 {hoveredPoint.orders}건
                  </p>
                )}
                <p className="text-muted-foreground">누적 {hoveredCumulative ?? "—"}건</p>
              </>
            )}
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-500">
        휠로 확대·축소 · 드래그로 이동 · 더블클릭으로 전체 보기
      </p>
    </div>
  );
}

/** hex/rgb 색 문자열에 알파를 입힌다. CSS 변수 실측값(hex)을 그대로 받는다. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.replace("#", "");
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

/** 시각에 가장 가까운 점의 인덱스. 점이 없으면 -1. */
export function nearestIndex(startMsList: number[], timeMs: number): number {
  if (startMsList.length === 0) return -1;
  let best = 0;
  let bestDelta = Math.abs(startMsList[0] - timeMs);
  for (let i = 1; i < startMsList.length; i += 1) {
    const delta = Math.abs(startMsList[i] - timeMs);
    if (delta < bestDelta) {
      best = i;
      bestDelta = delta;
    }
  }
  return best;
}
