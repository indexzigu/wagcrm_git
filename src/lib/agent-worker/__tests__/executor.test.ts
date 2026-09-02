import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload, AgentJobRoute } from "../contracts";
import type { RouterDecisionParseResult } from "../router";

const pipelineMock = vi.fn();
const snapshotMock = vi.fn();
const dealFindManyMock = vi.fn();
const proposalCreateMock = vi.fn();
const proposalEventCreateMock = vi.fn();
const dealFindUniqueMock = vi.fn();
const campaignFindUniqueMock = vi.fn();
const partnerFindUniqueMock = vi.fn();
const sellerFindUniqueMock = vi.fn();
const snapshotFindManyMock = vi.fn();
const transactionMock = vi.fn();

const tx = {
  actionProposal: { create: proposalCreateMock, updateMany: vi.fn(), update: vi.fn() },
  actionProposalEvent: { create: proposalEventCreateMock },
  deal: { findUnique: dealFindUniqueMock },
  salesCampaign: { findUnique: campaignFindUniqueMock },
  partner: { findUnique: partnerFindUniqueMock },
  seller: { findUnique: sellerFindUniqueMock },
};

vi.mock("@/lib/agent/tools/pipeline-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/tools/pipeline-status")>();
  return {
    getPipelineStatusTool: { ...actual.getPipelineStatusTool, execute: (input: unknown) => pipelineMock(input) },
  };
});
vi.mock("@/lib/agent/tools/order-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/tools/order-snapshot")>();
  return {
    getOrderSnapshotTool: { ...actual.getOrderSnapshotTool, execute: (input: unknown) => snapshotMock(input) },
  };
});
vi.mock("@/repositories/dealRepository", () => ({
  dealRepository: { findMany: (args: unknown) => dealFindManyMock(args) },
}));
// getPrisma() is invoked at import time by @/lib/order-converter/prisma.ts, before the
// hoisted vi.fn() consts above exist, so every member defers to the mock lazily.
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    $transaction: (callback: unknown) => transactionMock(callback),
    deal: { findUnique: (args: unknown) => dealFindUniqueMock(args) },
    salesCampaign: { findUnique: (args: unknown) => campaignFindUniqueMock(args) },
    partner: { findUnique: (args: unknown) => partnerFindUniqueMock(args) },
    seller: { findUnique: (args: unknown) => sellerFindUniqueMock(args) },
    naverOrderSnapshot: { findMany: (args: unknown) => snapshotFindManyMock(args) },
  }),
}));
vi.mock("@/lib/prisma-client", () => ({
  isSqliteDatabaseUrl: () => false,
}));

import { NO_MODEL_INVOKED, buildRouterArgv, executeAgentJob, runRouterDecision } from "../executor";

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

const financialCampaignRow = {
  id: "camp-1",
  status: "ACTIVE",
  actualSales: 1000000,
  operatingExpense: 0,
  miscExpense: 0,
  totalMarginRate: 30,
  sellerMarginRate: 10,
  sellerTaxType: null,
  isManualSettlementSales: false,
  isManualSellerExpense: false,
  isManualTaxExpense: false,
  settlementSales: null,
  sellerExpense: null,
  taxExpense: null,
  isDepositReceived: false,
  isPayoutCompleted: false,
  deal: { dealName: "D" },
  seller: { name: "S", agency: { businessNumber: "123-45-67890" } },
};

