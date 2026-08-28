// categoryProfile.ts — 택소노미 10개 확장(2026-07-07) 검증.
// 전체 카테고리 반환 계약·신규 키워드 매칭·식품↔다이어트 분리·정렬 계약을 고정한다.
import { describe, it, expect } from "vitest";
import { computeCategoryProfile } from "../categoryProfile";

const TAXONOMY = ["뷰티", "패션", "리빙", "식품", "육아", "다이어트", "건강", "스포츠", "일상", "교육"];

function byCategory(aiTags: unknown) {
  const list = computeCategoryProfile(aiTags);
  return Object.fromEntries(list.map((a) => [a.category, a]));
}

describe("computeCategoryProfile — 10개 택소노미 반환 계약", () => {
  it("입력이 없어도 전체 10개 카테고리를 반환한다 (소비처 계약 유지)", () => {
    const list = computeCategoryProfile(null);
    expect(list).toHaveLength(10);
    // 전부 0점 동점 → CATEGORY_ORDER(표시·동점 순서) 그대로
    expect(list.map((a) => a.category)).toEqual(TAXONOMY);
    expect(list.every((a) => a.score === 0 && !a.isPrimary)).toBe(true);
  });

  it("score 내림차순 정렬을 유지한다", () => {
    const list = computeCategoryProfile({ category: "건강", tags: ["영양제", "요가", "비타민"] });
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].score).toBeGreaterThanOrEqual(list[i].score);
    }
    expect(list[0].category).toBe("건강"); // 주 카테고리 100이 최상단
  });

  it("신규 카테고리도 주 카테고리(isPrimary)로 인식한다 — 구 4개 enum 밖이던 값", () => {
    const m = byCategory({ category: "스포츠" });
    expect(m["스포츠"].isPrimary).toBe(true);
    expect(m["스포츠"].score).toBe(100);
  });
});

describe("computeCategoryProfile — 신규 키워드 매칭", () => {
  it("'영양제' → 건강", () => {
    const m = byCategory({ tags: ["영양제"] });
    expect(m["건강"].matchedTerms).toEqual(["영양제"]);
    expect(m["건강"].score).toBeGreaterThan(0);
  });

  it("'책육아' → 교육 + 육아 다중 히트 허용", () => {
    const m = byCategory({ tags: ["책육아"] });
    expect(m["교육"].matchedTerms).toEqual(["책육아"]);
    expect(m["육아"].matchedTerms).toEqual(["책육아"]);
  });

  it("'필라테스' → 스포츠, '브이로그' → 일상", () => {
    const m = byCategory({ tags: ["필라테스", "브이로그"] });
    expect(m["스포츠"].matchedTerms).toEqual(["필라테스"]);
    expect(m["일상"].matchedTerms).toEqual(["브이로그"]);
  });

  it("sub_categories도 매칭 소스로 쓴다 — '이유식' → 육아", () => {
    const m = byCategory({ sub_categories: ["이유식"] });
    expect(m["육아"].matchedTerms).toEqual(["이유식"]);
  });
});

describe("computeCategoryProfile — 식품↔다이어트 분리", () => {
  it("'다이어트'는 다이어트 카테고리로만 매칭되고 식품에서는 제거됐다", () => {
    const m = byCategory({ tags: ["다이어트"] });
    expect(m["다이어트"].matchedTerms).toEqual(["다이어트"]);
    expect(m["식품"].matchedTerms).toEqual([]);
    expect(m["식품"].score).toBe(0);
  });

  it("기존 식품 키워드는 유지된다 — '레시피' → 식품", () => {
    const m = byCategory({ tags: ["레시피"] });
    expect(m["식품"].matchedTerms).toEqual(["레시피"]);
  });
});
