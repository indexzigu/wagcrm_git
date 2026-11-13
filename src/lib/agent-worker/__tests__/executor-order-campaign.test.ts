/**
 * 주문캠페인 새로 만들기 기안(`create_order_campaign`, 2026-11-13) — 실행기 배선. 고정하는 것:
 *  ① 봇 입력(상품 지목·셀러·거래처)에서 메모를 뺀 것만 창구에 보내고, 창구 초안 + 메모가 그대로 저장 args 가 된다
 *  ② 창구 실패(후보 여럿 등)는 기안을 만들지 않고 실패 코드·문구로 돌아간다(봇이 오너에게 고르게 한다)
 *  ③ 창구 초안이 저장 스키마에 안 맞으면 기안을 만들지 않는다
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload } from "../contracts";

const callMock = vi.fn();
const insertMock = vi.fn();
vi.mock("../internal-api-client", () => ({ callAgentInternalApi: (...args: unknown[]) => callMock(...args) }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ $transaction: async (cb: (tx: unknown) => unknown) => cb({}) }),
}));
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => false }));
vi.mock("@/lib/agent/agent-worker-proposal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/agent-worker-proposal")>()),
  insertAgentWorkerProposal: (...args: unknown[]) => insertMock(...args),
}));

const { executeAgentJob } = await import("../executor");

function job(input: AgentJobPayload["input"]): AgentJobRecord {
  return {
    id: "job-1",
    idempotencyKey: "key-1",
    payload: {
      schemaVersion: 1,
      taskType: "deterministic",
      skill: "wag-crm-order-campaign",
      operation: "create_action_proposal",
      input,
      origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t" },
    },
    status: "RUNNING",
    workerId: "worker-1",
    leaseExpiresAt: new Date("2026-11-13T00:02:00.000Z"),
    heartbeatAt: new Date("2026-11-13T00:00:00.000Z"),
    attempt: 0,
    result: null,
    failureCode: null,
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    updatedAt: new Date("2026-11-13T00:00:00.000Z"),
  };
}

const deps = {
  decideRoute: vi.fn(async () => ({ status: "ACCEPTED" as const, route: "python" as const, model: "python", reason: "deterministic" })),
  now: () => new Date("2026-11-13T00:00:00.000Z"),
};

const draft = {
  productId: "103",
  channelProductNo: "203",
  name: "[샘플셀러 X 샘플브랜드] 유산균",
  sellerName: "샘플셀러",
  template: "sample-brand",
  templateName: "샘플거래처",
  toEmail: null,
  ccEmail: null,
  thumbnailUrl: null,
  category: null,
  productStatus: "SALE",
  salePeriod: "2026.11.20 ~ 2026.11.26",
  mappings: [{ productName: "p", optionName: "구성: 1박스", price: 30000 }],
  sameProductCampaigns: [{ id: "oc1", name: "지난 회차", isActive: false }],
};

beforeEach(() => {
  callMock.mockReset();
  insertMock.mockReset();
  insertMock.mockResolvedValue("prop-1");
});

describe("create_action_proposal — create_order_campaign", () => {
  it("창구 초안 + 메모를 저장 args 로 기안을 만든다(메모는 창구에 보내지 않는다)", async () => {
    callMock.mockResolvedValue({ ok: true, body: { ok: true, data: draft } });
    const outcome = await executeAgentJob(
      job({ action: "create_order_campaign", productQuery: "유산균", orderBrand: "샘플거래처", memo: "11월 회차" }),
      deps,
    );
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("NEEDS_APPROVAL");
    expect(outcome.result.actionProposalId).toBe("prop-1");
    expect(callMock.mock.calls[0][0]).toBe("/api/internal/agent/order-campaign-draft");
    expect(callMock.mock.calls[0][1]).toEqual({ productQuery: "유산균", orderBrand: "샘플거래처" });
    const inserted = insertMock.mock.calls[0][1] as { intent: { action: string; summary: string }; storedArgs: unknown };
    expect(inserted.storedArgs).toEqual({ ...draft, memo: "11월 회차" });
    expect(inserted.intent.action).toBe("create_order_campaign");
    expect(inserted.intent.summary).toContain("같은 상품 캠페인 1개 있음");
  });

  it("후보가 여럿이면 기안 없이 실패 코드·후보 문구를 돌려준다", async () => {
    callMock.mockResolvedValue({
      ok: true,
      body: { ok: false, code: "PRODUCT_AMBIGUOUS", message: "상품이 2개 걸립니다: 「a」(상품번호 1), 「b」(상품번호 2)" },
    });
    const outcome = await executeAgentJob(job({ action: "create_order_campaign", productQuery: "비타민" }), deps);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(outcome.result.resultSummary).toContain("PRODUCT_AMBIGUOUS");
    expect(outcome.result.resultSummary).toContain("상품번호 2");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("창구 초안이 저장 스키마에 안 맞으면 기안을 만들지 않는다", async () => {
    callMock.mockResolvedValue({ ok: true, body: { ok: true, data: { ...draft, mappings: [] } } });
    const outcome = await executeAgentJob(job({ action: "create_order_campaign", productId: "103" }), deps);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(insertMock).not.toHaveBeenCalled();
  });
});
