/**
 * 모바일 캘린더 홈의 월 그리드 날짜 계산 + 캠페인 스팬 바 레인 배치 순수 함수.
 *
 * 레인 배치(assignMonthLanes)는 lramos33/big-calendar(MIT)의
 * calculateMonthEventPositions(src/calendar/helpers.ts)를 참조 이식한 것:
 * 일 단위 점유 배열 + 기간 내림차순 그리디 배정. 원본과의 차이 —
 * date-fns 미사용(네이티브 Date, tremor 전이 의존 직접 참조 금지 규칙),
 * 레인 3→2단 캡(MOBILE_UX_PLAN §4-1), 주 단위 세그먼트 투영(getWeekLaneSegments) 추가.
 */

export type MobileCalendarEvent = {
  id: string;
  /** "YYYY-MM-DD" 또는 ISO 문자열 — 앞 10자리만 로컬 자정 기준으로 해석 */
  startDate: string;
  endDate: string;
};

export type MonthGridDay = {
  date: Date;
  ymd: string;
  inMonth: boolean;
};

export type WeekLaneSegment = {
  event: MobileCalendarEvent;
  lane: number;
  /** 1-based, CSS grid-column 시작(1~7) */
  colStart: number;
  colSpan: number;
  continuesLeft: boolean;
  continuesRight: boolean;
};

export const MAX_EVENT_LANES = 2;

