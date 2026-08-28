import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRateLimit,
  buildAlreadyFreshCaption,
  buildFreshResponse,
  DEFAULT_REFRESH_TTL_SECONDS,
  interpretRefreshResponse,
  MAX_REFRESH_TTL_SECONDS,
  MIN_REFRESH_TTL_SECONDS,
  MAX_REFRESH_RATE_PER_MINUTE,
  MIN_REFRESH_RATE_PER_MINUTE,
  raceWithTimeout,
  REFRESH_RATE_LIMIT_PER_MINUTE,
  resolveRefreshRatePerMinute,
  resolveRefreshTtlSeconds,
  shouldTriggerSync,
  SYNC_WAIT_TIMEOUT_MS,
  SYNCING_FOLLOW_UP_DELAY_MS,
  type RateWindowState,
} from "./mobile-order-refresh";

const NOW = new Date("2026-07-15T10:00:00.000Z");

describe("resolveRefreshTtlSeconds — env TTL 클램프(60~120, 기본 90)", () => {
  it("미설정·빈값·비수치는 기본 90초", () => {
    expect(resolveRefreshTtlSeconds(undefined)).toBe(DEFAULT_REFRESH_TTL_SECONDS);
    expect(resolveRefreshTtlSeconds("")).toBe(DEFAULT_REFRESH_TTL_SECONDS);
    expect(resolveRefreshTtlSeconds("  ")).toBe(DEFAULT_REFRESH_TTL_SECONDS);
    expect(resolveRefreshTtlSeconds("abc")).toBe(DEFAULT_REFRESH_TTL_SECONDS);
  });

  it("범위 내 수치는 그대로(정수 절단)", () => {
    expect(resolveRefreshTtlSeconds("100")).toBe(100);
    expect(resolveRefreshTtlSeconds("75.9")).toBe(75);
  });

  it("60 미만은 60, 120 초과는 120으로 클램프", () => {
    expect(resolveRefreshTtlSeconds("30")).toBe(MIN_REFRESH_TTL_SECONDS);
    expect(resolveRefreshTtlSeconds("0")).toBe(MIN_REFRESH_TTL_SECONDS);
    expect(resolveRefreshTtlSeconds("-5")).toBe(MIN_REFRESH_TTL_SECONDS);
    expect(resolveRefreshTtlSeconds("300")).toBe(MAX_REFRESH_TTL_SECONDS);
  });
});

describe("shouldTriggerSync — 신선도 게이트 경계(TTL 90s)", () => {
  const TTL = 90;

  it("스냅샷이 없으면(null) 항상 트리거", () => {
    expect(shouldTriggerSync(null, NOW, TTL)).toBe(true);
    expect(shouldTriggerSync(undefined, NOW, TTL)).toBe(true);
  });

  it("경과 89.999초(TTL 직전)는 fresh — 트리거하지 않는다", () => {
    const lastCall = new Date(NOW.getTime() - (TTL * 1000 - 1));
    expect(shouldTriggerSync(lastCall, NOW, TTL)).toBe(false);
  });

  it("경과 정확히 90초(TTL 경계)는 stale — 트리거한다", () => {
    const lastCall = new Date(NOW.getTime() - TTL * 1000);
    expect(shouldTriggerSync(lastCall, NOW, TTL)).toBe(true);
  });

  it("경과 90.001초(TTL 직후)는 stale — 트리거한다", () => {
    const lastCall = new Date(NOW.getTime() - (TTL * 1000 + 1));
    expect(shouldTriggerSync(lastCall, NOW, TTL)).toBe(true);
  });

  it("경과 0초(방금 동기화)는 fresh", () => {
    expect(shouldTriggerSync(NOW, NOW, TTL)).toBe(false);
  });
});

describe("buildFreshResponse", () => {
  it("asOf = lastCallTime, nextAllowedAt = lastCallTime + TTL", () => {
    const lastCall = new Date("2026-07-15T10:00:00.000Z");
    expect(buildFreshResponse(lastCall, 90)).toEqual({
      status: "fresh",
      asOf: "2026-07-15T10:00:00.000Z",
      nextAllowedAt: "2026-07-15T10:01:30.000Z",
    });
  });
});

describe("interpretRefreshResponse — 클라이언트 후속 행동", () => {
  it("synced + changed>0 → 즉시 재조회", () => {
    expect(
      interpretRefreshResponse({ status: "synced", asOf: NOW.toISOString(), changed: 3 }),
    ).toEqual({ kind: "reload" });
  });

  it("synced + changed=0 → 재조회 생략, '이미 최신' 캡션", () => {
    const action = interpretRefreshResponse({
      status: "synced",
      asOf: NOW.toISOString(),
      changed: 0,
    });
    expect(action.kind).toBe("alreadyFresh");
    expect((action as { caption: string }).caption).toMatch(/^이미 최신 · \d{2}:\d{2}$/);
  });

  it("fresh → 재조회 생략, '이미 최신 · HH:MM' 캡션", () => {
    const action = interpretRefreshResponse({
      status: "fresh",
      asOf: NOW.toISOString(),
      nextAllowedAt: new Date(NOW.getTime() + 90_000).toISOString(),
    });
    expect(action.kind).toBe("alreadyFresh");
    expect((action as { caption: string }).caption).toMatch(/^이미 최신 · \d{2}:\d{2}$/);
  });

  it("syncing → 3초 뒤 1회 재조회", () => {
    expect(interpretRefreshResponse({ status: "syncing", asOf: null })).toEqual({
      kind: "reloadAfterDelay",
      delayMs: SYNCING_FOLLOW_UP_DELAY_MS,
    });
  });
});

