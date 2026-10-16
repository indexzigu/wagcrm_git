/**
 * 봇 내부 창구의 실행자 이름 — 의존성 없는 파일(client-safe)이라 결재함 화면도 같은 값을 import 한다.
 *
 * `AGENT_MAPPING_APPLY_ACTOR`: 상품 매핑 즉시 저장 경로의 승인자이자 `executedBy`(오너 결정 2026-10-16 — 슬랙 짝 확인
 * 「응」 한 번이 승인이다). 사람 승인자 id(uuid)도 시스템 실행자(`SYSTEM_*`)도 봇 기안자(`AGENT_WORKER`)도 아니다:
 * 매핑 실행 동작의 「사람 승인만」 가드는 그 둘만 막으므로 이 실행자는 통과하고, 기안자와 달라 자기 승인 금지에도
 * 걸리지 않는다. 결재함 완료 카드가 이 값으로 「즉시저장」을 표시한다.
 */
export const AGENT_MAPPING_APPLY_ACTOR = "AGENT_MAPPING_APPLY";
