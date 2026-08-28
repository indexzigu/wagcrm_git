import { describe, expect, it } from "vitest";

import {
  BUCKET_MS,
  buildAnchoredCumulativeSeries,
  buildSumColumns,
  buildHourlyCells,
  clampViewport,
  kstDayRange,
  clusterMarkers,
  CUMULATIVE_FILL,
  DAY_BUCKET_MS,
  densifyPoints,
  splitSegments,
  downsampleMax,
  MIN_VIEWPORT_MS,
  panViewport,
  resolveMinViewportMs,
  RATE_FILL,
  resolveCumulativeScale,
  resolveRateScale,
  timeRatio,
  visibleIndexRange,
  zoomViewport,
} from "./intraday-chart";

const HOUR = 60 * 60 * 1000;
const bounds = { startMs: 0, endMs: 24 * HOUR };

describe("뷰포트 — 확대·이동·경계", () => {
  it("데이터보다 넓게 확대하면 전체로 고정한다(빈 여백을 만들지 않는다)", () => {
    const v = clampViewport({ startMs: -10 * HOUR, endMs: 40 * HOUR }, bounds);
    expect(v).toEqual(bounds);
  });

  it("최소 폭 아래로는 확대되지 않는다(0 폭 좌표 붕괴 방지)", () => {
    const v = clampViewport({ startMs: 5 * HOUR, endMs: 5 * HOUR + 1000 }, bounds);
    expect(v.endMs - v.startMs).toBe(MIN_VIEWPORT_MS);
  });

  it("경계를 넘겨 이동하면 경계에 붙고 폭은 유지된다", () => {
    const start = { startMs: 20 * HOUR, endMs: 24 * HOUR };
    const moved = panViewport(start, bounds, 10 * HOUR);
    expect(moved.endMs).toBe(bounds.endMs);
    expect(moved.endMs - moved.startMs).toBe(4 * HOUR);
  });

  it("커서 위치를 고정한 채 확대한다 — 그 지점이 제자리에 남는다", () => {
    const before = { startMs: 0, endMs: 24 * HOUR };
    const anchor = 0.25; // 6시 지점
    const anchorMs = before.startMs + (before.endMs - before.startMs) * anchor;
    const after = zoomViewport(before, bounds, anchor, 0.5);
    const anchorMsAfter = after.startMs + (after.endMs - after.startMs) * anchor;
    expect(anchorMsAfter).toBeCloseTo(anchorMs, 0);
    expect(after.endMs - after.startMs).toBe(12 * HOUR);
  });
});

describe("확대 하한 — 버킷 폭 연동(일별 모드 공용)", () => {
  it("10분 버킷이면 종전 2시간 하한 그대로다", () => {
    expect(resolveMinViewportMs(BUCKET_MS)).toBe(MIN_VIEWPORT_MS);
  });

  it("일 버킷이면 2버킷(2일)이 하한이다 — 그 아래로 들어가면 막대 1개만 남는다", () => {
    expect(resolveMinViewportMs(DAY_BUCKET_MS)).toBe(2 * DAY_BUCKET_MS);
  });

  it("clampViewport 는 지정한 최소 폭을 지킨다", () => {
    const wide = { startMs: 0, endMs: 30 * DAY_BUCKET_MS };
    const v = clampViewport({ startMs: 0, endMs: HOUR }, wide, 2 * DAY_BUCKET_MS);
    expect(v.endMs - v.startMs).toBe(2 * DAY_BUCKET_MS);
  });

  it("minSpanMs 를 안 주면 종전 하한(MIN_VIEWPORT_MS)이 그대로 쓰인다", () => {
    const v = clampViewport({ startMs: 5 * HOUR, endMs: 5 * HOUR + 1 }, bounds);
    expect(v.endMs - v.startMs).toBe(MIN_VIEWPORT_MS);
  });

  it("zoomViewport 도 같은 하한에서 멈춘다", () => {
    const wide = { startMs: 0, endMs: 30 * DAY_BUCKET_MS };
    const v = zoomViewport(
      { startMs: 0, endMs: 2 * DAY_BUCKET_MS },
      wide,
      0.5,
      1 / 1.15,
      2 * DAY_BUCKET_MS,
    );
    expect(v.endMs - v.startMs).toBe(2 * DAY_BUCKET_MS);
  });

  it("panViewport 는 폭을 바꾸지 않으므로 하한과 무관하게 폭이 보존된다", () => {
    const wide = { startMs: 0, endMs: 30 * DAY_BUCKET_MS };
    const moved = panViewport({ startMs: 0, endMs: 5 * DAY_BUCKET_MS }, wide, 3 * DAY_BUCKET_MS);
    expect(moved.endMs - moved.startMs).toBe(5 * DAY_BUCKET_MS);
  });
});

