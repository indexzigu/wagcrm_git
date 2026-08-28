import { describe, expect, it } from "vitest";
import { STALE_GRACE_MS, isJobOverdue, overdueSummary } from "../cron-staleness";

/**
 * 크론 지연 판정 회귀.
 *
 * **왜 필요한가(2026-08-04):** `capture-stories` 를 오너 맥의 로컬 레인으로 옮기면서
 * 새 무음 실패 경로가 생겼다 — **맥이 꺼져 있으면 러너가 아예 안 돌고, 그때 레이더는
 * 마지막 성공 상태(초록)를 그대로 유지한 채 시각만 낡는다.** 서버 레인은 플랫폼이 발화를
 * 보장하므로 "안 돌았다"가 드물지만, 로컬 레인은 그게 상시 가능한 상태다.
 *
 * ⚠️ **오탐이 이 판정의 최대 위험이다.** 매일 빨강이 되면 습관화로 신호를 잃는다
 * (P6·P7 이 반복해서 경고하는 실패 모드). 그래서 ①유예를 두고 ②주기별로 다르게 잡고
 * ③기록이 없는 잡은 지연으로 승격하지 않는다(그건 "기록 없음"이 이미 말한다).
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-08-04T00:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("isJobOverdue — 매일 잡", () => {
  const daily = { cycle: "매일" } as const;

  it("방금 돌았으면 지연이 아니다", () => {
    expect(isJobOverdue(daily, ago(HOUR), NOW)).toBe(false);
  });

  it("하루가 갓 지난 정도는 지연이 아니다(유예) — 크론 발화 지연·시계 흔들림 흡수", () => {
    expect(isJobOverdue(daily, ago(DAY + HOUR), NOW)).toBe(false);
  });

  it("유예를 넘기면 지연이다(한 회차를 통째로 걸렀다는 뜻)", () => {
    expect(isJobOverdue(daily, ago(DAY + STALE_GRACE_MS.매일 + HOUR), NOW)).toBe(true);
  });

  it("이틀 넘게 안 돌면 당연히 지연이다", () => {
    expect(isJobOverdue(daily, ago(3 * DAY), NOW)).toBe(true);
  });
});

describe("isJobOverdue — 매주 잡", () => {
  const weekly = { cycle: "매주 월" } as const;

  it("6일 전이면 아직 다음 회차 전이라 지연이 아니다", () => {
    expect(isJobOverdue(weekly, ago(6 * DAY), NOW)).toBe(false);
  });

  it("8일이 지나도 유예 안이면 지연이 아니다", () => {
    expect(isJobOverdue(weekly, ago(7 * DAY + HOUR), NOW)).toBe(false);
  });

  it("9일이 지나면 지연이다", () => {
    expect(isJobOverdue(weekly, ago(9 * DAY), NOW)).toBe(true);
  });

  it("매일 잡의 임계로 주간 잡을 재지 않는다(오탐 방지 — 2일 된 주간 잡은 정상)", () => {
    expect(isJobOverdue(weekly, ago(2 * DAY), NOW)).toBe(false);
    expect(isJobOverdue({ cycle: "매일" }, ago(2 * DAY), NOW)).toBe(true);
  });
});

describe("isJobOverdue — 승격하지 않는 경우", () => {
  it("실행 기록이 아예 없으면 지연이 아니다(그건 '기록 없음' 상태가 이미 말한다)", () => {
    expect(isJobOverdue({ cycle: "매일" }, null, NOW)).toBe(false);
  });

  it("미래 시각이 들어와도 지연으로 뒤집히지 않는다(시계 오차 방어)", () => {
    expect(isJobOverdue({ cycle: "매일" }, new Date(NOW.getTime() + DAY), NOW)).toBe(false);
  });

  it("해석 불가한 주기는 지연 판정을 하지 않는다(모르면 조용히 있는다)", () => {
    expect(isJobOverdue({ cycle: "가끔" }, ago(30 * DAY), NOW)).toBe(false);
  });
});

describe("overdueSummary — 사람이 읽는 사유", () => {
  it("몇 회차를 걸렀는지 말한다(단순 '지연'보다 판단에 쓸모 있다)", () => {
    expect(overdueSummary({ cycle: "매일" }, ago(3 * DAY), NOW)).toContain("3일");
  });

  it("지연이 아니면 null 이다(호출부가 분기 없이 쓸 수 있게)", () => {
    expect(overdueSummary({ cycle: "매일" }, ago(HOUR), NOW)).toBeNull();
  });

  it("UI 문구에 em-dash 를 쓰지 않는다(styleseed 기계 점검 1)", () => {
    const text = overdueSummary({ cycle: "매일" }, ago(5 * DAY), NOW);
    expect(text).not.toContain("—");
  });
});
