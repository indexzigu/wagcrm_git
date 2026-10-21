/**
 * 자동승인 정책 모듈 (Phase 5 자동승인 화이트리스트 청사진 v2 §1, §2).
 *
 * approval.rules.json을 정적 import한다(§2 로딩 결정 — resolveJsonModule 활용,
 * Vercel 배포는 파일시스템 불변이라 런타임 로드와 실질적 차이가 없고, 정적 import는
 * 번들 포함이 보장되어 런타임 실패 모드가 없다. 보안 정책은 코드와 함께 리뷰·배포되어야
 * 한다는 원칙도 반영 — settlement.rules.json의 런타임 fs 로딩과는 의도적으로 다른 결정).
 */
import approvalRules from "../../../knowledge/rules/approval.rules.json";

export type ApprovalKind = "READ" | "WRITE";

type AutoApproveRule = {
  requestType: string;
  kind: ApprovalKind;
  note?: string;
};

type AlwaysManualRule = {
  requestType: string;
  reason?: string;
};

export type ApprovalRulesShape = {
  autoApprove: AutoApproveRule[];
  alwaysManual: AlwaysManualRule[];
};

// §1: action → requestType 매핑. 미등록 action은 REQUEST_TYPE_BY_ACTION에 없으므로
// getRequestTypeForAction이 fail-closed 기본값("crm_mutation")으로 처리한다.
export const REQUEST_TYPE_BY_ACTION: Record<string, string> = {
  add_entity_memo: "campaign_note_add", // autoApprove 등재 → 자동승인 대상
  change_deal_status: "crm_mutation", // alwaysManual → 수동
  confirm_settlement: "settlement_confirm", // alwaysManual → 수동(영구)
  // 생성은 언제나 수동 승인 — 없던 거래처·딜이 생기는 일은 되돌리기가 삭제뿐이다.
  // fail-closed 기본값도 같은 값이지만, 빠져서 그렇게 된 것과 그렇게 정한 것은 다르다.
  create_partner: "crm_mutation", // alwaysManual → 수동
  create_deal: "crm_mutation", // alwaysManual → 수동
  // 정산 금액 칸 정정 — 금전 영향이 있어 이 일반 정책에서는 수동이다(autoApprove 에 넣지 말 것).
  // 오너 결정 2026-10-09(2026-10-08 「브리지 쓰기는 자동 실행하지 않는다」를 대체): 슬랙 원문으로
  // Muse 요청임이 확인되고 한도(|변동| 50만 원·하루 10건) 안인 것만 전용 자동 실행기
  // (`auto-execute/settlement-auto-execute.ts`)가 승인할 수 있다. 그 밖은 사람이 승인한다.
  update_settlement_amount: "settlement_amount_update", // alwaysManual → 일반 정책상 수동
  // 화면에서 고칠 수 있는 칸을 화면 저장과 같은 본체로 고치는 기안 — 오너 결정(2026-10-14): 범위를 칸
  // 목록으로 좁히지 않는 대신 **언제나 오너가 승인**한다. 자동 실행기를 두지 않는다(정산 자동 실행기는
  // 이 requestType 을 집지 않는다). autoApprove 에 넣지 말 것.
  update_record: "record_update", // alwaysManual → 수동(영구)
  // 주문캠페인 상품 매핑 등록·수정(2026-10-15) — 발주서 상품코드·가격을 정하는 값이라 사람이 승인한다.
  // crm_mutation 은 이미 alwaysManual 이라 approval.rules.json 은 건드리지 않는다. 전용 requestType 을
  // 두지 않은 이유: 이 기안만 다르게 다룰 정책이 없다.
  upsert_product_mappings: "crm_mutation", // alwaysManual → 수동
  // [캘린더수집] 구글 캘린더에서 들어온 새 회차 생성(2026-10-21) — 없던 캠페인이 생기는 일이라 생성 기안과
  // 같이 언제나 사람이 승인한다. 캘린더 출처는 requestType 이 아니라 기안의 createdBy·sourceRef 로 구분한다.
  create_campaign_round: "crm_mutation", // alwaysManual → 수동
};

const FAIL_CLOSED_REQUEST_TYPE = "crm_mutation";

/**
 * action 문자열에서 requestType을 파생한다(§1-1: 실행 권한이 전혀 없는 파생 라벨,
 * action→requestType 단방향 계산만 존재). 매핑에 없는 action은 fail-closed로
 * "crm_mutation"(alwaysManual)을 반환해 항상 수동 승인 경로로 떨어지게 한다.
 */
export function getRequestTypeForAction(action: string): string {
  return REQUEST_TYPE_BY_ACTION[action] ?? FAIL_CLOSED_REQUEST_TYPE;
}

/**
 * requestType+kind 조합이 자동승인 가능한지 판정한다.
 *
 * ⚠️ 킬스위치(AUTO_APPROVE_DISABLED)는 반드시 이 함수 본문 안에서 매 호출 읽는다 —
 * 모듈 상수로 캡처하면 프로세스 기동 이후 env 변경(테스트/긴급 잠금)이 반영되지 않는다.
 * 의미론(security-review L1): **값과 무관하게 변수가 존재하면 잠금**("0"/"false"도 잠금) —
 * 긴급 스위치는 fail-safe하게 넓게 잡는다. 해제는 반드시 변수 자체를 삭제할 것.
 *
 * rules 파라미터는 테스트에서 오설정(양쪽 등재) 시나리오를 주입 검증하기 위한 선택적
 * 오버로드다 — 운영 코드는 항상 기본값(정적 import된 approval.rules.json)을 사용한다.
 */
export function isAutoApprovable(
  requestType: string,
  kind: ApprovalKind,
  rules: ApprovalRulesShape = approvalRules as ApprovalRulesShape
): boolean {
  if (process.env.AUTO_APPROVE_DISABLED) return false;

  const isAlwaysManual = rules.alwaysManual.some((rule) => rule.requestType === requestType);
  if (isAlwaysManual) return false;

  return rules.autoApprove.some((rule) => rule.requestType === requestType && rule.kind === kind);
}
