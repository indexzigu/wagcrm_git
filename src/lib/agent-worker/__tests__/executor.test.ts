import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload, AgentJobRoute } from "../contracts";
import type { RouterDecisionParseResult } from "../router";

const pipelineMock = vi.fn();
const financialsMock = vi.fn();
const snapshotMock = vi.fn();
const campaignSalesMock = vi.fn();
const dealFindManyMock = vi.fn();
const proposalCreateMock = vi.fn();
const proposalTransitionMock = vi.fn();
const dealFindUniqueMock = vi.fn();
const campaignFindUniqueMock = vi.fn();
const partnerFindUniqueMock = vi.fn();
const sellerFindUniqueMock = vi.fn();
const transactionMock = vi.fn();

const tx = {
  actionProposal: { create: proposalCreateMock },
  deal: { findUnique: dealFindUniqueMock },
  salesCampaign: { findUnique: campaignFindUniqueMock },
  partner: { findUnique: partnerFindUniqueMock },
  seller: { findUnique: sellerFindUniqueMock },
};

vi.mock("@/lib/agent/tools/pipeline-status", () => ({
  getPipelineStatusTool: { name: "get_pipeline_status", execute: (input: unknown) => pipelineMock(input) },
}));
vi.mock("@/lib/agent/tools/campaign-financials", () => ({
  getCampaignFinancialsTool: { name: "get_campaign_financials", execute: (input: unknown) => financialsMock(input) },
}));
vi.mock("@/lib/agent/tools/order-snapshot", () => ({
  getOrderSnapshotTool: { name: "get_order_snapshot", execute: (input: unknown) => snapshotMock(input) },
}));
vi.mock("@/lib/mobile-campaign-sales", () => ({
  getMobileCampaignSales: (...args: unknown[]) => campaignSalesMock(...args),
}));
vi.mock("@/repositories/dealRepository", () => ({
  dealRepository: { findMany: (args: unknown) => dealFindManyMock(args) },
}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    $transaction: transactionMock,
    deal: { findUnique: dealFindUniqueMock },
    salesCampaign: { findUnique: campaignFindUniqueMock },
    partner: { findUnique: partnerFindUniqueMock },
    seller: { findUnique: sellerFindUniqueMock },
  }),
}));
vi.mock("@/lib/prisma-client", () => ({
  isSqliteDatabaseUrl: () => false,
}));
vi.mock("@/repositories/actionProposalRepository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/repositories/actionProposalRepository")>();
  return {
    ...actual,
    ActionProposalRepository: {
      transition: (...args: unknown[]) => proposalTransitionMock(...args),
    },
  };
});

import { buildRouterArgv, executeAgentJob, runRouterDecision } from "../executor";

type Operation = AgentJobPayload["operation"];

function job(operation: Operation, input: AgentJobPayload["input"], taskType: AgentJobPayload["taskType"] = "deterministic"): AgentJobRecord {
  return {
    id: "job-1",
    idempotencyKey: "key-1",
    payload: {
      schemaVersion: 1,
      taskType,
      skill: "none",
      operation,
      input,
      origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t" },
    },
    status: "RUNNING",
    workerId: "worker-1",
    leaseExpiresAt: new Date("2026-09-02T00:02:00.000Z"),
    heartbeatAt: new Date("2026-09-02T00:00:00.000Z"),
    attempt: 0,
    result: null,
    failureCode: null,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
  };
}

const accepted = (route: AgentJobRoute, model: string = route, reason = "deterministic"): RouterDecisionParseResult => ({
  status: "ACCEPTED",
  route,
  model,
  reason,
});
const rejected: RouterDecisionParseResult = { status: "FAILED_SECURITY" };

function deps(decision: RouterDecisionParseResult) {
  return { decideRoute: vi.fn(async () => decision), now: () => new Date("2026-09-02T00:00:00.000Z") };
}

beforeEach(() => {
  for (const mock of [
    pipelineMock,
    financialsMock,
    snapshotMock,
    campaignSalesMock,
    dealFindManyMock,
    proposalCreateMock,
    proposalTransitionMock,
    dealFindUniqueMock,
    campaignFindUniqueMock,
    partnerFindUniqueMock,
    sellerFindUniqueMock,
    transactionMock,
  ]) {
    mock.mockReset();
  }
  transactionMock.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
});

