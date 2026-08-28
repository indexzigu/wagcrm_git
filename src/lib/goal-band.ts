/**
 * 매출 목표 달성률 밴드 — 홈 히어로(네이비 표면)의 색 규칙 SSOT.
 *
 * 오너 확정 2026-07-15(모바일 색 배치 시안). 데스크톱·모바일 히어로가 **같은 규칙**을
 * 쓰게 하려고 여기 한 곳에 둔다 — 각 화면이 따로 삼항을 쓰면 또 갈라진다(그게 이 버그의
 * 원인이었다).
 *
 * 고치는 문제(둘은 서로 다른 고장이다):
 * - 모바일(`mobile-home-view.tsx`): 달성률이 값과 무관하게 **항상 골드**였다(삼항 없음).
 *   61%도 119%도 같은 색 — 색이 값의 함수가 아니었다.
 * - 데스크톱(`dashboard-home.tsx`): `isUp ? 골드 : 흐림`이라 **방향이 거꾸로**였다
 *   (초과=하이라이트, 미달=더 흐림). 아직 미적용 — 이 모듈을 소비하면 해소된다.
 *
 * 3밴드 설계:
 * - 달성(≥100%) = 골드. P8 가드레일 3의 "골드=장식 전용"에 대한 오너 승인 예외
 *   (주문 파이프라인 배송완료에 이어 2번째 — 둘 다 "달성 종착점" 의미다).
 * - 정상(80~99%) = **무채색**. 색의 부재가 아니라 "볼 것 없음"이라는 등급이다.
 *   늘 있는 상태라 칠하면 심각 미달이 안 튄다(리스크 카드의 MISSING_SALES=slate-400과 같은 논리).
 * - 심각(<80%) = `--goal-miss`. 조치 필요 신호.
 */

export type GoalBand = "achieved" | "normal" | "missed";

/** 심각 미달 임계(%) — 이 아래면 조치 신호(오너 확정 2026-07-15) */
export const GOAL_MISS_THRESHOLD = 80;

/** 달성 임계(%) — 골드 승격선 */
export const GOAL_ACHIEVED_THRESHOLD = 100;

/**
 * 달성률(%) → 밴드. 목표 미설정 등으로 산출 불가면 `null`(호출부가 "미설정"을 렌더).
 *
 * 경계는 `>= 100` 달성 / `< 80` 심각 — 즉 정확히 80%는 "정상"이고 정확히 100%는 "달성"이다.
 */
export function resolveGoalBand(rate: number | null | undefined): GoalBand | null {
  if (rate == null || !Number.isFinite(rate)) return null;
  if (rate >= GOAL_ACHIEVED_THRESHOLD) return "achieved";
  if (rate < GOAL_MISS_THRESHOLD) return "missed";
  return "normal";
}

/**
 * 밴드별 달성률 **숫자 색** — 히어로 네이비(`--hero-navy` #08314E) 표면 전용이다.
 * 흰 배경에 그대로 옮기지 말 것: `--goal-miss` 는 흰 위에서 2.69:1 로 비텍스트 3:1 도
 * 미달이다(네이비 위 5.00 과 다른 세계). 흰 카드의 위험색은 `--status-urgent` 계열.
 *
 * 대비 실측(네이비 위): 골드 8.61:1 · white/70 7.34:1 · goal-miss 5.00:1 — 전부 AA 통과.
 * `white/70`인 이유: `white/90`(11.13)은 **골드(8.61)보다 밝아** 무채색이 달성보다 튀는
 * 역전이 나고, `white/50`(4.51)은 목표 라벨과 동률이 되어 "달성률이 그 줄에서 가장 흐린"
 * 데스크톱 버그를 그대로 이식한다. 위계는 명도가 아니라 **채도**가 만든다 — white/70은
 * 채도 0이라 hue를 가진 골드·로즈에 밀린다.
 */
export const GOAL_BAND_TEXT_ON_NAVY: Record<GoalBand, string> = {
  achieved: "text-accent-gold-soft",
  normal: "text-white/70",
  missed: "text-goal-miss",
};

/**
 * 밴드별 진행바 **fill 색** — 숫자와 짝을 이루는 2번째 캐리어다. 히어로 네이비 전용.
 *
 * 텍스트 색 하나만으로는 실외에서 안 읽힌다(P3: 모바일은 실외 사용). 리스크 카드가
 * 통한 이유가 배지 fill+도트+아이콘 다중 캐리어였던 것과 같은 이유로, 면적이 있는
 * 바를 함께 태운다. 필(pill)·도트는 오너가 기각했다 — 늘리지 말 것.
 *
 * **정상 밴드가 `white/45`인 이유(내리지 말 것):** fill 은 트랙(`bg-white/10`) 위에 얹히므로
 * 대비 기준은 네이비가 아니라 **트랙 대비**다. 첫 구현의 `white/35`는 트랙 대비 2.65:1 로
 * 비텍스트 3:1 미달이었다 — 밴드 색이 안 보이는 정도가 아니라 **바가 얼마나 찼는지 자체를
 * 못 읽어** 88% 같은 평상시에 진행 표시가 통째로 죽었다(ss-ux-designer 검토 적발).
 * `white/45` = 트랙 대비 3.39:1. 골드 4.76 · goal-miss 3.72 보다 여전히 낮아 "무채색이 가장
 * 조용하다" 순서는 유지된다.
 */
export const GOAL_BAND_FILL_ON_NAVY: Record<GoalBand, string> = {
  achieved: "bg-accent-gold",
  normal: "bg-white/45",
  missed: "bg-goal-miss",
};

/**
 * 밴드 산출 불가(목표 미설정) 시 숫자 색 — "정상"(white/70)보다 더 조용한 최하위 톤
 * (네이비 위 4.51:1, AA). 같은 줄의 "목표 미설정" 캡션과 동급으로 앉힌다 — 데이터가 없는
 * 상태이므로 실제 값을 담은 "정상"보다 흐린 게 맞다.
 */
export const GOAL_BAND_TEXT_UNSET_ON_NAVY = "text-white/50";

/**
 * 진행바 너비(%) — 트랙을 넘을 수 없으므로 100에서 자른다.
 * 초과분(예: 118.9%)은 **숫자가 말한다**. 바가 골드로 가득 찬 것 자체가 달성 신호다.
 */
export function goalBarWidth(rate: number | null | undefined): number {
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.min(rate, 100);
}
