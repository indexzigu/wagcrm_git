// Feature: multi-user-collaboration, Property 11: Timeline merge preserves descending order
// Validates: Requirements 4.2, 10.1

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";
import {
  mergeTimeline,
  formatRelativeTime,
  type ActivityLogEntry,
  type Comment,
} from "../components/crm/activity-timeline";

// --- Arbitraries ---

/** Generate a valid ISO date string within a reasonable range */
const isoDateArb = fc
  .integer({ min: 0, max: 2_000_000_000_000 })
  .map((ms) => new Date(ms).toISOString());

/** Generate a minimal ActivityLogEntry with a random createdAt */
const activityEntryArb = (createdAt: string): ActivityLogEntry => ({
  id: `entry-${createdAt}`,
  type: "CHANGE",
  fieldName: "status",
  previousValue: "A",
  newValue: "B",
  content: null,
  actor: "user1",
  createdAt,
});

/** Generate a minimal Comment with a random createdAt */
const commentArb = (createdAt: string): Comment => ({
  id: `comment-${createdAt}`,
  entityType: "CAMPAIGN",
  entityId: "entity-1",
  authorId: "author-1",
  authorName: "Author",
  content: "hello",
  mentions: "[]",
  createdAt,
});

/** Arbitrary for an array of ActivityLogEntry with random timestamps */
const entriesArb = fc
  .array(isoDateArb, { minLength: 0, maxLength: 20 })
  .map((dates) => dates.map(activityEntryArb));

/** Arbitrary for an array of Comment with random timestamps */
const commentsArb = fc
  .array(isoDateArb, { minLength: 0, maxLength: 20 })
  .map((dates) => dates.map(commentArb));

// --- Property 11: Timeline merge preserves descending order ---

