// 상품↔셀러 매칭 엔진 (Phase B-4) — 캠페인 배정 보조 랭킹.
// 원칙 (scores.ts와 동일):
//   - 순수 함수, throw 절대 금지, NaN/Infinity 절대 반환 금지
//   - 입력은 전부 unknown/any (JSONB 경계) — 입구에서 안전 추출
//   - 데이터 부족은 0점이 아니라 null + statusLabel (판단 불가와 낙제를 구분)
//   - reasons에 실제 근거를 한국어로 기록
// metrics.ts·scores.ts는 수정하지 않는다 — 이 모듈은 소비자다.

import { computeSubScores, CONFIDENCE_LABELS } from './scores';

// ---------- 타입 ----------

export interface MatchAxis {
  /** 0~100 정수, 계산 불가면 null */
  score: number | null;
  /** total 산출에 쓰이는 가중치 (null 축은 재정규화로 제외) */
  weight: number;
  /** 근거 문자열 (예: "겹친 키워드 2개: 뷰티, 스킨케어") */
  reasons: string[];
  /** null 사유 (예: '키워드 데이터 없음') */
  statusLabel: string | null;
}

export interface MatchResult {
  /** 가용 축 가중평균(재정규화), 전 축 null이면 null */
  total: number | null;
  axes: {
    category: MatchAxis;
    keywords: MatchAxis;
    audience: MatchAxis;
    quality: MatchAxis;
  };
}

/** UI에서 공용으로 쓰는 축 한국어 라벨 (키 순서 = 표시 순서) */
export const MATCH_AXIS_LABELS: Record<keyof MatchResult['axes'], string> = {
  category: '카테고리',
  keywords: '키워드',
  audience: '타깃 연령',
  quality: '채널 품질',
};

// ponytail: 경험적 기준, 실적 데이터 축적 후 보정 (축별 가중치)
const AXIS_WEIGHTS: Record<keyof MatchResult['axes'], number> = {
  category: 0.35,
  keywords: 0.25,
  audience: 0.15,
  quality: 0.25,
};

// ---------- 유틸 (JSONB 경계 방어) ----------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 0~100 정수로 확정 (NaN/Infinity 방어) */
function toScore(v: number): number {
  if (!isFinite(v)) return 0;
  return Math.round(clamp(v, 0, 100));
}

/** 배열이 아닌 순수 객체면 그대로, 아니면 빈 객체 */
function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

