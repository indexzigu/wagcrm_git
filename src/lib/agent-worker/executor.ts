import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { containsSearch } from "@/lib/prisma-search";
import { DEAL_STATUSES } from "@/lib/deal-status";
import { toKstYmd } from "@/lib/date-utils";
import { calculateDerivedCampaignFinancials } from "@/lib/campaign-financials";
import {
  aggregateCoversCampaigns,
  composeSalesDetailFromAggregates,
  parseSnapshotDailyAggregate,
  resolveLiveWindowKeys,
  type SnapshotDailyAggregate,
} from "@/lib/order-converter/daily-aggregate";
import { dealRepository } from "@/repositories/dealRepository";
import { serializeJsonFields } from "@/repositories/actionProposalRepository";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import { getPipelineStatusTool } from "@/lib/agent/tools/pipeline-status";
import { getOrderSnapshotTool } from "@/lib/agent/tools/order-snapshot";
import { addEntityMemoTool } from "@/lib/agent/tools/add-entity-memo";
import { changeDealStatusTool } from "@/lib/agent/tools/change-deal-status";
import { confirmSettlementTool } from "@/lib/agent/tools/confirm-settlement";
import type { AgentTool, ToolResult, WriteIntent } from "@/lib/agent/tools/types";
import { WRITE_ACTIONS } from "@/lib/agent/write-executor";
import { getRequestTypeForAction } from "@/lib/agent/approval-policy";
import {
  AgentJobResultSchema,
  MAX_EVIDENCE_REFS,
  MAX_RESULT_SUMMARY_CHARS,
  type AgentJobPayload,
  type AgentJobResult,
  type AgentJobRoute,
} from "./contracts";
import { parseRouterDecision, type RouterDecision, type RouterDecisionParseResult } from "./router";

/**
 * Agent worker executor (plan Task 5, contracts 4/5/7).
 *
 * - exact operation registry for the five frozen operations
 * - every read stays inside the worker role's SELECT scope (SalesCampaign, Deal,
 *   Partner, Seller, NaverOrderSnapshot, CampaignGroup) by reusing existing pure
 *   calculations over narrow projections; no business formula is copied here
 * - `create_action_proposal` validates WRITE_ACTIONS + Zod args + target existence,
 *   then INSERTs the proposal as PENDING_APPROVAL plus its initial event in one
 *   transaction — never an UPDATE, never an approval/execution function
 * - route behavior follows contract 7; a router failure has no fallback
 * - the abort signal is honored: nothing is committed after lease loss/timeout/shutdown
 */
export type TerminalStatus = AgentJobResult["status"];

/**
 * Contract-7 interpretation (Director ruling 14): the five operations are
 * deterministic, so on `python`/`gemini`/`local_shadow` only the in-process registry
 * runs and no model is invoked. `modelUsed` and the audit `model` then carry this
 * sentinel; `route` stays exactly as the router decided.
 */
export const NO_MODEL_INVOKED = "none";

export type ExecutionOutcome =
  | {
      kind: "terminal";
      toStatus: TerminalStatus;
      result: AgentJobResult;
      route: AgentJobRoute;
      model: string;
      escalationReason: string | null;
      errorClass: string | null;
    }
  | { kind: "security"; errorClass: string }
  | { kind: "retryable"; errorClass: string; route: AgentJobRoute | null; model: string | null };

export type ExecutionDeps = {
  decideRoute: (payload: AgentJobPayload) => Promise<RouterDecisionParseResult>;
  now?: () => Date;
};

export class ExecutionAbortedError extends Error {
  constructor() {
    super("agent job execution was aborted before committing");
    this.name = "ExecutionAbortedError";
  }
}

type OperationSuccess = {
  status: "SUCCEEDED" | "NEEDS_APPROVAL";
  summary: string;
  evidenceRefs: string[];
  actionProposalId: string | null;
};
type OperationFailure = { status: "FAILED_FINAL"; errorClass: string; summary: string };
type OperationRetry = { status: "RETRY"; errorClass: string };
type OperationOutcome = OperationSuccess | OperationFailure | OperationRetry;

type OperationContext = { now: Date; signal: AbortSignal };
type OperationHandler = (input: AgentJobPayload["input"], context: OperationContext) => Promise<OperationOutcome>;

