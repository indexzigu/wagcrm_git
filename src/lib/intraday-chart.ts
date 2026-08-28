/**
 * 인트라데이 차트(캔버스)의 순수 계산 — 뷰포트·평활·리스케일·클러스터링.
 *
 * 캔버스 렌더러에서 이 로직을 분리한 이유는 테스트다. 확정 설계
 * (`docs/private/specs/2026-07-25-content-order-correlation-design.md` 「v2 최종 확정」)의
 * 규칙 중 **눈으로는 틀린 걸 알아채기 어려운 것들**이 여기 모여 있다 — 특히 평활 창을
 * 시간이 아니라 **화면 스케일**에 연동하는 규칙과, 누적축을 **가시 구간**으로 리스케일하는
 * 규칙은 값이 조금 어긋나도 그림이 그럴듯하게 나와서 육안 검증이 통과해 버린다.
 *
 * recharts 를 쓰지 않는 이유는 휠 줌·팬이다(확정 설계).
 *
 * ⛔ 종전 서술 *"줌이 필요 없는 일별 차트까지 캔버스로 옮기지 말 것"* 은 **SUPERSEDED**
 * (오너 개정 2026-08-02). 인트라데이 유무로 렌더러가 갈리자 **캠페인마다 다른 제품처럼
 * 보였고**(오너 지적), 그 대가가 recharts 가 주는 접근성·툴팁 이득보다 컸다. 이제 일별도
 * 이 캔버스가 그리고 `bucketMs` 로 해상도만 가른다 — 접근성은 sr-only 일별 요약 목록과
 * DOM 마커 버튼이 담당한다(캔버스 도입 때부터 이미 그 구조였다).
 */

/** 화면에 보이는 시간 구간. */
export type Viewport = { startMs: number; endMs: number };

/** 확대 하한 — 10분 버킷 12칸(2시간). 더 들어가면 점 사이가 벌어져 곡선이 계단이 된다. */
export const MIN_VIEWPORT_MS = 2 * 60 * 60 * 1000;

/** 일 버킷 폭(ms) — 일별 모드의 `bucketMs`. 인트라데이가 없는 캠페인도 같은 캔버스로 그린다. */
export const DAY_BUCKET_MS = 24 * 60 * 60 * 1000;

/**
 * 해상도별 확대 하한. 버킷 2칸보다 좁게 들어가면 화면에 막대가 하나만 남아 판독 대상이
 * 사라진다 — 10분 버킷에서는 종전 2시간 하한이 이미 12칸이라 그대로 이긴다.
 */
export function resolveMinViewportMs(bucketMs: number): number {
  return Math.max(MIN_VIEWPORT_MS, 2 * bucketMs);
}

/** 마커 클러스터 임계(px) — 확정 설계 지정값. 줌하면 시간상 임계가 좁아져 자연히 풀린다. */
export const MARKER_CLUSTER_PX = 18;

/** 속도(활동량) 곡선이 플롯 높이를 채우는 비율(오너 지정). */
export const RATE_FILL = 0.92;

/** 누적 곡선이 플롯 높이를 채우는 비율(오너 지정). */
export const CUMULATIVE_FILL = 0.8;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 뷰포트를 데이터 경계 안으로 되돌린다.
 * - 최소 폭(MIN_VIEWPORT_MS) 보장 — 0 폭이면 좌표 계산이 0 나눗셈으로 무너진다.
 * - 데이터보다 넓게 확대하면 전체로 고정한다(빈 여백을 만들지 않는다).
 */
export function clampViewport(
  viewport: Viewport,
  bounds: Viewport,
  minSpanMs: number = MIN_VIEWPORT_MS,
): Viewport {
  const boundsSpan = Math.max(1, bounds.endMs - bounds.startMs);
  const desired = Math.max(1, viewport.endMs - viewport.startMs);
  const span = Math.min(boundsSpan, Math.max(Math.min(minSpanMs, boundsSpan), desired));

  let start = viewport.startMs;
  if (start < bounds.startMs) start = bounds.startMs;
  if (start + span > bounds.endMs) start = bounds.endMs - span;
  return { startMs: start, endMs: start + span };
}

