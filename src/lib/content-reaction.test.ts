import { describe, expect, it } from "vitest";

import {
  buildReactionRows,
  groupEventsByTime,
  REACTION_GROUP_SPAN_MS,
  REACTION_WINDOW_MS,
} from "./content-reaction";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
/** 2026-07-08 20:00 KST — 10분 경계 위의 합성 시각. */
const T0 = Date.parse("2026-07-08T20:00:00+09:00");
const iso = (ms: number) => new Date(ms).toISOString();
const ev = (id: string, ms: number) => ({ id, postedAt: iso(ms) });
const pt = (ms: number, orders: number, revenue = orders * 10000) => ({ startMs: ms, orders, revenue });

describe("groupEventsByTime — 표의 한 줄은 줌과 무관한 시간 묶음이다", () => {
  it("첫 발행부터 1시간 안의 콘텐츠를 한 묶음으로 만든다", () => {
    const groups = groupEventsByTime([ev("c", T0 + 50 * MIN), ev("a", T0), ev("b", T0 + 20 * MIN)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(groups[0].postedMs).toBe(T0);
  });

  it("폭은 직전 구성원이 아니라 묶음의 첫 구성원부터 잰다(사슬로 하루가 한 줄이 되지 않게)", () => {
    const chain = Array.from({ length: 13 }, (_, i) => ev(`e${i}`, T0 + i * 10 * MIN));
    const groups = groupEventsByTime(chain);
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups) {
      const last = Date.parse(g.members[g.members.length - 1].postedAt);
      expect(last - g.postedMs).toBeLessThanOrEqual(REACTION_GROUP_SPAN_MS);
    }
  });

  it("발행 시각을 읽을 수 없는 콘텐츠는 버린다", () => {
    expect(groupEventsByTime([{ id: "x", postedAt: "not-a-date" }])).toEqual([]);
  });
});

describe("buildReactionRows — 직전 3시간 → 직후 3시간", () => {
  const nowMs = T0 + 48 * HOUR;

  it("창은 각각 정확히 3시간이고 발행 시각이 든 10분 칸은 직후에 센다", () => {
    const rows = buildReactionRows({
      events: [ev("a", T0 + 7 * MIN)],
      points: [
        pt(T0 - 3 * HOUR - 10 * MIN, 99), // 직전 창 밖
        pt(T0 - 3 * HOUR, 2), // 직전 창 첫 칸
        pt(T0 - 10 * MIN, 3), // 직전 창 마지막 칸
        pt(T0, 5), // 발행 시각(20:07)이 든 칸 → 직후
        pt(T0 + 3 * HOUR - 10 * MIN, 7), // 직후 창 마지막 칸
        pt(T0 + 3 * HOUR, 99), // 직후 창 밖
      ],
      missingDayKeys: [],
      nowMs,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].pivotMs).toBe(T0);
    expect(rows[0].postedMs).toBe(T0 + 7 * MIN);
    expect(rows[0].before).toEqual({ orders: 5, revenue: 50000 });
    expect(rows[0].after).toEqual({ orders: 12, revenue: 120000 });
    expect(rows[0].afterPartial).toBe(false);
    expect(REACTION_WINDOW_MS).toBe(3 * HOUR);
  });

  it("창이 기록 없는 날에 걸리면 그쪽은 null 이다(0건으로 위조하지 않는다)", () => {
    // 20:00 발행 → 직전·직후 모두 07-08 안. 07-08 이 기록 없음이면 둘 다 null.
    const rows = buildReactionRows({
      events: [ev("a", T0)],
      points: [],
      missingDayKeys: ["2026-07-08"],
      nowMs,
    });
    expect(rows[0].before).toBeNull();
    expect(rows[0].after).toBeNull();
  });

  it("자정을 넘는 직후 창은 다음 날이 기록 없음이면 null 이다", () => {
    const lateMs = Date.parse("2026-07-08T23:00:00+09:00");
    const rows = buildReactionRows({
      events: [ev("a", lateMs)],
      points: [pt(lateMs - HOUR, 4)],
      missingDayKeys: ["2026-07-09"],
      nowMs,
    });
    expect(rows[0].before).toEqual({ orders: 4, revenue: 40000 });
    expect(rows[0].after).toBeNull();
  });

  it("직후 창이 아직 안 끝났으면 지금까지만 더하고 afterPartial 로 알린다", () => {
    const rows = buildReactionRows({
      events: [ev("a", T0)],
      points: [pt(T0, 5), pt(T0 + 2 * HOUR, 9)],
      missingDayKeys: [],
      nowMs: T0 + HOUR,
    });
    expect(rows[0].after).toEqual({ orders: 5, revenue: 50000 });
    expect(rows[0].afterPartial).toBe(true);
  });

  it("앞뒤 3시간 안에 다른 묶음의 콘텐츠가 있으면 그 건수를 센다(같은 묶음은 세지 않는다)", () => {
    const rows = buildReactionRows({
      events: [ev("a", T0), ev("a2", T0 + 10 * MIN), ev("b", T0 + 2 * HOUR), ev("z", T0 + 10 * HOUR)],
      points: [],
      missingDayKeys: [],
      nowMs,
    });
    expect(rows.map((r) => r.key)).toEqual(["a", "b", "z"]);
    expect(rows[0].overlapCount).toBe(1); // b
    expect(rows[1].overlapCount).toBe(2); // a, a2
    expect(rows[2].overlapCount).toBe(0);
  });

  it("콘텐츠가 없으면 빈 배열", () => {
    expect(buildReactionRows({ events: [], points: [pt(T0, 1)], missingDayKeys: [], nowMs })).toEqual([]);
  });
});
