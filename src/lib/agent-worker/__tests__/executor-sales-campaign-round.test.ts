/**
 * 판매캠페인 다음 회차 기안(`create_sales_campaign_round`, 2026-11-14) — 실행기 배선. 고정하는 것:
 *  ① 봇 입력(이전 회차·상품 지목·날짜)에서 메모를 뺀 것만 창구에 보내고, 창구 초안 + 메모가 그대로 저장 args 가 된다
 *  ② 창구 실패(후보 여럿·기간 없음 등)는 기안을 만들지 않고 실패 코드·문구로 돌아간다(봇이 오너에게 묻는다)
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
      skill: "wag-crm-sales-round",
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
  previousCampaignId: "camp-1",
  previousCampaignName: "샘플딜 - 샘플셀러",
  dealId: "deal-1",
  dealName: "샘플딜",
  sellerId: "seller-1",
  sellerName: "샘플셀러",
  salesChannel: "OWN_MALL_NAVER",
  isManualMargin: false,
  totalMarginRate: 30,
  sellerMarginRate: 12,
  campaignItems: [],
  product: {
    productId: "101",
    channelProductNo: "201",
    name: "[샘플셀러 X 샘플브랜드] 비타민 2차",
    productStatus: "SALE",
    salePeriod: "2026.12.01 ~ 2026.12.07",
    source: "INPUT",
  },
  baseNaverLink: "https://smartstore.naver.com/ygrd/products/201",
  startDate: "2026-12-01",
  endDate: "2026-12-07",
  dateSource: "STORE",
  status: "PREPARATION",
  expectedRoundNumber: 2,
  expectedCampaignName: "샘플딜 - 샘플셀러 2차",
  existingRounds: [{ id: "camp-1", name: "샘플딜 - 샘플셀러", startDate: "2026-11-01", endDate: "2026-11-07" }],
  linkOrderCampaign: null,
};

beforeEach(() => {
  callMock.mockReset();
  insertMock.mockReset();
  insertMock.mockResolvedValue("prop-1");
});

describe("create_action_proposal — create_sales_campaign_round", () => {
  it("창구 초안 + 메모를 저장 args 로 기안을 만든다(메모는 창구에 보내지 않는다)", async () => {
    callMock.mockResolvedValue({ ok: true, body: { ok: true, data: draft } });
    const outcome = await executeAgentJob(
      job({ action: "create_sales_campaign_round", previousCampaignId: "camp-1", productQuery: "비타민 2차", memo: "12월 회차" }),
      deps,
    );
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("NEEDS_APPROVAL");
    expect(outcome.result.actionProposalId).toBe("prop-1");
    expect(callMock.mock.calls[0][0]).toBe("/api/internal/agent/sales-campaign-round-draft");
    expect(callMock.mock.calls[0][1]).toEqual({ previousCampaignId: "camp-1", productQuery: "비타민 2차" });
    const inserted = insertMock.mock.calls[0][1] as { intent: { action: string; summary: string }; storedArgs: unknown };
    expect(inserted.storedArgs).toEqual({ ...draft, memo: "12월 회차" });
    expect(inserted.intent.action).toBe("create_sales_campaign_round");
    expect(inserted.intent.summary).toContain("샘플딜 - 샘플셀러 2차");
  });

  it("스토어 기간을 쓸 수 없으면 기안 없이 실패 코드·문구를 돌려준다", async () => {
    callMock.mockResolvedValue({
      ok: true,
      body: { ok: false, code: "SALE_PERIOD_UNAVAILABLE", message: "이번 회차 날짜를 startDate/endDate 로 넣어 주세요." },
    });
    const outcome = await executeAgentJob(job({ action: "create_sales_campaign_round", previousCampaignId: "camp-1" }), deps);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(outcome.result.resultSummary).toContain("SALE_PERIOD_UNAVAILABLE");
    expect(outcome.result.resultSummary).toContain("startDate/endDate");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("봇 입력이 틀리면 창구를 부르지 않는다(날짜 한쪽만)", async () => {
    const outcome = await executeAgentJob(
      job({ action: "create_sales_campaign_round", previousCampaignId: "camp-1", startDate: "2026-12-01" }),
      deps,
    );
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(callMock).not.toHaveBeenCalled();
  });

  it("창구 초안이 저장 스키마에 안 맞으면 기안을 만들지 않는다", async () => {
    callMock.mockResolvedValue({ ok: true, body: { ok: true, data: { ...draft, endDate: "2026-11-01" } } });
    const outcome = await executeAgentJob(job({ action: "create_sales_campaign_round", previousCampaignId: "camp-1" }), deps);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(insertMock).not.toHaveBeenCalled();
  });
});
