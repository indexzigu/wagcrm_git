// 셀러 카테고리 적합도 프로필 — ai_seller_profiles.ai_tags에 이미 저장된 데이터만으로
// "이 셀러가 10개 커머스 카테고리(뷰티/패션/리빙/식품/육아/다이어트/건강/스포츠/일상/교육)에
// 각각 몇 점 부합하는지"를 산출한다.
// matcher.ts가 담당하는 "선택한 상품 카테고리 적합도"(상품 관점)와 다른 축 — 이건 셀러 관점 프로필이다.
//
// 데이터 소스: ai_tags.category(주 카테고리 1개, LLM 권위 지정) · ai_tags.sub_categories(문자열 배열) ·
// ai_tags.tags(문자열 배열). JSONB 왕복을 거친 any이므로 입구에서 방어 정규화한다 (scores.ts normalizeMetrics 패턴).
//
// ponytail: 태그 기반 휴리스틱 — 오탐 가능(예 '헤어스타일링'이 뷰티(헤어)·패션(스타일) 양쪽에 걸림), 정밀판은 LLM 카테고리별 점수 출력(스키마 변경) 업그레이드 경로

export interface CategoryAffinity {
  category: string;        // CATEGORY_ORDER 10개 중 하나
  score: number;           // 0~100 정수
  isPrimary: boolean;      // ai_tags.category와 일치
  matchedTerms: string[];  // 이 카테고리로 매칭된 tag/sub_category 원문 (근거)
}

// ---------- 카테고리 순서·enum ----------
// 표시 순서 = 동점 tie-break 순서 (뷰티 > 패션 > 리빙 > 식품 > 육아 > 다이어트 > 건강 > 스포츠 > 일상 > 교육)
// gemini.ts analysisSchema의 category enum과 1:1 — 어긋나면 주 카테고리(isPrimary) 인식이 조용히 깨진다.
const CATEGORY_ORDER = ['뷰티', '패션', '리빙', '식품', '육아', '다이어트', '건강', '스포츠', '일상', '교육'] as const;
type CommerceCategory = (typeof CATEGORY_ORDER)[number];

// 카테고리별 키워드 사전 (정규화=trim+소문자 후 부분포함 매칭).
// 오탐 줄이려 2글자 이상 특정어만 수록한다. 다중 히트 허용(예: '책육아' → 교육+육아).
const CATEGORY_KEYWORDS: Record<CommerceCategory, string[]> = {
  뷰티: ['뷰티', '메이크업', '화장', '스킨케어', '피부', '미백', '코스메틱', '파운데이션', '쿠션', '클렌징', '세안', '향수', '네일', '헤어', '에센스', '세럼', '마스크팩', '구강케어', '홈케어'],
  패션: ['패션', '데일리룩', '코디', 'ootd', '스타일', '착장', '아우터', '원피스', '가방', '신발', '슈즈', '액세서리', '주얼리', '데님', '니트', '룩북'],
  리빙: ['리빙', '인테리어', '살림', '주방', '가전', '수납', '정리', '가구', '침구', '홈카페', '플랜테리어', '캔들', '디퓨저', '홈데코'],
  // '다이어트'는 다이어트 카테고리 신설로 이동 (2026-07-07 택소노미 10개 확장)
  식품: ['식품', '맛집', '레시피', '요리', '먹방', '간식', '디저트', '밀키트', '베이킹', '반찬', '비건', '간편식', '건강식'],
  육아: ['육아', '아기', '아이', '유아', '키즈', '신생아', '임신', '출산', '이유식', '유모차', '기저귀', '장난감', '아동'],
  다이어트: ['다이어트', '체지방', '감량', '식단관리', '바디프로필', '프로틴', '단백질'],
  건강: ['건강', '영양제', '비타민', '유산균', '홍삼', '콜라겐', '건기식', '면역', '오메가', '관절', '약사', '약국'],
  스포츠: ['운동', '스포츠', '피트니스', '헬스장', '요가', '필라테스', '골프', '러닝', '등산', '캠핑', '테니스'],
  일상: ['일상', '데일리', '브이로그', '생필품', '생활용품'],
  교육: ['교육', '학습', '공부', '책육아', '독서', '전집', '학원', '클래스', '강의'],
};

