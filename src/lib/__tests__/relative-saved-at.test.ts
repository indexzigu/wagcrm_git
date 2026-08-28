// `formatRelativeSavedAt` — 저장된 초안의 "언제 것인가" 표기.
//
// ⚠️ 이 테스트는 **고정 날짜를 쓰지 않는다.** 기준 시각을 인자로 넘겨 상대 간격만
// 검증한다 — 시스템 시각에 의존하면 어느 날 갑자기 깨진다(P9 「시각 의존 테스트
// 시한폭탄」, 이 레포에서 main 이 하루 막힌 실사고가 있다).

import { describe, expect, it } from "vitest";
import { formatRelativeSavedAt } from "../format";

const now = new Date("2026-08-01T12:00:00+09:00");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRelativeSavedAt", () => {
  it("1시간 미만은 '방금'", () => {
    expect(formatRelativeSavedAt(ago(0), now)).toBe("방금");
    expect(formatRelativeSavedAt(ago(59 * MIN), now)).toBe("방금");
  });

  it("1~23시간은 시간 단위", () => {
    expect(formatRelativeSavedAt(ago(HOUR), now)).toBe("1시간 전");
    expect(formatRelativeSavedAt(ago(23 * HOUR), now)).toBe("23시간 전");
  });

  it("1~6일은 일 단위", () => {
    expect(formatRelativeSavedAt(ago(DAY), now)).toBe("1일 전");
    expect(formatRelativeSavedAt(ago(6 * DAY), now)).toBe("6일 전");
  });

  it("7일 이상은 날짜로 — '37일 전'은 사람이 못 센다", () => {
    expect(formatRelativeSavedAt(ago(7 * DAY), now)).toMatch(/^\d{2}-\d{2}-\d{2}$/);
    expect(formatRelativeSavedAt(ago(40 * DAY), now)).toMatch(/^\d{2}-\d{2}-\d{2}$/);
  });

  it("미래 시각은 '방금'으로 접는다 — '-1시간 전'은 버그로 읽힌다", () => {
    expect(formatRelativeSavedAt(ago(-3 * HOUR), now)).toBe("방금");
  });

  it("잘못된 값은 날짜 포맷터로 떨어진다 — 던지지 않는다", () => {
    expect(() => formatRelativeSavedAt("not-a-date", now)).not.toThrow();
  });
});
