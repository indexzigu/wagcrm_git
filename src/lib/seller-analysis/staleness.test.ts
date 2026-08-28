import { describe, expect, it } from "vitest";
import { ANALYSIS_STALE_DAYS, analysisAgeDays, analysisStaleLabel } from "./staleness";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 6, 7, 12, 0, 0); // 2026-07-07T12:00Z 고정 (테스트 결정성)

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

describe("analysisAgeDays", () => {
  it("경과 일수를 내림으로 계산한다", () => {
    expect(analysisAgeDays(isoDaysAgo(0), NOW)).toBe(0);
    expect(analysisAgeDays(isoDaysAgo(27), NOW)).toBe(27);
    expect(analysisAgeDays(isoDaysAgo(63), NOW)).toBe(63);
  });

  it("미분석(null/undefined)·파싱 불가 입력은 null", () => {
    expect(analysisAgeDays(null, NOW)).toBeNull();
    expect(analysisAgeDays(undefined, NOW)).toBeNull();
    expect(analysisAgeDays("not-a-date", NOW)).toBeNull();
  });
});

describe("analysisStaleLabel", () => {
  it("임계(28일) 미만이면 null — 배지 없음", () => {
    expect(analysisStaleLabel(isoDaysAgo(0), NOW)).toBeNull();
    expect(analysisStaleLabel(isoDaysAgo(ANALYSIS_STALE_DAYS - 1), NOW)).toBeNull();
  });

  it("임계 이상이면 주 단위 경과 라벨", () => {
    expect(analysisStaleLabel(isoDaysAgo(ANALYSIS_STALE_DAYS), NOW)).toBe("4주 경과");
    expect(analysisStaleLabel(isoDaysAgo(35), NOW)).toBe("5주 경과");
    expect(analysisStaleLabel(isoDaysAgo(63), NOW)).toBe("9주 경과");
  });

  it("미분석이면 null — '미분석' 표기는 점수 셀이 담당", () => {
    expect(analysisStaleLabel(null, NOW)).toBeNull();
  });
});
