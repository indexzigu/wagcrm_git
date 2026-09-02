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

import { existsSync } from "node:fs";
import {
  DEFAULT_ROUTER_SCRIPT_PATH,
  NO_MODEL_INVOKED,
  ROUTER_TIMEOUT_MS,
  buildRouterArgv,
  executeAgentJob,
  runRouterDecision,
  type ExecutionDeps,
} from "../executor";
import { EMPTY_SHADOW_VALIDATORS, type LocalModelClient, type LocalModelRequest, type ShadowValidator } from "../shadow";

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

type Decision = Awaited<ReturnType<ExecutionDeps["decideRoute"]>>;

function deps(decision: Decision, shadow?: ExecutionDeps["shadow"]): ExecutionDeps {
  return { decideRoute: vi.fn(async () => decision), now: () => new Date("2026-09-02T00:00:00.000Z"), shadow };
}

const healthySnapshot = {
  colimaRunning: false,
  memoryFreePercent: 50,
  swapUsedBytes: 0,
  swapIncreaseBytesInFiveMinutes: 0,
  dockerDbHealthy: true,
  anotherOllamaModelLoaded: false,
};

function fakeLocalModel(output = "SENTINEL_LOCAL_RAW_OUTPUT_3c9d") {
  const calls: LocalModelRequest[] = [];
  const client: LocalModelClient = {
    generate: async (request) => {
      calls.push(request);
      return { output };
    },
  };
  return { client, calls };
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
  it("router output the Task 4 parser rejects is terminal FAILED_SECURITY (ROUTER_OUTPUT_REJECTED) with no fallback and no operation call", async () => {
    const outcome = await executeAgentJob(job("get_pipeline_status", {}), deps(rejected));

    expect(outcome).toEqual({ kind: "security", errorClass: "ROUTER_OUTPUT_REJECTED" });
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed stdout on a clean exit", "not json\n"],
    ["unknown route", '{"mode":"shadow","model":"x","reason":"none","route":"ollama"}\n'],
    ["wrong mode", '{"mode":"active","model":"python","reason":"deterministic","route":"python"}\n'],
  ])("end to end: %s from the router spawn -> FAILED_SECURITY, never NEEDS_EXTERNAL_EXECUTOR", async (_label, stdout) => {
    const execFile = vi.fn(async () => ({ stdout, stderr: "" }));
    const decideRoute = (payload: AgentJobPayload) => runRouterDecision(payload, { execFile: execFile as never, scriptPath: "/r.py", pythonPath: "python3" });

    const outcome = await executeAgentJob(job("get_pipeline_status", {}), { decideRoute });

    expect(outcome).toEqual({ kind: "security", errorClass: "ROUTER_OUTPUT_REJECTED" });
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("end to end: router stdout past maxBuffer (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) -> FAILED_SECURITY, not a transport escalation", async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new RangeError("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    });
    const decideRoute = (payload: AgentJobPayload) => runRouterDecision(payload, { execFile: execFile as never, scriptPath: "/r.py", pythonPath: "python3" });

    await expect(runRouterDecision(job("get_pipeline_status", {}).payload, { execFile: execFile as never, scriptPath: "/r.py", pythonPath: "python3" })).resolves.toEqual({ status: "FAILED_SECURITY" });
    const outcome = await executeAgentJob(job("get_pipeline_status", {}), { decideRoute });

    expect(outcome).toEqual({ kind: "security", errorClass: "ROUTER_OUTPUT_REJECTED" });
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout", Object.assign(new Error("killed"), { code: null, killed: true, signal: "SIGTERM" }), "router_timeout"],
    ["exit code 2", Object.assign(new Error("exit 2"), { code: 2, killed: false, signal: null }), "router_exit_nonzero"],
  ])("end to end: router %s from the spawn -> NEEDS_EXTERNAL_EXECUTOR, never FAILED_SECURITY", async (_label, error, escalationReason) => {
    const execFile = vi.fn(async () => {
      throw error;
    });
    const decideRoute = (payload: AgentJobPayload) => runRouterDecision(payload, { execFile: execFile as never, scriptPath: "/r.py", pythonPath: "python3" });

    const outcome = await executeAgentJob(job("get_pipeline_status", {}), { decideRoute });

    expect(outcome).toMatchObject({ kind: "terminal", toStatus: "NEEDS_EXTERNAL_EXECUTOR", route: "director", model: "none", escalationReason });
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it.each(["ROUTER_TIMEOUT", "ROUTER_EXIT_NONZERO", "ROUTER_SPAWN_FAILED"] as const)(
    "router failure %s ends NEEDS_EXTERNAL_EXECUTOR — never a local or python fallback",
    async (errorClass) => {
      const outcome = await executeAgentJob(job("get_pipeline_status", {}), deps({ status: "ROUTER_UNAVAILABLE", errorClass }));

      expect(outcome).toMatchObject({
        kind: "terminal",
        toStatus: "NEEDS_EXTERNAL_EXECUTOR",
        route: "director",
        model: "none",
        escalationReason: errorClass.toLowerCase(),
        errorClass,
        result: { status: "NEEDS_EXTERNAL_EXECUTOR", modelUsed: "none", validationResult: "not_validated" },
      });
      expect(pipelineMock).not.toHaveBeenCalled();
    },
  );

  it.each(["gpt_luna", "director"] as const)("%s returns NEEDS_EXTERNAL_EXECUTOR with route preserved and modelUsed=none (nothing ran)", async (route) => {
    const outcome = await executeAgentJob(job("get_pipeline_status", {}, "routine"), deps(accepted(route, route, "not_promoted")));

    expect(outcome).toMatchObject({
      kind: "terminal",
      toStatus: "NEEDS_EXTERNAL_EXECUTOR",
      route,
      model: "none",
      escalationReason: "not_promoted",
      result: { status: "NEEDS_EXTERNAL_EXECUTOR", route, modelUsed: "none", validationResult: "not_validated", actionProposalId: null },
    });
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("local is not active in this scope and fails closed to NEEDS_EXTERNAL_EXECUTOR with modelUsed=none", async () => {
    const outcome = await executeAgentJob(job("get_pipeline_status", {}, "routine"), deps(accepted("local", "qwen3.5:9b", "verified_routine")));

    expect(outcome).toMatchObject({
      kind: "terminal",
      toStatus: "NEEDS_EXTERNAL_EXECUTOR",
      route: "local",
      model: "none",
      escalationReason: "local_route_not_active",
      result: { route: "local", modelUsed: "none" },
    });
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

describe("local shadow integration (plan Task 7)", () => {
  const ALL_ROUTES = ["python", "gemini", "gpt_luna", "director", "local_shadow", "local"] as const;
  const SKILL_INPUTS = ["none", "", "not-registered", "sk-secret123", "constructor"] as const;
  const pipelineOk = { ok: true, data: { statusCounts: [{ status: "ACTIVE", count: 1 }], totalCount: 1, campaigns: [] }, evidence: { dataSources: ["SalesCampaign"], query: {} } };

  it("makes zero local model calls across all six routes and every skill input while no validator is registered", async () => {
    const { client, calls } = fakeLocalModel();
    const shadow = { client, validators: EMPTY_SHADOW_VALIDATORS, resourceSnapshot: async () => healthySnapshot };
    pipelineMock.mockResolvedValue(pipelineOk);

    for (const route of ALL_ROUTES) {
      for (const skill of SKILL_INPUTS) {
        const current = job("get_pipeline_status", {}, "routine");
        current.payload.skill = skill;
        await executeAgentJob(current, deps(accepted(route, route === "local" || route === "local_shadow" ? "qwen3.5:9b" : route, "not_promoted"), shadow));
      }
    }
    await executeAgentJob(job("get_pipeline_status", {}), deps(rejected, shadow));
    await executeAgentJob(job("get_pipeline_status", {}), deps({ status: "ROUTER_UNAVAILABLE", errorClass: "ROUTER_TIMEOUT" }, shadow));

    expect(calls).toHaveLength(0);
  });

  it("local_shadow without shadow deps keeps the deterministic result and audits validator_missing", async () => {
    pipelineMock.mockResolvedValue(pipelineOk);

    const outcome = await executeAgentJob(job("get_pipeline_status", {}, "routine"), deps(accepted("local_shadow", "qwen3.5:9b", "not_promoted")));

    expect(outcome).toMatchObject({
      kind: "terminal",
      toStatus: "SUCCEEDED",
      route: "local_shadow",
      model: "none",
      escalationReason: "validator_missing",
      errorClass: null,
      shadow: { validationResult: "not_validated", correction: false },
      result: { status: "SUCCEEDED", route: "local_shadow", modelUsed: "none", validationResult: "pass" },
    });
  });

  it("runs deterministic -> local model -> validator in that order and leaves the user-facing result unchanged", async () => {
    const order: string[] = [];
    pipelineMock.mockImplementation(async () => {
      order.push("canonical");
      return pipelineOk;
    });
    const client: LocalModelClient = {
      generate: async () => {
        order.push("local_model");
        return { output: "SENTINEL_LOCAL_RAW_OUTPUT_3c9d" };
      },
    };
    const validator: ShadowValidator = {
      buildPrompt: () => "SENTINEL_SHADOW_PROMPT_7a1b",
      validate: () => {
        order.push("validator");
        return "fail";
      },
    };
    const shadow = { client, validators: { "candidate-skill": validator }, resourceSnapshot: async () => healthySnapshot };
    const current = job("get_pipeline_status", {}, "routine");
    current.payload.skill = "candidate-skill";

    const shadowed = await executeAgentJob(current, deps(accepted("local_shadow", "qwen3.5:9b", "not_promoted"), shadow));
    const canonical = await executeAgentJob(job("get_pipeline_status", {}), deps(accepted("python")));

    expect(order).toEqual(["canonical", "local_model", "validator", "canonical"]);
    if (shadowed.kind !== "terminal" || canonical.kind !== "terminal") throw new Error("expected terminal");
    expect(shadowed.toStatus).toBe("SUCCEEDED");
    expect({ ...shadowed.result, route: "python" }).toEqual(canonical.result);
    expect(shadowed).toMatchObject({ model: "qwen3.5:9b", escalationReason: null, errorClass: null, shadow: { validationResult: "fail", correction: true } });
    expect(shadowed.result.modelUsed).toBe("none");
    const serialized = JSON.stringify(shadowed);
    for (const sentinel of ["SENTINEL_LOCAL_RAW_OUTPUT_3c9d", "SENTINEL_SHADOW_PROMPT_7a1b"]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("does not call the local model when the deterministic operation fails, retries, or needs approval", async () => {
    const { client, calls } = fakeLocalModel();
    const validator: ShadowValidator = { buildPrompt: () => "p", validate: () => "pass" };
    const shadow = { client, validators: { "candidate-skill": validator }, resourceSnapshot: async () => healthySnapshot };
    const withSkill = (operation: Operation, input: AgentJobPayload["input"]) => {
      const current = job(operation, input, "routine");
      current.payload.skill = "candidate-skill";
      return current;
    };
    const decision = accepted("local_shadow", "qwen3.5:9b", "not_promoted");

    pipelineMock.mockResolvedValue({ ok: false, error: { code: "QUERY_FAILED", message: "x" }, evidence: { dataSources: [], query: {} } });
    expect(await executeAgentJob(withSkill("get_pipeline_status", {}), deps(decision, shadow))).toMatchObject({ kind: "retryable" });

    campaignFindUniqueMock.mockResolvedValue(null);
    expect(await executeAgentJob(withSkill("get_campaign_financials", { campaignId: "camp-x" }), deps(decision, shadow))).toMatchObject({ toStatus: "FAILED_FINAL" });

    dealFindUniqueMock.mockResolvedValue({ id: "deal-1" });
    proposalCreateMock.mockResolvedValue({ id: "proposal-1" });
    proposalEventCreateMock.mockResolvedValue({ id: "event-1" });
    expect(
      await executeAgentJob(withSkill("create_action_proposal", { action: "change_deal_status", dealId: "deal-1", newStatus: "CONFIRMED" }), deps(decision, shadow)),
    ).toMatchObject({ toStatus: "NEEDS_APPROVAL" });

    expect(calls).toHaveLength(0);
  });

  it("a local model failure never changes the user-facing result: SUCCEEDED with the error class audited", async () => {
    pipelineMock.mockResolvedValue(pipelineOk);
    const client: LocalModelClient = {
      generate: async () => {
        const error = new Error("connect ECONNREFUSED 127.0.0.1:11434");
        error.name = "OllamaUnavailableError";
        throw error;
      },
    };
    const validator: ShadowValidator = { buildPrompt: () => "p", validate: () => "pass" };
    const current = job("get_pipeline_status", {}, "routine");
    current.payload.skill = "candidate-skill";

    const outcome = await executeAgentJob(current, deps(accepted("local_shadow", "qwen3.5:9b", "not_promoted"), { client, validators: { "candidate-skill": validator }, resourceSnapshot: async () => healthySnapshot }));

    expect(outcome).toMatchObject({
      kind: "terminal",
      toStatus: "SUCCEEDED",
      model: "qwen3.5:9b",
      escalationReason: "local_model_error",
      errorClass: "OllamaUnavailableError",
      shadow: { validationResult: "not_validated", correction: false },
      result: { status: "SUCCEEDED", validationResult: "pass", modelUsed: "none" },
    });
    expect(JSON.stringify(outcome)).not.toContain("ECONNREFUSED");
  });

  it("two concurrent local_shadow jobs: one local call, the other audited LOCAL_BUSY, both user-facing results SUCCEEDED", async () => {
    pipelineMock.mockResolvedValue(pipelineOk);
    let release!: (value: { output: string }) => void;
    const client: LocalModelClient = {
      generate: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    const generate = vi.spyOn(client, "generate");
    const validator: ShadowValidator = { buildPrompt: () => "p", validate: () => "pass" };
    const shadow = { client, validators: { "candidate-skill": validator }, resourceSnapshot: async () => healthySnapshot };
    const decision = accepted("local_shadow", "qwen3.5:9b", "not_promoted");
    const withSkill = (id: string) => {
      const current = job("get_pipeline_status", {}, "routine");
      current.id = id;
      current.payload.skill = "candidate-skill";
      return current;
    };

    const first = executeAgentJob(withSkill("job-a"), deps(decision, shadow));
    const second = executeAgentJob(withSkill("job-b"), deps(decision, shadow));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const busy = await second;
    release({ output: "ok" });
    const validated = await first;

    expect(busy).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED", model: "none", escalationReason: "resource_deferred:LOCAL_BUSY", shadow: { validationResult: "not_validated" }, result: { status: "SUCCEEDED", modelUsed: "none" } });
    expect(validated).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED", model: "qwen3.5:9b", shadow: { validationResult: "pass" }, result: { status: "SUCCEEDED", modelUsed: "none" } });
    expect(generate).toHaveBeenCalledTimes(1);
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

  it("appends --validator only when the worker has a registered validator for the payload skill", () => {
    const payload = job("search_deals", {}, "routine").payload;
    payload.skill = "candidate-skill";
    const validator: ShadowValidator = { buildPrompt: () => "p", validate: () => "pass" };

    expect(buildRouterArgv(payload, "/r.py", "/usr/bin/python3", { "candidate-skill": validator }).args).toEqual(["/r.py", "decide", "--task-type", "routine", "--skill", "candidate-skill", "--validator"]);
    expect(buildRouterArgv(payload, "/r.py", "/usr/bin/python3", { "other-skill": validator }).args).not.toContain("--validator");
    expect(buildRouterArgv(payload, "/r.py", "/usr/bin/python3", EMPTY_SHADOW_VALIDATORS).args).not.toContain("--validator");
    expect(buildRouterArgv(payload, "/r.py", "/usr/bin/python3").args).not.toContain("--validator");
  });

  it("defaults to the absolute /usr/bin/python3 interpreter and pins the 15 s spawn timeout", async () => {
    const { DEFAULT_ROUTER_PYTHON } = await import("../executor");
    expect(DEFAULT_ROUTER_PYTHON).toBe("/usr/bin/python3");
    expect(ROUTER_TIMEOUT_MS).toBe(15_000);
  });

  it("classifies spawn failures: timeout, non-zero exit, spawn error; malformed stdout stays the Task 4 parser verdict", async () => {
    const options = (execFile: ReturnType<typeof vi.fn>) => ({ execFile: execFile as never, scriptPath: "/r.py", pythonPath: "python3" });
    const payload = job("search_deals", {}).payload;

    const timedOut = vi.fn(async () => {
      throw Object.assign(new Error("killed"), { code: null, killed: true, signal: "SIGTERM" });
    });
    await expect(runRouterDecision(payload, options(timedOut))).resolves.toEqual({ status: "ROUTER_UNAVAILABLE", errorClass: "ROUTER_TIMEOUT" });

    const nonZero = vi.fn(async () => {
      throw Object.assign(new Error("exit 2"), { code: 2, killed: false, signal: null });
    });
    await expect(runRouterDecision(payload, options(nonZero))).resolves.toEqual({ status: "ROUTER_UNAVAILABLE", errorClass: "ROUTER_EXIT_NONZERO" });

    const enoent = vi.fn(async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT", errno: -2 });
    });
    await expect(runRouterDecision(payload, options(enoent))).resolves.toEqual({ status: "ROUTER_UNAVAILABLE", errorClass: "ROUTER_SPAWN_FAILED" });

    const garbage = vi.fn(async () => ({ stdout: "not json", stderr: "" }));
    await expect(runRouterDecision(payload, options(garbage))).resolves.toEqual({ status: "FAILED_SECURITY" });

    const exact = vi.fn(async () => ({ stdout: '{"mode":"shadow","model":"python","reason":"deterministic","route":"python"}\n', stderr: "" }));
    await expect(runRouterDecision(payload, options(exact))).resolves.toEqual({ status: "ACCEPTED", route: "python", model: "python", reason: "deterministic" });
    expect(exact).toHaveBeenCalledWith("python3", ["/r.py", "decide", "--task-type", "deterministic", "--skill", "none"], expect.objectContaining({ shell: false, timeout: ROUTER_TIMEOUT_MS }));
  });

  it("enforces the spawn timeout on a real child process that never exits", async () => {
    // `cat -` blocks on the child's open stdin pipe, so only the execFile timeout can end it.
    const result = await runRouterDecision(job("search_deals", {}).payload, { pythonPath: "/bin/cat", scriptPath: "-", timeoutMs: 200 });

    expect(result).toEqual({ status: "ROUTER_UNAVAILABLE", errorClass: "ROUTER_TIMEOUT" });
  });

  describe("against the real local-llm-route.py (read-only decide)", () => {
    const pythonPath = process.env.WAG_TEST_ROUTER_PYTHON ?? "/usr/bin/python3";
    const available = existsSync(DEFAULT_ROUTER_SCRIPT_PATH) && existsSync(pythonPath);

    it.skipIf(!available)(`decides deterministic/none as python under ${pythonPath}`, async () => {
      await expect(runRouterDecision(job("search_deals", {}).payload, { pythonPath })).resolves.toEqual({
        status: "ACCEPTED",
        route: "python",
        model: "python",
        reason: "deterministic",
      });
    });

    it.skipIf(!available)(`maps an unregistered skill (router exit 2) to ROUTER_EXIT_NONZERO under ${pythonPath}`, async () => {
      const payload = job("search_deals", {}, "routine").payload;
      payload.skill = "wag-unregistered-skill";

      await expect(runRouterDecision(payload, { pythonPath })).resolves.toEqual({ status: "ROUTER_UNAVAILABLE", errorClass: "ROUTER_EXIT_NONZERO" });
    });
  });
});