beforeEach(() => {
  for (const mock of [
    pipelineMock,
    snapshotMock,
    dealFindManyMock,
    proposalCreateMock,
    proposalEventCreateMock,
    dealFindUniqueMock,
    campaignFindUniqueMock,
    partnerFindUniqueMock,
    sellerFindUniqueMock,
    snapshotFindManyMock,
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

  it("python route runs the registered deterministic operation and records no model", async () => {
    pipelineMock.mockResolvedValue({
      ok: true,
      data: { statusCounts: [{ status: "ACTIVE", count: 2 }], totalCount: 2, campaigns: [] },
      evidence: { dataSources: ["SalesCampaign"], query: {} },
    });

    const outcome = await executeAgentJob(job("get_pipeline_status", {}), deps(accepted("python")));

    expect(pipelineMock).toHaveBeenCalledWith({});
    expect(NO_MODEL_INVOKED).toBe("none");
    expect(outcome).toMatchObject({
      kind: "terminal",
      toStatus: "SUCCEEDED",
      route: "python",
      model: "none",
      escalationReason: null,
      errorClass: null,
      result: { schemaVersion: 1, jobId: "job-1", status: "SUCCEEDED", route: "python", modelUsed: "none", validationResult: "pass", actionProposalId: null },
    });
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.result.resultSummary).toContain("ACTIVE");
    expect(outcome.result.resultSummary.length).toBeLessThanOrEqual(2000);
  });

  it("gemini route also runs only the deterministic registry: route kept, modelUsed is the sentinel", async () => {
    pipelineMock.mockResolvedValue({ ok: true, data: { statusCounts: [], totalCount: 0, campaigns: [] }, evidence: { dataSources: [], query: {} } });

    const outcome = await executeAgentJob(job("get_pipeline_status", {}, "bulk"), deps(accepted("gemini", "gemini", "bulk")));

    expect(outcome).toMatchObject({ kind: "terminal", route: "gemini", model: "none", result: { route: "gemini", modelUsed: "none" } });
  });
});

describe("read operations reuse existing calculations inside the granted read scope", () => {
  it("get_campaign_financials projects granted columns only and reuses calculateDerivedCampaignFinancials", async () => {
    campaignFindUniqueMock.mockResolvedValue(financialCampaignRow);

    const outcome = await executeAgentJob(job("get_campaign_financials", { campaignId: "camp-1" }), deps(accepted("python")));

    const args = campaignFindUniqueMock.mock.calls[0][0] as { where: unknown; select: Record<string, unknown>; include?: unknown };
    expect(args.where).toEqual({ id: "camp-1" });
    expect(args.include).toBeUndefined();
    expect(args.select.deal).toEqual({ select: { dealName: true } });
    expect(args.select.seller).toEqual({ select: { name: true, agency: { select: { businessNumber: true } } } });
    for (const forbidden of ["campaignDeals", "activities", "notes", "checklistItems", "histories", "orderCampaign"]) {
      expect(JSON.stringify(args.select)).not.toContain(forbidden);
    }
    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED", result: { evidenceRefs: ["camp-1"] } });
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.result.resultSummary).toMatch(/settlementSales/);
    expect(outcome.result.resultSummary).toContain("deal=D");
  });

  it("get_campaign_financials maps a missing campaign to FAILED_FINAL/NOT_FOUND", async () => {
    campaignFindUniqueMock.mockResolvedValue(null);

    const outcome = await executeAgentJob(job("get_campaign_financials", { campaignId: "camp-x" }), deps(accepted("gemini")));

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "NOT_FOUND", result: { status: "FAILED_FINAL", validationResult: "fail", route: "gemini", modelUsed: "none" } });
  });

  it("QUERY_FAILED from a tool is retryable and never copies the raw message", async () => {
    pipelineMock.mockResolvedValue({ ok: false, error: { code: "QUERY_FAILED", message: "connection to 127.0.0.1:55432 refused" }, evidence: { dataSources: ["SalesCampaign"], query: {} } });

    const outcome = await executeAgentJob(job("get_pipeline_status", {}), deps(accepted("python")));

    expect(outcome).toEqual({ kind: "retryable", errorClass: "QUERY_FAILED", route: "python", model: "none" });
  });

  it("a thrown repository error is retryable with only its error class", async () => {
    const error = new Error("password=hunter2");
    error.name = "PrismaClientInitializationError";
    pipelineMock.mockRejectedValue(error);

    const outcome = await executeAgentJob(job("get_pipeline_status", {}), deps(accepted("python")));

    expect(outcome).toEqual({ kind: "retryable", errorClass: "PrismaClientInitializationError", route: "python", model: "none" });
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

  it("get_order_snapshot enforces the tool's inputSchema (366-day cap) before execute()", async () => {
    const outcome = await executeAgentJob(
      job("get_order_snapshot", { startAt: "2024-01-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z" }),
      deps(accepted("python")),
    );

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "INVALID_INPUT" });
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("get_order_snapshot without a window mirrors the tool's MISSING_PARAM contract", async () => {
    const outcome = await executeAgentJob(job("get_order_snapshot", {}), deps(accepted("python")));

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "MISSING_PARAM" });
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("get_order_snapshot with campaignId reads SalesCampaign + NaverOrderSnapshot.dailyAggregate only and rejects a mixed window", async () => {
    campaignFindUniqueMock.mockResolvedValue({ id: "camp-1", startDate: new Date("2026-08-30T00:00:00.000Z"), orderCampaignId: "oc-1" });
    const leaf = {
      orderKeys: ["o1", "o2"],
      validLines: 2,
      quantity: 3,
      revenue: 30000,
      statusBreakdown: { newOrderBefore: 0, newOrderAfter: 0, preparing: 2, delivering: 0, completed: 0 },
      poCandidates: { newBefore: [], newAfter: [], other: [] },
      claims: { cancel: 0, return: 0, exchange: 0 },
      items: [],
    };
    snapshotFindManyMock.mockResolvedValue([
      { snapshotDate: "2026-08-31", dailyAggregate: { v: 1, campaignIds: ["camp-1"], days: { "2026-08-31": { "camp-1": leaf } } } },
      { snapshotDate: "2026-09-01", dailyAggregate: { v: 1, campaignIds: ["other"], days: {} } },
    ]);

    const outcome = await executeAgentJob(job("get_order_snapshot", { campaignId: "camp-1" }), deps(accepted("python")));

    const campaignArgs = campaignFindUniqueMock.mock.calls[0][0] as { select: Record<string, unknown> };
    expect(Object.keys(campaignArgs.select).sort()).toEqual(["id", "orderCampaignId", "startDate"]);
    expect(snapshotFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ select: { snapshotDate: true, dailyAggregate: true } }));
    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED", result: { evidenceRefs: ["camp-1", "2026-08-31"] } });
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.result.resultSummary).toContain("uncoveredRows=1");
    expect(outcome.result.resultSummary).toContain('"orders":2');

    campaignFindUniqueMock.mockResolvedValue({ id: "camp-2", startDate: new Date(), orderCampaignId: null });
    const unlinked = await executeAgentJob(job("get_order_snapshot", { campaignId: "camp-2" }), deps(accepted("python")));
    expect(unlinked).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED" });
    if (unlinked.kind !== "terminal") throw new Error("expected terminal");
    expect(unlinked.result.resultSummary).toContain("source=none");

    campaignFindUniqueMock.mockResolvedValue(null);
    const missing = await executeAgentJob(job("get_order_snapshot", { campaignId: "camp-x" }), deps(accepted("python")));
    expect(missing).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "NOT_FOUND" });

    const mixed = await executeAgentJob(job("get_order_snapshot", { campaignId: "camp-1", startAt: "2026-09-01T00:00:00.000Z" }), deps(accepted("python")));
    expect(mixed).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "INVALID_INPUT" });
  });
});