/**
 * 커서 위치(0~1)를 고정한 채 확대·축소한다 — 마우스 아래 지점이 제자리에 남아야
 * "그 봉우리를 들여다본다"는 조작이 성립한다.
 */
export function zoomViewport(
  viewport: Viewport,
  bounds: Viewport,
  anchorRatio: number,
  factor: number,
  minSpanMs: number = MIN_VIEWPORT_MS,
): Viewport {
  const span = viewport.endMs - viewport.startMs;
  const anchorMs = viewport.startMs + span * clamp01(anchorRatio);
  const nextSpan = span * factor;
  return clampViewport(
    { startMs: anchorMs - nextSpan * clamp01(anchorRatio), endMs: anchorMs + nextSpan * (1 - clamp01(anchorRatio)) },
    bounds,
    minSpanMs,
  );
}

/** 좌우 이동. 경계에 닿으면 더 밀리지 않는다(고무줄 없음 — 데이터 밖은 의미가 없다). */
export function panViewport(
  viewport: Viewport,
  bounds: Viewport,
  deltaMs: number,
  minSpanMs: number = MIN_VIEWPORT_MS,
): Viewport {
  return clampViewport(
    { startMs: viewport.startMs + deltaMs, endMs: viewport.endMs + deltaMs },
    bounds,
    minSpanMs,
  );
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}


