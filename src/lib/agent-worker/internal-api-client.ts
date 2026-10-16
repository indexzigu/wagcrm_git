import type { z } from "zod";
import { AGENT_INTERNAL_SECRET_HEADER, LOOPBACK_HOSTNAMES } from "@/lib/agent-internal/api-contract";

/**
 * 봇 작업 실행기 → CRM 앱 봇 내부 창구(`/api/internal/agent/*`) 호출 클라이언트(2026-10-16, 오너 결정 방식 A).
 *
 * 봇 작업 실행기는 네이버 열쇠도 매핑 쓰기 권한도 없다 — 스토어 옵션 조회와 매핑 즉시 저장은 앱이 앱 권한으로
 * 하고, 여기서는 **부탁만** 한다. 워커 env(`infra/selfhost/agent-worker.env`)에 두 줄이 있어야 한다:
 *  - `AGENT_INTERNAL_API_SECRET` — 앱 env 와 같은 값(앱 `agent-internal/auth.ts` 가 대조한다).
 *  - `AGENT_INTERNAL_API_URL` — 선택. 비우면 `DEFAULT_AGENT_INTERNAL_API_URL`(앱 `run-app.sh` 의 바인드 주소).
 *
 * ⛔ 루프백 주소만 받는다(`127.0.0.1` · `localhost` · `[::1]`, http). 공개 도메인을 적으면 비밀값이 터널 밖을
 *    돌아 들어가게 되므로 호출하지 않고 설정 오류로 끝낸다 — 창구도 터널 경유 요청은 404 로 거절한다.
 * ⛔ 리다이렉트를 따라가지 않는다(`redirect: "manual"`) — 세션 게이트 면제가 빠진 배포면 `/login` 으로 307 이
 *    오는데, 따라가면 로그인 페이지 HTML 을 「응답 모양 이상」으로 읽어 원인이 흐려진다.
 */
export const DEFAULT_AGENT_INTERNAL_API_URL = "http://127.0.0.1:3000";
export const AGENT_INTERNAL_TIMEOUT_MS = 60_000;

export type InternalApiFailureClass =
  /** 워커 env 에 비밀값이 없거나 주소가 루프백이 아님. */
  | "INTERNAL_API_NOT_CONFIGURED"
  /** 연결·시간 초과 — 앱이 꺼져 있거나 응답이 없음. */
  | "INTERNAL_API_UNREACHABLE"
  /** 404 본문 없음 · 리다이렉트 — 창구가 닫혀 있음(앱 비밀값 미설정·불일치, 또는 창구가 아직 배포되지 않음). */
  | "INTERNAL_API_UNAVAILABLE"
  /** 응답이 계약 모양이 아님. */
  | "INTERNAL_API_BAD_RESPONSE";

export type InternalApiCallResult<T> =
  | { ok: true; body: T }
  | { ok: false; errorClass: InternalApiFailureClass; detail: string };

export type InternalApiEnv = {
  AGENT_INTERNAL_API_SECRET?: string;
  AGENT_INTERNAL_API_URL?: string;
};

export type InternalApiDeps = {
  env?: InternalApiEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function resolveBaseUrl(raw: string | undefined): URL | null {
  const value = raw?.trim() || DEFAULT_AGENT_INTERNAL_API_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTNAMES.has(url.hostname)) return null;
  return url;
}

export async function callAgentInternalApi<S extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  schema: S,
  signal: AbortSignal,
  deps: InternalApiDeps = {},
): Promise<InternalApiCallResult<z.infer<S>>> {
  const env = deps.env ?? (process.env as InternalApiEnv);
  const secret = env.AGENT_INTERNAL_API_SECRET?.trim();
  if (!secret) {
    return {
      ok: false,
      errorClass: "INTERNAL_API_NOT_CONFIGURED",
      detail: "워커 env 에 AGENT_INTERNAL_API_SECRET 이 없습니다.",
    };
  }
  const base = resolveBaseUrl(env.AGENT_INTERNAL_API_URL);
  if (!base) {
    return {
      ok: false,
      errorClass: "INTERNAL_API_NOT_CONFIGURED",
      detail: "AGENT_INTERNAL_API_URL 은 루프백 http 주소여야 합니다(예: http://127.0.0.1:3000).",
    };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json", [AGENT_INTERNAL_SECRET_HEADER]: secret },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs ?? AGENT_INTERNAL_TIMEOUT_MS)]),
    });
  } catch (error) {
    return {
      ok: false,
      errorClass: "INTERNAL_API_UNREACHABLE",
      detail: `CRM 앱에 닿지 못했습니다: ${error instanceof Error ? error.name : "UnknownError"}`,
    };
  }

  const text = await response.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  if (json === null && (response.status === 404 || (response.status >= 300 && response.status < 400))) {
    return {
      ok: false,
      errorClass: "INTERNAL_API_UNAVAILABLE",
      detail: `CRM 앱 봇 창구가 닫혀 있습니다(HTTP ${response.status}). 앱·워커 비밀값 설정과 배포 여부를 확인하세요.`,
    };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errorClass: "INTERNAL_API_BAD_RESPONSE",
      detail: `CRM 앱 응답이 계약 모양이 아닙니다(HTTP ${response.status}).`,
    };
  }
  return { ok: true, body: parsed.data };
}