describe("route behavior (plan contract 7)", () => {
  it("router rejection is terminal FAILED_SECURITY with no fallback and no operation call", async () => {
    const outcome = await executeAgentJob(job("get_pipeline_status", {}), deps(rejected));

    expect(outcome).toEqual({ kind: "security", errorClass: "ROUTER_REJECTED" });
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it.each(["gpt_luna", "director"] as const)("%s returns NEEDS_EXTERNAL_EXECUTOR without substituting a model", async (route) => {
    const outcome = await executeAgentJob(job("get_pipeline_status", {}, "routine"), deps(accepted(route, route, "not_promoted")));

    expect(outcome).toMatchObject({
      kind: "terminal",
      toStatus: "NEEDS_EXTERNAL_EXECUTOR",
      route,
      model: route,
      escalationReason: "not_promoted",
      result: { status: "NEEDS_EXTERNAL_EXECUTOR", route, modelUsed: route, validationResult: "not_validated", actionProposalId: null },
    });
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("local is not active in this scope and fails closed to NEEDS_EXTERNAL_EXECUTOR", async () => {
    const outcome = await executeAgentJob(job("get_pipeline_status", {}, "routine"), deps(accepted("local", "qwen3.5:9b", "verified_routine")));

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "NEEDS_EXTERNAL_EXECUTOR", model: "qwen3.5:9b", escalationReason: "local_route_not_active" });
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("python route runs the registered deterministic operation and records the router model", async () => {
    pipelineMock.mockResolvedValue({
      ok: true,
      data: { statusCounts: [{ status: "ACTIVE", count: 2 }], totalCount: 2, campaigns: [] },
      evidence: { dataSources: ["SalesCampaign"], query: {} },
    });

    const outcome = await executeAgentJob(job("get_pipeline_status", {}), deps(accepted("python")));

    expect(pipelineMock).toHaveBeenCalledWith({});
    expect(outcome).toMatchObject({
      kind: "terminal",
      toStatus: "SUCCEEDED",
      route: "python",
      model: "python",
      escalationReason: null,
      errorClass: null,
      result: { schemaVersion: 1, jobId: "job-1", status: "SUCCEEDED", route: "python", modelUsed: "python", validationResult: "pass", actionProposalId: null },
    });
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.result.resultSummary).toContain("ACTIVE");
    expect(outcome.result.resultSummary.length).toBeLessThanOrEqual(2000);
  });
});

describe("read operations reuse existing calculations", () => {
  it("get_campaign_financials reuses the agent tool and maps NOT_FOUND to FAILED_FINAL", async () => {
    financialsMock.mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "raw not-found text" }, evidence: { dataSources: ["SalesCampaign"], query: {} } });

    const outcome = await executeAgentJob(job("get_campaign_financials", { campaignId: "camp-1" }), deps(accepted("gemini")));

    expect(financialsMock).toHaveBeenCalledWith({ campaignId: "camp-1" });
    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "NOT_FOUND", result: { status: "FAILED_FINAL", validationResult: "fail", route: "gemini", modelUsed: "gemini" } });
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.result.resultSummary).not.toContain("raw not-found text");
  });

  it("get_campaign_financials success carries the derived numbers and the campaign id as evidence", async () => {
    financialsMock.mockResolvedValue({
      ok: true,
      data: { campaignId: "camp-1", dealName: "D", sellerName: "S", status: "ACTIVE", actualSales: 1000, derived: { settlementSales: 900 }, isDepositReceived: false, isPayoutCompleted: false },
      evidence: { dataSources: ["SalesCampaign"], query: { campaignId: "camp-1" } },
    });

    const outcome = await executeAgentJob(job("get_campaign_financials", { campaignId: "camp-1" }), deps(accepted("python")));

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED", result: { evidenceRefs: ["camp-1"] } });
  });

  it("QUERY_FAILED from a tool is retryable and never copies the raw message", async () => {
    financialsMock.mockResolvedValue({ ok: false, error: { code: "QUERY_FAILED", message: "connection to 127.0.0.1:55432 refused" }, evidence: { dataSources: ["SalesCampaign"], query: {} } });

    const outcome = await executeAgentJob(job("get_campaign_financials", { campaignId: "camp-1" }), deps(accepted("python")));

    expect(outcome).toEqual({ kind: "retryable", errorClass: "QUERY_FAILED", route: "python", model: "python" });
  });

  it("a thrown repository error is retryable with only its error class", async () => {
    const error = new Error("password=hunter2");
    error.name = "PrismaClientInitializationError";
    pipelineMock.mockRejectedValue(error);

    const outcome = await executeAgentJob(job("get_pipeline_status", {}), deps(accepted("python")));

    expect(outcome).toEqual({ kind: "retryable", errorClass: "PrismaClientInitializationError", route: "python", model: "python" });
  });

  it("search_deals uses a narrower repository projection with the frozen partnerId/query/status input", async () => {
    dealFindManyMock.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({ id: `deal-${index}`, dealName: `Deal ${index}`, brandName: null, status: "CONFIRMED", partnerId: "partner-1", updatedAt: new Date("2026-09-01T00:00:00.000Z") })),
    );

    const outcome = await executeAgentJob(job("search_deals", { query: "vita", status: "CONFIRMED", partnerId: "partner-1" }), deps(accepted("python")));

    const args = dealFindManyMock.mock.calls[0][0] as { where: Record<string, unknown>; select: Record<string, boolean>; take: number; include?: unknown };
    expect(args.where).toMatchObject({ status: "CONFIRMED", partnerId: "partner-1" });
    expect(args.where.OR).toBeDefined();
    expect(args.include).toBeUndefined();
    expect(Object.keys(args.select).sort()).toEqual(["brandName", "dealName", "id", "partnerId", "status", "updatedAt"]);
    expect(args.take).toBe(21);
    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED" });
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.result.evidenceRefs).toHaveLength(10);
    expect(outcome.result.resultSummary).toContain("truncated");
  });

  it("search_deals rejects an unknown status before querying", async () => {
    const outcome = await executeAgentJob(job("search_deals", { status: "PAID" }), deps(accepted("python")));

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "INVALID_INPUT" });
    expect(dealFindManyMock).not.toHaveBeenCalled();
  });

  it("search_deals with no match is an empty SUCCEEDED result", async () => {
    dealFindManyMock.mockResolvedValue([]);

    const outcome = await executeAgentJob(job("search_deals", { query: "nothing" }), deps(accepted("python")));

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED", result: { evidenceRefs: [] } });
  });

  it("get_order_snapshot maps startAt/endAt to KST date keys and reuses the snapshot tool", async () => {
    snapshotMock.mockResolvedValue({
      ok: true,
      data: { days: [{ snapshotDate: "2026-09-01", ordersCount: 3, newOrdersCount: 1, preparingCount: 1, deliveringCount: 1, lastCallTime: "x" }], totals: { ordersCount: 3, newOrdersCount: 1, preparingCount: 1, deliveringCount: 1 } },
      evidence: { dataSources: ["NaverOrderSnapshot"], query: {} },
    });

    const outcome = await executeAgentJob(
      job("get_order_snapshot", { startAt: "2026-08-31T20:00:00.000Z", endAt: "2026-09-01T14:59:59.000Z" }),
      deps(accepted("python")),
    );

    expect(snapshotMock).toHaveBeenCalledWith({ startDate: "2026-09-01", endDate: "2026-09-01" });
    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED", result: { evidenceRefs: ["2026-09-01"] } });
  });

  it("get_order_snapshot without a window mirrors the tool's MISSING_PARAM contract", async () => {
    const outcome = await executeAgentJob(job("get_order_snapshot", {}), deps(accepted("python")));

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "MISSING_PARAM" });
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("get_order_snapshot with campaignId reuses getMobileCampaignSales and rejects a mixed window", async () => {
    campaignSalesMock.mockResolvedValue({ campaignId: "camp-1", source: "cache", asOf: "2026-09-01T00:00:00.000Z", cumulative: { orders: 5, revenue: 50000 }, today: { orders: 0, revenue: 0 }, daily: [{ date: "2026-08-31" }, { date: "2026-09-01" }], items: [] });

    const outcome = await executeAgentJob(job("get_order_snapshot", { campaignId: "camp-1" }), deps(accepted("python")));
    expect(campaignSalesMock).toHaveBeenCalledWith("camp-1", expect.any(Date));
    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED", result: { evidenceRefs: ["camp-1", "2026-08-31", "2026-09-01"] } });

    campaignSalesMock.mockResolvedValue(null);
    const missing = await executeAgentJob(job("get_order_snapshot", { campaignId: "camp-x" }), deps(accepted("python")));
    expect(missing).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "NOT_FOUND" });

    const mixed = await executeAgentJob(job("get_order_snapshot", { campaignId: "camp-1", startAt: "2026-09-01T00:00:00.000Z" }), deps(accepted("python")));
    expect(mixed).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "INVALID_INPUT" });
  });
});