describe("축 스케일 — 속도는 0 기준, 누적은 가시 구간 리스케일", () => {
  it("속도축은 0부터이고 최댓값이 지정 비율만큼 찬다", () => {
    const scale = resolveRateScale([0, 3, 9]);
    expect(scale.min).toBe(0);
    expect(scale.normalize(9)).toBeCloseTo(RATE_FILL, 5);
    expect(scale.normalize(0)).toBe(0);
  });

  it("누적축은 가시 구간의 최소~최대로 리스케일한다(전체 고정이면 기울기가 납작해진다)", () => {
    // 700~760 구간만 보이는 상황 — 0부터 그리면 60의 변화가 안 보인다.
    const scale = resolveCumulativeScale([700, 720, 760]);
    expect(scale.min).toBe(700);
    expect(scale.normalize(700)).toBe(0);
    expect(scale.normalize(760)).toBeCloseTo(CUMULATIVE_FILL, 5);
  });

  it("구간 내 변화가 없으면(주문 0 구간) 납작한 선이 되고 0 나눗셈이 나지 않는다", () => {
    const scale = resolveCumulativeScale([500, 500, 500]);
    expect(Number.isFinite(scale.normalize(500))).toBe(true);
    expect(scale.normalize(500)).toBe(0);
  });

  it("빈 구간에서도 스케일이 성립한다", () => {
    expect(resolveRateScale([]).normalize(0)).toBe(0);
    expect(resolveCumulativeScale([]).normalize(0)).toBe(0);
  });
});

describe("누적 계열 — 일 경계는 서버 일별 누계에 앵커한다", () => {
  /** dateKey 의 KST hh 시 지점. */
  const at = (dateKey: string, hour: number) => kstDayRange(dateKey)!.startMs + hour * HOUR;

  it("일 내부에서는 버킷 증분을 쌓는다(첫날 앵커는 0)", () => {
    const grid = [
      { startMs: at("2026-07-14", 10), orders: 2, revenue: 0 },
      { startMs: at("2026-07-14", 12), orders: 1, revenue: 0 },
    ];
    expect(buildAnchoredCumulativeSeries(grid, new Map([["2026-07-14", 3]]))).toEqual([2, 3]);
  });

  it("⛔ 기록 없는 날의 실주문이 누계에서 빠지지 않는다 — 서버 전일 누계가 다음 날의 시작값", () => {
    // 1일차는 버킷이 없지만(백필 퇴행 가드가 건너뛴 날) 서버 일별 누계는 50 이다.
    // 버킷 자체 누계였다면 2일차가 3,5 로 그려져 50건이 통째로 증발한다(실결함 2026-08-02).
    const grid = [
      { startMs: at("2026-07-13", 10), orders: null, revenue: 0 },
      { startMs: at("2026-07-14", 10), orders: 3, revenue: 0 },
      { startMs: at("2026-07-14", 11), orders: 2, revenue: 0 },
    ];
    const cumulative = new Map([
      ["2026-07-13", 50],
      ["2026-07-14", 55],
    ]);
    expect(buildAnchoredCumulativeSeries(grid, cumulative)).toEqual([null, 53, 55]);
  });

  it("기록 없는 칸은 null 로 남고, 구멍 뒤에서 서버 값에 재정렬된다", () => {
    const grid = [
      { startMs: at("2026-07-14", 10), orders: 1, revenue: 0 },
      { startMs: at("2026-07-15", 10), orders: null, revenue: 0 },
      { startMs: at("2026-07-16", 10), orders: 4, revenue: 0 },
    ];
    const cumulative = new Map([
      ["2026-07-14", 1],
      ["2026-07-15", 9],
      ["2026-07-16", 13],
    ]);
    expect(buildAnchoredCumulativeSeries(grid, cumulative)).toEqual([1, null, 13]);
  });

  it("일 버킷(일별 모드)이면 서버 누계와 정확히 일치한다 — 두 모드가 같은 함수를 쓴다", () => {
    const grid = [
      { startMs: at("2026-07-14", 0), orders: 3, revenue: 0 },
      { startMs: at("2026-07-15", 0), orders: 0, revenue: 0 },
      { startMs: at("2026-07-16", 0), orders: 5, revenue: 0 },
    ];
    const cumulative = new Map([
      ["2026-07-14", 3],
      ["2026-07-15", 3],
      ["2026-07-16", 8],
    ]);
    expect(buildAnchoredCumulativeSeries(grid, cumulative)).toEqual([3, 3, 8]);
  });

  it("서버 누계에 없는 전일은 계산 종값을 이월한다(90일 캡 경계 등)", () => {
    const grid = [
      { startMs: at("2026-07-15", 10), orders: 2, revenue: 0 },
      { startMs: at("2026-07-16", 10), orders: 1, revenue: 0 },
    ];
    expect(buildAnchoredCumulativeSeries(grid, new Map())).toEqual([2, 3]);
  });

  it("빈 격자에서 무너지지 않는다", () => {
    expect(buildAnchoredCumulativeSeries([], new Map())).toEqual([]);
  });
});

