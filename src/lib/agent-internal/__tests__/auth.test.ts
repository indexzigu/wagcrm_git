/**
 * 봇 내부 창구 인증 — 세 겹(비밀값 설정 · 터널 경유 거부 · 상수 시간 대조)을 고정한다. 정본 `../auth.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MIN_SECRET_CHARS, agentInternalNotFound, verifyAgentInternalRequest } from "../auth";
import { AGENT_INTERNAL_SECRET_HEADER } from "../api-contract";

const SECRET = "a".repeat(64);
const original = process.env.AGENT_INTERNAL_API_SECRET;

function request(headers: Record<string, string>, host = "127.0.0.1:3000"): Request {
  return new Request("http://127.0.0.1:3000/api/internal/agent/store-product-options", {
    method: "POST",
    headers: { host, ...headers },
  });
}

afterEach(() => {
  if (original === undefined) delete process.env.AGENT_INTERNAL_API_SECRET;
  else process.env.AGENT_INTERNAL_API_SECRET = original;
});

describe("verifyAgentInternalRequest", () => {
  it("비밀값이 맞고 터널 헤더가 없으면 통과한다", () => {
    process.env.AGENT_INTERNAL_API_SECRET = SECRET;
    expect(verifyAgentInternalRequest(request({ [AGENT_INTERNAL_SECRET_HEADER]: SECRET }))).toBe(true);
  });

  it("앱에 비밀값이 없으면 누구도 통과하지 못한다(fail-closed)", () => {
    delete process.env.AGENT_INTERNAL_API_SECRET;
    expect(verifyAgentInternalRequest(request({ [AGENT_INTERNAL_SECRET_HEADER]: "" }))).toBe(false);
    expect(verifyAgentInternalRequest(request({ [AGENT_INTERNAL_SECRET_HEADER]: "undefined" }))).toBe(false);
  });

  it("짧은 비밀값(붙여넣기 실수)은 맞아도 열지 않는다", () => {
    const short = "b".repeat(MIN_SECRET_CHARS - 1);
    process.env.AGENT_INTERNAL_API_SECRET = short;
    expect(verifyAgentInternalRequest(request({ [AGENT_INTERNAL_SECRET_HEADER]: short }))).toBe(false);
  });

  it("터널을 거쳐 온 요청은 비밀값이 맞아도 거절한다", () => {
    process.env.AGENT_INTERNAL_API_SECRET = SECRET;
    for (const tunnelHeader of ["cf-ray", "cf-connecting-ip"]) {
      expect(
        verifyAgentInternalRequest(request({ [AGENT_INTERNAL_SECRET_HEADER]: SECRET, [tunnelHeader]: "x" })),
      ).toBe(false);
    }
  });

  it("받는 주소(Host)가 루프백이 아니면 비밀값이 맞아도 거절한다", () => {
    process.env.AGENT_INTERNAL_API_SECRET = SECRET;
    expect(verifyAgentInternalRequest(request({ [AGENT_INTERNAL_SECRET_HEADER]: SECRET }, "crm.example.com"))).toBe(false);
    expect(verifyAgentInternalRequest(request({ [AGENT_INTERNAL_SECRET_HEADER]: SECRET }, "localhost:3000"))).toBe(true);
    expect(verifyAgentInternalRequest(request({ [AGENT_INTERNAL_SECRET_HEADER]: SECRET }, "[::1]:3000"))).toBe(true);
  });

  it("앱 비밀값의 앞뒤 공백(붙여넣기 줄 끝)은 걷고 잰다", () => {
    process.env.AGENT_INTERNAL_API_SECRET = `${SECRET} \r`;
    expect(verifyAgentInternalRequest(request({ [AGENT_INTERNAL_SECRET_HEADER]: SECRET }))).toBe(true);
  });

  it("비밀값이 없거나 다르면 거절한다", () => {
    process.env.AGENT_INTERNAL_API_SECRET = SECRET;
    expect(verifyAgentInternalRequest(request({}))).toBe(false);
    expect(verifyAgentInternalRequest(request({ [AGENT_INTERNAL_SECRET_HEADER]: `${SECRET}x` }))).toBe(false);
    expect(verifyAgentInternalRequest(request({ [AGENT_INTERNAL_SECRET_HEADER]: "c".repeat(64) }))).toBe(false);
  });

  it("거절 응답은 본문 없는 404 다(창구가 있는지 드러내지 않는다)", async () => {
    const response = agentInternalNotFound();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });
});