describe("buildAlreadyFreshCaption", () => {
  it("asOf가 없거나 파싱 불가면 시간 없이 '이미 최신'", () => {
    expect(buildAlreadyFreshCaption(null)).toBe("이미 최신");
    expect(buildAlreadyFreshCaption("not-a-date")).toBe("이미 최신");
  });

  it("asOf가 있으면 'HH:MM' 로컬 시각을 붙인다", () => {
    const caption = buildAlreadyFreshCaption("2026-07-15T10:05:00.000Z");
    expect(caption).toMatch(/^이미 최신 · \d{2}:\d{2}$/);
  });
});

describe("resolveRefreshRatePerMinute — env RPM 클램프(1~10, 기본 3)", () => {
  it("기본값은 3이다(오너 지시 2026-07-15 · 10→3 하향)", () => {
    expect(REFRESH_RATE_LIMIT_PER_MINUTE).toBe(3);
  });

  it("미설정·빈값·비수치는 기본 3", () => {
    expect(resolveRefreshRatePerMinute(undefined)).toBe(3);
    expect(resolveRefreshRatePerMinute("")).toBe(3);
    expect(resolveRefreshRatePerMinute("  ")).toBe(3);
    expect(resolveRefreshRatePerMinute("abc")).toBe(3);
  });

  it("범위 내 수치는 그대로(정수 절단)", () => {
    expect(resolveRefreshRatePerMinute("1")).toBe(1); // 오너가 1까지 낮출 수 있다
    expect(resolveRefreshRatePerMinute("5")).toBe(5);
    expect(resolveRefreshRatePerMinute("2.9")).toBe(2);
    expect(resolveRefreshRatePerMinute("10")).toBe(10);
  });

  it("1 미만은 1, 10 초과는 10으로 클램프", () => {
    expect(resolveRefreshRatePerMinute("0")).toBe(MIN_REFRESH_RATE_PER_MINUTE);
    expect(resolveRefreshRatePerMinute("-3")).toBe(MIN_REFRESH_RATE_PER_MINUTE);
    expect(resolveRefreshRatePerMinute("15")).toBe(MAX_REFRESH_RATE_PER_MINUTE);
  });
});

describe("applyRateLimit — 분당 기본 3회 고정창", () => {
  it("빈 상태에서 첫 요청은 허용되고 창이 시작된다", () => {
    const decision = applyRateLimit(null, 1_000_000);
    expect(decision.allowed).toBe(true);
    expect(decision.state).toEqual({ windowStartMs: 1_000_000, count: 1 });
  });

  it("같은 창 안에서 3회까지 허용, 4번째는 429 대상 + Retry-After 초", () => {
    let state: RateWindowState | null = null;
    const start = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      const decision = applyRateLimit(state, start + i * 100);
      expect(decision.allowed).toBe(true);
      state = decision.state;
    }
    const fourth = applyRateLimit(state, start + 30_000);
    expect(fourth.allowed).toBe(false);
    // 창 종료(start+60s)까지 남은 30초
    expect(fourth.retryAfterSeconds).toBe(30);
  });

  it("env로 한도를 넘기면 그 한도(예: 1)가 적용된다", () => {
    const limit = resolveRefreshRatePerMinute("1");
    const first = applyRateLimit(null, 1_000_000, limit);
    expect(first.allowed).toBe(true);
    const second = applyRateLimit(first.state, 1_000_500, limit);
    expect(second.allowed).toBe(false);
  });

  it("60초가 지나면 창이 리셋되어 다시 허용된다", () => {
    let state: RateWindowState | null = null;
    const start = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      state = applyRateLimit(state, start).state;
    }
    const afterWindow = applyRateLimit(state, start + 60_000);
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.state.count).toBe(1);
  });
});

describe("raceWithTimeout — 8초 타임아웃 폴백", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("타임아웃 전에 resolve되면 값을 돌려준다", async () => {
    const result = await raceWithTimeout(Promise.resolve("done"), SYNC_WAIT_TIMEOUT_MS);
    expect(result).toEqual({ timedOut: false, value: "done" });
  });

  it("8초를 넘기면 timedOut=true — 원 Promise는 계속 진행된다", async () => {
    vi.useFakeTimers();
    let settled = false;
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => {
        settled = true;
        resolve("late");
      }, 20_000);
    });
    const racePromise = raceWithTimeout(slow, SYNC_WAIT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(SYNC_WAIT_TIMEOUT_MS);
    const result = await racePromise;
    expect(result).toEqual({ timedOut: true });
    expect(settled).toBe(false);
    // 원 Promise는 취소되지 않고 이후에 완주한다(백그라운드 동기화 계약).
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(slow).resolves.toBe("late");
    expect(settled).toBe(true);
  });

  it("타임아웃 직전(7.999초) resolve는 timedOut=false", async () => {
    vi.useFakeTimers();
    const almost = new Promise<string>((resolve) => {
      setTimeout(() => resolve("just-in-time"), SYNC_WAIT_TIMEOUT_MS - 1);
    });
    const racePromise = raceWithTimeout(almost, SYNC_WAIT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(SYNC_WAIT_TIMEOUT_MS - 1);
    await expect(racePromise).resolves.toEqual({
      timedOut: false,
      value: "just-in-time",
    });
  });
});