/**
 * Per-operation input shapes. `AgentJobPayload.input` is a scalar record whose
 * operation-specific shape was already enforced by the contract's Zod superRefine
 * at submit time and again at the repository read boundary, so the handlers narrow
 * by cast instead of re-declaring the frozen schemas here.
 */
type SearchDealsInput = { query?: string; status?: string; partnerId?: string };
type OrderSnapshotInput = { campaignId?: string; startAt?: string; endAt?: string };
type CampaignFinancialsInput = { campaignId: string };
type CreateActionProposalInput = { action: string } & Record<string, string | number | boolean | null>;

const ACTOR = "AGENT_WORKER";
const SEARCH_TAKE_LIMIT = 20;

function boundSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(empty)";
  return trimmed.length > MAX_RESULT_SUMMARY_CHARS
    ? `${trimmed.slice(0, MAX_RESULT_SUMMARY_CHARS - 1)}…`
    : trimmed;
}

function boundEvidence(refs: Array<string | null | undefined>): string[] {
  return refs
    .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
    .map((ref) => ref.trim().slice(0, 256))
    .slice(0, MAX_EVIDENCE_REFS);
}

function failure(errorClass: string, summary: string): OperationFailure {
  return { status: "FAILED_FINAL", errorClass, summary };
}

/** Maps a tool error onto the queue contract without copying its raw message. */
function toolFailure(result: Extract<ToolResult, { ok: false }>): OperationFailure | OperationRetry {
  switch (result.error.code) {
    case "QUERY_FAILED":
      return { status: "RETRY", errorClass: "QUERY_FAILED" };
    case "NOT_FOUND":
      return failure("NOT_FOUND", "target not found");
    case "MISSING_PARAM":
      return failure("MISSING_PARAM", "required input missing");
  }
}

/**
 * Runs a reused agent tool exactly like agent-loop does: the tool's own
 * `inputSchema` gates `execute()` so its guards (date order, 366-day cap, enums)
 * are never bypassed (Task 5 review MEDIUM-4).
 */
async function runTool<TInput, TData>(
  tool: AgentTool<TInput, TData>,
  input: unknown,
): Promise<ToolResult<TData> | OperationFailure> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_INPUT", "tool input rejected by its schema");
  return tool.execute(parsed.data);
}

function isOperationFailure(value: unknown): value is OperationFailure {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "FAILED_FINAL";
}

function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

