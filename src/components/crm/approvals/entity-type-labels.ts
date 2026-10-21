/**
 * 대상 엔티티 타입 → 한글 라벨. 기안 카드(`proposal-card.tsx`)와 결재함 목록 카드
 * (`approval-cards.tsx`)가 공유한다.
 *
 * 종전 위치는 은퇴한 채팅의 공용 타입 모듈이었다 — 그 모듈이 사라지면서 결재함이 쓰는
 * 이 표만 여기로 옮겼다(PR 3).
 */
export const ENTITY_TYPE_LABELS: Record<string, string> = {
  PARTNER: "거래처",
  SELLER: "셀러",
  DEAL: "판매 조건",
  CAMPAIGN: "캠페인",
  // 가격표 반영 기안(lib/price-sheet/apply-executor.ts)의 대상 — 종전엔 표에 없어 영문 코드가 배지에 떴다.
  PRICE_SHEET: "가격표",
};

/** 기안 시점에 대상이 아직 없는 액션 — 새 회차 생성은 승인돼야 캠페인이 생긴다. */
const NO_TARGET_YET_ACTIONS: ReadonlySet<string> = new Set(["create_campaign_round"]);

/**
 * 대상 배지를 달지 않을 액션인가. 대상이 아직 없는데 종류(「캠페인」)만 적힌 배지를 달면 어느 캠페인인지
 * 알 수 없는 빈 배지가 된다. 목록 카드와 기안 카드가 같은 판정을 쓴다.
 */
export function actionHasNoTargetYet(action: string | null | undefined): boolean {
  return action != null && NO_TARGET_YET_ACTIONS.has(action);
}
