import { describe, expect, it } from "vitest";
import { evaluateGraphVersionExpiry, GRAPH_VERSION_EXPIRY } from "@/lib/instagram-graph-version";

// 현재 시각은 항상 주입한다 — 실제 날짜에 의존하는 단언 금지.
const VERSION = "v20.0"; // 만료표 2026-09-24
const EXPIRY = new Date("2026-09-24T00:00:00Z");
const daysBefore = (n: number) => new Date(EXPIRY.getTime() - n * 86_400_000);

describe("evaluateGraphVersionExpiry", () => {
  it("만료 표 값이 기대와 같다(손으로 옮긴 값 고정)", () => {
    expect(GRAPH_VERSION_EXPIRY[VERSION]).toBe("2026-09-24");
  });

  it("61일 전에는 경고하지 않는다", () => {
    const r = evaluateGraphVersionExpiry(VERSION, daysBefore(61));
    expect(r).toMatchObject({ daysUntilExpiry: 61, withinWarningWindow: false, expired: false, unknown: false });
  });

  it("60일 전부터 경고한다", () => {
    const r = evaluateGraphVersionExpiry(VERSION, daysBefore(60));
    expect(r).toMatchObject({ daysUntilExpiry: 60, withinWarningWindow: true, expired: false });
  });

  it("만료 당일과 이후는 만료로 본다", () => {
    expect(evaluateGraphVersionExpiry(VERSION, EXPIRY)).toMatchObject({ daysUntilExpiry: 0, expired: true, withinWarningWindow: true });
    const after = evaluateGraphVersionExpiry(VERSION, new Date(EXPIRY.getTime() + 3 * 86_400_000));
    expect(after).toMatchObject({ daysUntilExpiry: -3, expired: true, withinWarningWindow: true });
  });

  it("만료 1시간 뒤에도 남은 일수는 -0 이 아닌 0 이다", () => {
    const r = evaluateGraphVersionExpiry(VERSION, new Date(EXPIRY.getTime() + 3_600_000));
    expect(r.daysUntilExpiry).toBe(0);
    expect(r.expired).toBe(true);
  });

  it("만료표에 없는 버전은 unknown 이며 경고하지 않는다", () => {
    expect(evaluateGraphVersionExpiry("v99.0", EXPIRY)).toEqual({
      daysUntilExpiry: null,
      withinWarningWindow: false,
      expired: false,
      unknown: true,
    });
  });
});
