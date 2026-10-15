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
  DEAL: "딜",
  CAMPAIGN: "캠페인",
  // 가격표 반영 기안(lib/price-sheet/apply-executor.ts)의 대상 — 종전엔 표에 없어 영문 코드가 배지에 떴다.
  PRICE_SHEET: "가격표",
};
