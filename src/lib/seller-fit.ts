// 셀러 적합성(fitLevel) 자동 판정 — 단일 진실 원천 (SSOT).
// 4개 수동 평가 필드("N.라벨" 형태 문자열)의 숫자 접두사 합산(0~12)으로 추천/보류/비추천을 판정한다.
// 소비처: sellerService.updateSeller · PATCH /api/sellers/[id] (과거 두 곳에 중복 구현돼 있던 로직의 공용화).
// 제안 어휘 정합: src/lib/seller-analysis/reviewMapping.ts 도 이 규칙을 기준으로 문서화한다.
//
// 컷 근거 (2026-07-07, 실데이터 158명 실측 시뮬레이션):
//  - 구 컷(>10 추천 / >5 보류)은 합산 히스토그램에서 보류에 65%가 뭉쳐 변별력이 없었다.
//  - 신 컷(>9 추천 / >6 보류)은 추천 29% / 보류 44% / 비추천 27%로 분포가 펴진다.
//
// 미입력 처리 (구 구현의 결함 수정):
//  - 과거엔 미입력·파싱 불가 필드를 0점으로 합산해, 평가를 아예 안 한 셀러도 "비추천"으로 낙제 처리됐다.
//  - 이제 파싱 불가/null은 "미입력"으로 취급한다. 전부 미입력이면 null을 반환하고,
//    호출부는 fitLevel 자동 갱신을 스킵한다(미입력 ≠ 낙제).
//  - 부분 입력은 입력된 필드 평균을 4필드 만점(0~12 스케일)으로 정규화한 뒤 컷을 적용한다.

export const FIT_RECOMMEND_THRESHOLD = 9; // 초과 시 추천 (구 10)
export const FIT_HOLD_THRESHOLD = 6; // 초과 시 보류 (구 5)

export interface FitScoreFields {
  collaborationScore: string | null;
  adResponseScore: string | null;
  commentResponseScore: string | null;
  activityFrequency: string | null;
}

/** "N.라벨" 문자열에서 숫자 접두사 N을 파싱. null/파싱 불가면 null(=미입력). */
function parseScorePrefix(val: string | null): number | null {
  if (!val) return null;
  const match = val.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * 합산 기반 fitLevel 자동 판정.
 * @returns '추천' | '보류' | '비추천' — 전부 미입력이면 null (호출부는 fitLevel 자동 갱신을 스킵할 것)
 */
export function computeFitLevel(fields: FitScoreFields): string | null {
  const entered = [
    parseScorePrefix(fields.collaborationScore),
    parseScorePrefix(fields.adResponseScore),
    parseScorePrefix(fields.commentResponseScore),
    parseScorePrefix(fields.activityFrequency),
  ].filter((n): n is number => n !== null);

  if (entered.length === 0) return null;

  // 부분 입력 정규화: 입력된 필드 평균 × 4 → 0~12 스케일로 환산 (4필드 전부 입력이면 합계 그대로)
  const sum = entered.reduce((a, b) => a + b, 0);
  const normalized = Math.round((sum / entered.length) * 4);

  if (normalized > FIT_RECOMMEND_THRESHOLD) return "추천";
  if (normalized > FIT_HOLD_THRESHOLD) return "보류";
  return "비추천";
}