/** UTC ms → KST dateKey(YYYY-MM-DD). */
function kstDateKey(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 누적 주문 계열 — **일 경계 값의 정본은 서버 일별 `cumulativeOrders` 다.**
 * 버킷은 일 **내부**의 분해에만 쓴다: 각 날의 시작 누계를 서버의 전일 누계에 앵커하고
 * 그 위에 그 날 버킷 증분을 쌓는다.
 *
 * ⛔ **버킷에서 자체 누계를 만들지 말 것**(실결함 2026-08-02). 백필 퇴행 가드가 건너뛴
 * 「기록 없음」 날짜들의 실주문이 누계에서 통째로 빠져, 창 앞쪽에 구멍이 있는 캠페인의
 * 누적선이 0 부터 시작했다. 서버 일별 누계는 dailyAggregate 경유라 그 구간도 정확하다
 * (P7 「정확한 건수의 정본은 일별, 인트라데이는 모양 판독용」).
 *
 * - 기록 없는 칸(null)은 null 로 남긴다 — 그 구간의 누계를 이어 그리면 "그동안 아무 일도
 *   없었다"는 거짓 주장이 된다(렌더러가 `splitSegments` 로 끊어 그린다).
 * - 전일이 서버 맵에 없으면(90일 캡 경계 등) 계산 종값을 이월한다.
 * - 그룹 합성 버킷은 카운트만 담아 중복 제거가 불가능하므로 일 내부 증분 합이 서버 일계와
 *   어긋날 수 있다 — **다음 날 앵커가 그 오차를 흡수**해 일 경계는 항상 정본으로 돌아온다.
 */
export function buildAnchoredCumulativeSeries(
  grid: GridPoint[],
  cumulativeByDate: ReadonlyMap<string, number>,
): Array<number | null> {
  let anchor = 0;
  let withinDay = 0;
  let currentDay: string | null = null;
  return grid.map((point) => {
    const day = kstDateKey(point.startMs);
    if (day !== currentDay) {
      anchor = currentDay === null ? 0 : (cumulativeByDate.get(currentDay) ?? anchor + withinDay);
      withinDay = 0;
      currentDay = day;
    }
    if (point.orders === null) return null;
    withinDay += point.orders;
    return anchor + withinDay;
  });
}

export type AxisScale = {
  /** 값 → 0(바닥) ~ 1(천장) 정규화. */
  normalize: (value: number) => number;
  min: number;
  max: number;
};

/**
 * 속도축 — 0 부터 시작한다(활동량은 절대량이라 바닥이 0이어야 크기 비교가 성립).
 * 가시 구간 최댓값이 플롯의 RATE_FILL 만큼 차도록 천장을 잡는다.
 */
export function resolveRateScale(visibleValues: number[]): AxisScale {
  const max = visibleValues.length > 0 ? Math.max(...visibleValues) : 0;
  const ceiling = max > 0 ? max / RATE_FILL : 1;
  return { min: 0, max: ceiling, normalize: (v) => (ceiling <= 0 ? 0 : v / ceiling) };
}

/**
 * 누적축 — **가시 구간의 최소~최대로 리스케일한다**(확정 설계).
 * 전체 범위로 고정하면 확대해도 기울기 변화가 납작하게 보여 확대가 무의미해진다.
 * 구간 내 변화가 0이면(주문이 없던 구간) 납작한 선이 되도록 폭 1을 준다.
 */
export function resolveCumulativeScale(visibleValues: number[]): AxisScale {
  if (visibleValues.length === 0) return { min: 0, max: 1, normalize: () => 0 };
  const min = Math.min(...visibleValues);
  const max = Math.max(...visibleValues);
  const span = max - min;
  const ceiling = span > 0 ? min + span / CUMULATIVE_FILL : min + 1;
  return {
    min,
    max: ceiling,
    normalize: (v) => (ceiling - min <= 0 ? 0 : (v - min) / (ceiling - min)),
  };
}

/**
 * 캔버스 폭에 맞춰 다운샘플 — 열당 1점 미만이면 그리는 의미가 없고 좌표 계산만 늘어난다.
 * 각 화면 열의 **최댓값**을 남긴다(평균이면 좁은 봉우리가 사라진다 — 이 차트의 목적이
 * "가파르게 움직이는 지점 찾기"이므로 봉우리 보존이 평균보다 중요하다).
 */
export function downsampleMax(values: number[], targetCount: number): number[] {
  if (targetCount <= 0) return [];
  if (values.length <= targetCount) return [...values];
  const out: number[] = [];
  const step = values.length / targetCount;
  for (let i = 0; i < targetCount; i += 1) {
    const from = Math.floor(i * step);
    const to = Math.min(values.length, Math.floor((i + 1) * step));
    let peak = values[from] ?? 0;
    for (let j = from + 1; j < to; j += 1) peak = Math.max(peak, values[j]);
    out.push(peak);
  }
  return out;
}

export type MarkerInput = { id: string; timeMs: number };

export type MarkerCluster<T extends MarkerInput> = {
  /** 클러스터 대표 시각(구성원 평균) — 화면 위치 계산용. */
  timeMs: number;
  members: T[];
};

/**
 * 화면 거리 기준 마커 클러스터링 — 임계 안에 들어온 마커를 묶는다.
 * **줌 연동이다**: toX 가 현재 뷰포트 기준이므로 확대하면 임계가 시간상 좁아져 자연히 풀린다
 * (별도 펼치기 버튼 불요 — 확정 설계).
 */
export function clusterMarkers<T extends MarkerInput>(
  markers: T[],
  toX: (timeMs: number) => number,
  thresholdPx: number = MARKER_CLUSTER_PX,
): MarkerCluster<T>[] {
  const sorted = [...markers].sort((a, b) => a.timeMs - b.timeMs);
  const clusters: MarkerCluster<T>[] = [];
  for (const marker of sorted) {
    const last = clusters[clusters.length - 1];
    // ⚠️ 비교 기준은 **직전 구성원**이지 클러스터 대표 시각(평균)이 아니다. 평균과 비교하면
    // 구성원이 늘수록 대표가 뒤로 밀려 **바로 옆 마커가 임계 밖으로 튕긴다** — 12.5px 간격으로
    // 늘어선 3개가 2개+1개로 갈리는 것을 테스트가 잡았다. 인접 간격 사슬이 올바른 판정이다.
    const previous = last?.members[last.members.length - 1];
    if (last && previous && Math.abs(toX(marker.timeMs) - toX(previous.timeMs)) <= thresholdPx) {
      last.members.push(marker);
      // 대표 시각은 구성원 평균 — 묶음이 자기 구성원들의 가운데에 놓인다(배치 전용).
      last.timeMs = last.members.reduce((sum, m) => sum + m.timeMs, 0) / last.members.length;
      continue;
    }
    clusters.push({ timeMs: marker.timeMs, members: [marker] });
  }
  return clusters;
}

export type HourlyCell = {
  /** KST 0~23 시. */
  hour: number;
  orders: number;
  revenue: number;
};

/**
 * 보조뷰 C-1 — 가시 구간의 1시간 히트맵. 색만으로는 추이가 약해 **숫자를 병기**하므로
 * 매출도 함께 돌려준다(확정 설계).
 */
export function buildHourlyCells(
  points: Array<{ startMs: number; orders: number; revenue: number }>,
  viewport: Viewport,
): HourlyCell[] {
  const cells: HourlyCell[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    orders: 0,
    revenue: 0,
  }));
  for (const point of points) {
    if (point.startMs < viewport.startMs || point.startMs >= viewport.endMs) continue;
    const hour = new Date(point.startMs + KST_OFFSET_MS).getUTCHours();
    cells[hour].orders += point.orders;
    cells[hour].revenue += point.revenue;
  }
  return cells;
}