export function parseYmdLocal(value: string): Date {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function toYmd(date: Date): string {
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function dayDiff(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/** 일요일 시작 월 그리드. 앞뒤 달 채움 셀 포함, 주 단위 배열로 반환. */
export function getMonthGridWeeks(year: number, monthIndex: number): MonthGridDay[][] {
  const first = new Date(year, monthIndex, 1);
  const lastDate = new Date(year, monthIndex + 1, 0).getDate();
  const offset = first.getDay();
  const weekCount = Math.ceil((offset + lastDate) / 7);
  const gridStart = addDays(first, -offset);

  const weeks: MonthGridDay[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const week: MonthGridDay[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(gridStart, w * 7 + d);
      week.push({ date, ymd: toYmd(date), inMonth: date.getMonth() === monthIndex });
    }
    weeks.push(week);
  }
  return weeks;
}

/**
 * 월 전체 기준으로 이벤트별 레인(0..MAX_EVENT_LANES-1)을 배정한다.
 * 배정 실패(레인 초과)는 -1 — 주별 "+N" 카운트 대상.
 * 정렬: 기간 내림차순 → 시작일 오름차순 (lramos33 원본과 동일).
 * ponytail: 점유 추적은 해당 월의 날짜만 대상 — 앞뒤 달 채움 셀 구간에서
 * 드물게 시각적 겹침이 생길 수 있음(월 밖 기간은 클램프됨). 필요 시 그리드
 * 전체 범위 점유로 확장하는 것이 업그레이드 경로.
 */
export function assignMonthLanes(
  events: MobileCalendarEvent[],
  year: number,
  monthIndex: number,
  // 모바일은 공간 제약으로 2단 캡(기본값). 데스크톱 캘린더는 세로 여유가 있어
  // 더 많은 레인을 허용하려고 이 값을 상향 주입한다(초과분만 "+N" 오버플로).
  maxLanes: number = MAX_EVENT_LANES,
): Map<string, number> {
  const monthStart = new Date(year, monthIndex, 1);
  const monthEnd = new Date(year, monthIndex + 1, 0);

  const occupied = new Map<string, boolean[]>();
  for (let d = 1; d <= monthEnd.getDate(); d++) {
    occupied.set(toYmd(new Date(year, monthIndex, d)), new Array(maxLanes).fill(false));
  }

  const sorted = [...events].sort((a, b) => {
    const aStart = parseYmdLocal(a.startDate);
    const bStart = parseYmdLocal(b.startDate);
    const aDuration = dayDiff(aStart, parseYmdLocal(a.endDate));
    const bDuration = dayDiff(bStart, parseYmdLocal(b.endDate));
    return bDuration - aDuration || aStart.getTime() - bStart.getTime();
  });

  const lanes = new Map<string, number>();

  for (const event of sorted) {
    const start = parseYmdLocal(event.startDate);
    const end = parseYmdLocal(event.endDate);
    if (end.getTime() < monthStart.getTime() || start.getTime() > monthEnd.getTime()) {
      continue;
    }
    const clampedStart = maxDate(start, monthStart);
    const clampedEnd = minDate(end, monthEnd);
    const dayKeys: string[] = [];
    for (let cursor = clampedStart; cursor.getTime() <= clampedEnd.getTime(); cursor = addDays(cursor, 1)) {
      dayKeys.push(toYmd(cursor));
    }

    let lane = -1;
    for (let i = 0; i < maxLanes; i++) {
      if (dayKeys.every((key) => occupied.get(key)?.[i] === false)) {
        lane = i;
        break;
      }
    }
    if (lane !== -1) {
      for (const key of dayKeys) {
        const slots = occupied.get(key);
        if (slots) slots[lane] = true;
      }
    }
    lanes.set(event.id, lane);
  }

  return lanes;
}

export type WeekSpanUnionSegment = {
  /** 1-based, CSS grid-column 시작(1~7) */
  colStart: number;
  colSpan: number;
  continuesLeft: boolean;
  continuesRight: boolean;
};

/**
 * 한 주(7일)에 겹치는 이벤트들을 "날짜가 겹치는 것끼리" 하나의 스팬으로 병합한다.
 *
 * 모바일 캘린더의 스팬 바는 라벨 없는 배경 필(pill)이라 레인을 나눠 쌓을 세로
 * 공간이 없다 — 레인 세그먼트를 그대로 그리면 CSS grid 자동 배치가 암시적
 * 2행을 만들어 바가 2겹으로 겹쳐 보인다(소유자 신고 버그). 겹치는 구간은
 * union으로 합치고, 날짜가 떨어진 이벤트만 별도 세그먼트로 남긴다(단일 행 보장).
 * 일별 캠페인 개수는 DayCell 점 표시가 담당하므로 정보 손실이 없다.
 */
export function getWeekSpanUnion(
  events: MobileCalendarEvent[],
  week: MonthGridDay[],
): WeekSpanUnionSegment[] {
  const weekStart = week[0].date;
  const weekEnd = week[6].date;

  const clamped: WeekSpanUnionSegment[] = [];
  for (const event of events) {
    const start = parseYmdLocal(event.startDate);
    const end = parseYmdLocal(event.endDate);
    if (end.getTime() < weekStart.getTime() || start.getTime() > weekEnd.getTime()) {
      continue;
    }
    const segStart = maxDate(start, weekStart);
    const segEnd = minDate(end, weekEnd);
    clamped.push({
      colStart: dayDiff(weekStart, segStart) + 1,
      colSpan: dayDiff(segStart, segEnd) + 1,
      continuesLeft: start.getTime() < weekStart.getTime(),
      continuesRight: end.getTime() > weekEnd.getTime(),
    });
  }

  clamped.sort((a, b) => a.colStart - b.colStart);

  const merged: WeekSpanUnionSegment[] = [];
  for (const segment of clamped) {
    const last = merged[merged.length - 1];
    const lastEnd = last ? last.colStart + last.colSpan - 1 : 0;
    // 날짜가 겹칠 때만 병합 — 맞닿기만 한(인접) 별개 일정은 분리 유지.
    if (last && segment.colStart <= lastEnd) {
      const segmentEnd = segment.colStart + segment.colSpan - 1;
      last.colSpan = Math.max(lastEnd, segmentEnd) - last.colStart + 1;
      last.continuesLeft = last.continuesLeft || (segment.colStart === 1 && segment.continuesLeft);
      last.continuesRight = last.continuesRight || (segmentEnd === 7 && segment.continuesRight);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/** 한 주(7일)에 겹치는 이벤트를 레인별 스팬 세그먼트로 투영한다. */
export function getWeekLaneSegments(
  events: MobileCalendarEvent[],
  laneMap: Map<string, number>,
  week: MonthGridDay[],
): { segments: WeekLaneSegment[]; overflowCount: number } {
  const weekStart = week[0].date;
  const weekEnd = week[6].date;

  const segments: WeekLaneSegment[] = [];
  let overflowCount = 0;

  for (const event of events) {
    const start = parseYmdLocal(event.startDate);
    const end = parseYmdLocal(event.endDate);
    if (end.getTime() < weekStart.getTime() || start.getTime() > weekEnd.getTime()) {
      continue;
    }
    const lane = laneMap.get(event.id) ?? -1;
    if (lane === -1) {
      overflowCount += 1;
      continue;
    }
    const segStart = maxDate(start, weekStart);
    const segEnd = minDate(end, weekEnd);
    const colStart = dayDiff(weekStart, segStart) + 1;
    const colSpan = dayDiff(segStart, segEnd) + 1;
    segments.push({
      event,
      lane,
      colStart,
      colSpan,
      continuesLeft: start.getTime() < weekStart.getTime(),
      continuesRight: end.getTime() > weekEnd.getTime(),
    });
  }

  segments.sort((a, b) => a.lane - b.lane || a.colStart - b.colStart);
  return { segments, overflowCount };
}
