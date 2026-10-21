import type { AdoptLedgerOutcome } from "@/lib/google-calendar-sync";

// [캘린더수집] CalendarInboundEvent.status 값 — 스키마는 String 이라 허용 값을 여기 한곳에 둔다.
// 넘겨받기(adopt.ts)와 수집 스캔(scan.ts)이 같은 상수를 쓴다. 손으로 문자열을 다시 쓰지 말 것.
//
// - PROPOSED      : 기안을 올렸고 결정을 기다린다.
// - SKIPPED       : 해석 못 함·대상 없음 등으로 기안하지 않았다(`skipReason`).
// - ADOPTED       : 처리 끝 — 승인돼 반영됐거나(장부 넘겨받기 여부와 무관), CRM 값이 이미 같아 할 일이 없었다
//                   (`already_current`, 장부는 그대로). 같은 지문이면 다시 기안하지 않는다.
// - REJECTED      : 오너가 반려했다(다시 기안하지 않는다).
// - PENDING_RETRY : 승인 실행이 실패했다 — 다음 스캔이 지문과 무관하게 최신 값으로 다시 판정한다(지문은 보존).
// - AWAITING_HINT : 규칙으로 못 푼 제목이 모델 해석을 기다린다. `parsed` 칸은 `{ hintStage: "local" | "gemini" }`
//                   (다음 스캔이 이을 단계)이고 기안은 없다. 끝난 행이 아니다 — 매 스캔이 그 단계부터 잇고,
//                   일정이 바뀌면 규칙부터 다시 본다.
export const INBOUND_STATUS = {
  PROPOSED: "PROPOSED",
  SKIPPED: "SKIPPED",
  ADOPTED: "ADOPTED",
  REJECTED: "REJECTED",
  PENDING_RETRY: "PENDING_RETRY",
  AWAITING_HINT: "AWAITING_HINT",
} as const;

export type InboundStatus = (typeof INBOUND_STATUS)[keyof typeof INBOUND_STATUS];

// 승인됐지만 장부에 넘겨받지 못하고 처리 끝(ADOPTED)으로 둔 행의 `skipReason` — 원본은 평범한 일정으로 남는다.
/** 장부 칸에 이미 다른 이벤트가 있다(덮으면 그 CRM 이벤트가 고아가 된다). */
export const INBOUND_SKIP_LEDGER_CONFLICT = "ledger_conflict";
/** 다른 장부가 이미 그 이벤트를 가리킨다(두 주인이면 번갈아 덮고, 한쪽 삭제가 원본을 지운다). */
export const INBOUND_SKIP_ALREADY_REFERENCED = "already_referenced";
/** 다음 동기화가 그 칸을 남기지 않는다(적으면 동기화가 원본을 지운다). */
export const INBOUND_SKIP_NOT_ACTIVE = "not_active";
/** 넘겨받기 도중 오류 — 장부는 그대로일 수 있다(로그 확인). */
export const INBOUND_SKIP_ADOPT_FAILED = "adopt_failed";
/** 넘겨받을 캠페인(또는 그 그룹)이 없다. */
export const INBOUND_SKIP_CAMPAIGN_NOT_FOUND = "campaign_not_found";

// 기안 없이 끝난 행의 `skipReason`(스캔이 적는다).
/** CRM 값이 이미 일정과 같아 기안하지 않았다 — 승인이 없으므로 장부에 넘겨받지도 않는다(원본은 평범한 일정). */
export const INBOUND_SKIP_ALREADY_CURRENT = "already_current";
/** 열린 기안이 있어 다시 기안하지 않았다(옛 기안이 결정될 때까지). */
export const INBOUND_SKIP_OPEN_PROPOSAL = "open_proposal";

/** 넘겨받지 못한 판정 → 수집 행 `skipReason`. 표에 없는 판정(adopted·already_adopted)은 사유 없음. */
const INBOUND_SKIP_BY_OUTCOME: Partial<Record<AdoptLedgerOutcome, string>> = {
  conflict: INBOUND_SKIP_LEDGER_CONFLICT,
  already_referenced: INBOUND_SKIP_ALREADY_REFERENCED,
  not_active: INBOUND_SKIP_NOT_ACTIVE,
  not_found: INBOUND_SKIP_CAMPAIGN_NOT_FOUND,
};

/**
 * 넘겨받기 판정 → 수집 행 `skipReason`(null = 장부에 있다). 넘겨받기는 승인 뒤 단계(`approveProposal`)에서만
 * 일어난다 — 판정→사유 표는 여기 한 곳에 둔다.
 */
export function inboundSkipReasonForAdoptOutcome(outcome: AdoptLedgerOutcome): string | null {
  return INBOUND_SKIP_BY_OUTCOME[outcome] ?? null;
}
