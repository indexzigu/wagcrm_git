import { describe, expect, it } from "vitest";
import {
  buildTimelineDays,
  mapAssetMediaType,
  type ContentEvent,
} from "./content-order-correlation";

const KST = 9 * 60 * 60 * 1000;
const dayMs = (dateKey: string) => Date.parse(`${dateKey}T00:00:00.000Z`) - KST; // KST 자정의 UTC ms

function event(partial: Partial<ContentEvent> & { dateKey: string }): ContentEvent {
  return {
    id: partial.id ?? `ev-${partial.dateKey}`,
    source: partial.source ?? "asset",
    type: partial.type ?? "image",
    postedAt: partial.postedAt ?? new Date(dayMs(partial.dateKey) + 10 * 3600_000).toISOString(),
    thumbnailUrl: null,
    permalink: null,
    likeCount: null,
    commentCount: null,
    likesHidden: false,
    ...partial,
  };
}

describe("mapAssetMediaType", () => {
  it("normalizeMediaType 값을 이벤트 유형으로 매핑하고 미지값은 unknown", () => {
    expect(mapAssetMediaType("reel")).toBe("reel");
    expect(mapAssetMediaType("carousel")).toBe("carousel");
    expect(mapAssetMediaType("image")).toBe("image");
    expect(mapAssetMediaType("video")).toBe("video");
    expect(mapAssetMediaType(null)).toBe("unknown");
    expect(mapAssetMediaType("whatever")).toBe("unknown");
  });
});

describe("buildTimelineDays", () => {
  it("창의 모든 KST 날짜를 열거하고 주문 0일도 자리 유지, 이벤트를 날짜에 귀속한다", () => {
    const days = buildTimelineDays({
      windowStartMs: dayMs("2026-07-01"),
      windowEndMs: dayMs("2026-07-03") + 1, // 3일 창
      daily: [{ date: "2026-07-02", orders: 5, revenue: 50000 }],
      events: [event({ dateKey: "2026-07-01", type: "reel" })],
    });
    expect(days.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(days[0].events).toHaveLength(1);
    expect(days[0].orders).toBe(0);
    expect(days[1].orders).toBe(5);
    expect(days[2].events).toHaveLength(0);
  });

  it("창 밖 daily·events는 버린다", () => {
    const days = buildTimelineDays({
      windowStartMs: dayMs("2026-07-01"),
      windowEndMs: dayMs("2026-07-01") + 1,
      daily: [
        { date: "2026-06-30", orders: 9, revenue: 1 },
        { date: "2026-07-01", orders: 2, revenue: 2 },
      ],
      events: [event({ dateKey: "2026-07-05" })],
    });
    expect(days).toHaveLength(1);
    expect(days[0].orders).toBe(2);
    expect(days[0].events).toHaveLength(0);
  });

  it("누적 주문은 표시 구간 기준 단조 누계이고, 마지막 값이 일별 합과 같다", () => {
    const days = buildTimelineDays({
      windowStartMs: dayMs("2026-07-01"),
      windowEndMs: dayMs("2026-07-04") + 1,
      daily: [
        { date: "2026-07-01", orders: 2, revenue: 1 },
        { date: "2026-07-03", orders: 3, revenue: 1 },
        { date: "2026-07-04", orders: 1, revenue: 1 },
      ],
      events: [],
    });
    expect(days.map((d) => d.cumulativeOrders)).toEqual([2, 2, 5, 6]);
    expect(days[days.length - 1].cumulativeOrders).toBe(
      days.reduce((sum, d) => sum + d.orders, 0),
    );
  });

  it("90일 캡으로 잘린 구간은 누계에도 들어가지 않는다(보이는 합 = 마지막 누계)", () => {
    const days = buildTimelineDays({
      windowStartMs: dayMs("2026-01-01"),
      windowEndMs: dayMs("2026-07-01") + 1,
      // 캡 밖(1월)과 캡 안(마지막 날) 각 1건.
      daily: [
        { date: "2026-01-02", orders: 7, revenue: 1 },
        { date: "2026-07-01", orders: 3, revenue: 1 },
      ],
      events: [],
    });
    expect(days[days.length - 1].cumulativeOrders).toBe(3);
  });

  it("창이 90일을 넘으면 최근 90일로 캡한다", () => {
    const days = buildTimelineDays({
      windowStartMs: dayMs("2026-01-01"),
      windowEndMs: dayMs("2026-07-01") + 1,
      daily: [],
      events: [],
    });
    expect(days).toHaveLength(90);
    expect(days[days.length - 1].date).toBe("2026-07-01");
  });
});
