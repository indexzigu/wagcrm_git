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
