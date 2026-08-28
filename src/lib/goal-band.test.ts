import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GOAL_BAND_FILL_ON_NAVY,
  GOAL_BAND_TEXT_ON_NAVY,
  goalBarWidth,
  resolveGoalBand,
  type GoalBand,
} from "./goal-band";

describe("resolveGoalBand", () => {
  it("경계값 — 100%는 달성, 80%는 정상(미달 아님)", () => {
    expect(resolveGoalBand(100)).toBe("achieved");
    expect(resolveGoalBand(99.9)).toBe("normal");
    expect(resolveGoalBand(80)).toBe("normal");
    expect(resolveGoalBand(79.9)).toBe("missed");
  });

  it("초과 달성도 달성 밴드 — 100%에서 잘리는 건 바 너비뿐", () => {
    expect(resolveGoalBand(118.9)).toBe("achieved");
    expect(goalBarWidth(118.9)).toBe(100);
  });

  it("목표 미설정·비유한값은 null — 호출부가 '미설정'을 렌더한다", () => {
    expect(resolveGoalBand(null)).toBeNull();
    expect(resolveGoalBand(undefined)).toBeNull();
    expect(resolveGoalBand(NaN)).toBeNull();
    expect(resolveGoalBand(Infinity)).toBeNull();
    expect(goalBarWidth(null)).toBe(0);
  });

  it("음수 매출이어도 바 너비는 음수가 되지 않는다", () => {
    expect(resolveGoalBand(-12)).toBe("missed");
    expect(goalBarWidth(-12)).toBe(0);
  });
});

describe("밴드 색 계약", () => {
  const bands: GoalBand[] = ["achieved", "normal", "missed"];

  it("세 밴드가 서로 다른 색을 쓴다 — 하나라도 겹치면 밴드가 무의미해진다", () => {
    const texts = bands.map((b) => GOAL_BAND_TEXT_ON_NAVY[b]);
    const fills = bands.map((b) => GOAL_BAND_FILL_ON_NAVY[b]);
    expect(new Set(texts).size).toBe(3);
    expect(new Set(fills).size).toBe(3);
  });

  it("정상 밴드는 무채색이다 — 늘 있는 상태를 칠하면 심각 미달이 안 튄다", () => {
    // hue 토큰(accent-gold·goal-miss)이 들어오면 "무채색=랭크" 설계가 깨진다.
    expect(GOAL_BAND_TEXT_ON_NAVY.normal).toMatch(/white\//);
    expect(GOAL_BAND_FILL_ON_NAVY.normal).toMatch(/white\//);
  });

  it("정상 밴드 fill 은 white/45 미만으로 내리지 않는다 — 트랙 대비 3:1 요건", () => {
    // fill 은 트랙(bg-white/10) 위에 얹히므로 기준은 네이비가 아니라 트랙 대비다.
    // white/35 = 2.65:1 로 비텍스트 3:1 미달 → 바가 얼마나 찼는지 자체가 안 읽혔다(적발 이력).
    // white/40 = 3.00(경계) · white/45 = 3.39(채택).
    const alpha = Number(GOAL_BAND_FILL_ON_NAVY.normal.match(/white\/(\d+)/)?.[1]);
    expect(alpha, "정상 밴드 fill 알파를 읽지 못했다").toBeGreaterThan(0);
    expect(alpha, "트랙 대비 3:1 미달 — 진행바 길이가 안 읽힌다").toBeGreaterThanOrEqual(45);
  });

  it("심각 미달은 --goal-miss 토큰을 쓴다 — 흰 배경용 status-urgent 재사용 금지", () => {
    // --status-urgent(#BF5050)는 히어로 네이비 위 2.87:1로 AA 미달이라 흡수 불가.
    expect(GOAL_BAND_TEXT_ON_NAVY.missed).toBe("text-goal-miss");
    expect(GOAL_BAND_FILL_ON_NAVY.missed).toBe("bg-goal-miss");
    expect(GOAL_BAND_TEXT_ON_NAVY.missed).not.toMatch(/status-urgent/);
  });
});

/**
 * 위 테스트들은 클래스 **이름**만 본다 — 이름이 맞아도 토큰이 @theme 에 노출되지 않으면
 * 유틸이 생성되지 않아 **색이 조용히 사라진다**(클래스는 붙어 있고 화면만 회색).
 * elevation-ladder-contract 가 그림자에 대해 막는 것과 같은 함정이라 같은 방식으로 막는다.
 */
describe("--goal-miss 토큰 — 정의와 @theme 노출이 둘 다 있어야 색이 나온다", () => {
  const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");

  it("값이 정의돼 있다 (D3 오너 확정: rose-400)", () => {
    expect(css, "--goal-miss 정의 누락").toMatch(/--goal-miss:\s*#FB7185/i);
  });

  it("@theme 에 노출돼 있다 — 빠지면 text-goal-miss 가 무효 클래스가 된다", () => {
    expect(css, "--goal-miss @theme 노출 누락 — 유틸이 생성되지 않는다").toMatch(
      /--color-goal-miss:\s*var\(--goal-miss\)/,
    );
  });

  it("밴드가 의존하는 골드 토큰도 노출돼 있다", () => {
    expect(css).toMatch(/--color-accent-gold-soft:\s*var\(--accent-gold-soft\)/);
    expect(css).toMatch(/--color-accent-gold:\s*var\(--accent-gold\)/);
  });
});
