/**
 * 제품명 정규화 계약 — 이 값이 그대로 딜명이 되므로 잘못 다듬으면 이름이 망가진다.
 */
import { describe, expect, it } from "vitest";
import { normalizeItemName } from "../normalize-name";

describe("normalizeItemName — 셀 안 줄바꿈 접기", () => {
  it("CRLF·LF 줄바꿈을 한 칸 공백으로 접는다", () => {
    expect(normalizeItemName("스노우 펄 네크리스\r\n(실버925\r\n+핵진주")).toBe(
      "스노우 펄 네크리스 (실버925 +핵진주"
    );
    expect(normalizeItemName("A\nB")).toBe("A B");
  });

  it("연속 공백·탭도 한 칸으로 접는다", () => {
    expect(normalizeItemName("A   \t  B")).toBe("A B");
  });

  it("앞뒤 공백을 뗀다", () => {
    expect(normalizeItemName("  제품A  ")).toBe("제품A");
  });
});

describe("normalizeItemName — 선행 번호 접두", () => {
  it("`1. ` 형태를 뗀다", () => {
    expect(normalizeItemName("1. 스노우 펄 네크리스")).toBe("스노우 펄 네크리스");
  });

  it("두 자리·세 자리 번호도 뗀다", () => {
    expect(normalizeItemName("10. 노바 이어링")).toBe("노바 이어링");
    expect(normalizeItemName("100. 제품")).toBe("제품");
  });

  it("`1) ` 형태도 뗀다", () => {
    expect(normalizeItemName("2) 블룸 오픈링")).toBe("블룸 오픈링");
  });

  it("줄바꿈을 접은 뒤에 번호를 뗀다 — 순서가 중요하다", () => {
    expect(normalizeItemName("3.\r\n쁘띠 크라운 오픈링")).toBe("쁘띠 크라운 오픈링");
  });
});

describe("normalizeItemName — 잘라내면 안 되는 것", () => {
  it("⚠️ `2.5mm` 는 번호가 아니다 — 구분자 뒤 공백이 없으면 안 뗀다", () => {
    expect(normalizeItemName("2.5mm 테니스팔찌")).toBe("2.5mm 테니스팔찌");
  });

  it("실사고 형태 — 번호와 치수가 함께 있어도 치수는 보존된다", () => {
    expect(normalizeItemName("2. 2.5mm 테니스팔찌 (brass)")).toBe("2.5mm 테니스팔찌 (brass)");
  });

  it("문장 중간의 번호는 건드리지 않는다", () => {
    expect(normalizeItemName("링 9. 호 프리사이즈")).toBe("링 9. 호 프리사이즈");
  });

  it("네 자리 이상 숫자는 번호로 보지 않는다 — 연도·모델명 보호", () => {
    expect(normalizeItemName("2026. 신상 컬렉션")).toBe("2026. 신상 컬렉션");
  });
});

describe("normalizeItemName — 빈 값 처리", () => {
  it("null·undefined 는 null 이다", () => {
    expect(normalizeItemName(null)).toBeNull();
    expect(normalizeItemName(undefined)).toBeNull();
  });

  it("공백뿐인 값은 null 이다 — 빈 문자열이 남으면 필수값 판정이 갈린다", () => {
    expect(normalizeItemName("   \r\n  ")).toBeNull();
  });

  it("번호만 있는 셀은 원본을 남긴다 — 이름이 사라지는 것보다 낫다", () => {
    expect(normalizeItemName("3. ")).toBe("3.");
  });
});
