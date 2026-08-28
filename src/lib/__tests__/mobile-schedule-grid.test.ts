import { describe, expect, it } from "vitest";
import {
  assignMonthLanes,
  getMonthGridWeeks,
  getWeekLaneSegments,
  getWeekSpanUnion,
  MAX_EVENT_LANES,
  type MobileCalendarEvent,
} from "../mobile-schedule-grid";

function event(id: string, startDate: string, endDate: string): MobileCalendarEvent {
  return { id, startDate, endDate };
}

const YEAR = 2026;
const JULY = 6;

describe("getMonthGridWeeks", () => {
  it("builds July 2026 as 5 sunday-start weeks with leading/trailing fill", () => {
    const weeks = getMonthGridWeeks(YEAR, JULY);
    expect(weeks).toHaveLength(5);
    expect(weeks[0][0].ymd).toBe("2026-06-28");
    expect(weeks[0][0].inMonth).toBe(false);
    expect(weeks[0][3].ymd).toBe("2026-07-01");
    expect(weeks[0][3].inMonth).toBe(true);
    expect(weeks[1][3].ymd).toBe("2026-07-08");
    expect(weeks[4][6].ymd).toBe("2026-08-01");
    expect(weeks[4][6].inMonth).toBe(false);
  });

  it("handles a month starting on sunday without a leading fill week", () => {
    const weeks = getMonthGridWeeks(2026, 2);
    expect(weeks[0][0].ymd).toBe("2026-03-01");
    expect(weeks[0][0].inMonth).toBe(true);
  });
});

describe("assignMonthLanes", () => {
  it("prefers longer events for lower lanes and overflows beyond the cap", () => {
    const long = event("long", "2026-07-01", "2026-07-10");
    const mid = event("mid", "2026-07-05", "2026-07-11");
    const short = event("short", "2026-07-07", "2026-07-09");
    const lanes = assignMonthLanes([short, mid, long], YEAR, JULY);
    expect(lanes.get("long")).toBe(0);
    expect(lanes.get("mid")).toBe(1);
    expect(lanes.get("short")).toBe(-1);
    expect(MAX_EVENT_LANES).toBe(2);
  });

  it("maxLanes 상향 주입 시 기본 캡을 넘겨 오버플로 없이 배정한다(데스크톱 캘린더)", () => {
    const long = event("long", "2026-07-01", "2026-07-10");
    const mid = event("mid", "2026-07-05", "2026-07-11");
    const short = event("short", "2026-07-07", "2026-07-09");
    const lanes = assignMonthLanes([short, mid, long], YEAR, JULY, 6);
    expect(lanes.get("long")).toBe(0);
    expect(lanes.get("mid")).toBe(1);
    expect(lanes.get("short")).toBe(2); // 기본 캡(2)이면 -1이었을 것
  });

  it("reuses a lane once earlier events end", () => {
    const first = event("first", "2026-07-01", "2026-07-03");
    const second = event("second", "2026-07-04", "2026-07-06");
    const lanes = assignMonthLanes([first, second], YEAR, JULY);
    expect(lanes.get("first")).toBe(0);
    expect(lanes.get("second")).toBe(0);
  });

  it("clamps events crossing the month boundary instead of dropping them", () => {
    const crossing = event("crossing", "2026-06-25", "2026-07-02");
    const lanes = assignMonthLanes([crossing], YEAR, JULY);
    expect(lanes.get("crossing")).toBe(0);
  });

  it("skips events with no overlap with the month", () => {
    const outside = event("outside", "2026-08-02", "2026-08-05");
    const lanes = assignMonthLanes([outside], YEAR, JULY);
    expect(lanes.has("outside")).toBe(false);
  });
});

