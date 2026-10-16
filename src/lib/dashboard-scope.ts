// 클라이언트 컴포넌트가 import 하는 모듈 — prisma 등 서버 전용 import 를 두지 말 것.

/** 대시보드 히어로 캡션 — 데스크톱·모바일이 같은 문자열을 그린다(범위 정의를 한 곳에서). */
export const DASHBOARD_SCOPE_CAPTION = "드랍 제외 · 이달에 걸친 캠페인 전액";

/**
 * 대시보드 거래액·매출총이익 집계에 넣을 상태인가. 드랍(DROPPED)은 진행되지 않은 캠페인이라 뺀다.
 * 개수 지표(유효 캠페인 수·활성 셀러)는 이 술어를 쓰지 않는다 — 금액 합산 전용.
 */
export function isCountedForDashboard(status: string): boolean {
  return status !== "DROPPED";
}
