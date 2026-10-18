// 클라이언트 컴포넌트가 import 하는 모듈 — prisma 등 서버 전용 import 를 두지 말 것.

/**
 * 데스크톱 대시보드 범위 안내 — 페이지 맨 위에 **한 번만** 그린다(오너 2026-10-17: 범위 안내는 대시보드
 * 맨 위 한 번). 종전엔 히어로의 두 단(연간 누적·이번 달)마다 짧은 캡션이 따로 붙어 같은 말이 두 번 읽혔다.
 */
export const DASHBOARD_PAGE_SCOPE_CAPTION =
  "드랍 캠페인 제외 · 이달 지표는 이달에 걸친 캠페인 전액, 연간은 올해 시작한 캠페인 기준";

/**
 * 히어로 단별 짧은 캡션 — 이제 **모바일 홈 히어로만** 쓴다(`src/components/mobile/mobile-home-view.tsx`).
 * 데스크톱은 위 `DASHBOARD_PAGE_SCOPE_CAPTION` 한 줄로 옮겼다. 모바일 표면은 애플 UI 리뉴얼 묶음 1 에서
 * 손대지 않으므로(P5) 이 두 상수를 지우거나 값을 바꾸면 모바일 화면이 바뀐다 — 모바일을 고칠 때 함께 정리할 것.
 * 범위 정의 자체(드랍 제외 · 이달 걸침 · 올해 시작)는 세 문자열이 같은 것을 말해야 한다.
 */
export const DASHBOARD_SCOPE_CAPTION = "드랍 제외 · 이달에 걸친 캠페인 전액";

/** 연간 누적 캡션(모바일 전용) — 시작일이 올해인 캠페인(드랍 제외) 전액(`ytdCampaigns`, desktop-dashboard.ts). */
export const DASHBOARD_YTD_SCOPE_CAPTION = "드랍 제외 · 올해 시작한 캠페인 전액";

/**
 * 대시보드 거래액·매출총이익 집계에 넣을 상태인가. 드랍(DROPPED)은 진행되지 않은 캠페인이라 뺀다.
 * 금액 지표뿐 아니라 개수 지표(운영일·유효 캠페인 수·활성 셀러·추이의 캠페인 수)도 이 술어 하나를 쓴다
 * (오너 2026-10-17). 현재·전월·전전월 모두 같다.
 */
export function isCountedForDashboard(status: string): boolean {
  return status !== "DROPPED";
}
