// 시장 최저가 후보 스코어링 — 순수함수(서버/클라 공유).
//
// 버그④ 복구: market-price-monitor.tsx가 자체 bigram 유사도(calculateSimilarity)를
// 재구현하고 있었다. order-converter/similarity.ts의 computeSimilarityScore(마스터 데이터
// 매칭에도 쓰이는 공용 함수)를 재사용해 이원화를 없앤다.
import { computeSimilarityScore } from "@/lib/order-converter/similarity";
import { inferQuantityFromName } from "./query-builder";

export type ScorableCandidate = {
  productName?: string | null;
  price: number;
  totalPrice: number;
};

export type ScoringContext = {
  /** 우리 검색쿼리(비교 기준 문자열) */
  targetQuery: string;
  /** 옵션 수량/단위 — 있으면 수량 불일치 페널티/보너스 적용 */
  expectedUnit?: string | null;
  expectedQuantity?: number | null;
  /**
   * AI가 추출한 모델명/모델코드(P1-3). 후보 productName에 정규화 후 포함되면 보너스를 준다
   * (P3-1). 페널티는 없다 — 쇼핑몰 상품명에 모델명이 생략되는 경우가 흔하기 때문이다.
   */
  modelName?: string | null;
};

/** 모델 토큰 정규화: lowercase + 공백/하이픈 제거 (P3-1, "PB-10000X" ~ "PB 10000X" 매치용). */
function normalizeModelToken(value: string): string {
  return value.toLowerCase().replace(/[\s-]/g, "");
}

/** 최소 정규화 길이 — 이보다 짧으면 우연 매치 가능성이 높아 스킵한다. */
const MIN_MODEL_TOKEN_LENGTH = 3;

/**
 * 가격/수량/용량 접미 패턴 — 숫자 뒤에 바로 이어지면 그 숫자는 "가격·수량 표기"로 간주하고
 * 모델 토큰 매치에서 제외한다(Major 2). 정규화된 문자열(공백 제거됨) 기준으로 검사하므로
 * 접미어와 숫자 사이에 원래 공백이 있었어도(예: "10000 원") 여기서는 붙어 있다.
 */
const PRICE_QTY_SUFFIX_PATTERN = /^(원|개|박스|통|세트|봉지|포|병|장|매|%|mah|ml|g|kg|mm|cm|분)/i;

/**
 * 정규화된 productName에 정규화된 모델 토큰이 포함되는지 검사한다. 짧은 토큰은 스킵.
 *
 * Major 2 회귀 수정: modelName이 "10000"처럼 숫자로만 구성되면, 후보 상품명의 가격/용량
 * 표기(예: "10000원", "10000mAh") 안의 숫자에 우연히 substring 매치될 위험이 크다(3자 이상
 * 가드는 숫자 토큰을 걸러내지 못한다). 숫자 전용 토큰은 ①매치 지점 양옆이 숫자가 아닌 경계일
 * 것, ②매치 직후 문자열이 가격/수량/용량 접미 패턴으로 시작하지 않을 것(예: "10000원") —
 * 두 조건을 모두 만족해야 인정한다("파워뱅크 10000 블랙"처럼 독립 토큰으로 등장하는 경우만
 * 통과). 영숫자 혼합 모델("PB-10000X")은 이 가드 대상이 아니므로 기존 동작 그대로 유지된다.
 */
function matchesModelToken(productName: string, modelName: string): boolean {
  const normalizedModel = normalizeModelToken(modelName);
  if (normalizedModel.length < MIN_MODEL_TOKEN_LENGTH) return false;
  const normalizedProduct = normalizeModelToken(productName);

  const isNumericOnly = /^\d+$/.test(normalizedModel);
  if (!isNumericOnly) {
    return normalizedProduct.includes(normalizedModel);
  }

  // 숫자 전용 토큰: 등장하는 모든 위치를 검사해 두 조건(비숫자 경계 + 가격/수량 접미사 아님)을
  // 모두 만족하는 위치가 하나라도 있으면 매치.
  let searchStart = 0;
  while (true) {
    const idx = normalizedProduct.indexOf(normalizedModel, searchStart);
    if (idx === -1) return false;
    const before = idx > 0 ? normalizedProduct[idx - 1] : "";
    const afterStr = normalizedProduct.slice(idx + normalizedModel.length);
    const boundaryOk = !/\d/.test(before) && !/^\d/.test(afterStr);
    const isPriceQtySuffix = PRICE_QTY_SUFFIX_PATTERN.test(afterStr);
    if (boundaryOk && !isPriceQtySuffix) return true;
    searchStart = idx + 1;
  }
}

export type ScoredCandidate = ScorableCandidate & {
  /** 0~100 종합 매치 점수 */
  matchScore: number;
  /** 후보 상품명에서 역추출한 수량(없으면 null) */
  extractedQuantity: number | null;
  /** 단위가격(가격/수량). 수량 정보가 없으면 null. */
  unitPrice: number | null;
};

/**
 * 유사도(0~100 스케일) + 수량 토큰 보정을 결합한 매치 점수.
 * computeSimilarityScore는 절대치가 아니라 "매치된 토큰 가중합"이므로, 문자열 길이에 비례해
 * 커질 수 있다. 100 상한으로 clamp해 이후 outlier.ts의 MATCH_FLOOR(40)와 비교 가능한
 * 척도로 맞춘다.
 *
 * 제네릭 T를 받아 호출부가 넘긴 부가 필드(mall/url/channel 등)를 결과 타입에 그대로 보존한다.
 */
export function scoreCandidate<T extends ScorableCandidate>(
  candidate: T,
  ctx: ScoringContext,
): T & ScoredCandidate {
  const productName = candidate.productName ?? "";
  const rawSimilarity = computeSimilarityScore(ctx.targetQuery, productName);
  let score = Math.min(100, rawSimilarity * 20); // 토큰 1개 매치당 20점 스케일 (기존 UI 구현 계승)

  if (ctx.modelName && matchesModelToken(productName, ctx.modelName)) {
    score = Math.min(100, score + 30);
  }

  const extractedQuantity = inferQuantityFromName(productName, ctx.expectedUnit);

  if (ctx.expectedUnit && ctx.expectedQuantity != null) {
    if (extractedQuantity !== null) {
      if (extractedQuantity !== ctx.expectedQuantity) {
        score = score * 0.3; // 수량 불일치 — 강한 페널티
      } else {
        score = Math.min(100, score + 15); // 수량 일치 보너스
      }
    } else {
      score = score * 0.8; // 수량 정보 자체가 없음 — 경미한 페널티
    }
  }

  const qtyForUnitPrice = extractedQuantity ?? ctx.expectedQuantity ?? null;
  const unitPrice =
    qtyForUnitPrice && qtyForUnitPrice > 0
      ? candidate.totalPrice / qtyForUnitPrice
      : null;

  return {
    ...candidate,
    matchScore: Math.round(score),
    extractedQuantity,
    unitPrice,
  };
}

export function scoreCandidates<T extends ScorableCandidate>(
  candidates: T[],
  ctx: ScoringContext,
): Array<T & ScoredCandidate> {
  return candidates.map((c) => scoreCandidate(c, ctx));
}

/** 우리 판매가의 단위가격(원/단위). 수량 정보가 없으면 null. */
export function computeOurUnitPrice(
  ourTotalPrice: number,
  expectedQuantity: number | null | undefined,
): number | null {
  if (!expectedQuantity || expectedQuantity <= 0) return null;
  return ourTotalPrice / expectedQuantity;
}
