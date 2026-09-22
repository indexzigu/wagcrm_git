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
};