describe("create_action_proposal", () => {
  const validInput = { action: "change_deal_status", dealId: "deal-1", newStatus: "CONFIRMED" } as const;

  it("INSERTs the proposal as PENDING_APPROVAL plus its initial event in one transaction, with no UPDATE", async () => {
    dealFindUniqueMock.mockResolvedValue({ id: "deal-1" });
    proposalCreateMock.mockResolvedValue({ id: "proposal-1", status: "PENDING_APPROVAL" });
    proposalEventCreateMock.mockResolvedValue({ id: "event-1" });

    const outcome = await executeAgentJob(job("create_action_proposal", validInput), deps(accepted("python")));

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(proposalCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "WRITE",
        status: "PENDING_APPROVAL",
        reviewRequired: true,
        requestType: "crm_mutation",
        payload: { action: "change_deal_status", args: { dealId: "deal-1", newStatus: "CONFIRMED" } },
        targetEntityType: "DEAL",
        targetEntityId: "deal-1",
        createdBy: "AGENT_WORKER",
      }),
    });
    expect(proposalEventCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ proposalId: "proposal-1", fromStatus: "DRAFT", toStatus: "PENDING_APPROVAL", actor: "AGENT_WORKER" }),
    });
    expect(tx.actionProposal.updateMany).not.toHaveBeenCalled();
    expect(tx.actionProposal.update).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "terminal",
      toStatus: "NEEDS_APPROVAL",
      result: { status: "NEEDS_APPROVAL", actionProposalId: "proposal-1", evidenceRefs: ["proposal-1"], validationResult: "pass" },
    });
  });

  it("refuses an action outside WRITE_ACTIONS (including prototype members) without touching the database", async () => {
    for (const action of ["delete_everything", "constructor", "toString", "__proto__"]) {
      const outcome = await executeAgentJob(
        job("create_action_proposal", { action, dealId: "deal-1" } as never),
        deps(accepted("python")),
      );
      expect(outcome, action).toMatchObject({ kind: "terminal", toStatus: "FAILED_FINAL", errorClass: "WRITE_ACTION_NOT_ALLOWED" });
    }
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
    proposalEventCreateMock.mockResolvedValue({ id: "event-2" });

    await executeAgentJob(job("create_action_proposal", { action: "add_entity_memo", entityType: "PARTNER", entityId: "partner-1", content: "memo" }), deps(accepted("python")));
    expect(partnerFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "partner-1" } }));

    await executeAgentJob(job("create_action_proposal", { action: "confirm_settlement", campaignId: "camp-1", target: "deposit" }), deps(accepted("python")));
    expect(campaignFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "camp-1" } }));
    expect(proposalCreateMock).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ requestType: "settlement_confirm", campaignId: "camp-1", targetEntityType: "CAMPAIGN" }),
    });
  });

  it("does not open the transaction when the lease was already lost (aborted signal)", async () => {
    const controller = new AbortController();
    controller.abort(new Error("lease lost"));

    await expect(executeAgentJob(job("create_action_proposal", validInput), deps(accepted("python")), controller.signal)).rejects.toMatchObject({
      name: "ExecutionAbortedError",
    });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(proposalCreateMock).not.toHaveBeenCalled();
  });

  it("rolls back instead of committing when the abort arrives inside the transaction (requeue-duplicate guard)", async () => {
    const controller = new AbortController();
    dealFindUniqueMock.mockImplementation(async () => {
      controller.abort(new Error("runtime timeout"));
      return { id: "deal-1" };
    });

    await expect(executeAgentJob(job("create_action_proposal", validInput), deps(accepted("python")), controller.signal)).rejects.toMatchObject({
      name: "ExecutionAbortedError",
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(proposalCreateMock).not.toHaveBeenCalled();
    expect(proposalEventCreateMock).not.toHaveBeenCalled();
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

  it("defaults to the absolute /usr/bin/python3 interpreter", async () => {
    const { DEFAULT_ROUTER_PYTHON } = await import("../executor");
    expect(DEFAULT_ROUTER_PYTHON).toBe("/usr/bin/python3");
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