describe("다운샘플 — 봉우리를 남긴다", () => {
  it("열당 최댓값을 남긴다(평균이면 좁은 봉우리가 사라진다)", () => {
    const values = [0, 0, 9, 0, 0, 0, 1, 0];
    const out = downsampleMax(values, 2);
    expect(out).toEqual([9, 1]);
  });

  it("점이 목표보다 적으면 그대로 둔다", () => {
    expect(downsampleMax([1, 2], 10)).toEqual([1, 2]);
  });
});

describe("마커 클러스터링 — 화면 거리 기준·줌 연동", () => {
  const markers = [
    { id: "a", timeMs: 0 },
    { id: "b", timeMs: 30 * 60 * 1000 },
    { id: "c", timeMs: 60 * 60 * 1000 },
    { id: "z", timeMs: 20 * HOUR },
  ];

  /** 24시간을 600px 에 그리는 축소 뷰 — 1시간 ≈ 25px. */
  const wideX = (t: number) => (t / (24 * HOUR)) * 600;
  /** 3시간을 600px 에 그리는 확대 뷰 — 1시간 = 200px. */
  const zoomX = (t: number) => (t / (3 * HOUR)) * 600;

  it("축소하면 가까운 마커가 묶이고 +N 이 된다", () => {
    const clusters = clusterMarkers(markers, wideX);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].members.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(clusters[1].members.map((m) => m.id)).toEqual(["z"]);
  });

  it("확대하면 같은 마커가 개별로 풀린다(별도 펼치기 버튼 불요)", () => {
    const clusters = clusterMarkers(markers, zoomX);
    expect(clusters.filter((c) => c.members.length > 1)).toHaveLength(0);
  });

  it("클러스터 대표 시각은 구성원 평균이다", () => {
    const clusters = clusterMarkers(markers, wideX);
    const avg = (0 + 30 * 60 * 1000 + 60 * 60 * 1000) / 3;
    expect(clusters[0].timeMs).toBeCloseTo(avg, 0);
  });
});

describe("보조뷰 — 1시간 히트맵", () => {
  it("가시 구간의 점만 KST 시간대로 접는다", () => {
    const kst = (h: number) => Date.parse(`2026-07-08T${String(h).padStart(2, "0")}:00:00+09:00`);
    const points = [
      { startMs: kst(9), orders: 2, revenue: 1000 },
      { startMs: kst(9) + 10 * 60 * 1000, orders: 1, revenue: 500 },
      { startMs: kst(21), orders: 5, revenue: 9000 },
    ];
    const cells = buildHourlyCells(points, { startMs: kst(0), endMs: kst(23) });
    expect(cells).toHaveLength(24);
    expect(cells[9]).toEqual({ hour: 9, orders: 3, revenue: 1500 });
    expect(cells[21]).toEqual({ hour: 21, orders: 5, revenue: 9000 });
    expect(cells[0].orders).toBe(0);
  });

  it("뷰포트 밖 점은 세지 않는다(보조뷰가 메인 차트와 같은 구간을 말해야 한다)", () => {
    const kst = (h: number) => Date.parse(`2026-07-08T${String(h).padStart(2, "0")}:00:00+09:00`);
    const points = [
      { startMs: kst(9), orders: 2, revenue: 1000 },
      { startMs: kst(21), orders: 5, revenue: 9000 },
    ];
    const cells = buildHourlyCells(points, { startMs: kst(8), endMs: kst(12) });
    expect(cells[9].orders).toBe(2);
    expect(cells[21].orders).toBe(0);
  });
});

