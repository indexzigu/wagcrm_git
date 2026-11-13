// 시장 최저가 판정 — 순수함수(서버/클라 공유).
//
// 청사진 §설계-판정: OK / TIE(±1%) / VIOLATED(알림) / NO_DATA(운영 신호)

export const TIE_BAND = 0.01;

/**
 * 위반(VIOLATED)을 "확정"해 알림·칸반 배지를 만들 만큼 "같은 상품이라고 확신"하는 최소
 * 일치율(matchScore, 0~100). 최저가를 만든 결정적 후보가 이 미만이면 다른 품목일 가능성이
 * 높다고 보고 REVIEW(검토·알림X)로 강등한다.
 *
 * outlier.ts의 MATCH_FLOOR(40)와 역할이 다르다: MATCH_FLOOR는 "목록/감사에 남길 후보" 하한,
 * 이 값은 그보다 높은 "위반 경고를 보낼 확신" 하한이다(40 ≤ 검토구간 < 60 ≤ 위반구간).
 * 보수적으로 60에서 시작하며, 매칭 로직이 고도화되면 70~80까지 올릴 수 있는 튜닝 상수다.
 */
export const VIOLATION_CONFIDENCE_FLOOR = 60;

/** 축 분리 전 「수량 정보 없음」 감점 계수 — 아래 하한을 이 값에서 끌어낸다. */
const LEGACY_MISSING_QUANTITY_FACTOR = 0.8;

/**
 * 구성(수량)을 모르는 후보 — 우리 쪽 수량은 알지만 후보 상품명에서 수량을 못 뽑은 경우 — 의 확신 하한.
 * 2026-11-13 축 분리 전에는 이런 후보의 단일 점수에 ×0.8 을 곱해 60 을 넘기려면 원점수 75 가
 * 필요했다. 축을 나누며 그 감점이 빠졌으므로, 같은 효과를 확신 하한에서 유지한다.
 * 목록·배제 판정(MATCH_FLOOR)에는 쓰지 않는다 — 위반 "확정" 근거로 쓸지에만 쓴다. 값 = 75.
 */
export const COMPOSITION_UNKNOWN_CONFIDENCE_FLOOR = Math.ceil(VIOLATION_CONFIDENCE_FLOOR / LEGACY_MISSING_QUANTITY_FACTOR);

/**
 * - OK / TIE / VIOLATED / NO_DATA: computeVerdict가 가격만으로 판정한다.
 * - REVIEW: 최저가 후보의 일치율이 VIOLATION_CONFIDENCE_FLOOR(60) 미만(수량을 못 읽은 후보는
 *   COMPOSITION_UNKNOWN_CONFIDENCE_FLOOR(75) 미만)이라 "같은 상품 위반"으로
 *   확신할 수 없어 강등된 상태(evaluateMarketPrice에서 파생). 알림·칸반 위반 배지를 만들지
 *   않고, 운영자 수동 검토용으로만 노출한다.
 */
export type PriceVerdict = "OK" | "TIE" | "VIOLATED" | "REVIEW" | "NO_DATA";

export type VerdictInput = {
  /** 우리 총가(판매가+배송비) 또는 단위가격 — minValidPrice와 동일 축(총가 vs 총가, 단위가 vs 단위가)이어야 함 */
  ourPrice: number | null;
  /** 이상치 필터를 통과한 유효 후보 중 최저가. 유효 후보가 없으면 null. */
  minValidPrice: number | null;
};

/**
 * 우리 가격과 시장 유효 최저가를 비교해 판정한다.
 * - NO_DATA: 유효 비교 대상이 없음(우리 가격 미상 또는 시장 유효 후보 0건)
 * - TIE: 서로 ±1% 이내 — 사실상 동가
 * - OK: 우리가 시장 최저가와 같거나 더 쌈(TIE 범위 밖에서)
 * - VIOLATED: 시장에 우리보다 확실히 싼 유효 후보가 있음
 */
export function computeVerdict({ ourPrice, minValidPrice }: VerdictInput): PriceVerdict {
  if (ourPrice == null || !Number.isFinite(ourPrice) || ourPrice <= 0) return "NO_DATA";
  if (minValidPrice == null || !Number.isFinite(minValidPrice)) return "NO_DATA";

  const diffRatio = (ourPrice - minValidPrice) / minValidPrice;

  if (Math.abs(diffRatio) <= TIE_BAND) return "TIE";
  if (diffRatio <= 0) return "OK";
  return "VIOLATED";
}
