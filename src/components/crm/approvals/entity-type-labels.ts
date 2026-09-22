/**
 * 대상 엔티티 타입 → 한글 라벨. 기안 카드(`proposal-card.tsx`)와 결재함 목록 카드
 * (`approval-cards.tsx`)가 공유한다.
 *
 * 종전 위치는 채팅 전용 타입 모듈(`components/crm/assistant/types.ts`)이었다 —
 * 채팅 은퇴(PR 3)로 그 모듈이 사라지므로, 결재함이 쓰는 이 표만 여기로 옮겼다.
 */
export const ENTITY_TYPE_LABELS: Record<string, string> = {
  PARTNER: "거래처",
  SELLER: "셀러",
  DEAL: "딜",
  CAMPAIGN: "캠페인",
};
