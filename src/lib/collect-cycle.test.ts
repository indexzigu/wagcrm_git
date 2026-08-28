import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COLLECT_INTERVAL_DAYS,
  getCollectCutoff,
  getCollectIntervalDays,
} from "./collect-cycle";

// 자동수집 주기 규약의 회귀 가드.
// 배경(2026-07-30): 크론이 주 1회(월)만 발화하던 시절엔 이 cutoff가 부차적이었지만,
// 매일 발화로 바꾸면서 "언제 수집할지"의 유일한 판정자가 됐다 — 오설정이 곧 과수집(유료
// 호출 7배) 또는 미수집이므로 파싱 가드를 계약으로 고정한다.

describe("getCollectIntervalDays", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("미설정이면 기본 7일", () => {
    vi.stubEnv("FOLLOWERS_SYNC_INTERVAL_DAYS", "");
    expect(getCollectIntervalDays()).toBe(DEFAULT_COLLECT_INTERVAL_DAYS);
    expect(DEFAULT_COLLECT_INTERVAL_DAYS).toBe(7); // 음성 대조군: 기본값이 조용히 바뀌면 여기서 걸린다
  });

  it("양의 정수는 그대로 쓴다", () => {
    vi.stubEnv("FOLLOWERS_SYNC_INTERVAL_DAYS", "3");
    expect(getCollectIntervalDays()).toBe(3);
  });

  // 구현(`parseInt(env || "7", 10)`)은 NaN을 그대로 흘려보냈고, cutoff가 Invalid Date가 되면
  // `snapshotDate > cutoff` 비교가 전부 false → 전 셀러를 매 회차 재수집한다.
  it.each(["abc", "0", "-2", "7일"])(
    "양의 정수가 아니면(%s) 기본값으로 되돌리고 경고를 남긴다",
    (raw) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubEnv("FOLLOWERS_SYNC_INTERVAL_DAYS", raw);
      expect(getCollectIntervalDays()).toBe(DEFAULT_COLLECT_INTERVAL_DAYS);
      expect(warn).toHaveBeenCalledTimes(1); // 조용히 넘어가지 않는다 (P0 No Silent Failure)
      warn.mockRestore();
    }
  );
});

describe("getCollectCutoff", () => {
  afterEach(() => vi.unstubAllEnvs());

  const DAY_MS = 24 * 60 * 60 * 1000;

  it("기본값이면 정확히 7일 전을 가리킨다", () => {
    vi.stubEnv("FOLLOWERS_SYNC_INTERVAL_DAYS", "");
    const now = new Date("2026-07-30T03:00:00.000Z");
    expect(now.getTime() - getCollectCutoff(now).getTime()).toBe(7 * DAY_MS);
  });

  it("env로 주기를 바꾸면 cutoff도 따라간다", () => {
    vi.stubEnv("FOLLOWERS_SYNC_INTERVAL_DAYS", "3");
    const now = new Date("2026-07-30T03:00:00.000Z");
    expect(now.getTime() - getCollectCutoff(now).getTime()).toBe(3 * DAY_MS);
  });

  it("오설정이어도 Invalid Date를 만들지 않는다(전수 재수집 방지)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("FOLLOWERS_SYNC_INTERVAL_DAYS", "abc");
    const cutoff = getCollectCutoff(new Date("2026-07-30T03:00:00.000Z"));
    expect(Number.isNaN(cutoff.getTime())).toBe(false);
    vi.restoreAllMocks();
  });

  it("인자를 넘겨도 원본 Date를 변형하지 않는다", () => {
    const now = new Date("2026-07-30T03:00:00.000Z");
    const before = now.getTime();
    getCollectCutoff(now);
    expect(now.getTime()).toBe(before);
  });
});
