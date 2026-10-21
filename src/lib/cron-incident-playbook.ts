import type { CronErrorKind } from "@/lib/cron-error-kind";
import type { IncidentKind } from "@/lib/cron-incident";

/**
 * 알려진 원인 플레이북 — 자동 작업 사고가 오너 조치대기로 올라갈 때, 이미 겪어 본 원인이면 원인을
 * 확정(또는 후보)으로 적고 그 원인에 맞는 오너 할 일 한 문장을 고른다(크론 자가 정상화 4단계, 설계 §5.5).
 * 순수 함수다 — 프록시 장부 조회는 호출처(`escalatePendingIncidents`)가 하고 결과만 넘긴다.
 *
 * ⚠️ 원인·할 일 문장은 오너 알림·화면에 그대로 나간다. 고정 문장만 쓰고, 사고 원문(`lastMessage`)에서
 * 끼워 넣는 값은 **환경변수 키 이름(대문자_밑줄)과 건수(정수)** 뿐이다(⚙️L3 — 원문에는 셀러 핸들·
 * 응답 본문이 섞일 수 있다). `cron-incident-playbook.test.ts` 의 계약이 이것을 강제한다.
 * 「확정」은 문구가 원인을 직접 말할 때만, 정황 추정은 「후보」다(⚙️L2).
 */

export type PlaybookId =
  | "proxy-quota"
  | "ig-token"
  | "gemini-cap"
  | "response-format"
  | "captcha"
  | "db-auth"
  | "env-missing"
  | "encryption-key";

export type PlaybookMatch = {
  id: PlaybookId;
  cause: string;
  confidence: "확정" | "후보";
  ownerAction: string;
};

export type PlaybookInput = {
  jobKey: string;
  kind: IncidentKind;
  errorKind: CronErrorKind | null;
  lastMessage: string | null;
  /**
   * 그 작업의 프록시 장부(그날)가 「요청 `PROXY_LEDGER_MIN_REQUESTS` 이상이고 전부 실패」인가. 모르면 생략.
   * 문구가 407 을 말하지 않는 정황 추정이라 「후보」로만 쓴다(⚙️L2).
   */
  proxyLedgerAllFailed?: boolean;
};

/**
 * 프록시(`proxyFetch`)로 외부를 부르는 작업 — 프록시 장부(`ProxyRequestDaily`, source `cron:<작업>`)에 그 작업
 * 줄이 쌓인다. 네이버 커머스 API(주문·정산·문의), 인스타 수집기, 레퍼런스 보강, 인박스 썸네일 수집.
 */
const PROXY_JOB_KEYS: ReadonlySet<string> = new Set([
  "naver-order-sync",
  "naver-settlement-sync",
  "collect-qnas",
  "collect-instagram",
  "enrich-references",
  "enrich-inbox",
]);

/**
 * 장부 정황만으로 프록시 한도를 의심하려면 그날 요청이 이만큼은 쌓여야 한다 — 요청 1건 실패(1/1)는
 * 일시 장애 한 번과 구별되지 않는다.
 */
export const PROXY_LEDGER_MIN_REQUESTS = 5;

export function isProxyJob(jobKey: string): boolean {
  return PROXY_JOB_KEYS.has(jobKey);
}

const fixed = (id: PlaybookId, cause: string, confidence: PlaybookMatch["confidence"], ownerAction: string) =>
  ({ id, cause, confidence, ownerAction }) satisfies PlaybookMatch;

const PROXY_QUOTA = fixed(
  "proxy-quota",
  "프록시 월 한도 소진",
  "확정",
  "프록시 월 한도가 바닥났습니다. 운영 서버 설정의 프록시 목록 맨 앞에 여유 있는 계정을 넣고 서버를 다시 시작해 주세요.",
);
// 장부 정황(요청 전부 실패)만 있고 문구에 407 이 없을 때 — 같은 원인을 「후보」로, 할 일도 추정 어조로.
const PROXY_QUOTA_LEDGER = fixed(
  "proxy-quota",
  "프록시 월 한도 소진",
  "후보",
  "프록시 월 한도가 바닥난 것으로 보입니다. 운영 서버 설정의 프록시 목록 맨 앞에 여유 있는 계정을 넣고 서버를 다시 시작해 주세요.",
);
const IG_TOKEN = fixed(
  "ig-token",
  "인스타그램 접근 토큰 만료",
  "확정",
  "인스타그램 접근 토큰이 만료됐습니다. Meta 개발자 화면에서 토큰을 다시 발급해 운영 서버 설정에 넣어 주세요.",
);
const GEMINI_CAP = fixed(
  "gemini-cap",
  "Gemini 사용 한도 도달",
  "후보",
  "Gemini 사용 한도에 걸린 것으로 보입니다. Google AI Studio 에서 월 지출 한도와 사용량을 확인해 주세요.",
);
const RESPONSE_FORMAT = fixed(
  "response-format",
  "외부 사이트 화면 구조가 바뀜",
  "후보",
  "수집하는 외부 사이트의 화면 구조가 바뀐 것으로 보입니다. 수집 코드 수정이 필요해 조사 작업을 열어 주세요.",
);
const CAPTCHA = fixed(
  "captcha",
  "외부 사이트가 자동 접근을 막음",
  "후보",
  "외부 사이트가 자동 접근을 막고 있습니다. 수집 경로를 바꿀지 판단이 필요합니다.",
);
const DB_AUTH = fixed(
  "db-auth",
  "데이터베이스 접속 정보 불일치",
  "확정",
  "데이터베이스 접속 정보가 맞지 않습니다. 운영 서버 설정의 데이터베이스 주소와 비밀번호를 확인해 주세요.",
);

