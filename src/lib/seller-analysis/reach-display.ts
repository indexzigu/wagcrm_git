// [셀러분석] 릴스 조회 배수 표시 문구 SSOT (순수·client-safe) — 셀러 리포트 KPI 카드와 비교표가 같이 쓴다.
// 값이 없을 때는 대시가 아니라 사유를 말한다(「릴스 없음」과 「조회수 미수집」은 다른 정보다).

import { REEL_VIEW_MIN_SAMPLE, type ReachMetrics } from './metrics';

/** 배수 숫자 — 1 미만은 둘째 자리까지(0.04 와 0.4 를 구분), 10 이상은 정수. */
export function formatReelViewMultiple(v: number): string {
  if (v >= 10) return v.toFixed(0);
  if (v >= 1) return v.toFixed(1);
  return String(Number(v.toFixed(2))); // 0.80 → 0.8, 0.04 그대로
}

/** 리포트 카드의 판단 불가 한 줄. 값이 있으면 null. */
export function reachUnavailableLine(reach: ReachMetrics | null): string | null {
  if (!reach) return '재분석하면 표시';
  switch (reach.unavailableReason) {
    case null:
      return reach.reelViewMultiple === null ? '재분석하면 표시' : null;
    case 'NO_REELS':
      return '릴스 없음';
    case 'NO_VIEWS':
      return `조회수 미수집 (릴스 ${reach.reelCount}개)`;
    case 'TOO_FEW':
      return `릴스 ${reach.reelViewSample}개 · ${REEL_VIEW_MIN_SAMPLE}개부터 계산`;
    case 'NO_FOLLOWERS':
      return '팔로워 미수집';
    case 'LEGACY':
      return '재분석하면 표시';
  }
}

/** 비교표 칸의 사유 낱말(좁은 칸이라 짧게). 값이 있으면 null. */
export function reachReasonWord(reach: ReachMetrics | null): string | null {
  if (reach && reach.unavailableReason === null && reach.reelViewMultiple !== null) return null;
  switch (reach?.unavailableReason) {
    case 'NO_REELS':
      return '릴스 없음';
    case 'TOO_FEW':
      return '표본 부족';
    default:
      return '미수집';
  }
}