describe("좌표 헬퍼", () => {
  it("timeRatio 는 뷰포트 내 위치를 0~1 로 준다", () => {
    const v = { startMs: 0, endMs: 10 * HOUR };
    expect(timeRatio(0, v)).toBe(0);
    expect(timeRatio(5 * HOUR, v)).toBe(0.5);
    expect(timeRatio(10 * HOUR, v)).toBe(1);
  });

  it("visibleIndexRange 는 양끝에 1점씩 여유를 둬 곡선이 잘린 것처럼 보이지 않게 한다", () => {
    const times = [0, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR];
    const { from, to } = visibleIndexRange(times, { startMs: 2 * HOUR, endMs: 3 * HOUR });
    expect(from).toBeLessThanOrEqual(1);
    expect(to).toBeGreaterThanOrEqual(4);
  });

  it("점이 없어도 무너지지 않는다", () => {
    expect(visibleIndexRange([], { startMs: 0, endMs: HOUR })).toEqual({ from: 0, to: 0 });
  });
});

describe("희소 → 균일 격자(densifyPoints)", () => {
  it("빠진 버킷을 0으로 채워 시간 간격이 보존된다", () => {
    const base = Date.parse("2026-07-08T10:00:00+09:00");
    const points = [
      { startMs: base, orders: 2, revenue: 1000 },
      // 30분(=3버킷) 뒤 — 사이 2칸이 비어 있다.
      { startMs: base + 3 * BUCKET_MS, orders: 1, revenue: 500 },
    ];
    const dense = densifyPoints(points);
    expect(dense.map((p) => p.orders)).toEqual([2, 0, 0, 1]);
    expect(dense.map((p) => p.startMs - base)).toEqual([0, BUCKET_MS, 2 * BUCKET_MS, 3 * BUCKET_MS]);
  });

  it("총합은 보존된다(0 채움이 값을 만들어내지 않는다)", () => {
    const base = Date.parse("2026-07-08T10:00:00+09:00");
    const points = [
      { startMs: base, orders: 2, revenue: 1000 },
      { startMs: base + 10 * BUCKET_MS, orders: 5, revenue: 700 },
    ];
    const dense = densifyPoints(points);
    expect(dense.reduce((s, p) => s + (p.orders ?? 0), 0)).toBe(7);
    expect(dense.reduce((s, p) => s + p.revenue, 0)).toBe(1700);
  });

  it("⛔ 기록 없는 날은 0 이 아니라 null 이다 — '주문 0건'으로 위조하지 않는다", () => {
    const d8 = Date.parse("2026-07-08T10:00:00+09:00");
    const d10 = Date.parse("2026-07-10T10:00:00+09:00");
    const dense = densifyPoints(
      [
        { startMs: d8, orders: 2, revenue: 1000 },
        { startMs: d10, orders: 3, revenue: 2000 },
      ],
      BUCKET_MS,
      ["2026-07-09"], // 이 날은 버킷이 아직 없다
    );
    const day9 = dense.filter(
      (p) => p.startMs >= Date.parse("2026-07-09T00:00:00+09:00") &&
        p.startMs < Date.parse("2026-07-10T00:00:00+09:00"),
    );
    expect(day9.length).toBeGreaterThan(0);
    expect(day9.every((p) => p.orders === null)).toBe(true);
    // 기록이 있는 날의 빈 칸은 여전히 진짜 0 이다(둘을 합치지 않는다).
    const day8Empty = dense.filter(
      (p) => p.startMs > d8 && p.startMs < Date.parse("2026-07-09T00:00:00+09:00"),
    );
    expect(day8Empty.every((p) => p.orders === 0)).toBe(true);
  });

  it("빈 입력·단일 점에서도 무너지지 않는다", () => {
    expect(densifyPoints([])).toEqual([]);
    expect(densifyPoints([{ startMs: 1000, orders: 1, revenue: 1 }])).toHaveLength(1);
  });

});

