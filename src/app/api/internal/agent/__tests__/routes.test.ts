/**
 * 봇 내부 창구 라우트 2개 — 인증 실패면 본체를 부르지 않고 404, 모양이 틀리면 400, 통과하면 본체 결과를 그대로.
 * 본체 동작은 `src/lib/agent-internal/__tests__/*` 가 고정한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const optionsMock = vi.fn();
const applyMock = vi.fn();
vi.mock("@/lib/agent-internal/store-product-options", () => ({ getStoreProductOptions: (...a: unknown[]) => optionsMock(...a) }));
vi.mock("@/lib/agent-internal/apply-product-mappings", () => ({ applyProductMappings: (...a: unknown[]) => applyMock(...a) }));
vi.mock("@/lib/order-converter/proxy-usage", () => ({
  withProxySource: (_source: string, handler: (...args: unknown[]) => unknown) => handler,
}));

const { POST: optionsPost } = await import("../store-product-options/route");
const { POST: applyPost } = await import("../apply-product-mappings/route");

const SECRET = "k".repeat(64);
const original = process.env.AGENT_INTERNAL_API_SECRET;

function post(path: string, body: unknown, headers: Record<string, string> = { "x-agent-internal-secret": SECRET }) {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: { host: "127.0.0.1:3000", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.AGENT_INTERNAL_API_SECRET = SECRET;
  optionsMock.mockReset();
  applyMock.mockReset();
});
afterEach(() => {
  if (original === undefined) delete process.env.AGENT_INTERNAL_API_SECRET;
  else process.env.AGENT_INTERNAL_API_SECRET = original;
});

describe("봇 내부 창구 라우트", () => {
  it("비밀값이 없거나 터널을 거쳐 오면 본체를 부르지 않고 404", async () => {
    const noSecret = await optionsPost(post("/api/internal/agent/store-product-options", { orderCampaignId: "c1" }, {}));
    const viaTunnel = await applyPost(
      post("/api/internal/agent/apply-product-mappings", {}, { "x-agent-internal-secret": SECRET, "cf-ray": "abc" }),
    );
    expect([noSecret.status, viaTunnel.status]).toEqual([404, 404]);
    expect(optionsMock).not.toHaveBeenCalled();
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("요청 모양이 틀리면 400 INVALID_INPUT — 상품명 칸·중복 옵션명도 받지 않는다", async () => {
    const extraField = await applyPost(
      post("/api/internal/agent/apply-product-mappings", {
        orderCampaignId: "c1",
        mappings: [{ optionName: "a", brandCode: "b", price: 1, productName: "코드표 이름" }],
      }),
    );
    const duplicate = await applyPost(
      post("/api/internal/agent/apply-product-mappings", {
        orderCampaignId: "c1",
        mappings: [
          { optionName: "a", brandCode: "b", price: 1 },
          { optionName: " a ", brandCode: "c", price: 2 },
        ],
      }),
    );
    expect([extraField.status, duplicate.status]).toEqual([400, 400]);
    expect(await extraField.json()).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("통과하면 본체 결과를 그대로 응답하고, 실패 코드는 HTTP 상태로도 가른다", async () => {
    optionsMock.mockResolvedValue({ ok: false, code: "NO_STORE_OPTIONS", message: "m" });
    const response = await optionsPost(post("/api/internal/agent/store-product-options", { orderCampaignId: "c1" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, code: "NO_STORE_OPTIONS", message: "m" });
    expect(optionsMock).toHaveBeenCalledWith("c1");
  });
});
