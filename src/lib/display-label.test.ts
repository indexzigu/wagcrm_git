import { describe, expect, it } from "vitest";
import { displayLabel, NO_LABEL, UNKNOWN_NAME } from "./display-label";

const TABLE = { ACTIVE: "판매중", CLOSED: "판매마감" } as const;

describe("displayLabel — 표에 없는 영문 코드를 화면에 내지 않는다", () => {
  it("표에 있으면 표의 낱말", () => {
    expect(displayLabel(TABLE, "ACTIVE")).toBe("판매중");
  });

  it("값이 없으면 「—」", () => {
    expect(displayLabel(TABLE, null)).toBe(NO_LABEL);
    expect(displayLabel(TABLE, undefined)).toBe(NO_LABEL);
    expect(displayLabel(TABLE, "")).toBe(NO_LABEL);
  });

  it("표에 없는 영문 코드 모양이면 「—」", () => {
    expect(displayLabel(TABLE, "PRICE_SHEET")).toBe(NO_LABEL);
    expect(displayLabel(TABLE, "naver")).toBe(NO_LABEL);
  });

  it("표에 없는 한글 저장값은 그대로", () => {
    expect(displayLabel(TABLE, "응답없음")).toBe("응답없음");
  });

  it("화면에 이미 있는 「모를 때」 낱말을 넘기면 그 낱말로 떨어진다(빈 값·모르는 코드 모두)", () => {
    expect(displayLabel(TABLE, "brand_new_action", UNKNOWN_NAME)).toBe("알 수 없음");
    expect(displayLabel(TABLE, null, UNKNOWN_NAME)).toBe("알 수 없음");
    expect(displayLabel(TABLE, "ACTIVE", UNKNOWN_NAME)).toBe("판매중");
  });

  it("객체 기본 속성 이름(constructor 등)을 낱말로 착각하지 않는다", () => {
    expect(displayLabel(TABLE, "constructor")).toBe(NO_LABEL);
    expect(displayLabel(TABLE, "toString")).toBe(NO_LABEL);
  });
});
