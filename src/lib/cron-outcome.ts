import { describeErrorChain } from "@/lib/cron-error-text";

/**
 * 크론의 **실질 실패 선언** 공용 판정 — `withSystemTaskStatus` 의 `CronOutcomeBody` 계약
 * (`src/lib/system-task-status.ts`)에서 핸들러가 답해야 하는 질문 하나를 재사용 가능한
 * 형태로 둔다: **"이번 실행이 통째로 헛돌았는가."**
 *
 * ⚠️ **판정 기준은 산출량이 아니라 「시도했는데 하나도 성공하지 못했는가」다.** 대상이 없던
 * 날은 산출도 0이지만 정상이므로, 산출량으로 재면 조용한 날마다 빨강이 되어 습관화로 신호를
 * 잃는다(P7·P6 이 반복 경고하는 실패 모드). 그래서 **`attempted === 0` 은 언제나 정상**이다.
 *
 * ⛔ **개별 항목 실패를 승격하지 않는다** — 썸네일 1건, 셀러 1명 실패는 상시 노이즈다.
 * 승격은 "전량"일 때만 일어난다. 되돌리지 말 것(`CronOutcomeBody` 주석의 실사고).
 *
 * **무엇이 `attempted`·`succeeded` 인가는 잡마다 다르고 호출부가 정한다** — 멱등 게이트로
 * 건너뛴 대상(`skipped`)은 시도가 아니고, 데드라인 이월분도 실패가 아니다. 이 함수는 그
 * 정의를 대신 내려 주지 않는다(도메인 지식은 핸들러에 있다는 것이 계약의 전제다).
 *
 * ℹ️ `capture-stories` 의 `declareStoryCaptureOutcome`(`src/lib/story-capture.ts`)은 이 함수로
 * 접지 않는다 — 그쪽은 **로컬 러너와 공유하는 도메인 SSOT** 라 결과 타입까지 함께 들고 있고,
 * 여기로 옮기면 두 레인이 공유하던 지점이 흩어진다.
 */
export function declareTotalFailure(input: {
  /** 이번 실행이 실제로 손을 댄 대상 수(멱등 스킵·이월분 제외) */
  attempted: number;
  /** 그중 성공한 수 */
  succeeded: number;
  /** 대상의 단위 — "명" · "건" 등. 사유 문구에 그대로 들어간다 */
  unit: string;
  /** 무엇을 하다 실패했는가 — "인스타 지표 수집" 등 */
  what: string;
  /**
   * 대표 원인 — 처음 난 항목 오류의 원인 사슬(`describeFailureCause`, 항목 식별자 제외).
   * 있으면 사유 뒤에 「 · 대표 원인: …」으로 붙는다. 없으면 사유가 종전 문구 그대로다.
   */
  cause?: string;
}): { failed: boolean; failureReason?: string; targets: number; produced: number } {
  const { attempted, succeeded, unit, what, cause } = input;
  // targets·produced 는 래퍼의 산출 판정(사고 B·`lastProducedAt`) 근거다 — 라우트가 이 반환을
  // 응답 본문에 펼치면 그대로 이력에 남는다(`CronOutcomeBody`).
  const counts = { targets: attempted, produced: succeeded };
  if (attempted > 0 && succeeded === 0) {
    return {
      failed: true,
      failureReason: appendFailureCause(`${what} 대상 ${attempted}${unit} 전량 실패(성공 0)`, cause),
      ...counts,
    };
  }
  return { failed: false, ...counts };
}

/**
 * 사유와 대표 원인을 잇는 구분 문구 — 사고 서명(`incidentSignature`)이 이것으로 원인 부분을 찾는다.
 * 바꾸면 서명도 함께 바뀐다(열린 사고가 새 사고로 갈라진다).
 */
export const FAILURE_CAUSE_SEPARATOR = " · 대표 원인: ";

/** 대표 원인 상한 — 사고 기록(`lastMessage` 1,000자) 안에 사유·원인이 함께 들어가게 한다. */
const FAILURE_CAUSE_MAX = 300;
/** 상한을 넘으면 앞·끝을 이만큼 남긴다 — 원인 사슬(`a <- b <- c`)의 진짜 원인은 끝에 있다. */
const FAILURE_CAUSE_HEAD = 100;
const FAILURE_CAUSE_TAIL = 200;

function clipFailureCause(cause: string): string {
  if (cause.length <= FAILURE_CAUSE_MAX) return cause;
  return `${cause.slice(0, FAILURE_CAUSE_HEAD)} … ${cause.slice(-FAILURE_CAUSE_TAIL)}`;
}

