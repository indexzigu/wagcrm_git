// 시장 최저가 모니터링 파이프라인 조립 — 순수함수(서버/클라 공유).
// scoring → outlier → verdict 를 한 번에 묶어 API route(price-monitoring, cron)와
// UI(market-price-monitor.tsx)가 동일한 판정 로직을 쓰게 한다("모달과 판정 로직 일원화").
import { scoreCandidates, computeOurUnitPrice, type ScorableCandidate, type ScoredCandidate } from "./scoring";
import { filterOutliers, type OutlierReason } from "./outlier";
import { computeVerdict, VIOLATION_CONFIDENCE_FLOOR, type PriceVerdict } from "./verdict";

export type EvaluateInput<T extends ScorableCandidate> = {
  candidates: T[];
  targetQuery: string;
  ourTotalPrice: number;
  expectedUnit?: string | null;
  expectedQuantity?: number | null;
  /** AI가 추출한 모델명/모델코드(P3-2) — scoreCandidates ctx로 그대로 전달된다. */
  modelName?: string | null;
};

export type EvaluatedCandidate = ScoredCandidate & { excludeReason?: OutlierReason };

export type EvaluateResult<T extends ScorableCandidate> = {
  verdict: PriceVerdict;
  /** 이상치 배제 후 남은 유효 후보 중 최저 총가 항목 */
  minValidItem: (T & ScoredCandidate) | null;
  /**
   * 신뢰선(VIOLATION_CONFIDENCE_FLOOR) 이상 유효 후보 중 최저 총가 항목. 위반 "확정"의 근거가
   * 되는 후보다(없으면 null → 저매치만 있어 REVIEW로 강등될 수 있음). 모달의 검토 표시용.
   */
  minConfidentItem: (T & ScoredCandidate) | null;
  /** 우리 단위가격(원/단위). 수량 정보가 없으면 null. */
  ourUnitPrice: number | null;
  validCount: number;
  /** 유효+배제 전체 — 배제분은 excludeReason 포함(감사용, rawResults에 그대로 저장) */
  allScored: Array<T & EvaluatedCandidate>;
};

/**
 * 원시 검색 후보 목록을 받아 스코어링 → 이상치 배제 → 판정까지 한 번에 수행한다.
 * 제네릭 T로 호출부의 부가 필드(mall/url/channel 등)를 결과에 그대로 보존한다.
 */
export function evaluateMarketPrice<T extends ScorableCandidate>(
  input: EvaluateInput<T>,
): EvaluateResult<T> {
  const { candidates, targetQuery, ourTotalPrice, expectedUnit, expectedQuantity, modelName } = input;

  const scored = scoreCandidates(candidates, {
    targetQuery,
    expectedUnit,
    expectedQuantity,
    modelName,
  });

  const { valid, excluded } = filterOutliers(scored, {
    ourTotalPrice,
    expectedQuantity,
  });

  const sortedValid = [...valid].sort((a, b) => a.totalPrice - b.totalPrice);
  const minValidItem = sortedValid[0] ?? null;

  // 신뢰선 이상(고신뢰) 후보만 — 위반 "확정"의 근거로 삼는다. 저매치(신뢰선 미만)만으로
  // 최저가가 형성되면 다른 품목일 가능성이 높아 아래에서 REVIEW로 강등한다.
  const minConfidentItem =
    sortedValid.find((c) => c.matchScore >= VIOLATION_CONFIDENCE_FLOOR) ?? null;

  const ourUnitPrice = computeOurUnitPrice(ourTotalPrice, expectedQuantity);

  // 단위가격 비교가 가능하면(양쪽 다 unitPrice 존재) 단위가 기준, 아니면 총가 기준으로 판정한다.
  const canCompareUnitPrice = ourUnitPrice != null && minValidItem?.unitPrice != null;
  const looseVerdict = computeVerdict({
    ourPrice: canCompareUnitPrice ? ourUnitPrice : ourTotalPrice,
    minValidPrice: canCompareUnitPrice ? (minValidItem!.unitPrice as number) : minValidItem?.totalPrice ?? null,
  });

  // 신뢰선 이상 후보 기준 판정 — 이게 VIOLATED면 "고신뢰 위반"(진짜 알림 대상).
  const confidentCanCompareUnit = ourUnitPrice != null && minConfidentItem?.unitPrice != null;
  const confidentVerdict = computeVerdict({
    ourPrice: confidentCanCompareUnit ? ourUnitPrice : ourTotalPrice,
    minValidPrice: confidentCanCompareUnit
      ? (minConfidentItem!.unitPrice as number)
      : minConfidentItem?.totalPrice ?? null,
  });

  // 신뢰도 게이트: 최저가는 위반이지만 신뢰선 이상 후보는 우리보다 싸지 않다면 → 다른 품목
  // 의심으로 보고 REVIEW(검토·알림X)로 강등한다. 그 외에는 기존 판정(looseVerdict)을 유지한다.
  const verdict: PriceVerdict =
    looseVerdict === "VIOLATED" && confidentVerdict !== "VIOLATED" ? "REVIEW" : looseVerdict;

  const allScored: Array<T & EvaluatedCandidate> = [...valid, ...excluded];

  return {
    verdict,
    minValidItem,
    minConfidentItem,
    ourUnitPrice,
    validCount: valid.length,
    allScored,
  };
}