describe("create_action_proposal", () => {
  const validInput = { action: "change_deal_status", dealId: "deal-1", newStatus: "CONFIRMED" } as const;

  it("inserts a PENDING_APPROVAL WRITE proposal and its initial event in one transaction", async () => {
    dealFindUniqueMock.mockResolvedValue({ id: "deal-1" });
    proposalCreateMock.mockResolvedValue({ id: "proposal-1", status: "DRAFT" });
    proposalTransitionMock.mockResolvedValue({ id: "proposal-1", status: "PENDING_APPROVAL" });

    const outcome = await executeAgentJob(job("create_action_proposal", validInput), deps(accepted("python")));

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(proposalCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "WRITE",
        status: "DRAFT",
        reviewRequired: true,
        requestType: "crm_mutation",
        payload: { action: "change_deal_status", args: { dealId: "deal-1", newStatus: "CONFIRMED" } },
        targetEntityType: "DEAL",
        targetEntityId: "deal-1",
        createdBy: "AGENT_WORKER",
      }),
    });
    expect(proposalTransitionMock).toHaveBeenCalledWith(
      "proposal-1",
      "PENDING_APPROVAL",
      expect.objectContaining({ tx, expectedFrom: "DRAFT", actor: "AGENT_WORKER" }),
    );
    expect(outcome).toMatchObject({
      kind: "terminal",
      toStatus: "NEEDS_APPROVAL",
      result: { status: "NEEDS_APPROVAL", actionProposalId: "proposal-1", evidenceRefs: ["proposal-1"], validationResult: "pass" },
    });
  });

  it("refuses an action outside WRITE_ACTIONS without touching the database", async () => {
    const outcome = await executeAgentJob(
      job("create_action_proposal", { action: "delete_everything", dealId: "deal-1" } as never),
      deps(accepted("python")),
    );

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "WRITE_ACTION_NOT_ALLOWED" });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("refuses args that fail the action's Zod schema", async () => {
    const outcome = await executeAgentJob(
      job("create_action_proposal", { action: "change_deal_status", dealId: "deal-1", newStatus: "PAID" } as never),
      deps(accepted("python")),
    );

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "INVALID_INPUT" });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("refuses a missing target before inserting anything", async () => {
    dealFindUniqueMock.mockResolvedValue(null);

    const outcome = await executeAgentJob(job("create_action_proposal", validInput), deps(accepted("python")));

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "TARGET_NOT_FOUND" });
    expect(proposalCreateMock).not.toHaveBeenCalled();
  });

  it("checks add_entity_memo targets by entity type and confirm_settlement by campaign", async () => {
    partnerFindUniqueMock.mockResolvedValue({ id: "partner-1" });
    campaignFindUniqueMock.mockResolvedValue({ id: "camp-1" });
    proposalCreateMock.mockResolvedValue({ id: "proposal-2" });
    proposalTransitionMock.mockResolvedValue({ id: "proposal-2" });

    await executeAgentJob(job("create_action_proposal", { action: "add_entity_memo", entityType: "PARTNER", entityId: "partner-1", content: "memo" }), deps(accepted("python")));
    expect(partnerFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "partner-1" } }));

    await executeAgentJob(job("create_action_proposal", { action: "confirm_settlement", campaignId: "camp-1", target: "deposit" }), deps(accepted("python")));
    expect(campaignFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "camp-1" } }));
    expect(proposalCreateMock).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ requestType: "settlement_confirm", campaignId: "camp-1", targetEntityType: "CAMPAIGN" }),
    });
  });
});

