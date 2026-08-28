// 분석 신선도 (§12′ 후속, 2026-07-07 결정): 수집 크론엔 Gemini 재분석을 넣지 않는다
// (리포트는 사람이 볼 때만 가치·워터폴 유료 폴백 리스크·maxDuration 300s 예산 — 크론은 지표-only §11-3).
// 대신 저장된 analyzedAt 경과를 T1 목록·상세 패널에 표시해 사람이 필요한 시점에 재분석을 트리거한다.

// 4주: 피드 구성·ER 지표가 월 단위로 의미 있게 변할 수 있는 기간 (ER 주간 적립 4점 분량)
export const ANALYSIS_STALE_DAYS = 28;

/** 분석 후 경과 일수. 미분석/파싱 불가면 null. */
export function analysisAgeDays(
  analyzedAt: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!analyzedAt) return null;
  const then = new Date(analyzedAt).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((nowMs - then) / 86_400_000);
}

/** ANALYSIS_STALE_DAYS 이상 경과 시 "N주 경과" 라벨, 신선하거나 미분석이면 null. */
export function analysisStaleLabel(
  analyzedAt: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  const days = analysisAgeDays(analyzedAt, nowMs);
  if (days === null || days < ANALYSIS_STALE_DAYS) return null;
  return `${Math.floor(days / 7)}주 경과`;
}
