import { describe, expect, it } from "vitest";
import {
  computePullOffset,
  PULL_MAX_PX,
  PULL_THRESHOLD_PX,
  REFRESH_THROTTLE_MS,
  shouldFireRefresh,
} from "../use-pull-to-refresh";

describe("computePullOffset — 감쇠·상한", () => {
  it("위로 밀거나 이동 0이면 0", () => {
    expect(computePullOffset(0)).toBe(0);
    expect(computePullOffset(-50)).toBe(0);
  });

  it("감쇠 0.5 적용: 이동 200px → 100px", () => {
    expect(computePullOffset(200)).toBe(100);
  });

  it("상한(110px)을 넘지 않는다", () => {
    expect(computePullOffset(1_000)).toBe(PULL_MAX_PX);
  });
});

describe("shouldFireRefresh — 임계·refreshing·20초 스로틀", () => {
  const base = {
    pullDistance: PULL_THRESHOLD_PX,
    refreshing: false,
    lastSuccessAt: null,
    now: 100_000,
  };

  it("임계 이상 + 유휴 + 스로틀 밖이면 실행", () => {
    expect(shouldFireRefresh(base)).toBe(true);
  });

  it("임계(70px) 미만이면 실행하지 않는다", () => {
    expect(shouldFireRefresh({ ...base, pullDistance: PULL_THRESHOLD_PX - 1 })).toBe(false);
  });

  it("refreshing 중 재트리거는 무시한다", () => {
    expect(shouldFireRefresh({ ...base, refreshing: true })).toBe(false);
  });

  it("마지막 성공 후 20초 이내는 무시, 20초 경과부터 허용", () => {
    expect(REFRESH_THROTTLE_MS).toBe(20_000); // 10s → 20s (2026-07-15 egress 절감)
    expect(
      shouldFireRefresh({ ...base, lastSuccessAt: base.now - (REFRESH_THROTTLE_MS - 1) }),
    ).toBe(false);
    expect(
      shouldFireRefresh({ ...base, lastSuccessAt: base.now - REFRESH_THROTTLE_MS }),
    ).toBe(true);
  });
});