// ---------- 입력 정규화 (JSONB 경계 방어) ----------

/** 값이 문자열 배열이면 유효 문자열만 추린다. 배열 아니면 빈 배열. */
function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/** 매칭용 정규화: trim + 소문자 */
function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

// ---------- 비주 카테고리 점수 산식 ----------
// ponytail: 경험적 임계값, 자사 셀러 풀 분위수로 교체 예정 (주 카테고리 100보다 항상 낮게)
function matchCountScore(matchCount: number): number {
  if (matchCount <= 0) return 0;
  if (matchCount === 1) return 40;
  if (matchCount === 2) return 65;
  return 85; // 3개 이상
}

/**
 * 셀러 카테고리 적합도 프로필 계산 진입점. 입력을 unknown으로 받아 내부에서 정규화한다 —
 * 콜사이트(ai_seller_profiles[0].ai_tags)가 JSONB 왕복된 any이므로 어떤 형태가 와도 throw하지 않는다.
 * 반환: 전체(10개) 카테고리 배열, score 내림차순 정렬(동점 시 CATEGORY_ORDER 순) — 소비처 계약 유지.
 */
export function computeCategoryProfile(aiTags: unknown): CategoryAffinity[] {
  const obj = aiTags && typeof aiTags === 'object' && !Array.isArray(aiTags) ? (aiTags as Record<string, unknown>) : null;

  // 주 카테고리: LLM이 지정한 enum 값. enum 밖이거나 없으면 null (isPrimary 전부 false로 수렴).
  const rawCategory = obj ? obj.category : undefined;
  const primary: CommerceCategory | null =
    typeof rawCategory === 'string' && (CATEGORY_ORDER as readonly string[]).includes(rawCategory)
      ? (rawCategory as CommerceCategory)
      : null;

  // tags ∪ sub_categories. 문자열 배열인 구형 ai_tags(예: 이별미 케이스)는 배열 자체를 tags로 흡수한다.
  let terms: string[];
  if (Array.isArray(aiTags)) {
    terms = stringArray(aiTags);
  } else {
    terms = [...stringArray(obj ? obj.tags : undefined), ...stringArray(obj ? obj.sub_categories : undefined)];
  }

  const affinities: CategoryAffinity[] = CATEGORY_ORDER.map((category) => {
    // 이 카테고리로 매칭된 원문 수집 (중복 제거, 원문 그대로 보존)
    const keywords = CATEGORY_KEYWORDS[category];
    const matchedTerms: string[] = [];
    const seen = new Set<string>();
    for (const term of terms) {
      const norm = normalizeTerm(term);
      if (norm.length === 0) continue;
      const hit = keywords.some((kw) => norm.includes(kw));
      // 중복제거는 정규화된 키 기준 — 대소문자만 다른 동일 태그(OOTD/ootd)의 중복 카운트 방지
      if (hit && !seen.has(norm)) {
        seen.add(norm);
        matchedTerms.push(term); // 표시용 원문은 그대로 보존
      }
    }

    const isPrimary = primary !== null && category === primary;
    // 주 카테고리는 매칭 여부와 무관하게 100 고정 (LLM의 권위적 지정). 그 외는 matchCount 기준.
    const score = isPrimary ? 100 : matchCountScore(matchedTerms.length);

    return { category, score, isPrimary, matchedTerms };
  });

  // score 내림차순 정렬, 동점 시 CATEGORY_ORDER 순 유지
  const orderIndex = (c: string) => CATEGORY_ORDER.indexOf(c as CommerceCategory);
  affinities.sort((a, b) => (b.score - a.score) || (orderIndex(a.category) - orderIndex(b.category)));

  return affinities;
}