describe("구간 분할(splitSegments) — 구멍을 이어붙이지 않는다", () => {
  it("기록 없는 칸을 경계로 연속 구간을 나눈다", () => {
    const grid = [
      { startMs: 0, orders: 1, revenue: 0 },
      { startMs: 1, orders: 0, revenue: 0 },
      { startMs: 2, orders: null, revenue: 0 },
      { startMs: 3, orders: null, revenue: 0 },
      { startMs: 4, orders: 2, revenue: 0 },
    ];
    expect(splitSegments(grid)).toEqual([
      { from: 0, to: 2 },
      { from: 4, to: 5 },
    ]);
  });

  it("구멍이 없으면 구간은 하나다", () => {
    const grid = [
      { startMs: 0, orders: 1, revenue: 0 },
      { startMs: 1, orders: 0, revenue: 0 },
    ];
    expect(splitSegments(grid)).toEqual([{ from: 0, to: 2 }]);
  });

  it("전부 기록 없음이면 그릴 구간이 없다", () => {
    expect(splitSegments([{ startMs: 0, orders: null, revenue: 0 }])).toEqual([]);
  });
});

describe("막대 열 집계(buildSumColumns) — 절대 활동량 보존", () => {
  const pts = (orders: number[]) => orders.map((o, i) => ({ startMs: i * BUCKET_MS, orders: o }));

  it("열 합의 총합 = 원본 총합 (max 처럼 부풀리지도, 평균처럼 봉우리를 지우지도 않는다)", () => {
    const values = [0, 5, 0, 0, 3, 0, 0, 0, 7, 1];
    const cols = buildSumColumns(pts(values), 3);
    expect(cols.reduce((s, c) => s + c.orders, 0)).toBe(values.reduce((s, v) => s + v, 0));
    expect(cols).toHaveLength(3);
  });

  it("점이 목표보다 적으면 버킷 그대로 1:1 (폭 = 버킷 폭)", () => {
    const cols = buildSumColumns(pts([2, 3]), 10);
    expect(cols).toHaveLength(2);
    expect(cols[0]).toEqual({ startMs: 0, endMs: BUCKET_MS, orders: 2 });
  });

  it("열의 시간 범위가 이어진다(빈 화면 틈 없음)", () => {
    const cols = buildSumColumns(pts([1, 1, 1, 1, 1, 1]), 2);
    expect(cols[0].endMs).toBe(cols[1].startMs);
  });

  it("빈 입력·0 목표에서 무너지지 않는다", () => {
    expect(buildSumColumns([], 5)).toEqual([]);
    expect(buildSumColumns(pts([1]), 0)).toEqual([]);
  });

  it("점수≈열수 비율에서 부동소수 반올림이 마지막 점을 삼키지 않는다(리뷰 실측 회귀)", () => {
    // step = 1000/998 — floor((998)*step) 가 999 로 떨어져 마지막 점이 유실되던 케이스.
    const values = Array.from({ length: 1000 }, () => 1);
    const cols = buildSumColumns(pts(values), 998);
    expect(cols.reduce((s, c) => s + c.orders, 0)).toBe(1000);
    expect(cols[cols.length - 1].endMs).toBe(1000 * BUCKET_MS);
  });
});

describe("densifyPoints range — 버킷보다 넓은 창", () => {
  it("창이 버킷보다 앞서 시작하면 그 앞 구간도 격자에 들어간다(마커 잘림 방지)", () => {
    const base = Date.parse("2026-07-16T00:00:00+09:00");
    const windowStart = Date.parse("2026-07-12T00:00:00+09:00");
    const dense = densifyPoints(
      [{ startMs: base, orders: 2, revenue: 100 }],
      BUCKET_MS,
      ["2026-07-13"],
      { startMs: windowStart, endMs: base + BUCKET_MS },
    );
    expect(dense[0].startMs).toBe(windowStart);
    // 기록 없다고 표시된 날은 null, 나머지 앞 구간은 0(일별이 0이라 말할 수 있는 날).
    const day13 = dense.filter((p) => p.startMs >= Date.parse("2026-07-13T00:00:00+09:00") && p.startMs < Date.parse("2026-07-14T00:00:00+09:00"));
    expect(day13.every((p) => p.orders === null)).toBe(true);
    expect(dense[dense.length - 1].orders).toBe(2);
  });

  it("점이 하나도 없어도 range 만으로 격자가 선다", () => {
    const start = Date.parse("2026-07-12T00:00:00+09:00");
    const dense = densifyPoints([], BUCKET_MS, [], { startMs: start, endMs: start + 3 * BUCKET_MS });
    expect(dense).toHaveLength(3);
  });
});