/**
 * 전량 실패 사유에 대표 원인을 붙인다 — `declareTotalFailure` 와 스토리 수집 선언
 * (`declareStoryCaptureOutcome`)이 같은 꼴을 쓰도록 한 곳에 둔다.
 *
 * 잇는 기호는 가운뎃점이다 — em-dash 는 UI 카피 계약(`ui-copy-em-dash.contract.test.ts`)이 막는다.
 *
 * ⚠️ 왜 붙이는가: 일반 문구(「대상 N건 전량 실패」)만 남으면 사고 기록에서 진짜 원인(토큰 만료·
 * 프록시 한도 소진·외부 응답 형식 변경)이 사라져 원인 판정이 「원인 불명」에 머문다(자가 정상화 4단계).
 */
export function appendFailureCause(reason: string, cause?: string | null): string {
  const trimmed = cause?.trim();
  if (!trimmed) return reason;
  return `${reason}${FAILURE_CAUSE_SEPARATOR}${clipFailureCause(trimmed)}`;
}

/**
 * 원인 문구에서 항목 식별자와 자격 증명을 걷어낸다.
 *
 * - 항목 식별자(셀러 핸들·이름·id·URL)는 `<항목>` 으로 바꾼다 — 남기면 같은 원인이 셀러마다 다른
 *   사고 서명이 되어 반복 집계가 갈라지고, 오너 알림 경로로 셀러 정보가 샐 수 있다.
 *   긴 것부터 바꾼다(짧은 식별자가 긴 식별자의 일부를 먼저 먹지 않게).
 *   **낱말 전체로 나올 때만** 바꾼다(앞뒤가 영숫자·밑줄·점으로 이어지지 않을 때 — 문장 끝 마침표는 경계다).
 *   그냥 부분 문자열로 바꾸면 「ai」 같은 짧은 핸들이 「email」 속을 먹어 원인 문구가 망가진다.
 *   흔한 오류 낱말(`fetch`·`failed`·`timeout` 등)과 같은 식별자는 아예 바꾸지 않는다 — 그런 핸들이
 *   「fetch failed」를 지우면 원인 판정 신호가 사라진다.
 * - URL 사용자 정보(`//user:pw@`)·이름에 secret·token·key 가 든 쿼리 값·`Bearer` 토큰·JSON 의
 *   `access_token`·`refresh_token`·`client_secret` 값은 `<가림>` 으로 바꾼다 — 전송 계층 오류 사슬에
 *   프록시 주소·토큰 교환 요청/응답이 섞일 수 있다(실행 이력으로 새면 안 된다).
 */
export function scrubFailureCause(
  text: string,
  identifiers: ReadonlyArray<string | null | undefined> = [],
): string {
  let out = text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1<가림>@")
    .replace(/([?&][\w-]*(?:secret|token|key)[\w-]*=)[^&\s]+/gi, "$1<가림>")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<가림>")
    .replace(/("(?:access_token|refresh_token|client_secret)"\s*:\s*")[^"]*"/gi, '$1<가림>"');
  const ids = [
    ...new Set(
      identifiers.filter(
        (id): id is string =>
          typeof id === "string" && id.trim().length > 0 && !COMMON_ERROR_WORDS.has(id.trim().toLowerCase()),
      ),
    ),
  ].sort((a, b) => b.length - a.length);
  for (const id of ids) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_.])${escapeRegExp(id)}(?![A-Za-z0-9_]|\\.[A-Za-z0-9_])`, "g"), "<항목>");
  }
  return out;
}

/** 식별자로 들어와도 바꾸지 않는 흔한 오류 낱말 — 바꾸면 원인 문구 자체가 지워진다. */
const COMMON_ERROR_WORDS: ReadonlySet<string> = new Set([
  "fetch",
  "failed",
  "fail",
  "error",
  "code",
  "status",
  "timeout",
  "network",
  "proxy",
  "request",
  "response",
  "token",
  "http",
  "https",
  "null",
  "undefined",
  "unknown",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 항목 오류 하나를 대표 원인 문구로 — 원인 사슬(`describeErrorChain`)을 펼친 뒤 식별자를 걷어낸다. */
export function describeFailureCause(
  error: unknown,
  identifiers: ReadonlyArray<string | null | undefined> = [],
): string {
  return scrubFailureCause(describeErrorChain(error), identifiers);
}
