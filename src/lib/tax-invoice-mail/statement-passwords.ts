/**
 * 정산 메일 첨부의 열기 암호 — 환경변수 `STATEMENT_ATTACHMENT_PASSWORDS` 에서만 읽는다(봇 정산 대조).
 *
 * ⛔ 이 레포는 공개다 — 비밀번호를 소스·테스트·주석·문서·커밋에 적지 않는다. 값은 호스트 `.env` 에만 둔다.
 * 형식: 비밀번호 하나면 그 글자 그대로, 여럿이면 JSON 문자열 배열(`["a","b"]`). 앞뒤 공백은 버린다. 브랜드마다 암호가 다르면
 * 여럿을 적는다 — 첨부마다 검증값(`biff-rc4.ts`)이 맞는 것만 쓰이고 나머지는 걸러진다.
 * 값이 없거나 형식이 틀리면 빈 목록이다(암호 첨부는 「못 읽음」으로 남는다) — 예외를 던지지 않고 값도 싣지 않는다.
 */
const MAX_PASSWORDS = 8;
const MAX_PASSWORD_CHARS = 255;

export function readStatementAttachmentPasswords(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.STATEMENT_ATTACHMENT_PASSWORDS?.trim();
  if (!raw) return [];
  let candidates: unknown[] = [raw];
  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      candidates = Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const password = candidate.trim();
    if (password.length > 0 && password.length <= MAX_PASSWORD_CHARS) seen.add(password);
    if (seen.size >= MAX_PASSWORDS) break;
  }
  return [...seen];
}