// 신호 — 사고 원문의 부분 문자열. 숫자 앞뒤는 직접 막는다(「(code 1900)」·「422건」이 걸리지 않게).
// 「토큰 교환 실패」 문구만으로는 걸지 않는다 — 교환 서버 장애(503)는 토큰 만료가 아니다. 숫자 코드 190 만 본다.
const IG_TOKEN_SIGNAL = /\(code 190(?!\d)|"code"\s*:\s*190(?!\d)/;
const GEMINI_STRONG = /RESOURCE_EXHAUSTED/;
const STATUS_429 = /status=429(?!\d)/;
const GEMINI_CAP_WORDS = /spending cap|quota/i;
const RESPONSE_FORMAT_SIGNAL = /응답 형식 불일치|응답 미포착|감시 패턴 불일치|검색 결과 미렌더/;
const CAPTCHA_SIGNAL = /CAPTCHA_REQUIRED|status=422(?!\d)/;
const DB_AUTH_SIGNAL = /Authentication failed against database server/i;
const ENV_KEY = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const UNREADABLE_ROWS = /열리지 않는 행 (\d+)건/;

/** 원문에서 환경변수 키 이름(대문자_밑줄)만 겹치지 않게 최대 2개 */
function extractEnvKeys(message: string): string[] {
  const keys: string[] = [];
  for (const m of message.matchAll(ENV_KEY)) {
    if (!keys.includes(m[0])) keys.push(m[0]);
    if (keys.length === 2) break;
  }
  return keys;
}

/**
 * 표 순서대로 처음 맞는 플레이북을 돌려준다. 안 맞으면 null — 호출처는 종류별 일반 문장을 쓴다.
 * 실패 기록(A)만 본다: 산출 없음(B)은 오류 문구가 없어 신호가 없고, 알림 틀림(C)은 승격하지 않는다.
 */
export function matchPlaybook(input: PlaybookInput): PlaybookMatch | null {
  if (input.kind !== "A") return null;
  const msg = input.lastMessage ?? "";

  if (input.errorKind === "proxy_quota") return PROXY_QUOTA;
  if (input.proxyLedgerAllFailed === true && isProxyJob(input.jobKey)) return PROXY_QUOTA_LEDGER;
  if (!msg) return null;

  if (IG_TOKEN_SIGNAL.test(msg)) return IG_TOKEN;
  if (GEMINI_STRONG.test(msg) || (STATUS_429.test(msg) && GEMINI_CAP_WORDS.test(msg))) return GEMINI_CAP;
  if (RESPONSE_FORMAT_SIGNAL.test(msg)) return RESPONSE_FORMAT;
  if (CAPTCHA_SIGNAL.test(msg)) return CAPTCHA;
  if (DB_AUTH_SIGNAL.test(msg)) return DB_AUTH;

  if (input.errorKind === "config") {
    const keys = extractEnvKeys(msg);
    if (keys.length > 0) {
      const names = keys.join("·");
      return {
        id: "env-missing",
        cause: `설정값 누락: ${names}`,
        confidence: "확정",
        ownerAction: `운영 서버 설정에 ${names} 값이 비어 있습니다. 값을 넣고 서버를 다시 시작해 주세요.`,
      };
    }
  }

  if (input.jobKey === "encryption-key-audit") {
    const m = UNREADABLE_ROWS.exec(msg);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      return {
        id: "encryption-key",
        cause: `암호화 키로 열리지 않는 주민등록번호 ${n}건`,
        confidence: "확정",
        ownerAction: `현재 암호화 키로 열리지 않는 주민등록번호가 ${n}건 있습니다. 구 키를 찾을 수 있으면 키 교체 절차대로 다시 암호화하고, 없으면 해당 셀러의 주민등록번호를 다시 입력해 주세요.`,
      };
    }
  }
  return null;
}
