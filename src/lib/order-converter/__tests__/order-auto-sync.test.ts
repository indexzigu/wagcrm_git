import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORDER_AUTO_SYNC_INTERVAL_HOURS,
  isOrderAutoSyncDue,
  normalizeOrderAutoSyncInterval,
} from "../order-auto-sync";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 10, 3, 0, 0);

describe("isOrderAutoSyncDue", () => {
  it("마지막 동기화가 간격보다 최근이면 진입 동기화를 걸지 않는다", () => {
    expect(isOrderAutoSyncDue(NOW - 3 * HOUR + 1, 3, NOW)).toBe(false);
  });

  it("간격이 정확히 지났거나 더 지났으면 건다", () => {
    expect(isOrderAutoSyncDue(NOW - 3 * HOUR, 3, NOW)).toBe(true);
    expect(isOrderAutoSyncDue(NOW - 7 * HOUR, 6, NOW)).toBe(true);
  });

  it("마지막 동기화 시각을 모르면 건다(무기한 낡은 화면 방지)", () => {
    expect(isOrderAutoSyncDue(null, 6, NOW)).toBe(true);
    expect(isOrderAutoSyncDue(Number.NaN, 6, NOW)).toBe(true);
  });
});

describe("normalizeOrderAutoSyncInterval", () => {
  it("허용값 1·3·6은 그대로 읽는다", () => {
    expect([1, 3, 6].map(normalizeOrderAutoSyncInterval)).toEqual([1, 3, 6]);
  });

  it("허용값 밖·행 없음은 기본값(6시간)으로 읽는다", () => {
    expect(DEFAULT_ORDER_AUTO_SYNC_INTERVAL_HOURS).toBe(6);
    for (const value of [undefined, null, 0, 2, 24, "3"]) {
      expect(normalizeOrderAutoSyncInterval(value)).toBe(6);
    }
  });
});