/** 비어 있지 않은 trim 문자열 또는 null */
function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** 문자열 배열 안전 추출 (비문자열 원소 제거, trim, 빈 문자열 제거) */
function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 키워드 정규화: trim → 소문자 → 선행 '#' 제거 */
function normalizeKeyword(s: string): string {
  return s.trim().toLowerCase().replace(/^#+/, '');
}

function uniqueKeywords(list: string[]): string[] {
  return [...new Set(list.map(normalizeKeyword).filter(Boolean))];
}

/**
 * ai_tags 정규화. 신형은 {category, tags[], ...} 객체지만,
 * 실 DB에 ai_tags가 태그 문자열 배열 그 자체인 구형 레코드가 존재한다 —
 * 배열이면 tags로만 해석하고 나머지 필드는 빈 객체로 둔다.
 */
function normalizeAiTags(aiTags: unknown): { record: Record<string, any>; tags: string[] } {
  if (Array.isArray(aiTags)) {
    return { record: {}, tags: strArray(aiTags) };
  }
  const record = asRecord(aiTags);
  return { record, tags: strArray(record.tags) };
}

// ---------- 연령 구간 파서 ----------

/**
 * 연령 표기 문자열을 [lo, hi] 구간으로 파싱. 지원 형태:
 *   "20~35" / "20-35" / "20~35세" → [20, 35]
 *   "20대" → [20, 29], "20대~30대" → [20, 39]
 *   "2030" / "2030 여성" (연속 십년대 붙임 표기) → [20, 39]
 * 숫자 2개 미만·범위 불성립·해석 불가 → null. (테스트용 export)
 */
export function parseAgeRange(s: unknown): [number, number] | null {
  if (typeof s !== 'string') return null;
  const text = s.trim();
  if (!text) return null;

  // 1) 'N대' 표기 — 각 십년대를 [d, d+9]로 보고 최소~최대를 취한다 ('20대', '20대~30대')
  const decades = [...text.matchAll(/(\d{1,2})\s*대/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((d) => d >= 10 && d <= 90); // ponytail: 경험적 기준, 실적 데이터 축적 후 보정
  if (decades.length > 0) {
    return [Math.min(...decades), Math.max(...decades) + 9];
  }

  // 2) 명시적 범위 'a~b' / 'a-b' (뒤에 '세' 등 잉여 문자는 무시)
  //    룩어라운드로 긴 숫자열 내부 매칭 차단 — '010-1234-5678' 전화번호 오인 방지 (리뷰 Critical)
  const range = text.match(/(?<!\d)(\d{1,2})\s*[~\-–]\s*(\d{1,2})(?!\d)/);
  if (range) {
    const lo = parseInt(range[1], 10);
    const hi = parseInt(range[2], 10);
    // ponytail: 경험적 기준, 실적 데이터 축적 후 보정 (사람 연령으로 성립하는 5~99 구간만 채택)
    return 5 <= lo && lo <= hi && hi <= 99 ? [lo, hi] : null; // 범위 불성립 → null
  }

  // 3) 십년대 붙임 표기 '2030' / '1020' — 유니코드 경계로 '회원2030' 같은 접합 토큰 거부(리뷰 High),
  //    2자리 그룹이 전부 10~70 사이 10의 배수 + 오름차순일 때만 채택 ('1234' 거부)
  const packed = text.match(/(?<![\p{L}\p{N}])(\d{4,6})(?![\p{L}\p{N}])/u);
  if (packed && packed[1].length % 2 === 0) {
    const parts: number[] = [];
    for (let i = 0; i < packed[1].length; i += 2) {
      parts.push(parseInt(packed[1].slice(i, i + 2), 10));
    }
    // ponytail: 경험적 기준, 실적 데이터 축적 후 보정 (십년대 하한 10 · 상한 70)
    const valid = parts.every(
      (d, i) => d % 10 === 0 && d >= 10 && d <= 70 && (i === 0 || d > parts[i - 1])
    );
    if (valid) {
      return [parts[0], parts[parts.length - 1] + 9];
    }
  }

  return null;
}

// ---------- 축별 계산 ----------

function computeCategoryAxis(
  product: Record<string, any>,
  seller: Record<string, any>,
  at: { record: Record<string, any>; tags: string[] }
): MatchAxis {
  const weight = AXIS_WEIGHTS.category;
  const productCategory = strOrNull(product.category);
  if (!productCategory) {
    return { score: null, weight, reasons: [], statusLabel: '상품 카테고리 없음' };
  }

  // 비교는 소문자+trim 정규화, reasons 표시는 원문 유지 (리뷰 High — 'BEAUTY' vs 'beauty' 일치)
  const normCat = productCategory.toLowerCase();

  // ponytail: 경험적 기준, 실적 데이터 축적 후 보정 (일치 단계별 100/70/40/0)
  const sellerCategory = strOrNull(seller.category);
  if (sellerCategory !== null && sellerCategory.toLowerCase() === normCat) {
    return {
      score: 100,
      weight,
      reasons: [`셀러 카테고리 '${sellerCategory}' 정확 일치`],
      statusLabel: null,
    };
  }

  const subCategories = strArray(at.record.sub_categories);
  if (subCategories.some((sc) => sc.toLowerCase() === normCat)) {
    return {
      score: 70,
      weight,
      reasons: [`셀러 세부 카테고리에 '${productCategory}' 포함`],
      statusLabel: null,
    };
  }

  // 부분 포함 단계는 카테고리 2글자 이상일 때만 — 1글자('뷰')의 우연 매칭 오탐 차단 (리뷰 High)
  if (productCategory.length >= 2) {
    const matchedTag = at.tags.find((t) => t.toLowerCase().includes(normCat));
    if (matchedTag) {
      return {
        score: 40,
        weight,
        reasons: [`AI 태그 '${matchedTag}'에 '${productCategory}' 포함`],
        statusLabel: null,
      };
    }
  }

  return {
    score: 0,
    weight,
    reasons: [`셀러 카테고리 '${sellerCategory ?? '미지정'}': 상품 '${productCategory}'와 불일치`],
    statusLabel: null,
  };
}

function computeKeywordsAxis(
  product: Record<string, any>,
  at: { record: Record<string, any>; tags: string[] }
): MatchAxis {
  const weight = AXIS_WEIGHTS.keywords;
  const productKws = uniqueKeywords(strArray(asRecord(product.marketing_metadata).marketing_keywords));
  const sellerKws = uniqueKeywords([
    ...at.tags,
    ...strArray(asRecord(at.record.audience_analysis).keywords),
  ]);

  if (productKws.length === 0 || sellerKws.length === 0) {
    return { score: null, weight, reasons: [], statusLabel: '키워드 데이터 없음' };
  }

  const sellerSet = new Set(sellerKws);
  const overlap = productKws.filter((k) => sellerSet.has(k));
  // ponytail: 경험적 기준, 실적 데이터 축적 후 보정 (교집합 / min(양쪽 크기) 정규화)
  const score = toScore((overlap.length / Math.min(productKws.length, sellerKws.length)) * 100);

  const reasons: string[] = [`상품 키워드 ${productKws.length}개 vs 셀러 키워드 ${sellerKws.length}개`];
  if (overlap.length > 0) {
    reasons.push(`겹친 키워드 ${overlap.length}개: ${overlap.slice(0, 5).join(', ')}`);
  } else {
    reasons.push('겹친 키워드 없음');
  }
  return { score, weight, reasons, statusLabel: null };
}

function computeAudienceAxis(
  product: Record<string, any>,
  at: { record: Record<string, any>; tags: string[] }
): MatchAxis {
  const weight = AXIS_WEIGHTS.audience;
  const pRange = parseAgeRange(product.target_age);
  const sRange = parseAgeRange(asRecord(at.record.audience_analysis).age_range);
  if (!pRange || !sRange) {
    return { score: null, weight, reasons: [], statusLabel: '연령 정보 파싱 불가' };
  }

  const overlapYears = Math.max(0, Math.min(pRange[1], sRange[1]) - Math.max(pRange[0], sRange[0]) + 1);
  const shorter = Math.min(pRange[1] - pRange[0] + 1, sRange[1] - sRange[0] + 1);
  // ponytail: 경험적 기준, 실적 데이터 축적 후 보정 (겹침 / 짧은 구간 길이 정규화)
  const score = shorter > 0 ? toScore((overlapYears / shorter) * 100) : 0;

  const reasons: string[] = [
    `상품 타깃 ${pRange[0]}~${pRange[1]}세 vs 셀러 오디언스 ${sRange[0]}~${sRange[1]}세`,
  ];
  reasons.push(
    overlapYears > 0 ? `연령 구간 ${overlapYears}년 겹침 (짧은 구간 ${shorter}년 기준)` : '연령 구간 겹침 없음'
  );
  return { score, weight, reasons, statusLabel: null };
}

function computeQualityAxis(at: { record: Record<string, any>; tags: string[] }): MatchAxis {
  const weight = AXIS_WEIGHTS.quality;

  // 1순위: 결정적 지표 기반 종합점수 (scores.ts) — metrics 형태가 뭐든 computeSubScores가 방어
  const scores = computeSubScores(at.record.metrics);
  if (scores.composite !== null) {
    return {
      score: scores.composite,
      weight,
      reasons: [`정량 종합점수 ${scores.composite}점 (${CONFIDENCE_LABELS[scores.confidence]})`],
      statusLabel: null,
    };
  }

  // 2순위 폴백: LLM 공구 적합도 점수 — 숫자 문자열("85")은 Number 변환 후 사용 (리뷰 Medium)
  const rawCss = asRecord(at.record.seller_analysis).commerce_suitability_score;
  let css: number | null = null;
  if (typeof rawCss === 'number' && isFinite(rawCss)) {
    css = rawCss;
  } else if (typeof rawCss === 'string' && rawCss.trim() !== '' && isFinite(Number(rawCss))) {
    css = Number(rawCss);
  }
  if (css !== null && css >= 0 && css <= 100) {
    // ponytail: 경험적 기준, 실적 데이터 축적 후 보정 — 0 초과 10 이하는 0~10 스케일로 기록된
    // 구형 값일 가능성이 높아(8.5 → 9점 오채택 위험) 스케일 불명으로 간주하고 채택하지 않는다
    if (css > 0 && css <= 10) {
      return { score: null, weight, reasons: [], statusLabel: '적합도 점수 스케일 불명' };
    }
    return {
      score: Math.round(css),
      weight,
      reasons: [`LLM 적합도 점수로 대체 (${Math.round(css)}점)`],
      statusLabel: null,
    };
  }

  return { score: null, weight, reasons: [], statusLabel: '품질 지표 없음' };
}

// ---------- 진입점 ----------

/**
 * 상품↔셀러 매칭 점수 계산. 입력이 어떤 형태(null/문자열/배열/빈 객체)라도
 * throw 없이 null 축 + statusLabel로 자연 수렴한다.
 */
export function computeMatch(product: unknown, seller: unknown, aiTags: unknown): MatchResult {
  const p = asRecord(product);
  const s = asRecord(seller);
  const at = normalizeAiTags(aiTags);

  const axes: MatchResult['axes'] = {
    category: computeCategoryAxis(p, s, at),
    keywords: computeKeywordsAxis(p, at),
    audience: computeAudienceAxis(p, at),
    quality: computeQualityAxis(at),
  };

  // total: null 축 제외 가중치 재정규화 (scores.ts composite와 동일 패턴)
  let acc = 0;
  let weightSum = 0;
  for (const key of Object.keys(axes) as Array<keyof MatchResult['axes']>) {
    const axis = axes[key];
    if (axis.score !== null) {
      acc += axis.weight * axis.score;
      weightSum += axis.weight;
    }
  }
  const total = weightSum > 0 ? toScore(acc / weightSum) : null;

  return { total, axes };
}

/** 셀러 목록을 매칭 총점 내림차순 정렬 (total null은 맨 뒤) */
export function rankSellers(
  product: unknown,
  sellers: Array<{ seller: any; aiTags: any }>
): Array<{ seller: any; aiTags: any; match: MatchResult }> {
  const list = Array.isArray(sellers) ? sellers : [];
  return list
    .map((entry) => ({
      seller: entry?.seller,
      aiTags: entry?.aiTags,
      match: computeMatch(product, entry?.seller, entry?.aiTags),
    }))
    .sort((a, b) => {
      if (a.match.total === null && b.match.total === null) return 0;
      if (a.match.total === null) return 1;
      if (b.match.total === null) return -1;
      return b.match.total - a.match.total;
    });
}
