/**
 * 자동 작업(크론) 오류 본문 — `cause` 사슬을 한 줄로 펼친다.
 * `fetch failed` 처럼 겉 문구만 남으면 진짜 원인(프록시 407 등)이 사라지므로
 * 응답 본문의 `error` 에는 이 문자열을 싣는다. 결과는 1,000자에서 자른다.
 */
const MAX_LENGTH = 1000;

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
    if (!(current instanceof Error)) {
      parts.push(describeValue(current));
      break;
    }
    parts.push(current.message);
    if (current.cause === undefined) break;
    current = current.cause;
  }
  return parts.join(" <- ").slice(0, MAX_LENGTH);
}
