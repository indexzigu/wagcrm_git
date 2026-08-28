import { describe, expect, it } from "vitest";
import {
  MONEY_DIRECTION_STROKE,
  MONEY_DIRECTION_TEXT,
  MONEY_ROW_AMOUNT_NEUTRAL,
} from "./money-direction";

/**
 * 이 축의 계약은 "같은 의미는 같은 색"(P8)과 **대칭**이다. 회귀 시나리오는 실제로 있었다 —
 * 입금·지급이 같은 색이던 표면이 3곳, 대비 미달 리터럴이 2곳이었다.
 */
describe("money-direction", () => {
  it("입금과 지급은 서로 다른 색이다 — 방향이 색으로 구분되어야 한다", () => {
    // 회귀 방지: text-primary·muted-foreground/70·slate-800 으로 양쪽이 같던 표면이 3곳이었다.
    expect(MONEY_DIRECTION_TEXT.in).not.toBe(MONEY_DIRECTION_TEXT.out);
    expect(MONEY_DIRECTION_STROKE.in).not.toBe(MONEY_DIRECTION_STROKE.out);
  });

  it("양쪽 다 유채색이다 — 한쪽만 칠하면 '지급=나쁜 것'으로 오독된다", () => {
    for (const tone of Object.values(MONEY_DIRECTION_TEXT)) {
      expect(tone).not.toMatch(/slate|muted|foreground|primary/);
    }
  });

  it("텍스트 표면은 AA 통과 토큰을 쓴다 — 링 전용 원본(--money-in 3.77:1)을 쓰지 않는다", () => {
    // --money-in 은 흰 배경 3.77:1 로 텍스트 AA(4.5) 미달이다. 텍스트에는 -text 변형만 쓴다.
    expect(MONEY_DIRECTION_TEXT.in).toBe("text-money-in-text");
    expect(MONEY_DIRECTION_TEXT.out).toBe("text-money-out");
  });

  it("링(비텍스트 3:1) 은 원본 토큰을 쓴다 — 텍스트 맵과 섞이면 안 된다", () => {
    expect(MONEY_DIRECTION_STROKE.in).toBe("var(--money-in)");
    expect(MONEY_DIRECTION_STROKE.out).toBe("var(--money-out)");
    // 두 맵은 다른 대비 기준을 만족한다 — "통일"하지 말 것.
    expect(MONEY_DIRECTION_STROKE.in).not.toBe(MONEY_DIRECTION_TEXT.in);
  });

  it("적자·위험 토큰을 방향축에 태우지 않는다 — 그건 심각도축이다", () => {
    // --money-out 주석의 역: 적자는 방향이 아니라서 money-out 에 흡수할 수 없다
    // (mobile-campaign-card 의 적자 배지가 status-urgent 를 쓰는 이유).
    for (const tone of [...Object.values(MONEY_DIRECTION_TEXT), ...Object.values(MONEY_DIRECTION_STROKE)]) {
      expect(tone).not.toMatch(/status-urgent|status-caution|goal-miss/);
    }
  });

  it("목록 행 금액은 무채색이다 — 방향은 아이콘이 말하고, 색은 지연 배지에 양보한다", () => {
    expect(MONEY_ROW_AMOUNT_NEUTRAL).toMatch(/slate/);
  });
});
