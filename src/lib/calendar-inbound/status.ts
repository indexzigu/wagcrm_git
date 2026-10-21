// [캘린더수집] CalendarInboundEvent.status 값 — 스키마는 String 이라 허용 값을 여기 한곳에 둔다.
// 넘겨받기(adopt.ts)와 스캔(Task 7)이 같은 상수를 쓴다. 손으로 문자열을 다시 쓰지 말 것.
//
// - PROPOSED      : 기안을 올렸고 결정을 기다린다.
// - SKIPPED       : 해석 못 함·대상 없음 등으로 기안하지 않았다(`skipReason`).
// - ADOPTED       : 승인돼 처리 끝(장부 넘겨받기 여부와 무관 — 다시 기안하지 않는다).
// - REJECTED      : 오너가 반려했다(다시 기안하지 않는다).
// - PENDING_RETRY : 승인 실행이 실패했다 — 지문을 비워 다음 스캔이 최신 값으로 다시 판정한다.
export const INBOUND_STATUS = {
  PROPOSED: "PROPOSED",
  SKIPPED: "SKIPPED",
  ADOPTED: "ADOPTED",
  REJECTED: "REJECTED",
  PENDING_RETRY: "PENDING_RETRY",
} as const;

export type InboundStatus = (typeof INBOUND_STATUS)[keyof typeof INBOUND_STATUS];

/** 장부 키에 이미 다른 이벤트가 있어 넘겨받지 않고 처리 끝으로 둔 행의 `skipReason`. */
export const INBOUND_SKIP_LEDGER_CONFLICT = "ledger_conflict";
