/**
 * 봇 내부 창구의 실행자 이름 — 의존성 없는 파일(client-safe)이라 결재함 화면도 같은 값을 import 한다.
 *
 * `AGENT_MAPPING_APPLY_ACTOR`: 옛 상품 매핑 즉시 저장 경로(2026-10-16 ~ 2026-11-14)의 승인자이자 `executedBy`.
 * 2026-11-14 오너 결정으로 그 경로는 폐기됐다(매핑도 승인대기 기안 → 결재함·슬랙 카드 승인). 이제 이 값으로 승인을
 * 부르는 곳은 없고, 모든 실행 동작의 「사람 승인만」 가드가 이 값을 막는다. 남겨 둔 까닭은 지난 결재함 기록의
 * 「즉시저장」 표시뿐이다.
 */
export const AGENT_MAPPING_APPLY_ACTOR = "AGENT_MAPPING_APPLY";

/**
 * `SLACK_OWNER_APPROVAL_ACTOR`: 슬랙 버튼 승인·반려의 승인자이자 `executedBy`(오너 결정 2026-11-14 — 슬랙 카드의
 * [승인]·[반려] 버튼, 누를 수 있는 사람은 hermes 설정의 오너 슬랙 ID 하나). 오너 본인의 승인이라 사람 승인으로 다룬다:
 * 실행 동작들의 「사람 승인만」 가드는 시스템·봇 값만 거르는 금지 목록이라 이 값을 그대로 통과시키고, 봇 기안자와
 * 달라 자기 승인 금지에도 걸리지 않는다. 이 값으로 승인을 부르는 곳은 `agent-internal/slack-decision.ts` 하나뿐이고
 * (계약 `agent-internal-boundary.contract.test.ts` B4·B5), 그 모듈이 버튼 허용 액션 목록과 「봇 기안만」을 강제한다.
 * 결재함 완료 카드가 이 값으로 「슬랙에서 승인」을 표시한다.
 */
export const SLACK_OWNER_APPROVAL_ACTOR = "SLACK_OWNER_APPROVAL";
