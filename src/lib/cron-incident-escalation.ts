import { isTransientErrorKind, type CronErrorKind } from "@/lib/cron-error-kind";
import type { IncidentKind } from "@/lib/cron-incident";

/**
 * 사고 승격 규칙 — 열린 사고 중 오너가 손봐야 하는 것을 가려 `waiting_owner` 로 올린다(크론 자가 복구 2단계).
 * 일시 장애(network·timeout·upstream_5xx·app_down)는 한 번은 재시도로 풀릴 수 있으니 2회째부터 올리고,
 * 산출 없음(B)과 사람이 손봐야 하는 오류(한도·인증·설정·미분류)는 첫 회에 올린다. 알림 틀림(C)은 올리지 않는다.
 */
export function shouldEscalate(i: {
  kind: IncidentKind;
  errorKind: CronErrorKind | null;
  occurrences: number;
}): boolean {
  // C(알림 틀림)는 작업 고장이 아니라 알림 쪽 기록이다 — 오너 조치로 올리면 틀린 알림이 또 알림을 낳는다.
  if (i.kind === "C") return false;
  if (i.kind === "B") return true;
  if (i.kind === "A" && i.errorKind && isTransientErrorKind(i.errorKind)) return i.occurrences >= 2;
  return true;
}

const B_ACTION =
  "대상은 있는데 이틀 연속 결과가 0건입니다. 설정의 「자동화 작업 상태」에서 작동 로그를 확인해 주세요.";
const TRANSIENT_ACTION = "같은 오류가 연속으로 났습니다. 외부 서비스 상태와 서버의 인터넷 연결을 확인해 주세요.";
const FALLBACK_ACTION = "설정의 「자동화 작업 상태」에서 작동 로그를 확인해 주세요.";

// 오너 화면·알림에 그대로 나가는 문구다 — 긴 줄표·영문 코드를 넣지 않는다(설계 검토 10-18).
// 조사 에이전트·플레이북이 붙는 3~5단계에서 이 표를 대체한다.
const ACTION_BY_ERROR_KIND: Readonly<Record<CronErrorKind, string>> = {
  proxy_quota: "프록시 월 한도가 바닥난 것으로 보입니다. 프록시 계정을 더 등록하고 서버를 다시 시작해 주세요.",
  auth: "인증이 거부됐습니다. 해당 서비스의 토큰이나 키가 만료됐는지 확인해 주세요.",
  rate_limit: "호출 한도를 넘었습니다. 한도가 풀릴 때까지 기다리거나 사용량을 확인해 주세요.",
  config: "설정값이 빠졌거나 데이터베이스에 연결하지 못했습니다. 운영 서버 설정을 확인해 주세요.",
  network: TRANSIENT_ACTION,
  timeout: TRANSIENT_ACTION,
  upstream_5xx: TRANSIENT_ACTION,
  app_down: "서버가 응답하지 않아 작업이 시작되지 못했습니다. 서버가 켜져 있는지 확인해 주세요.",
  unknown: FALLBACK_ACTION,
};

/** 승격된 사고에 붙일 오너 조치 한 줄 */
export function ownerActionFor(i: { kind: IncidentKind; errorKind: CronErrorKind | null }): string {
  if (i.kind === "B") return B_ACTION;
  return (i.errorKind && ACTION_BY_ERROR_KIND[i.errorKind]) || FALLBACK_ACTION;
}
