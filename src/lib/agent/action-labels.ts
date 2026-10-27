// 기안 액션 이름표 — 결재함 카드(클라이언트)와 결재 대기 텔레그램 알림(서버)이 함께 쓴다.
// 종전 위치는 `proposal-card.tsx`("use client")였다 — 서버 라우트가 클라이언트 모듈을 import 하지 않게 여기로 옮겼고,
// 카드 파일은 기존 소비처를 위해 같은 이름으로 다시 내보낸다.

/**
 * payload.action → 한글 라벨 매핑 (§1-2). 미지 action은 원문 그대로 노출한다.
 *
 * ⚠️ **WRITE 도구가 늘면 여기도 늘어야 한다** — 빠진 도구는 배지에 `create_partner`
 * 같은 영문 식별자로 뜬다(운영자에게는 그냥 읽을 수 없는 글자다). 레지스트리
 * (`WRITE_TOOL_NAMES`)·실행기(`WRITE_ACTIONS`)와의 짝은 `action-labels.contract.test.ts` 가 고정한다.
 */
export const ACTION_LABELS: Record<string, string> = {
  add_entity_memo: "메모 추가",
  change_deal_status: "판매 조건 상태 변경",
  confirm_settlement: "정산 확정",
  create_partner: "거래처 등록",
  create_deal: "판매 조건 등록",
  update_settlement_amount: "정산 금액 수정",
  update_record: "기록 수정",
  upsert_product_mappings: "상품 매핑 등록",
  add_campaign_items: "캠페인 품목 추가",
  // [캘린더수집] 봇 도구가 아니라 캘린더 수집만 기안하는 실행기 액션 — 계약 상한이 실행기 화이트리스트다.
  create_campaign_round: "새 회차 생성",
};
