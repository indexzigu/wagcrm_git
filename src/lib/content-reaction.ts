// 콘텐츠별 반응 — 발행 직전/직후 창의 주문·매출 합. 순수 계산이다(prisma·fetch 없음).
// 설계 정본: docs/private/specs/2026-07-25-content-order-correlation-design.md 「개정(2026-09-18)」.
//
// ⛔ 합산 원천은 **10분 원본 버킷**이다. 화면 막대는 ≈3px 합산 열이라 줌마다 값이 달라지므로
// 표가 막대를 읽으면 같은 콘텐츠의 숫자가 확대할 때마다 바뀐다.
// ⛔ 이 모듈은 인과를 말하지 않는다 — 앞뒤 건수만 낸다(배수·증감률 필드를 추가하지 말 것).
import { BUCKET_MS, kstDayRange } from "@/lib/intraday-chart";

/** 반응 창 — 오너 확정 2026-09-18(1시간·24시간은 검토 후 미채택). */
export const REACTION_WINDOW_MS = 3 * 60 * 60 * 1000;
/** 표의 한 줄로 묶는 폭 — 묶음 **첫 구성원**부터 잰다. */
export const REACTION_GROUP_SPAN_MS = 60 * 60 * 1000;

export type ReactionPoint = { startMs: number; orders: number; revenue: number };
export type ReactionEventInput = { id: string; postedAt: string };
export type ReactionTotals = { orders: number; revenue: number };

export type ReactionRow<T extends ReactionEventInput> = {
  /** 첫 구성원 id — 줄의 안정 키. */
  key: string;
  /** 첫 발행 시각을 10분 칸 시작으로 내림한 값. 직전/직후 창의 경계다. */
  pivotMs: number;
  /** 첫 구성원의 실제 발행 시각. */
  postedMs: number;
  members: T[];
  /** null = 창이 「기록 없음」 날짜에 걸려 말할 수 없다(0건과 다르다). */
  before: ReactionTotals | null;
  after: ReactionTotals | null;
  /** 직후 창이 아직 안 끝났다 — after 는 지금까지의 부분 합이다. */
  afterPartial: boolean;
  /** 앞뒤 창 안에 발행된 **다른 묶음**의 콘텐츠 수 — 같은 주문이 두 줄에 잡힐 수 있다는 표시. */
  overlapCount: number;
};

export function groupEventsByTime<T extends ReactionEventInput>(
  events: T[],
  maxSpanMs: number = REACTION_GROUP_SPAN_MS,
): Array<{ postedMs: number; members: T[] }> {
  const timed = events
    .map((event) => ({ event, postedMs: Date.parse(event.postedAt) }))
    .filter((t) => Number.isFinite(t.postedMs))
    .sort((a, b) => a.postedMs - b.postedMs);
  const groups: Array<{ postedMs: number; members: T[] }> = [];
  for (const t of timed) {
    const last = groups[groups.length - 1];
    if (last !== undefined && t.postedMs - last.postedMs <= maxSpanMs) {
      last.members.push(t.event);
      continue;
    }
    groups.push({ postedMs: t.postedMs, members: [t.event] });
  }
  return groups;
}

function sumWindow(points: ReactionPoint[], fromMs: number, toMs: number): ReactionTotals {
  let orders = 0;
  let revenue = 0;
  for (const p of points) {
    if (p.startMs >= fromMs && p.startMs < toMs) {
      orders += p.orders;
      revenue += p.revenue;
    }
  }
  return { orders, revenue };
}

function touchesMissingDay(fromMs: number, toMs: number, missingDayKeys: string[]): boolean {
  return missingDayKeys.some((key) => {
    const range = kstDayRange(key);
    return range !== null && fromMs < range.endMs && toMs > range.startMs;
  });
}

export function buildReactionRows<T extends ReactionEventInput>(args: {
  events: T[];
  points: ReactionPoint[];
  /** 10분 버킷이 없는 날짜(YYYY-MM-DD KST) — 서버 `intraday.daysWithoutBuckets`. */
  missingDayKeys: string[];
  nowMs: number;
  windowMs?: number;
  bucketMs?: number;
}): ReactionRow<T>[] {
  const windowMs = args.windowMs ?? REACTION_WINDOW_MS;
  const bucketMs = args.bucketMs ?? BUCKET_MS;
  const groups = groupEventsByTime(args.events);
  const posted = groups.flatMap((g, gi) =>
    g.members.map((m) => ({ gi, postedMs: Date.parse(m.postedAt) })),
  );
  return groups.map((group, gi) => {
    const pivotMs = Math.floor(group.postedMs / bucketMs) * bucketMs;
    const beforeStartMs = pivotMs - windowMs;
    const afterEndMs = pivotMs + windowMs;
    return {
      key: group.members[0].id,
      pivotMs,
      postedMs: group.postedMs,
      members: group.members,
      before: touchesMissingDay(beforeStartMs, pivotMs, args.missingDayKeys)
        ? null
        : sumWindow(args.points, beforeStartMs, pivotMs),
      after: touchesMissingDay(pivotMs, afterEndMs, args.missingDayKeys)
        ? null
        : sumWindow(args.points, pivotMs, Math.min(afterEndMs, args.nowMs)),
      afterPartial: afterEndMs > args.nowMs,
      overlapCount: posted.filter(
        (p) => p.gi !== gi && p.postedMs >= beforeStartMs && p.postedMs < afterEndMs,
      ).length,
    };
  });
}
