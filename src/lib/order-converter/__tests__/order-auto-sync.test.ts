import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { latestChangeCursorMock } = vi.hoisted(() => ({ latestChangeCursorMock: vi.fn() }));
vi.mock("@/repositories/naverOrderSnapshotRepository", () => ({
  naverOrderSnapshotRepository: { latestChangeCursor: latestChangeCursorMock },
}));

import {
  DEFAULT_ORDER_AUTO_SYNC_INTERVAL_HOURS,
  getLastChangeSyncMs,
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

  it("코드 기본값이 두 스키마의 @default 와 같다(새 행은 DB 기본값으로 생긴다)", () => {
    for (const schema of ["prisma/schema.prisma", "prisma/schema.sqlite.prisma"]) {
      const source = readFileSync(join(process.cwd(), schema), "utf8");
      const match = source.match(/orderAutoSyncIntervalHours\s+Int\s+@default\((\d+)\)/);
      expect(match?.[1], schema).toBe(String(DEFAULT_ORDER_AUTO_SYNC_INTERVAL_HOURS));
    }
  });
});

describe("getLastChangeSyncMs", () => {
  beforeEach(() => {
    latestChangeCursorMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("변경피드 커서(latestChangeCursor)의 ISO 시각을 ms로 읽는다", async () => {
    latestChangeCursorMock.mockResolvedValueOnce({ lastChangeStatusCursor: "2026-09-10T03:00:00.000Z" });
    expect(await getLastChangeSyncMs()).toBe(Date.parse("2026-09-10T03:00:00.000Z"));
    expect(latestChangeCursorMock).toHaveBeenCalledTimes(1);
  });

  it("커서 없음·해석 불가·조회 실패는 null(「모름」 → 진입 동기화를 건다)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    latestChangeCursorMock.mockResolvedValueOnce(null);
    expect(await getLastChangeSyncMs()).toBeNull();
    latestChangeCursorMock.mockResolvedValueOnce({ lastChangeStatusCursor: "not-a-date" });
    expect(await getLastChangeSyncMs()).toBeNull();
    latestChangeCursorMock.mockRejectedValueOnce(new Error("db down"));
    expect(await getLastChangeSyncMs()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
