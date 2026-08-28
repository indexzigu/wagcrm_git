// seller-fit.ts — 합산 fitLevel 자동 판정 SSOT 테스트.
// 컷(>9 추천 / >6 보류)·전부 미입력 null·부분 입력 정규화·파싱 불가 처리를 고정한다.
import { describe, it, expect } from "vitest";
import { computeFitLevel, FIT_HOLD_THRESHOLD, FIT_RECOMMEND_THRESHOLD } from "../seller-fit";

/** 4필드 축약 헬퍼 — (공구활성, 광고반응, 댓글반응, 활동빈도) */
function fit(
  collaborationScore: string | null,
  adResponseScore: string | null,
  commentResponseScore: string | null,
  activityFrequency: string | null
): string | null {
  return computeFitLevel({ collaborationScore, adResponseScore, commentResponseScore, activityFrequency });
}

describe("computeFitLevel — 컷 경계 (4필드 전부 입력)", () => {
  it("합계 12 (만점) → 추천", () => {
    expect(fit("3.홍보+활성", "3.10개이상", "3.10개이상", "3.매일")).toBe("추천");
  });

  it("합계 10 (>9) → 추천", () => {
    expect(fit("3.홍보+활성", "3.10개이상", "2.10개미만", "2.주5회")).toBe("추천");
  });

  it("합계 9 (경계) → 보류 — 구 컷(>10)이면 보류였고 신 컷에서도 보류", () => {
    expect(fit("3.홍보+활성", "3.10개이상", "2.10개미만", "1.주2-3회")).toBe("보류");
  });

  it("합계 7 (>6) → 보류", () => {
    expect(fit("2.적극홍보", "2.5개이상", "2.10개미만", "1.주2-3회")).toBe("보류");
  });

  it("합계 6 (경계) → 비추천", () => {
    expect(fit("2.적극홍보", "2.5개이상", "1.5개미만", "1.주2-3회")).toBe("비추천");
  });

  it("합계 0 (전부 0점 입력) → 비추천 — 입력된 0점은 미입력이 아니라 낙제", () => {
    expect(fit("0.비노출", "0.없음", "0.없음", "0.주1회이하")).toBe("비추천");
  });

  it("컷 상수 계약 고정 — 추천 >9, 보류 >6", () => {
    expect(FIT_RECOMMEND_THRESHOLD).toBe(9);
    expect(FIT_HOLD_THRESHOLD).toBe(6);
  });
});

describe("computeFitLevel — 미입력 처리", () => {
  it("전부 null → null (자동 갱신 스킵 신호, 미입력 ≠ 낙제)", () => {
    expect(fit(null, null, null, null)).toBeNull();
  });

  it("전부 파싱 불가 문자열 → null (숫자 접두사 없음 = 미입력 취급)", () => {
    expect(fit("높음", "보통", "추천", "-")).toBeNull();
  });

  it("빈 문자열도 미입력 취급", () => {
    expect(fit("", "", "", "")).toBeNull();
  });
});

describe("computeFitLevel — 부분 입력 정규화 round(합계÷입력수×4)", () => {
  it("2필드 합 5 → 5/2×4=10 → 추천 (스펙 예시)", () => {
    expect(fit("3.홍보+활성", "2.5개이상", null, null)).toBe("추천");
  });

  it("1필드 1점 → 1×4=4 → 비추천", () => {
    expect(fit(null, null, null, "1.주2-3회")).toBe("비추천");
  });

  it("1필드 3점 → 3×4=12 → 추천", () => {
    expect(fit("3.홍보+활성", null, null, null)).toBe("추천");
  });

  it("3필드 합 5 → round(6.67)=7 → 보류", () => {
    expect(fit("2.적극홍보", "2.5개이상", "1.5개미만", null)).toBe("보류");
  });

  it("파싱 불가 필드는 분모에서 제외 — 유효 1필드 2점 → 8 → 보류", () => {
    expect(fit("쓰레기값", "2.5개이상", null, null)).toBe("보류");
  });
});