describe("mergeTimeline", () => {
  it(
    "Property 11: merged timeline is sorted by createdAt descending for any entries and comments",
    () => {
      fc.assert(
        fc.property(entriesArb, commentsArb, (entries, comments) => {
          const merged = mergeTimeline(entries, comments);

          // Verify descending order: each item's createdAt >= the next item's createdAt
          for (let i = 0; i < merged.length - 1; i++) {
            const current = new Date(merged[i].data.createdAt).getTime();
            const next = new Date(merged[i + 1].data.createdAt).getTime();
            expect(current).toBeGreaterThanOrEqual(next);
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "Property 11: merged timeline contains all entries and comments (no items lost)",
    () => {
      fc.assert(
        fc.property(entriesArb, commentsArb, (entries, comments) => {
          const merged = mergeTimeline(entries, comments);
          expect(merged.length).toBe(entries.length + comments.length);
        }),
        { numRuns: 100 },
      );
    },
  );

  it("returns empty array when both inputs are empty", () => {
    expect(mergeTimeline([], [])).toEqual([]);
  });

  it("returns only entries when comments is empty", () => {
    const entries = [
      activityEntryArb("2024-01-03T00:00:00.000Z"),
      activityEntryArb("2024-01-01T00:00:00.000Z"),
      activityEntryArb("2024-01-02T00:00:00.000Z"),
    ];
    const merged = mergeTimeline(entries, []);
    expect(merged.length).toBe(3);
    expect(merged[0].data.createdAt).toBe("2024-01-03T00:00:00.000Z");
    expect(merged[1].data.createdAt).toBe("2024-01-02T00:00:00.000Z");
    expect(merged[2].data.createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("returns only comments when entries is empty", () => {
    const comments = [
      commentArb("2024-06-01T12:00:00.000Z"),
      commentArb("2024-06-03T08:00:00.000Z"),
    ];
    const merged = mergeTimeline([], comments);
    expect(merged.length).toBe(2);
    expect(merged[0].data.createdAt).toBe("2024-06-03T08:00:00.000Z");
    expect(merged[1].data.createdAt).toBe("2024-06-01T12:00:00.000Z");
  });

  it("interleaves entries and comments in descending order", () => {
    const entries = [
      activityEntryArb("2024-01-01T10:00:00.000Z"),
      activityEntryArb("2024-01-01T08:00:00.000Z"),
    ];
    const comments = [
      commentArb("2024-01-01T09:00:00.000Z"),
      commentArb("2024-01-01T11:00:00.000Z"),
    ];
    const merged = mergeTimeline(entries, comments);
    expect(merged.length).toBe(4);
    expect(merged[0].data.createdAt).toBe("2024-01-01T11:00:00.000Z");
    expect(merged[0].kind).toBe("comment");
    expect(merged[1].data.createdAt).toBe("2024-01-01T10:00:00.000Z");
    expect(merged[1].kind).toBe("entry");
    expect(merged[2].data.createdAt).toBe("2024-01-01T09:00:00.000Z");
    expect(merged[2].kind).toBe("comment");
    expect(merged[3].data.createdAt).toBe("2024-01-01T08:00:00.000Z");
    expect(merged[3].kind).toBe("entry");
  });
});

// --- formatRelativeTime unit tests ---

/**
 * ⏰ **시계를 얼린 채로 경계를 본다.** `formatRelativeTime` 은 내부에서 `Date.now()` 를
 * 다시 읽으므로, 픽스처를 만든 시각과 포맷하는 시각이 다르면 경과가 **커지는 방향으로만**
 * 흔들린다. 그래서 `dateSecondsAgo(59)`("방금 전", 구현 경계는 `diffSeconds < 60`)는
 * 두 문장 사이에 1초가 끼는 순간 `"1분 전"` 이 되어 깨진다 — 실제로 터지진 않았지만
 * PR #336(`durationMs` 하한을 요청 지연으로 잡아 29 vs 30 으로 간헐 실패)과 **구조가 같고
 * 마진만 1,000배 큰** 시한폭탄이다.
 *
 * 값을 안전한 쪽(59 → 30)으로 낮추면 플레이크는 사라지지만 **경계 테스트가 경계를 보지
 * 않게 된다.** 그래서 값이 아니라 시계를 고정한다 — `59` 가 진짜 59초가 되고 나머지
 * 경계값(60초·24시간·7일·30일·365일)도 전부 정확해진다.
 *
 * `toFake: ["Date"]` 로 **Date 만** 얼린다(전역 룰 `rules/testing.md`) — `setTimeout` 까지
 * 얼리면 이 파일이 쓰는 fast-check 의 비동기 경로가 멈춘다. 고정 시각은 하드코딩하지 않고
 * 실행 시점의 실시계를 그대로 얼려, 고정 날짜 픽스처가 만드는 별개의 시한폭탄
 * (P9 `dev-qa.md` — 창 로직이 날짜를 넘기며 깨지는 부류)을 들이지 않는다.
 */
describe("formatRelativeTime", () => {
  beforeEach(() => {
    const frozenNow = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: frozenNow });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function dateSecondsAgo(seconds: number): string {
    return new Date(Date.now() - seconds * 1000).toISOString();
  }

  it('returns "방금 전" for timestamps less than 60 seconds ago', () => {
    expect(formatRelativeTime(dateSecondsAgo(30))).toBe("방금 전");
    expect(formatRelativeTime(dateSecondsAgo(0))).toBe("방금 전");
    expect(formatRelativeTime(dateSecondsAgo(59))).toBe("방금 전");
  });

  it("returns minutes ago for timestamps 1–59 minutes ago", () => {
    expect(formatRelativeTime(dateSecondsAgo(60))).toBe("1분 전");
    expect(formatRelativeTime(dateSecondsAgo(120))).toBe("2분 전");
    expect(formatRelativeTime(dateSecondsAgo(59 * 60))).toBe("59분 전");
  });

  it("returns hours ago for timestamps 1–23 hours ago", () => {
    expect(formatRelativeTime(dateSecondsAgo(3600))).toBe("1시간 전");
    expect(formatRelativeTime(dateSecondsAgo(7200))).toBe("2시간 전");
    expect(formatRelativeTime(dateSecondsAgo(23 * 3600))).toBe("23시간 전");
  });

  it('returns "어제" for timestamps exactly 1 day ago', () => {
    expect(formatRelativeTime(dateSecondsAgo(24 * 3600))).toBe("어제");
  });

  it("returns days ago for timestamps 2–6 days ago", () => {
    expect(formatRelativeTime(dateSecondsAgo(2 * 24 * 3600))).toBe("2일 전");
    expect(formatRelativeTime(dateSecondsAgo(6 * 24 * 3600))).toBe("6일 전");
  });

  it("returns weeks ago for timestamps 7–29 days ago", () => {
    expect(formatRelativeTime(dateSecondsAgo(7 * 24 * 3600))).toBe("1주 전");
    expect(formatRelativeTime(dateSecondsAgo(14 * 24 * 3600))).toBe("2주 전");
  });

  it("returns months ago for timestamps 30–364 days ago", () => {
    expect(formatRelativeTime(dateSecondsAgo(30 * 24 * 3600))).toBe("1개월 전");
    expect(formatRelativeTime(dateSecondsAgo(60 * 24 * 3600))).toBe("2개월 전");
  });

  it("returns years ago for timestamps 365+ days ago", () => {
    expect(formatRelativeTime(dateSecondsAgo(365 * 24 * 3600))).toBe("1년 전");
    expect(formatRelativeTime(dateSecondsAgo(730 * 24 * 3600))).toBe("2년 전");
  });
});
