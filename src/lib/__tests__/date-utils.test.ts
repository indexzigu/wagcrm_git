import { describe, it, expect } from "vitest";
import { formatDateRange, formatLastSyncLabel, getDateUrgency } from "../date-utils";

describe("formatLastSyncLabel", () => {
  it("KST 기준 오늘이면 시:분만 보인다", () => {
    // 05:10Z = KST 14:10, 기준 시각 10:00Z = KST 19:00(같은 날)
    expect(formatLastSyncLabel("2026-09-10T05:10:00.000Z", new Date("2026-09-10T10:00:00.000Z"))).toBe("14:10");
  });

  it("KST 기준 전날이면 MM.DD 를 붙인다", () => {
    // 14:10Z = KST 09.09 23:10, 기준 01:00Z = KST 09.10 10:00
    expect(formatLastSyncLabel("2026-09-09T14:10:00.000Z", new Date("2026-09-10T01:00:00.000Z"))).toBe("09.09 23:10");
  });

  it("UTC 로는 같은 날이어도 KST 로 날짜가 다르면 날짜를 붙인다(브라우저 시간대가 아니라 KST 로 가른다)", () => {
    // 14:30Z = KST 09.09 23:30, 기준 15:30Z = KST 09.10 00:30 — UTC 날짜는 둘 다 09.09
    expect(formatLastSyncLabel("2026-09-09T14:30:00.000Z", new Date("2026-09-09T15:30:00.000Z"))).toBe("09.09 23:30");
  });

  it("해석할 수 없는 값은 빈 문자열", () => {
    expect(formatLastSyncLabel("not-a-date")).toBe("");
  });
});

describe("formatDateRange", () => {
  it("formats valid start and end dates as MM.DD ~ MM.DD", () => {
    expect(formatDateRange("2024-03-15", "2024-04-20")).toBe("03.15 ~ 04.20");
  });

  it("pads single-digit months and days with leading zeros", () => {
    expect(formatDateRange("2024-01-05", "2024-02-09")).toBe("01.05 ~ 02.09");
  });

  it("handles double-digit months and days", () => {
    expect(formatDateRange("2024-12-25", "2025-01-31")).toBe("12.25 ~ 01.31");
  });

  it("returns '일정 미정' when startDate is null", () => {
    expect(formatDateRange(null, "2024-04-20")).toBe("일정 미정");
  });

  it("returns '일정 미정' when endDate is null", () => {
    expect(formatDateRange("2024-03-15", null)).toBe("일정 미정");
  });

  it("returns '일정 미정' when both dates are null", () => {
    expect(formatDateRange(null, null)).toBe("일정 미정");
  });

  it("returns '일정 미정' when startDate is empty string", () => {
    expect(formatDateRange("", "2024-04-20")).toBe("일정 미정");
  });

  it("returns '일정 미정' when endDate is empty string", () => {
    expect(formatDateRange("2024-03-15", "")).toBe("일정 미정");
  });

  it("returns '일정 미정' when startDate is undefined", () => {
    expect(formatDateRange(undefined, "2024-04-20")).toBe("일정 미정");
  });

  it("returns '일정 미정' for invalid date strings", () => {
    expect(formatDateRange("not-a-date", "2024-04-20")).toBe("일정 미정");
  });
});

describe("getDateUrgency", () => {
  const today = new Date("2024-06-15");

  it("returns 'overdue' when endDate is before today", () => {
    expect(getDateUrgency("2024-06-14", today)).toBe("overdue");
    expect(getDateUrgency("2024-06-01", today)).toBe("overdue");
  });

  it("returns 'imminent' when endDate is today (0 days away)", () => {
    expect(getDateUrgency("2024-06-15", today)).toBe("imminent");
  });

  it("returns 'imminent' when endDate is 1 day away", () => {
    expect(getDateUrgency("2024-06-16", today)).toBe("imminent");
  });

  it("returns 'imminent' when endDate is 3 days away", () => {
    expect(getDateUrgency("2024-06-18", today)).toBe("imminent");
  });

  it("returns 'normal' when endDate is 4 days away", () => {
    expect(getDateUrgency("2024-06-19", today)).toBe("normal");
  });

  it("returns 'normal' when endDate is far in the future", () => {
    expect(getDateUrgency("2025-01-01", today)).toBe("normal");
  });

  it("returns 'unset' when endDate is null", () => {
    expect(getDateUrgency(null, today)).toBe("unset");
  });

  it("returns 'unset' when endDate is undefined", () => {
    expect(getDateUrgency(undefined, today)).toBe("unset");
  });

  it("returns 'unset' when endDate is empty string", () => {
    expect(getDateUrgency("", today)).toBe("unset");
  });

  it("returns 'unset' for invalid date strings", () => {
    expect(getDateUrgency("invalid-date", today)).toBe("unset");
  });

  it("uses current date when today parameter is not provided", () => {
    // A date far in the future should always be 'normal'
    expect(getDateUrgency("2099-12-31")).toBe("normal");
  });
});
