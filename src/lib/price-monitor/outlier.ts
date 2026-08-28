// 시장 최저가 후보 이상치 필터 — 순수함수(서버/클라 공유).
//
// 청사진 §설계-이상치: ±20% 밴드(PRICE_BAND)·MATCH_FLOOR 40·수량불일치·
// EXCLUDE_KW(중고|해외직구|리퍼|렌탈|반품|파손). 배제분도 rawResults에 남겨 오배제를 감사할 수
// 있게 한다(호출부가 excluded 배열을 그대로 저장).
import type { ScoredCandidate } from "./scoring";

/** 우리 판매가 대비 허용 가격 밴드. 이 범위를 벗어나면 "비정상적으로 싼 가격"으로 배제한다. */
export const PRICE_BAND = 0.2;

/** 이 매치점수 미만이면 상품이 다르다고 간주해 배제한다. */
export const MATCH_FLOOR = 40;

/** 중고/해외직구/리퍼 등 정상 신품 유통이 아닌 상품을 나타내는 키워드(상품명 기준 배제). */
export const EXCLUDE_KW = /중고|해외직구|리퍼|렌탈|반품|파손/;

export type OutlierReason =
  | "EXCLUDE_KEYWORD"
  | "MATCH_TOO_LOW"
  | "PRICE_BAND_VIOLATION"
  | "QUANTITY_MISMATCH";

export type OutlierCheckResult<T extends ScoredCandidate> = {
  valid: T[];
  excluded: Array<T & { excludeReason: OutlierReason }>;
};

export type OutlierContext = {
  /** 우리 총가(판매가+배송비) — 밴드 계산 기준 */
  ourTotalPrice: number;
  expectedQuantity?: number | null;
};

/**
 * 후보 하나에 대해 배제 사유를 판정한다. 배제 사유가 없으면 null.
 * 여러 조건에 동시에 걸릴 수 있으므로 우선순위(키워드 > 매치점수 > 가격밴드 > 수량)로 하나만 반환.
 */
export function detectOutlierReason(
  candidate: ScoredCandidate,
  ctx: OutlierContext,
): OutlierReason | null {
  const name = candidate.productName ?? "";
  if (EXCLUDE_KW.test(name)) return "EXCLUDE_KEYWORD";

  if (candidate.matchScore < MATCH_FLOOR) return "MATCH_TOO_LOW";

  if (ctx.ourTotalPrice > 0) {
    const lowerBound = ctx.ourTotalPrice * (1 - PRICE_BAND);
    if (candidate.totalPrice < lowerBound) return "PRICE_BAND_VIOLATION";
  }

  if (
    ctx.expectedQuantity != null &&
    candidate.extractedQuantity != null &&
    candidate.extractedQuantity !== ctx.expectedQuantity
  ) {
    return "QUANTITY_MISMATCH";
  }

  return null;
}

/**
 * 후보 목록을 valid/excluded로 분리한다. excluded에도 원본 필드를 그대로 보존해
 * (스프레드) rawResults에 통째로 저장할 수 있게 한다 — "배제분도 rawResults 보존(오배제 감사)".
 */
export function filterOutliers<T extends ScoredCandidate>(
  candidates: T[],
  ctx: OutlierContext,
): OutlierCheckResult<T> {
  const valid: T[] = [];
  const excluded: Array<T & { excludeReason: OutlierReason }> = [];

  for (const candidate of candidates) {
    const reason = detectOutlierReason(candidate, ctx);
    if (reason) {
      excluded.push({ ...candidate, excludeReason: reason });
    } else {
      valid.push(candidate);
    }
  }

  return { valid, excluded };
}