async function searchDeals(input: SearchDealsInput): Promise<OperationOutcome> {
  if (input.status !== undefined && !(DEAL_STATUSES as readonly string[]).includes(input.status)) {
    return failure("INVALID_INPUT", "unknown deal status");
  }
  const where: Prisma.DealWhereInput = {
    ...(input.status ? { status: input.status as Prisma.DealWhereInput["status"] } : {}),
    ...(input.partnerId ? { partnerId: input.partnerId } : {}),
    ...(input.query
      ? { OR: [{ dealName: containsSearch(input.query) }, { brandName: containsSearch(input.query) }] }
      : {}),
  };
  const rows = await dealRepository.findMany({
    where,
    select: { id: true, dealName: true, brandName: true, status: true, partnerId: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: SEARCH_TAKE_LIMIT + 1,
  });
  const truncated = rows.length > SEARCH_TAKE_LIMIT;
  const items = rows.slice(0, SEARCH_TAKE_LIMIT);
  const lines = items.map((row) => `${row.dealName}${row.brandName ? ` / ${row.brandName}` : ""} [${row.status}] id=${row.id}`);
  return {
    status: "SUCCEEDED",
    summary: boundSummary(
      `search_deals: ${items.length} deal(s)${truncated ? " (truncated at 20)" : ""}\n${lines.join("\n")}`,
    ),
    evidenceRefs: boundEvidence(items.map((row) => row.id)),
    actionProposalId: null,
  };
}

async function pipelineStatus(): Promise<OperationOutcome> {
  const result = await runTool(getPipelineStatusTool, {});
  if (isOperationFailure(result)) return result;
  if (!result.ok) {
    return result.error.code === "NOT_FOUND"
      ? { status: "SUCCEEDED", summary: "get_pipeline_status: no campaigns", evidenceRefs: [], actionProposalId: null }
      : toolFailure(result);
  }
  const counts = result.data.statusCounts.map((entry) => `${entry.status}=${entry.count}`).join(", ");
  return {
    status: "SUCCEEDED",
    summary: boundSummary(`get_pipeline_status: total=${result.data.totalCount}; ${counts}`),
    evidenceRefs: boundEvidence(result.data.campaigns.map((campaign) => campaign.id)),
    actionProposalId: null,
  };
}

/**
 * Campaign-scoped snapshot: SalesCampaign (granted) for existence/link/window,
 * NaverOrderSnapshot.dailyAggregate (granted) folded by the pure
 * `composeSalesDetailFromAggregates`. Rows whose aggregate does not cover this
 * campaign are counted as `uncovered` instead of falling back to the orders blob —
 * that fallback would need OrderCampaign/CampaignDeal, which the worker cannot read.
 */
async function campaignOrderSnapshot(campaignId: string, now: Date): Promise<OperationOutcome> {
  const prisma = getPrisma();
  const campaign = await prisma.salesCampaign.findUnique({
    where: { id: campaignId },
    select: { id: true, startDate: true, orderCampaignId: true },
  });
  if (!campaign) return failure("NOT_FOUND", "campaign not found");
  if (!campaign.orderCampaignId) {
    return {
      status: "SUCCEEDED",
      summary: `get_order_snapshot campaign=${campaign.id} source=none (no linked order campaign)`,
      evidenceRefs: boundEvidence([campaign.id]),
      actionProposalId: null,
    };
  }
  const window = resolveLiveWindowKeys(new Date(campaign.startDate).getTime(), now, "agent-worker");
  const rows = await prisma.naverOrderSnapshot.findMany({
    where: { snapshotDate: { gte: window.startKey, lte: window.todayKey } },
    orderBy: { snapshotDate: "asc" },
    select: { snapshotDate: true, dailyAggregate: true },
  });
  const targets = new Set([campaign.id]);
  const aggregates: SnapshotDailyAggregate[] = [];
  let uncovered = 0;
  for (const row of rows) {
    const parsed = parseSnapshotDailyAggregate(row.dailyAggregate);
    if (parsed && aggregateCoversCampaigns(parsed, targets)) aggregates.push(parsed);
    else uncovered += 1;
  }
  const { detail } = composeSalesDetailFromAggregates(aggregates, window.todayKey, targets);
  return {
    status: "SUCCEEDED",
    summary: boundSummary(
      `get_order_snapshot campaign=${campaign.id} window=${window.startKey}..${window.todayKey} truncated=${window.truncated} uncoveredRows=${uncovered} cumulative=${JSON.stringify(detail.cumulative)} today=${JSON.stringify(detail.today)} days=${detail.daily.length}`,
    ),
    evidenceRefs: boundEvidence([campaign.id, ...detail.daily.map((point) => point.date)]),
    actionProposalId: null,
  };
}

async function orderSnapshot(input: OrderSnapshotInput, now: Date): Promise<OperationOutcome> {
  if (input.campaignId) {
    if (input.startAt || input.endAt) {
      return failure("INVALID_INPUT", "campaignId cannot be combined with startAt/endAt");
    }
    return campaignOrderSnapshot(input.campaignId, now);
  }
  if (!input.startAt || !input.endAt) {
    return failure("MISSING_PARAM", "startAt and endAt are required without campaignId");
  }
  const result = await runTool(getOrderSnapshotTool, {
    startDate: toKstYmd(new Date(input.startAt)),
    endDate: toKstYmd(new Date(input.endAt)),
  });
  if (isOperationFailure(result)) return result;
  if (!result.ok) {
    return result.error.code === "NOT_FOUND"
      ? { status: "SUCCEEDED", summary: "get_order_snapshot: no snapshot rows in window", evidenceRefs: [], actionProposalId: null }
      : toolFailure(result);
  }
  return {
    status: "SUCCEEDED",
    summary: boundSummary(`get_order_snapshot days=${result.data.days.length} totals=${JSON.stringify(result.data.totals)}`),
    evidenceRefs: boundEvidence(result.data.days.map((day) => day.snapshotDate)),
    actionProposalId: null,
  };
}

/**
 * Narrow projection over granted tables only (SalesCampaign scalars, Deal.dealName,
 * Seller.name, Seller.agency -> Partner.businessNumber) feeding the pure
 * `calculateDerivedCampaignFinancials` — the same mapping the agent tool uses, minus
 * its `campaignRepository.findById` include of non-granted tables (review HIGH-2).
 */
async function campaignFinancials(input: CampaignFinancialsInput): Promise<OperationOutcome> {
  const campaign = await getPrisma().salesCampaign.findUnique({
    where: { id: input.campaignId },
    select: {
      id: true,
      status: true,
      actualSales: true,
      operatingExpense: true,
      miscExpense: true,
      totalMarginRate: true,
      sellerMarginRate: true,
      sellerTaxType: true,
      isManualSettlementSales: true,
      isManualSellerExpense: true,
      isManualTaxExpense: true,
      settlementSales: true,
      sellerExpense: true,
      taxExpense: true,
      isDepositReceived: true,
      isPayoutCompleted: true,
      deal: { select: { dealName: true } },
      seller: { select: { name: true, agency: { select: { businessNumber: true } } } },
    },
  });
  if (!campaign) return failure("NOT_FOUND", "campaign not found");

  const derived = calculateDerivedCampaignFinancials({
    actualSales: toNumber(campaign.actualSales),
    operatingExpense: toNumber(campaign.operatingExpense),
    miscExpense: toNumber(campaign.miscExpense),
    totalMarginRate: toNumber(campaign.totalMarginRate),
    sellerMarginRate: toNumber(campaign.sellerMarginRate),
    sellerTaxType: campaign.sellerTaxType ?? null,
    sellerCompanyBusinessNumber: campaign.seller?.agency?.businessNumber ?? null,
    isManualSettlementSales: campaign.isManualSettlementSales ?? false,
    isManualSellerExpense: campaign.isManualSellerExpense ?? false,
    isManualTaxExpense: campaign.isManualTaxExpense ?? false,
    manualSettlementSales: toNullableNumber(campaign.settlementSales),
    manualSellerExpense: toNullableNumber(campaign.sellerExpense),
    manualTaxExpense: toNullableNumber(campaign.taxExpense),
  });
  return {
    status: "SUCCEEDED",
    summary: boundSummary(
      `get_campaign_financials campaign=${campaign.id} deal=${campaign.deal?.dealName ?? ""} seller=${campaign.seller?.name ?? ""} status=${campaign.status} actualSales=${toNumber(campaign.actualSales)} derived=${JSON.stringify(derived)} deposit=${campaign.isDepositReceived} payout=${campaign.isPayoutCompleted}`,
    ),
    evidenceRefs: boundEvidence([campaign.id]),
    actionProposalId: null,
  };
}

// ---------------------------------------------------------------------------
// create_action_proposal — INSERT only (contract 5)
// ---------------------------------------------------------------------------

type ProposalTx = Prisma.TransactionClient;

const WRITE_INTENT_TOOLS = {
  add_entity_memo: addEntityMemoTool,
  change_deal_status: changeDealStatusTool,
  confirm_settlement: confirmSettlementTool,
} as const;

async function targetExists(intent: WriteIntent, client: ProposalTx): Promise<boolean> {
  const where = { where: { id: intent.targetEntityId }, select: { id: true } } as const;
  switch (intent.targetEntityType) {
    case "PARTNER":
      return (await client.partner.findUnique(where)) !== null;
    case "SELLER":
      return (await client.seller.findUnique(where)) !== null;
    case "DEAL":
      return (await client.deal.findUnique(where)) !== null;
    case "CAMPAIGN":
      return (await client.salesCampaign.findUnique(where)) !== null;
    default:
      return false;
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExecutionAbortedError();
}

async function createActionProposal(
  input: CreateActionProposalInput,
  { signal }: OperationContext,
): Promise<OperationOutcome> {
  const { action, ...args } = input;
  // Own-property lookups only: prototype members ("constructor", "toString") are not actions.
  if (!Object.hasOwn(WRITE_ACTIONS, action) || !Object.hasOwn(WRITE_INTENT_TOOLS, action)) {
    return failure("WRITE_ACTION_NOT_ALLOWED", "action is not in WRITE_ACTIONS");
  }
  const definition = WRITE_ACTIONS[action];
  const intentTool = WRITE_INTENT_TOOLS[action as keyof typeof WRITE_INTENT_TOOLS];
  const parsedArgs = definition.argsSchema.safeParse(args);
  if (!parsedArgs.success) {
    return failure("INVALID_INPUT", "action args failed validation");
  }
  const intentResult = (await intentTool.execute(parsedArgs.data as never)) as ToolResult<{ writeIntent: WriteIntent }>;
  if (!intentResult.ok) return toolFailure(intentResult);
  const intent = intentResult.data.writeIntent;

  // No commit after lease loss / timeout / shutdown (review MEDIUM-2).
  assertNotAborted(signal);
  const prisma = getPrisma();
  const proposalId = await prisma.$transaction(async (tx) => {
    if (!(await targetExists(intent, tx))) return null;
    assertNotAborted(signal);
    const created = await tx.actionProposal.create({
      data: serializeJsonFields({
        requestType: getRequestTypeForAction(intent.action),
        kind: "WRITE",
        status: "PENDING_APPROVAL",
        title: intent.summary.slice(0, 200),
        resultSummary: intent.summary,
        payload: { action: intent.action, args: parsedArgs.data as Prisma.InputJsonValue },
        targetEntityType: intent.targetEntityType,
        targetEntityId: intent.targetEntityId,
        campaignId: intent.targetEntityType === "CAMPAIGN" ? intent.targetEntityId : null,
        reviewRequired: true,
        createdBy: ACTOR,
      }),
    });
    await tx.actionProposalEvent.create({
      data: {
        proposalId: created.id,
        fromStatus: "DRAFT",
        toStatus: "PENDING_APPROVAL",
        actor: ACTOR,
        note: "agent worker 기안 상신, 관리자 승인 대기",
      },
    });
    return created.id;
  });
  if (proposalId === null) return failure("TARGET_NOT_FOUND", "proposal target does not exist");

  return {
    status: "NEEDS_APPROVAL",
    summary: boundSummary(`create_action_proposal: ${intent.summary} (proposal ${proposalId}, PENDING_APPROVAL)`),
    evidenceRefs: boundEvidence([proposalId]),
    actionProposalId: proposalId,
  };
}

/** Exact registry — the only dispatch surface for the five frozen operations. */
export const OPERATION_REGISTRY: Record<AgentJobPayload["operation"], OperationHandler> = {
  search_deals: (input) => searchDeals(input as SearchDealsInput),
  get_pipeline_status: () => pipelineStatus(),
  get_order_snapshot: (input, context) => orderSnapshot(input as OrderSnapshotInput, context.now),
  get_campaign_financials: (input) => campaignFinancials(input as CampaignFinancialsInput),
  create_action_proposal: (input, context) => createActionProposal(input as CreateActionProposalInput, context),
};

function buildResult(
  job: AgentJobRecord,
  route: AgentJobRoute,
  modelUsed: string,
  fields: Pick<AgentJobResult, "status" | "validationResult" | "resultSummary" | "actionProposalId" | "evidenceRefs">,
): AgentJobResult {
  return AgentJobResultSchema.parse({
    schemaVersion: 1,
    jobId: job.id,
    route,
    modelUsed,
    ...fields,
  });
}

function externalExecutor(job: AgentJobRecord, decision: RouterDecision, escalationReason: string): ExecutionOutcome {
  return {
    kind: "terminal",
    toStatus: "NEEDS_EXTERNAL_EXECUTOR",
    route: decision.route,
    model: decision.model,
    escalationReason,
    errorClass: null,
    result: buildResult(job, decision.route, decision.model, {
      status: "NEEDS_EXTERNAL_EXECUTOR",
      validationResult: "not_validated",
      resultSummary: boundSummary(`external executor required (route=${decision.route}, reason=${escalationReason})`),
      actionProposalId: null,
      evidenceRefs: [],
    }),
  };
}

export async function executeAgentJob(
  job: AgentJobRecord,
  deps: ExecutionDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<ExecutionOutcome> {
  const now = deps.now ?? (() => new Date());
  const decision = await deps.decideRoute(job.payload);
  if (decision.status !== "ACCEPTED") {
    return { kind: "security", errorClass: "ROUTER_REJECTED" };
  }

  switch (decision.route) {
    case "gpt_luna":
    case "director":
      return externalExecutor(job, decision, decision.reason);
    case "local":
      // Contract 7: local runs only after owner promotion + validator + threshold.
      // Nothing is promoted in this scope, so the route fails closed.
      return externalExecutor(job, decision, "local_route_not_active");
    case "python":
    case "gemini":
    case "local_shadow":
      break;
  }

  // Only the deterministic registry runs from here on: no model is invoked.
  const route = decision.route;
  const model = NO_MODEL_INVOKED;
  let outcome: OperationOutcome;
  try {
    assertNotAborted(signal);
    outcome = await OPERATION_REGISTRY[job.payload.operation](job.payload.input, { now: now(), signal });
  } catch (error) {
    if (error instanceof ExecutionAbortedError) throw error;
    return {
      kind: "retryable",
      errorClass: error instanceof Error ? error.name : "UnknownError",
      route,
      model,
    };
  }

  if (outcome.status === "RETRY") {
    return { kind: "retryable", errorClass: outcome.errorClass, route, model };
  }
  if (outcome.status === "FAILED_FINAL") {
    return {
      kind: "terminal",
      toStatus: "FAILED_FINAL",
      route,
      model,
      escalationReason: null,
      errorClass: outcome.errorClass,
      result: buildResult(job, route, model, {
        status: "FAILED_FINAL",
        validationResult: "fail",
        resultSummary: boundSummary(`${job.payload.operation} failed: ${outcome.errorClass}`),
        actionProposalId: null,
        evidenceRefs: [],
      }),
    };
  }
  return {
    kind: "terminal",
    toStatus: outcome.status,
    route,
    model,
    escalationReason: null,
    errorClass: null,
    result: buildResult(job, route, model, {
      status: outcome.status,
      validationResult: "pass",
      resultSummary: outcome.summary,
      actionProposalId: outcome.actionProposalId,
      evidenceRefs: outcome.evidenceRefs,
    }),
  };
}

// ---------------------------------------------------------------------------
// Router invocation — fixed argv, shell=false, stdout parsed by Task 4's parser.
// ---------------------------------------------------------------------------

export const DEFAULT_ROUTER_SCRIPT_PATH = path.join(homedir(), ".gemini", "bin", "local-llm-route.py");
/** Absolute so a minimal launchd PATH cannot change which interpreter runs (review LOW-4). */
export const DEFAULT_ROUTER_PYTHON = "/usr/bin/python3";
export const ROUTER_TIMEOUT_MS = 15_000;

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { shell: false; timeout: number; maxBuffer: number; windowsHide: true },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileLike = async (file, args, options) => {
  const { stdout, stderr } = await promisify(execFileCallback)(file, args, { ...options, encoding: "utf8" });
  return { stdout: String(stdout), stderr: String(stderr) };
};

export function buildRouterArgv(payload: AgentJobPayload, scriptPath: string, pythonPath: string): { file: string; args: string[] } {
  return {
    file: pythonPath,
    args: [scriptPath, "decide", "--task-type", payload.taskType, "--skill", payload.skill],
  };
}

export async function runRouterDecision(
  payload: AgentJobPayload,
  options: { scriptPath?: string; pythonPath?: string; execFile?: ExecFileLike; timeoutMs?: number } = {},
): Promise<RouterDecisionParseResult> {
  const argv = buildRouterArgv(
    payload,
    options.scriptPath ?? DEFAULT_ROUTER_SCRIPT_PATH,
    options.pythonPath ?? DEFAULT_ROUTER_PYTHON,
  );
  let stdout: string;
  try {
    ({ stdout } = await (options.execFile ?? defaultExecFile)(argv.file, argv.args, {
      shell: false,
      timeout: options.timeoutMs ?? ROUTER_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }));
  } catch {
    return { status: "FAILED_SECURITY" };
  }
  return parseRouterDecision(stdout.trim());
}