describe("router invocation", () => {
  it("builds a fixed argv for local-llm-route.py decide from the payload only", () => {
    const argv = buildRouterArgv(job("search_deals", { query: "x" }, "bulk").payload, "/router/local-llm-route.py", "/usr/bin/python3");

    expect(argv).toEqual({
      file: "/usr/bin/python3",
      args: ["/router/local-llm-route.py", "decide", "--task-type", "bulk", "--skill", "none"],
    });
  });

  it("treats a non-zero router exit or non-JSON stdout as FAILED_SECURITY and accepts exact JSON", async () => {
    const failing = vi.fn(async () => {
      throw Object.assign(new Error("exit 1"), { code: 1 });
    });
    await expect(runRouterDecision(job("search_deals", {}).payload, { execFile: failing, scriptPath: "/r.py", pythonPath: "python3" })).resolves.toEqual({ status: "FAILED_SECURITY" });

    const garbage = vi.fn(async () => ({ stdout: "not json", stderr: "" }));
    await expect(runRouterDecision(job("search_deals", {}).payload, { execFile: garbage, scriptPath: "/r.py", pythonPath: "python3" })).resolves.toEqual({ status: "FAILED_SECURITY" });

    const exact = vi.fn(async () => ({ stdout: '{"mode":"shadow","model":"python","reason":"deterministic","route":"python"}\n', stderr: "" }));
    await expect(runRouterDecision(job("search_deals", {}).payload, { execFile: exact, scriptPath: "/r.py", pythonPath: "python3" })).resolves.toEqual({
      status: "ACCEPTED",
      route: "python",
      model: "python",
      reason: "deterministic",
    });
    expect(exact).toHaveBeenCalledWith("python3", ["/r.py", "decide", "--task-type", "deterministic", "--skill", "none"], expect.objectContaining({ shell: false }));
  });
});
