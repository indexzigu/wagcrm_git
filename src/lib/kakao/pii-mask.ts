/**
 * PII 마스킹 — 카톡 원문이 네트워크 경계(Vercel)를 넘기 전 로컬에서 결정적으로 적용한다.
 * LLM 미사용. 순수 정규식 치환이라 같은 입력 → 같은 출력(멱등)이 보장된다.
 *
 * 대상: 한국 휴대전화(010/011 등), 지역번호 유선전화, 계좌번호, 주민등록번호, 이메일.
 * 업무 맥락(누가/무엇을 논의했는지)은 보존하고 PII 토큰만 치환한다.
 */

export type PiiMaskResult = {
  text: string;
  masked: boolean;
};

// 순서 중요: 더 구체적인(자릿수 긴) 패턴을 먼저 매칭해야 부분 매칭으로 인한 오탐을 줄인다.

// 주민등록번호: 6자리 + (하이픈 옵션) + 뒤 7자리 중 첫 숫자(세기/성별 코드)는 1~4만 유효.
// 하이픈을 옵션으로 바꾸되 뒷자리 첫 숫자를 [1-4]로 제한해, 하이픈 없는 일반 13~14자리 숫자열
// (예: 계좌/전화 조합)을 주민번호로 오탐하지 않도록 한다.
const RRN_PATTERN = /\b\d{6}-?[1-4]\d{6}\b/g;

// 이메일
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

// 한국 휴대전화: 국내형(010/011/016/017/018/019, 하이픈/공백/점 유무 모두 허용) +
// 국제형(+82 10 1234 5678, +821012345678, +82-10-1234-5678 — 국가코드 뒤 0은 생략 가능).
// (?:\+?82[-.\s]?)? 로 국가코드를 옵션 처리하고, 이어지는 0?1[016789]로 국내/국제 두 형태를 한 번에 커버한다.
const MOBILE_PATTERN = /(?:\+?82[-.\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b/g;

// 지역번호 유선전화: 02(서울, 2자리) 또는 0XX(3자리 지역번호) + 3~4자리 + 4자리.
const LANDLINE_PATTERN = /\b0(?:2|[3-6]\d)[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g;

// 계좌번호(하이픈 포함): 은행 계좌는 형식이 은행마다 다르므로 "은행 계좌 느낌"이 나는
// 하이픈 포함 10~14자리 숫자열로 근사. 전화번호(01x/0x/+82 시작)는 이 패턴 적용 전에 이미
// 마스킹되어 치환되므로 남은 하이픈 3분할 숫자열만 계좌로 취급된다.
const ACCOUNT_HYPHEN_PATTERN = /\b\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,6})?\b/g;

// 계좌번호(하이픈 없음, 10~14자리): 하이픈 없는 순수 숫자열은 오탐 위험이 매우 크므로
// (날짜, 금액, 임의 코드 등과 구분 불가) 정규식 단독으로는 마스킹하지 않는다. 같은 줄에서
// "계좌/입금/송금/농협/국민/신한/우리/하나/기업" 등 계좌 관련 키워드가 매칭 위치 기준 ±20자
// 이내에 근접해 있을 때만 마스킹하는 보수적 근사(M1)로 제한한다.
const BARE_ACCOUNT_CANDIDATE_PATTERN = /\b\d{10,14}\b/g;
const BANK_KEYWORDS = ["계좌", "입금", "송금", "농협", "국민", "신한", "우리", "하나", "기업"];
const KEYWORD_PROXIMITY_CHARS = 20;

const MASK_TOKENS = {
  rrn: "[RRN_MASKED]",
  email: "[EMAIL_MASKED]",
  mobile: "[PHONE_MASKED]",
  landline: "[PHONE_MASKED]",
  account: "[ACCOUNT_MASKED]",
} as const;

/**
 * 하이픈 없는 10~14자리 숫자열 중, 같은 줄에서 매칭 위치 ±20자 이내에 계좌 관련 키워드가
 * 있는 경우에만 [ACCOUNT_MASKED]로 치환한다. 키워드 근접 조건이 없으면 원문을 그대로 둔다
 * (날짜·금액·일반 코드 오탐 방지).
 */
function maskBareAccountsNearKeywords(text: string): { text: string; masked: boolean } {
  let masked = false;
  let result = "";
  let lastIndex = 0;

  BARE_ACCOUNT_CANDIDATE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_ACCOUNT_CANDIDATE_PATTERN.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    const lineStart = text.lastIndexOf("\n", start) + 1;
    const nextNewline = text.indexOf("\n", end);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;

    const windowStart = Math.max(lineStart, start - KEYWORD_PROXIMITY_CHARS);
    const windowEnd = Math.min(lineEnd, end + KEYWORD_PROXIMITY_CHARS);
    const window = text.slice(windowStart, windowEnd);

    if (BANK_KEYWORDS.some((keyword) => window.includes(keyword))) {
      result += text.slice(lastIndex, start) + MASK_TOKENS.account;
      lastIndex = end;
      masked = true;
    }
  }
  result += text.slice(lastIndex);

  return { text: result, masked };
}

/**
 * 결정적 정규식 기반 PII 마스킹.
 * 적용 순서: 주민번호 → 이메일 → 휴대전화(국내+국제) → 유선전화 → 계좌(하이픈 3분할) →
 * 계좌(하이픈 없음, 키워드 근접 시에만).
 * 전화번호(01x/0x/+82로 시작하는 특정 자릿수 패턴)를 계좌보다 먼저 마스킹해야
 * "하이픈 2개짜리 숫자열"로 근사한 계좌 정규식이 전화번호를 먼저 삼키는 오탐을 막는다.
 */
export function maskPii(text: string): PiiMaskResult {
  if (!text) {
    return { text: text ?? "", masked: false };
  }

  let result = text;
  let masked = false;

  const applyPattern = (pattern: RegExp, token: string) => {
    if (pattern.test(result)) {
      masked = true;
    }
    pattern.lastIndex = 0;
    result = result.replace(pattern, token);
  };

  applyPattern(RRN_PATTERN, MASK_TOKENS.rrn);
  applyPattern(EMAIL_PATTERN, MASK_TOKENS.email);
  applyPattern(MOBILE_PATTERN, MASK_TOKENS.mobile);
  applyPattern(LANDLINE_PATTERN, MASK_TOKENS.landline);
  applyPattern(ACCOUNT_HYPHEN_PATTERN, MASK_TOKENS.account);

  const bareAccountResult = maskBareAccountsNearKeywords(result);
  result = bareAccountResult.text;
  if (bareAccountResult.masked) {
    masked = true;
  }

  return { text: result, masked };
}
