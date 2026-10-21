/**
 * 자동 작업(크론) 오류 본문 — `cause` 사슬을 한 줄로 펼친다.
 * `fetch failed` 처럼 겉 문구만 남으면 진짜 원인(프록시 407 등)이 사라지므로
 * 응답 본문의 `error` 에는 이 문자열을 싣는다. 결과는 1,000자에서 자른다.
 *
 * ⚠️ 결과는 **빈 문자열이 되지 않는다** — 메시지 없는 오류(`new Error()`)는 이름(`Error`·`AbortError`)으로,
 * 이름도 없으면 「알 수 없는 오류」로 쓴다. 빈 문자열이면 `if (result.error)` 로 실패를 가르는 호출처
 * (주문 동기화 크론 등)가 실패를 성공으로 기록한다.
 * `Error` 가 아니어도 `message` 문자열을 가진 객체(직렬화 경계를 넘어온 오류 등)는 그 메시지를 쓰고 `cause` 를 잇는다.
 */
const MAX_LENGTH = 1000;
const UNKNOWN_ERROR = "알 수 없는 오류";

/** `message` 문자열을 가진 오류 비슷한 객체 — Error 인스턴스 포함 */
function messageOf(value: unknown): { message: string; name: string; cause: unknown } | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as { message?: unknown; name?: unknown; cause?: unknown };
  if (!(value instanceof Error) && typeof v.message !== "string") return null;
  return {
    message: typeof v.message === "string" ? v.message : "",
    name: typeof v.name === "string" ? v.name : "",
    cause: v.cause,
  };
}

function describeValue(value: unknown): string {
  if (value !== null && typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      if (typeof json === "string") return json;
    } catch {
      // 순환 구조 등 — 아래 String 폴백.
    }
  }
  return String(value);
}

export function describeErrorChain(error: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const err = messageOf(current);
    if (!err) {
      parts.push(describeValue(current) || UNKNOWN_ERROR);
      break;
    }
    parts.push(err.message || err.name || UNKNOWN_ERROR);
    if (err.cause === undefined) {
      // `AggregateError` 는 원인을 `cause` 가 아니라 `errors` 배열에 싣는다 — 프록시 407 이 이 안에 실려 오는
      // 경로가 있다(`fetch-client.contract.test.ts`). 안 보면 원인이 「all attempts failed」에서 끊겨 한도 소진이
      // 네트워크 장애로 분류되고 헛재시도가 난다. 앞의 3개만, 각각 짧게 펼친다.
      const inner = (current as { errors?: unknown }).errors;
      if (Array.isArray(inner) && inner.length > 0) {
        parts.push(`[${inner.slice(0, 3).map((e) => describeErrorChain(e, 2)).join(" | ")}]`);
      }
      break;
    }
    current = err.cause;
  }
  return parts.join(" <- ").slice(0, MAX_LENGTH);
}
