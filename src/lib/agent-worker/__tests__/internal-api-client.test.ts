/**
 * 봇 작업 실행기 → CRM 앱 봇 내부 창구 클라이언트. 정본 `../internal-api-client.ts`.
 * 루프백만 · 비밀값 헤더 · 리다이렉트 비추종 · 실패 갈래(설정 없음·연결 실패·창구 닫힘·모양 이상)를 고정한다.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callAgentInternalApi } from "../internal-api-client";
import { AGENT_INTERNAL_SECRET_HEADER } from "@/lib/agent-internal/api-contract";

const schema = z.object({ ok: z.literal(true), value: z.number() }).strict();
const SECRET = "s".repeat(64);
const signal = new AbortController().signal;

function fetchReturning(response: Response) {
  return vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => response);
}

describe("callAgentInternalApi", () => {
  it("루프백 주소로 비밀값 헤더를 실어 POST 하고, 리다이렉트를 따라가지 않는다", async () => {
    const fetchImpl = fetchReturning(new Response(JSON.stringify({ ok: true, value: 1 }), { status: 200 }));
    const result = await callAgentInternalApi("/api/internal/agent/x", { a: 1 }, schema, signal, {
      env: { AGENT_INTERNAL_API_SECRET: SECRET },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, body: { ok: true, value: 1 } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:3000/api/internal/agent/x");
    expect(init?.redirect).toBe("manual");
    expect((init?.headers as Record<string, string>)[AGENT_INTERNAL_SECRET_HEADER]).toBe(SECRET);
    expect(init?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("비밀값이 없으면 부르지 않고 INTERNAL_API_NOT_CONFIGURED", async () => {
    const fetchImpl = vi.fn();
    const result = await callAgentInternalApi("/x", {}, schema, signal, { env: {}, fetchImpl: fetchImpl as never });
    expect(result).toMatchObject({ ok: false, errorClass: "INTERNAL_API_NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("루프백이 아닌 주소(공개 도메인)는 비밀값을 보내지 않고 INTERNAL_API_NOT_CONFIGURED", async () => {
    const fetchImpl = vi.fn();
    for (const url of ["https://crm.example.com", "http://192.168.0.10:3000", "https://127.0.0.1:3000", "nonsense"]) {
      const result = await callAgentInternalApi("/x", {}, schema, signal, {
        env: { AGENT_INTERNAL_API_SECRET: SECRET, AGENT_INTERNAL_API_URL: url },
        fetchImpl: fetchImpl as never,
      });
      expect(result).toMatchObject({ ok: false, errorClass: "INTERNAL_API_NOT_CONFIGURED" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("본문 없는 404 · 리다이렉트는 창구가 닫힌 것(INTERNAL_API_UNAVAILABLE)", async () => {
    for (const response of [
      new Response("Not Found", { status: 404 }),
      new Response(null, { status: 307, headers: { location: "/login" } }),
    ]) {
      const result = await callAgentInternalApi("/x", {}, schema, signal, {
        env: { AGENT_INTERNAL_API_SECRET: SECRET },
        fetchImpl: fetchReturning(response) as unknown as typeof fetch,
      });
      expect(result).toMatchObject({ ok: false, errorClass: "INTERNAL_API_UNAVAILABLE" });
    }
  });

  it("연결 실패는 INTERNAL_API_UNREACHABLE, 계약 밖 응답은 INTERNAL_API_BAD_RESPONSE", async () => {
    const unreachable = await callAgentInternalApi("/x", {}, schema, signal, {
      env: { AGENT_INTERNAL_API_SECRET: SECRET },
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(unreachable).toMatchObject({ ok: false, errorClass: "INTERNAL_API_UNREACHABLE" });

    const bad = await callAgentInternalApi("/x", {}, schema, signal, {
      env: { AGENT_INTERNAL_API_SECRET: SECRET },
      fetchImpl: fetchReturning(new Response(JSON.stringify({ ok: true, value: "x" }), { status: 200 })) as never,
    });
    expect(bad).toMatchObject({ ok: false, errorClass: "INTERNAL_API_BAD_RESPONSE" });
  });
});