describe("getWeekLaneSegments", () => {
  const weeks = getMonthGridWeeks(YEAR, JULY);

  it("projects an event onto grid columns with continuation flags", () => {
    const spanning = event("spanning", "2026-07-01", "2026-07-10");
    const lanes = assignMonthLanes([spanning], YEAR, JULY);

    const week1 = getWeekLaneSegments([spanning], lanes, weeks[0]);
    expect(week1.segments).toHaveLength(1);
    expect(week1.segments[0]).toMatchObject({
      colStart: 4,
      colSpan: 4,
      continuesLeft: false,
      continuesRight: true,
    });

    const week2 = getWeekLaneSegments([spanning], lanes, weeks[1]);
    expect(week2.segments[0]).toMatchObject({
      colStart: 1,
      colSpan: 6,
      continuesLeft: true,
      continuesRight: false,
    });
  });

  it("renders single-day events as one-column segments", () => {
    const single = event("single", "2026-07-15", "2026-07-15");
    const lanes = assignMonthLanes([single], YEAR, JULY);
    const week3 = getWeekLaneSegments([single], lanes, weeks[2]);
    expect(week3.segments[0]).toMatchObject({ colStart: 4, colSpan: 1, lane: 0 });
  });

  it("counts lane overflow per overlapping week as +N", () => {
    const a = event("a", "2026-07-20", "2026-07-23");
    const b = event("b", "2026-07-20", "2026-07-22");
    const c = event("c", "2026-07-21", "2026-07-22");
    const d = event("d", "2026-07-21", "2026-07-21");
    const all = [a, b, c, d];
    const lanes = assignMonthLanes(all, YEAR, JULY);

    const week4 = getWeekLaneSegments(all, lanes, weeks[3]);
    expect(week4.segments).toHaveLength(2);
    expect(week4.overflowCount).toBe(2);

    const week5 = getWeekLaneSegments(all, lanes, weeks[4]);
    expect(week5.segments).toHaveLength(0);
    expect(week5.overflowCount).toBe(0);
  });

  it("keeps a stable lane for the same event across weeks", () => {
    const long = event("long", "2026-07-01", "2026-07-10");
    const mid = event("mid", "2026-07-05", "2026-07-11");
    const lanes = assignMonthLanes([long, mid], YEAR, JULY);
    const w1 = getWeekLaneSegments([long, mid], lanes, weeks[0]);
    const w2 = getWeekLaneSegments([long, mid], lanes, weeks[1]);
    expect(w1.segments.find((s) => s.event.id === "long")?.lane).toBe(0);
    expect(w2.segments.find((s) => s.event.id === "long")?.lane).toBe(0);
    expect(w2.segments.find((s) => s.event.id === "mid")?.lane).toBe(1);
  });
});

describe("getWeekSpanUnion (스팬 바 2겹 겹침 버그 회귀)", () => {
  const weeks = getMonthGridWeeks(YEAR, JULY);
  // weeks[1] = 2026-07-05(일) ~ 2026-07-11(토)

  it("날짜가 겹치는 이벤트를 하나의 세그먼트로 병합한다", () => {
    const merged = getWeekSpanUnion(
      [event("a", "2026-07-06", "2026-07-08"), event("b", "2026-07-07", "2026-07-10")],
      weeks[1],
    );
    expect(merged).toEqual([
      { colStart: 2, colSpan: 5, continuesLeft: false, continuesRight: false },
    ]);
  });

  it("맞닿기만 한(인접) 이벤트는 별도 세그먼트로 유지한다", () => {
    const merged = getWeekSpanUnion(
      [event("a", "2026-07-06", "2026-07-07"), event("b", "2026-07-08", "2026-07-10")],
      weeks[1],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ colStart: 2, colSpan: 2 });
    expect(merged[1]).toMatchObject({ colStart: 4, colSpan: 3 });
  });

  it("주 경계를 넘는 이벤트는 클램프하고 continues 플래그를 병합에 보존한다", () => {
    const merged = getWeekSpanUnion(
      [event("a", "2026-07-01", "2026-07-08"), event("b", "2026-07-07", "2026-07-14")],
      weeks[1],
    );
    expect(merged).toEqual([
      { colStart: 1, colSpan: 7, continuesLeft: true, continuesRight: true },
    ]);
  });

  it("주와 무관한 이벤트는 제외하고, 입력 순서와 무관하게 colStart 오름차순으로 정렬한다", () => {
    const merged = getWeekSpanUnion(
      [
        event("later", "2026-07-09", "2026-07-10"),
        event("earlier", "2026-07-05", "2026-07-06"),
        event("outside", "2026-07-20", "2026-07-22"),
      ],
      weeks[1],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ colStart: 1, colSpan: 2 });
    expect(merged[1]).toMatchObject({ colStart: 5, colSpan: 2 });
  });
});