/** 10분 버킷 폭(ms) — 저장 형식과 같은 값(daily-aggregate 의 INTRADAY_BUCKET_MINUTES). */
export const BUCKET_MS = 10 * 60 * 1000;

/**
 * 격자 1칸. `orders: null` = **기록이 없는 구간**(그 날의 버킷이 아직 안 채워짐)이고
 * `orders: 0` = **그 시간에 주문이 없었다**는 사실이다. 이 둘을 절대 합치지 말 것.
 */
export type GridPoint = { startMs: number; orders: number | null; revenue: number };

const KST_DAY_MS = 24 * 60 * 60 * 1000;

/** dateKey(YYYY-MM-DD KST) → 그 날의 [시작, 끝) UTC ms 구간. */
export function kstDayRange(dateKey: string): { startMs: number; endMs: number } | null {
  const parsed = Date.parse(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return null;
  const startMs = parsed - KST_OFFSET_MS;
  return { startMs, endMs: startMs + KST_DAY_MS };
}

/**
 * 희소 점 열 → **균일 격자**로 채운다.
 *
 * ⚠️ 격자가 없으면 두 가지가 동시에 틀어진다(dev 실측):
 * ① 인덱스 기준으로 x 를 잡으면 **주문 없는 시간대가 통째로 압축**돼 곡선이 시각축과 어긋난다.
 * ② 이동평균이 **시간 간격을 건너뛰며** 평균해 "10분 평균"이 아니라 "이벤트 N개 평균"이 된다.
 *
 * ⚠️⚠️ 그리고 **빈 칸을 무조건 0 으로 채우면 안 된다.** 버킷이 아직 없는 날(백필 전 구간)이
 * 데이터 있는 날들 **사이에** 끼면 그 날이 "주문 0건"으로 위조된다 — 실제 프로덕션 상태가
 * 그렇다(마감 캠페인 구간 18일이 구멍). 그래서 `missingDayKeys` 로 받은 날짜는 `null` 로
 * 남기고, 렌더러가 그 구간을 **끊어서** 그린다.
 */
export function densifyPoints<T extends { startMs: number; orders: number; revenue: number }>(
  points: T[],
  bucketMs: number = BUCKET_MS,
  missingDayKeys: string[] = [],
  /**
   * 격자를 펼 시간 범위(옵션). **기본값(첫 점~끝 점)을 그대로 쓰면 버킷이 늦게 시작하는
   * 캠페인에서 앞 구간이 통째로 잘린다** — 실사고: 창은 07-12 부터인데 버킷이 07-16 부터라
   * 콘텐츠 마커 36건 중 32건과 주문 피크가 화면 밖이었다. 호출부는 일별 데이터의 전체 창을
   * 넘겨야 한다.
   */
  range?: { startMs: number; endMs: number },
): GridPoint[] {
  if (points.length === 0 && !range) return [];
  const sorted = [...points].sort((a, b) => a.startMs - b.startMs);
  const first = range ? Math.min(range.startMs, sorted[0]?.startMs ?? range.startMs) : sorted[0].startMs;
  const last = range
    ? Math.max(range.endMs - bucketMs, sorted[sorted.length - 1]?.startMs ?? range.startMs)
    : sorted[sorted.length - 1].startMs;
  const byStart = new Map(sorted.map((p) => [p.startMs, p]));
  const gaps = missingDayKeys
    .map((key) => kstDayRange(key))
    .filter((r): r is { startMs: number; endMs: number } => r !== null);
  const inGap = (t: number) => gaps.some((g) => t >= g.startMs && t < g.endMs);

  const out: GridPoint[] = [];
  for (let t = first; t <= last; t += bucketMs) {
    const hit = byStart.get(t);
    if (hit) {
      out.push({ startMs: t, orders: hit.orders, revenue: hit.revenue });
      continue;
    }
    out.push({ startMs: t, orders: inGap(t) ? null : 0, revenue: 0 });
  }
  return out;
}

/**
 * 격자를 **연속 구간들**로 자른다(기록 없는 칸이 경계). 렌더러는 구간마다 따로 그려
 * 구멍을 이어붙이지 않는다 — 이어 그리면 없는 데이터를 있는 것처럼 보간하게 된다.
 */
export function splitSegments(grid: GridPoint[]): Array<{ from: number; to: number }> {
  const segments: Array<{ from: number; to: number }> = [];
  let start: number | null = null;
  for (let i = 0; i < grid.length; i += 1) {
    const known = grid[i].orders !== null;
    if (known && start === null) start = i;
    if (!known && start !== null) {
      segments.push({ from: start, to: i });
      start = null;
    }
  }
  if (start !== null) segments.push({ from: start, to: grid.length });
  return segments;
}

export type SumColumn = { startMs: number; endMs: number; orders: number };

/**
 * 막대용 열 집계 — 버킷들을 화면 열(≈3px)로 접되 **합산**한다.
 *
 * 곡선의 downsampleMax(봉우리 보존)와 다른 이유: 막대의 계약은 "절대 활동량 보존"이다
 * (v2 1차 확정 — "막대는 절대 활동량을 보존한다", 데모 실측 3px 열 합산). max 를 쓰면
 * 축소할수록 총량이 부풀려 보이고, 평균을 쓰면 좁은 봉우리가 사라진다. 합산이면
 * "보이는 막대의 합 = 그 구간 주문 합"이 어느 배율에서도 성립한다.
 */
export function buildSumColumns(
  points: Array<{ startMs: number; orders: number }>,
  targetCount: number,
  bucketMs: number = BUCKET_MS,
): SumColumn[] {
  if (points.length === 0 || targetCount <= 0) return [];
  if (points.length <= targetCount) {
    return points.map((p) => ({ startMs: p.startMs, endMs: p.startMs + bucketMs, orders: p.orders }));
  }
  const out: SumColumn[] = [];
  const step = points.length / targetCount;
  for (let i = 0; i < targetCount; i += 1) {
    const from = Math.floor(i * step);
    // 마지막 열은 끝을 **명시적으로** points.length 로 잡는다 — `(i+1)*step` 은 수학적으로
    // points.length 지만 부동소수 반올림이 한 점을 삼킬 수 있다(실측: 1000점/998열에서
    // floor 가 999를 줘 합산 보존이 깨졌다 — 코드 리뷰가 잡음).
    const to =
      i === targetCount - 1
        ? points.length
        : Math.max(from + 1, Math.min(points.length, Math.floor((i + 1) * step)));
    let orders = 0;
    for (let j = from; j < to; j += 1) orders += points[j].orders;
    out.push({ startMs: points[from].startMs, endMs: points[to - 1].startMs + bucketMs, orders });
  }
  return out;
}

/** 시각 → 뷰포트 내 0~1 비율. 뷰포트 밖이면 0 미만·1 초과가 나온다(호출부가 자른다). */
export function timeRatio(timeMs: number, viewport: Viewport): number {
  const span = viewport.endMs - viewport.startMs;
  return span <= 0 ? 0 : (timeMs - viewport.startMs) / span;
}

/** 뷰포트에 걸리는 점의 인덱스 구간 [from, to) — 곡선을 자르는 데 쓴다(양끝 1점씩 여유). */
export function visibleIndexRange(
  startMsList: number[],
  viewport: Viewport,
): { from: number; to: number } {
  if (startMsList.length === 0) return { from: 0, to: 0 };
  let from = startMsList.findIndex((t) => t >= viewport.startMs);
  if (from === -1) from = startMsList.length - 1;
  from = Math.max(0, from - 1);
  let to = startMsList.findIndex((t) => t > viewport.endMs);
  if (to === -1) to = startMsList.length;
  to = Math.min(startMsList.length, to + 1);
  return { from, to: Math.max(from + 1, to) };
}
