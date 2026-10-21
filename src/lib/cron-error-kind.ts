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

// 분류 규칙과 플레이북(`cron-incident-playbook.ts`)이 같은 신호를 본다 — 두 곳에 따로 적으면 모양이 갈라진다.
/** DB 접속 비밀번호 불일치(Prisma). auth 보다 먼저 config 로 판정한다. */
export const DB_AUTH_FAILED = /Authentication failed against database server/i;
/** Meta Graph 토큰 만료 코드 190 — 「(code 190)」·「"code":190」 표기, 1900 같은 다른 숫자는 제외. */
export const IG_TOKEN_EXPIRED = /\(code 190(?!\d)|"code"\s*:\s*190(?!\d)/;

// 위에서 아래로 처음 맞는 규칙이 이긴다 — 407 은 `fetch failed` 와 같은 줄에 있어도 proxy_quota.
const RULES: readonly Rule[] = [
  { kind: "proxy_quota", patterns: [/Proxy response \(407\)/, new RegExp(`${bareStatus("407").source}.*(proxy|Proxy|tunnel)`)] },
  { kind: "rate_limit", statuses: [429], patterns: [bareStatus("429"), /RESOURCE_EXHAUSTED/, /rate.?limit/i] },
  // DB 인증 실패(Prisma)는 접속 정보 불일치 = 설정 문제다. 아래 인증 규칙의 「authentication failed」가
  // 먼저 잡지 않도록 반드시 인증 규칙보다 위에 둔다(규칙 순서가 판정이다).
  { kind: "config", patterns: [DB_AUTH_FAILED] },
  {
    kind: "auth",
    statuses: [401, 403],
    // IMAP 인증 실패(`AUTHENTICATIONFAILED`·`Invalid credentials`)는 메일함 작업이 HTTP 502 로 돌려준다 —
    // 이 규칙이 외부 서버 오류보다 위라 상태코드보다 문구가 먼저 걸린다(⚙️K4, 대소문자 무시).
    patterns: [
      bareStatus("401|403"),
      /AUTHENTICATIONFAILED|Invalid credentials|authentication failed/i,
      // 토큰 갱신·교환이 남기는 Meta 오류 코드 표기 「(code 190)」. 「토큰 교환 실패」 문구만으로는 걸지 않는다 —
      // 교환 서버 장애(HTTP 503 등)까지 인증으로 접혀 일시 장애 재시도가 막힌다(코드 190 이 있어야 만료다).
      IG_TOKEN_EXPIRED,
      /GW\.IP_NOT_ALLOWED/,
    ],
  },
  {
    kind: "config",
    // 「설정되어 있지 않」 = 메일함 연동 정보 누락(메일함 작업은 이것도 HTTP 502 로 돌려준다, ⚙️K4).
    patterns: [
      /Can't reach database/,
      /(미설정|설정되어 있지 않|설정되지 않|설정돼 있지 않|not set|missing env|is not defined in env)/i,
    ],
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
