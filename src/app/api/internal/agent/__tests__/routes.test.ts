/**
 * 봇 내부 창구 라우트 6개(슬랙 버튼 결정 창구 포함) — 인증 실패면 본체를 부르지 않고 404, 모양이 틀리면 400, 통과하면 본체 결과를 그대로.
 * 본체 동작은 `src/lib/agent-internal/__tests__/*` 가 고정한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const optionsMock = vi.fn();
const applyMock = vi.fn();
const draftMock = vi.fn();
const roundDraftMock = vi.fn();
const groupRoundDraftMock = vi.fn();
const slackDecisionMock = vi.fn();
vi.mock("@/lib/agent-internal/store-product-options", () => ({ getStoreProductOptions: (...a: unknown[]) => optionsMock(...a) }));
vi.mock("@/lib/agent-internal/apply-product-mappings", () => ({ applyProductMappings: (...a: unknown[]) => applyMock(...a) }));
vi.mock("@/lib/agent-internal/order-campaign-draft", () => ({ buildOrderCampaignDraft: (...a: unknown[]) => draftMock(...a) }));
vi.mock("@/lib/agent-internal/sales-campaign-round-draft", () => ({
  buildSalesCampaignRoundDraft: (...a: unknown[]) => roundDraftMock(...a),
}));
vi.mock("@/lib/agent-internal/sales-campaign-group-round-draft", () => ({
  buildSalesCampaignGroupRoundDraft: (...a: unknown[]) => groupRoundDraftMock(...a),
}));
vi.mock("@/lib/agent-internal/slack-decision", () => ({
  decideProposalFromSlack: (...a: unknown[]) => slackDecisionMock(...a),
}));
vi.mock("@/lib/order-converter/proxy-usage", () => ({
  withProxySource: (_source: string, handler: (...args: unknown[]) => unknown) => handler,
}));

const { POST: optionsPost } = await import("../store-product-options/route");
const { POST: applyPost } = await import("../apply-product-mappings/route");
const { POST: draftPost } = await import("../order-campaign-draft/route");
const { POST: roundDraftPost } = await import("../sales-campaign-round-draft/route");
const { POST: groupRoundDraftPost } = await import("../sales-campaign-group-round-draft/route");
const { POST: slackDecisionPost } = await import("../slack-decision/route");

const SECRET = "k".repeat(64);
const original = process.env.AGENT_INTERNAL_API_SECRET;
const SLACK_SECRET = "s".repeat(64);
const originalSlack = process.env.AGENT_SLACK_DECISION_SECRET;

function post(path: string, body: unknown, headers: Record<string, string> = { "x-agent-internal-secret": SECRET }) {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: { host: "127.0.0.1:3000", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.AGENT_INTERNAL_API_SECRET = SECRET;
  process.env.AGENT_SLACK_DECISION_SECRET = SLACK_SECRET;
  slackDecisionMock.mockReset();
  optionsMock.mockReset();
  applyMock.mockReset();
  draftMock.mockReset();
  roundDraftMock.mockReset();
  groupRoundDraftMock.mockReset();
});
afterEach(() => {
  if (original === undefined) delete process.env.AGENT_INTERNAL_API_SECRET;
  else process.env.AGENT_INTERNAL_API_SECRET = original;
  if (originalSlack === undefined) delete process.env.AGENT_SLACK_DECISION_SECRET;
  else process.env.AGENT_SLACK_DECISION_SECRET = originalSlack;
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

  it("주문캠페인 초안 창구 — 비밀값 없으면 404, 상품 지목이 0개·2개면 400, 통과하면 본체 결과", async () => {
    const noSecret = await draftPost(post("/api/internal/agent/order-campaign-draft", { productQuery: "상품" }, {}));
    const none = await draftPost(post("/api/internal/agent/order-campaign-draft", { sellerName: "s" }));
    const both = await draftPost(
      post("/api/internal/agent/order-campaign-draft", { productQuery: "상품", productId: "123" }),
    );
    const withMemo = await draftPost(
      post("/api/internal/agent/order-campaign-draft", { productQuery: "상품", memo: "메모는 실행기가 붙인다" }),
    );
    expect([noSecret.status, none.status, both.status, withMemo.status]).toEqual([404, 400, 400, 400]);
    expect(draftMock).not.toHaveBeenCalled();

    draftMock.mockResolvedValue({ ok: false, code: "PRODUCT_AMBIGUOUS", message: "후보" });
    const response = await draftPost(post("/api/internal/agent/order-campaign-draft", { productQuery: "상품" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, code: "PRODUCT_AMBIGUOUS", message: "후보" });
    expect(draftMock).toHaveBeenCalledWith({ productQuery: "상품" });
  });

  it("판매캠페인 회차 초안 창구 — 비밀값 없으면 404, 이전 회차 없음·상품 2개·날짜 한쪽·메모는 400, 통과하면 본체 결과", async () => {
    const path = "/api/internal/agent/sales-campaign-round-draft";
    const noSecret = await roundDraftPost(post(path, { previousCampaignId: "c1" }, {}));
    const none = await roundDraftPost(post(path, { productQuery: "상품" }));
    const both = await roundDraftPost(post(path, { previousCampaignId: "c1", productQuery: "상품", productId: "1" }));
    const half = await roundDraftPost(post(path, { previousCampaignId: "c1", startDate: "2026-12-01" }));
    const withMemo = await roundDraftPost(post(path, { previousCampaignId: "c1", memo: "메모는 실행기가 붙인다" }));
    expect([noSecret.status, none.status, both.status, half.status, withMemo.status]).toEqual([404, 400, 400, 400, 400]);
    expect(roundDraftMock).not.toHaveBeenCalled();

    roundDraftMock.mockResolvedValue({ ok: false, code: "SALE_PERIOD_UNAVAILABLE", message: "날짜" });
    const response = await roundDraftPost(post(path, { previousCampaignId: "c1" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, code: "SALE_PERIOD_UNAVAILABLE", message: "날짜" });
    expect(roundDraftMock).toHaveBeenCalledWith({ previousCampaignId: "c1" });
  });

  it("판매캠페인 그룹 회차 초안 창구 — 비밀값 없으면 404, 근거 없음·상품 2개·날짜 한쪽·메모는 400, 통과하면 본체 결과", async () => {
    const path = "/api/internal/agent/sales-campaign-group-round-draft";
    const noSecret = await groupRoundDraftPost(post(path, { productQuery: "상품" }, {}));
    const none = await groupRoundDraftPost(post(path, { startDate: "2026-12-01", endDate: "2026-12-07" }));
    const both = await groupRoundDraftPost(post(path, { productQuery: "상품", productId: "1" }));
    const half = await groupRoundDraftPost(post(path, { productId: "1", startDate: "2026-12-01" }));
    const withMemo = await groupRoundDraftPost(post(path, { productId: "1", memo: "메모는 실행기가 붙인다" }));
    expect([noSecret.status, none.status, both.status, half.status, withMemo.status]).toEqual([404, 400, 400, 400, 400]);
    expect(groupRoundDraftMock).not.toHaveBeenCalled();

    groupRoundDraftMock.mockResolvedValue({ ok: false, code: "PREVIOUS_GROUP_NOT_FOUND", message: "그룹 없음" });
    const response = await groupRoundDraftPost(post(path, { productQuery: "상품" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, code: "PREVIOUS_GROUP_NOT_FOUND", message: "그룹 없음" });
    expect(groupRoundDraftMock).toHaveBeenCalledWith({ productQuery: "상품" });
  });

  describe("슬랙 버튼 결정 창구", () => {
    const path = "/api/internal/agent/slack-decision";
    const body = { proposalId: "p1", decision: "approve" };

    it("전용 비밀값만 연다 — 워커 비밀값·비밀값 없음·터널 경유는 본체를 부르지 않고 404", async () => {
      const workerSecret = await slackDecisionPost(post(path, body));
      const none = await slackDecisionPost(post(path, body, {}));
      const viaTunnel = await slackDecisionPost(
        post(path, body, { "x-agent-internal-secret": SLACK_SECRET, "cf-connecting-ip": "1.2.3.4" }),
      );
      expect([workerSecret.status, none.status, viaTunnel.status]).toEqual([404, 404, 404]);
      expect(slackDecisionMock).not.toHaveBeenCalled();
    });

    it("슬랙 비밀값으로는 워커 창구가 열리지 않는다", async () => {
      const response = await optionsPost(
        post("/api/internal/agent/store-product-options", { orderCampaignId: "c1" }, { "x-agent-internal-secret": SLACK_SECRET }),
      );
      expect(response.status).toBe(404);
      expect(optionsMock).not.toHaveBeenCalled();
    });

    it("두 비밀값이 같게 설정되면 결정 창구를 닫는다", async () => {
      process.env.AGENT_SLACK_DECISION_SECRET = SECRET;
      const response = await slackDecisionPost(post(path, body));
      expect(response.status).toBe(404);
      expect(slackDecisionMock).not.toHaveBeenCalled();
    });

    it("모양이 틀리면 400 INVALID_INPUT — 슬랙 좌표 같은 추가 칸도 받지 않는다", async () => {
      const headers = { "x-agent-internal-secret": SLACK_SECRET };
      const extra = await slackDecisionPost(post(path, { ...body, channel: "C1" }, headers));
      const badDecision = await slackDecisionPost(post(path, { proposalId: "p1", decision: "retry" }, headers));
      expect([extra.status, badDecision.status]).toEqual([400, 400]);
      expect(await extra.json()).toEqual({ ok: false, code: "INVALID_INPUT", status: null });
      expect(slackDecisionMock).not.toHaveBeenCalled();
    });

    it("통과하면 본체 결과를 200 으로 그대로 — 실패 결과도 카드 문구를 정하는 값이라 200", async () => {
      const headers = { "x-agent-internal-secret": SLACK_SECRET };
      slackDecisionMock.mockResolvedValueOnce({ ok: false, code: "ALREADY_DECIDED", status: "EXECUTED" });
      const response = await slackDecisionPost(post(path, body, headers));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: false, code: "ALREADY_DECIDED", status: "EXECUTED" });
      expect(slackDecisionMock).toHaveBeenCalledWith({ proposalId: "p1", decision: "approve" });
    });
  });
});
