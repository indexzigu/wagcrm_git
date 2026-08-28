/**
 * 셀러 AI 종합점수(composite 0~100) 밴드 — 흰 표면(셀러 목록·상세 ScoreCard)의 색 규칙 SSOT.
 *
 * `goal-band.ts`(히어로 달성)·`profit-tone.ts`(손익)와 같은 이유로 한 곳에 둔다: 화면마다
 * 삼항을 새로 쓰면 규칙이 갈라진다. 이 프로젝트에서 실제로 반복된 버그다.
 *
 * **경계는 여기서 새로 정한 게 아니다.** 아래 두 상수는 원래
 * `seller-analysis/reviewMapping.ts` 에 있던 값을 **의존성 없는 leaf 로 옮겨온 것**이며
 * (정의는 여전히 한 곳), reviewMapping 이 여기서 import 해 `suggestFitLevel` 에 쓴다.
 * 옮긴 이유: 색 규칙 모듈이 도메인 분석 체인(metrics.ts + scores.ts ≈ 750줄)을 끌고 들어오면
 * 셀러 **목록** 번들에 분석 로직이 딸려온다. 자매 SSOT 2종도 전부 의존성 0 leaf 다.
 *
 * **경계값을 지금 분포에 맞춰 재보정하지 말 것(오너 확정 2026-07-16).** 이 점수는 절대평가이고
 * 분석을 받은 셀러가 전체가 아니다 — 부분 표본의 분위수에 컷을 맞추면 편향된 표본에 규칙을
 * 맞추는 셈이 된다. (`seller-fit.ts` 의 분위수 재보정은 성격이 다른 상대평가 축이다.)
 *
 * 3밴드 설계(오너 확정 2026-07-16, 시안 v2 B안) — `goal-band.ts` 와 **같은 구조**다:
 * - 추천(≥65) = `--status-success`. "쓸 만한 셀러 찾기"가 이 화면의 주 업무라 좋은 쪽도 켠다.
 * - 보류(48~64) = **무채색**. 색의 부재가 아니라 "볼 것 없음"이라는 **등급**이다
 *   (`goal-band.ts` 의 normal 과 같은 논리 — 늘 있는 상태를 칠하면 양끝이 안 튄다).
 * - 비추천(<48) = `--status-urgent-text`. 거를 신호.
 *
 * 대비(흰 배경): `--status-success` #047857 = 5.48:1 · `--status-urgent-text` #8F3C3C = 7.29:1 ·
 * 무채색 `slate-800` #1E293B = 14.63:1. 전부 AA 통과. 원색 `--status-urgent`(#BF5050 4.69)와
 * `emerald-600`(#059669 3.77 — AA 미달)은 이 표의 12px 숫자에 쓰지 않는다.
 *
 * **`--money-in-text` 를 쓰지 말 것** — 값(#047857)이 `--status-success` 와 같아도 그건 자금 방향
 * 축이다(`profit-tone.ts` 참조). AI 점수는 돈이 아니라 품질 판정이므로 상태 축을 쓴다.
 * **네이비 표면에 쓰지 말 것** — 어두운 배경은 `goal-band.ts` 소관이다.
 */

/** 추천 승격선 — 이 값 **이상**이면 추천. (구 `reviewMapping.COMPOSITE_RECOMMEND_THRESHOLD`) */
export const COMPOSITE_RECOMMEND_THRESHOLD = 65;

/** 보류 하한 — 이 값 **미만**이면 비추천. (구 `reviewMapping.COMPOSITE_HOLD_THRESHOLD`) */
export const COMPOSITE_HOLD_THRESHOLD = 48;

export type SellerScoreBand = "recommend" | "hold" | "reject";

/**
 * composite(0~100) → 밴드. 미분석(`null`)이면 `null` — 호출부가 "분석" 버튼/"미분석"을 렌더한다.
 *
 * **미분석은 0점이 아니다.** `seller-fit.ts` 가 고쳤던 결함과 같은 함정 — 미입력을 0으로 합산해
 * 평가를 안 한 셀러가 낙제 처리됐었다. 여기서도 `null`은 "판단 불가"지 "최하위"가 아니다.
 *
 * 경계: `>= 65` 추천 / `>= 48` 보류 / 그 미만 비추천 — `suggestFitLevel`(reviewMapping)과
 * **정확히 같은 부등호**다. 화면 색과 저장되는 제안 등급이 어긋나면 안 된다.
 */
export function resolveSellerScoreBand(
  composite: number | null | undefined,
): SellerScoreBand | null {
  if (composite == null || !Number.isFinite(composite)) return null;
  if (composite >= COMPOSITE_RECOMMEND_THRESHOLD) return "recommend";
  if (composite >= COMPOSITE_HOLD_THRESHOLD) return "hold";
  return "reject";
}

/**
 * 밴드별 점수 **숫자 색** — 흰 표면 전용(셀러 목록 표 · 상세 ScoreCard).
 *
 * `hold` 가 무채색인 건 폴백이 아니라 **의도된 등급**이다 — 여기에 amber 를 넣으면 한 행에
 * 색 계열이 3벌(평가 배지 + 신뢰도 + 점수)이 되어 정작 <48 이 묻힌다. 대신 이 작업은
 * **신뢰도 색을 회수**해 벌 수를 2벌로 줄였다(라벨이 "높음/보통/부족"이라 색이 정보를 안 더한다 —
 * `followup-engine.ts` 의 `INFO_BADGE_COLOR` 선례와 동형). 그래서 양끝을 켜도 무지개가 아니다.
 */
export const SELLER_SCORE_BAND_TEXT: Record<SellerScoreBand, string> = {
  recommend: "text-status-success",
  hold: "text-slate-800",
  reject: "text-status-urgent-text",
};

/**
 * 밴드 산출 불가(미분석) 시 색 — 호출부가 폴백을 각자 적으면 화면마다 갈린다(실제로 목록 slate-800 vs
 * 상세 slate-900 로 갈렸다). `goal-band.ts` 의 `GOAL_BAND_TEXT_UNSET_ON_NAVY` 와 같은 자리다.
 *
 * `hold` 와 값이 같아도 **의미가 다르다**(볼 것 없음 vs 판단 불가). 여기선 그게 문제가 안 되는데,
 * 두 표면 다 미분석이면 숫자 자리에 아예 다른 걸 그리기 때문이다 — 목록은 "분석" 버튼/"미분석" 텍스트로
 * 조기 return 하고, 상세는 숫자 대신 `-` 를 찍는다. 즉 색이 유일한 구분 수단이 아니다.
 * (히어로가 미설정에 별도 톤을 둔 건 거기선 같은 자리에 똑같이 숫자%를 찍기 때문이다 — 구조가 다르다.)
 */
export const SELLER_SCORE_BAND_TEXT_UNSET = "text-slate-800";
