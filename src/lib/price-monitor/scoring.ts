// 시장 최저가 후보 스코어링 — 순수함수(서버/클라 공유).
//
// 서버(cron)와 화면(market-price-monitor.tsx)이 같은 함수를 쓴다(판정 일원화 — 버그④).
// 2026-11-13: 종전 computeSimilarityScore(토큰 개수 × 20) 단일 점수를 버리고 match-axes.ts 의
// 세 축(브랜드·상품·구성)으로 나눴다. 그 함수는 주문 매핑용으로 남아 있고 여기서는 쓰지 않는다.
import { inferQuantityFromName } from "./query-builder";
import {
  brandAxis,
  candidateNameKey,
  productCoreWords,
  productScore,
  type BrandAxis,
} from "./match-axes";

export type ScorableCandidate = {
  productName?: string | null;
  price: number;
  totalPrice: number;
  /** 판매처 — 브랜드 축(회사명이 판매처에만 있는 경우)과 오너 표시 열쇠에 쓴다. */
  mall?: string | null;
  /** 상품 주소 — 오너 표시 보조 열쇠. */
  url?: string | null;
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
  /**
   * 브랜드·회사 축의 정체성 이름(딜 brandName + 오너가 등록한 회사 이름 등). 비어 있으면 브랜드
   * 축은 unknown 이고 판정에 쓰이지 않는다(종전 동작). 2026-11-13 3축 분리.
   */
  brandIdentities?: readonly string[];
  /** 오너가 남긴 「같은 상품 / 다른 상품」 표시 — 열쇠가 맞는 후보에 붙는다. */
  ownerLabels?: readonly OwnerMatchLabel[];
};

export type OwnerMatchLabelValue = "SAME" | "DIFFERENT";

export type OwnerMatchLabel = {
  nameKey: string;
  urlKey: string | null;
  label: OwnerMatchLabelValue;
};

/**
 * 후보에 해당하는 오너 표시를 찾는다 — 판매처+상품명 열쇠로만. 주소 열쇠(urlKey)는 기록용이다:
 * 쿠팡 제휴 주소는 쿼리를 떼면 전부 같은 값이 되어, 한 건 표시가 다른 쿠팡 후보 전체에 번진다.
 */
export function findOwnerLabel(
  candidate: { productName?: string | null; mall?: string | null },
  labels: readonly OwnerMatchLabel[] | undefined,
): OwnerMatchLabelValue | null {
  if (!labels || labels.length === 0) return null;
  const nameKey = candidateNameKey(candidate.mall, candidate.productName);
  return labels.find((l) => l.nameKey === nameKey)?.label ?? null;
}

/** 모델 토큰 정규화: lowercase + 공백/하이픈 제거 (P3-1, "PB-10000X" ~ "PB 10000X" 매치용). */
function normalizeModelToken(value: string): string {
  return value.toLowerCase().replace(/[\s-]/g, "");
}

/** 후보 상품명에 모델명이 있으면 더하는 상품 점수. */
export const MODEL_MATCH_BONUS = 30;

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
export function matchesModelToken(productName: string, modelName: string): boolean {
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
  /**
   * 0~100 상품 일치 점수(축 ②, 모델명 보너스 포함). 2026-11-13 전에는 브랜드·수량까지 섞인
   * 단일 점수였다 — 저장된 옛 스냅샷의 값은 그 기준이다.
   */
  matchScore: number;
  /** 축 ① 브랜드·회사 일치. 옛 스냅샷에는 없다. */
  brandMatch?: BrandAxis;
  /** 오너 표시(같은 상품/다른 상품). 없으면 null. */
  ownerLabel?: OwnerMatchLabelValue | null;
  /** 후보 상품명에서 역추출한 수량(없으면 null) */
  extractedQuantity: number | null;
  /** 단위가격(가격/수량). 수량 정보가 없으면 null. */
  unitPrice: number | null;
};

/**
 * 후보 하나를 세 축으로 채점한다 — matchScore(상품 축, 0~100) · brandMatch(브랜드 축) ·
 * extractedQuantity(구성 축 재료) · ownerLabel(오너 표시). 배제·강등 판정은 outlier/pipeline 몫이다.
 *
 * 제네릭 T를 받아 호출부가 넘긴 부가 필드(mall/url/channel 등)를 결과 타입에 그대로 보존한다.
 */
export function scoreCandidate<T extends ScorableCandidate>(
  candidate: T,
  ctx: ScoringContext,
): T & ScoredCandidate {
  const identities = ctx.brandIdentities ?? [];
  return scoreWithCoreWords(candidate, ctx, productCoreWords(ctx.targetQuery, { identities, unit: ctx.expectedUnit }));
}

function scoreWithCoreWords<T extends ScorableCandidate>(
  candidate: T,
  ctx: ScoringContext,
  coreWords: readonly string[],
): T & ScoredCandidate {
  const productName = candidate.productName ?? "";
  const identities = ctx.brandIdentities ?? [];
  let score = productScore(coreWords, productName);

  if (ctx.modelName && matchesModelToken(productName, ctx.modelName)) {
    score = Math.min(100, score + MODEL_MATCH_BONUS);
  }

  // 축 ③ 구성(수량)은 점수에 섞지 않는다 — 수량이 다르면 outlier 가 QUANTITY_MISMATCH 로 따로
  // 배제한다(오너 지적: 축을 섞으면 일치율이 엇갈린다). 단위가격 계산용으로만 추출한다.
  const extractedQuantity = inferQuantityFromName(productName, ctx.expectedUnit);

  const qtyForUnitPrice = extractedQuantity ?? ctx.expectedQuantity ?? null;
  const unitPrice =
    qtyForUnitPrice && qtyForUnitPrice > 0
      ? candidate.totalPrice / qtyForUnitPrice
      : null;

  return {
    ...candidate,
    matchScore: Math.round(score),
    brandMatch: brandAxis({ productName, mall: candidate.mall }, identities),
    ownerLabel: findOwnerLabel(candidate, ctx.ownerLabels),
    extractedQuantity,
    unitPrice,
  };
}

export function scoreCandidates<T extends ScorableCandidate>(
  candidates: T[],
  ctx: ScoringContext,
): Array<T & ScoredCandidate> {
  // 기준 낱말은 후보마다 같으므로 한 번만 만든다(모달은 입력 중에도 다시 판정한다).
  const coreWords = productCoreWords(ctx.targetQuery, { identities: ctx.brandIdentities ?? [], unit: ctx.expectedUnit });
  return candidates.map((c) => scoreWithCoreWords(c, ctx, coreWords));
}

/** 우리 판매가의 단위가격(원/단위). 수량 정보가 없으면 null. */
export function computeOurUnitPrice(
  ourTotalPrice: number,
  expectedQuantity: number | null | undefined,
): number | null {
  if (!expectedQuantity || expectedQuantity <= 0) return null;
  return ourTotalPrice / expectedQuantity;
}
