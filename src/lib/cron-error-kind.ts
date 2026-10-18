/**
 * 자동 작업(크론) 오류 종류 분류기.
 * 오류 문구·HTTP 상태를 몇 가지 종류로 접어, 일시 장애(재시도 대상)와
 * 사람이 손봐야 하는 장애를 가른다. 설계 §5.2 표.
 * `app_down` 은 앱 밖 `run-cron.sh` 가 붙인다 — classifyCronError 는 돌려주지 않는다.
 */
export type CronErrorKind =
  | "network"
  | "timeout"
  | "upstream_5xx"
  | "proxy_quota"
  | "auth"
  | "rate_limit"
  | "config"
  | "app_down"
  | "unknown";

type Rule = {
  kind: CronErrorKind;
  /** 숫자 상태코드가 이 목록에 있으면 곧바로 이 종류 */
  statuses?: readonly number[];
  patterns: readonly RegExp[];
};

// 맨 상태코드 숫자 패턴 — 건수("503건")·식별자("ORD-503-1")·버전("4.0.403")은 제외한다.
// JS \b 는 한글을 비단어로 보므로 앞뒤를 직접 막는다.
const bareStatus = (alt: string): RegExp =>
  new RegExp(`(?<![\\w.\\-가-힣])(?:${alt})(?![\\w\\-]|\\.\\w|[가-힣])`);

// 위에서 아래로 처음 맞는 규칙이 이긴다 — 407 은 `fetch failed` 와 같은 줄에 있어도 proxy_quota.
const RULES: readonly Rule[] = [
  { kind: "proxy_quota", patterns: [/Proxy response \(407\)/, new RegExp(`${bareStatus("407").source}.*(proxy|Proxy|tunnel)`)] },
  { kind: "rate_limit", statuses: [429], patterns: [bareStatus("429"), /RESOURCE_EXHAUSTED/, /rate.?limit/i] },
  {
    kind: "auth",
    statuses: [401, 403],
    patterns: [bareStatus("401|403"), /Authentication failed/, /"code"\s*:\s*190\b/, /GW\.IP_NOT_ALLOWED/],
  },
  {
    kind: "config",
    patterns: [/Can't reach database/, /(미설정|not set|missing env|is not defined in env)/i],
  },
  { kind: "upstream_5xx", statuses: [502, 503, 504], patterns: [bareStatus("502|503|504")] },
  { kind: "timeout", patterns: [/ETIMEDOUT|timed? ?out|시간 초과|AbortError|TimeoutError/i] },
  {
    kind: "network",
    patterns: [/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i],
  },
];

export function classifyCronError(text: string, httpStatus?: number): CronErrorKind {
  for (const rule of RULES) {
    if (httpStatus !== undefined && rule.statuses?.includes(httpStatus)) return rule.kind;
    if (rule.patterns.some((p) => p.test(text))) return rule.kind;
  }
  return "unknown";
}

const TRANSIENT_KINDS: ReadonlySet<CronErrorKind> = new Set([
  "network",
  "timeout",
  "upstream_5xx",
  "app_down",
]);

/** 재시도하면 풀릴 수 있는 일시 장애인가 */
export function isTransientErrorKind(kind: CronErrorKind): boolean {
  return TRANSIENT_KINDS.has(kind);
}
