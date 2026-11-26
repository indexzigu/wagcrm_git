/**
 * 판매 조건 이름·상품명의 낱말로 표현 규칙 카테고리를 **제안**한다(순수 함수).
 *
 * ⚠️ 제안일 뿐이다 — 저장은 운영자가 「적용」을 누를 때 기존 카테고리 저장 경로로만
 * 일어난다. 이 파일은 DB·네트워크를 쓰지 않는다(계약 테스트가 AST 로 고정).
 * 두 카테고리의 낱말이 함께 걸리면 제안하지 않는다(엉뚱한 규칙 적용보다 미지정이 낫다).
 */
export type SuggestableCategory = "FOOD" | "SUPPLEMENT" | "COSMETIC";

const KEYWORDS: Record<SuggestableCategory, readonly string[]> = {
  SUPPLEMENT: ["유산균", "프로바이오틱스", "비타민", "오메가", "홍삼", "콜라겐", "루테인", "밀크씨슬"],
  COSMETIC: ["크림", "세럼", "앰플", "토너", "선크림", "에센스", "클렌징", "마스크팩"],
  FOOD: ["간식", "소스", "음료", "과자", "김치", "라면", "밀키트"],
};

/**
 * 낱말 일부가 다른 말에 박힌 흔한 경우 — 매칭 전에 걷어 낸다. 한글 lookbehind 는
 * 수분크림·핸드크림까지 죽이므로 쓰지 않는다.
 */
const EXCLUDED_PHRASES = [
  "아이스크림", "생크림", "크림치즈", "크림빵", "슈크림", "토너먼트", "리소스",
] as const;

export interface ClaimCategorySuggestion {
  category: SuggestableCategory;
  /** 근거가 된 낱말 — 화면이 그대로 보여 준다. */
  keyword: string;
}

export const SUGGESTED_CATEGORY_LABEL: Record<SuggestableCategory, string> = {
  FOOD: "식품",
  SUPPLEMENT: "건강기능식품",
  COSMETIC: "화장품",
};

/** 카테고리 미지정(null)일 때 판정에서 빠지는 카테고리 규칙 수 — 실제로 읽은 규칙에서 센다. */
export function countSkippedCategoryRules(
  rules: readonly { category?: string | null }[],
  category: string | null,
): number {
  if (category) return 0;
  return rules.filter((r) => Boolean(r.category)).length;
}

export function suggestClaimCategory(
  ...texts: (string | null | undefined)[]
): ClaimCategorySuggestion | null {
  let haystack = texts.filter(Boolean).join(" ").toLowerCase();
  for (const phrase of EXCLUDED_PHRASES) haystack = haystack.replaceAll(phrase, " ");
  if (!haystack) return null;
  const hits: ClaimCategorySuggestion[] = [];
  for (const category of Object.keys(KEYWORDS) as SuggestableCategory[]) {
    const keyword = KEYWORDS[category].find((k) => haystack.includes(k));
    if (keyword) hits.push({ category, keyword });
  }
  return hits.length === 1 ? hits[0] : null;
}
