import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { containsSearch } from "@/lib/prisma-search";
import { DEAL_STATUSES } from "@/lib/deal-status";
import { toKstYmd } from "@/lib/date-utils";
import { dealRepository } from "@/repositories/dealRepository";
import { ActionProposalRepository, serializeJsonFields } from "@/repositories/actionProposalRepository";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import { getPipelineStatusTool } from "@/lib/agent/tools/pipeline-status";
import { getCampaignFinancialsTool } from "@/lib/agent/tools/campaign-financials";
import { getOrderSnapshotTool } from "@/lib/agent/tools/order-snapshot";
import { addEntityMemoTool } from "@/lib/agent/tools/add-entity-memo";
import { changeDealStatusTool } from "@/lib/agent/tools/change-deal-status";
import { confirmSettlementTool } from "@/lib/agent/tools/confirm-settlement";
import type { ToolResult, WriteIntent } from "@/lib/agent/tools/types";
import { getMobileCampaignSales } from "@/lib/mobile-campaign-sales";
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
 * - read operations reuse the existing agent tools / calculations or a narrower
 *   repository projection; no business logic is copied here
 * - `create_action_proposal` validates WRITE_ACTIONS + Zod args + target existence,
 *   then inserts the proposal and its initial event in one transaction. It never
 *   imports an approval or execution function.
 * - route behavior follows contract 7; a router failure has no fallback.
 */
export type TerminalStatus = AgentJobResult["status"];

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

type OperationSuccess = {
  status: "SUCCEEDED" | "NEEDS_APPROVAL";
  summary: string;
  evidenceRefs: string[];
  actionProposalId: string | null;
};
type OperationFailure = { status: "FAILED_FINAL"; errorClass: string; summary: string };
type OperationRetry = { status: "RETRY"; errorClass: string };
type OperationOutcome = OperationSuccess | OperationFailure | OperationRetry;

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

type OperationHandler = (input: AgentJobPayload["input"], now: Date) => Promise<OperationOutcome>;

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
  const result = await getPipelineStatusTool.execute({});
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

async function orderSnapshot(input: OrderSnapshotInput, now: Date): Promise<OperationOutcome> {
  if (input.campaignId) {
    if (input.startAt || input.endAt) {
      return failure("INVALID_INPUT", "campaignId cannot be combined with startAt/endAt");
    }
    const sales = await getMobileCampaignSales(input.campaignId, now);
    if (!sales) return failure("NOT_FOUND", "campaign not found");
    const cumulative = JSON.stringify(sales.cumulative);
    const today = JSON.stringify(sales.today);
    return {
      status: "SUCCEEDED",
      summary: boundSummary(
        `get_order_snapshot campaign=${sales.campaignId} source=${sales.source} asOf=${sales.asOf ?? "n/a"} cumulative=${cumulative} today=${today} days=${sales.daily.length}`,
      ),
      evidenceRefs: boundEvidence([sales.campaignId, ...sales.daily.map((point) => point.date)]),
      actionProposalId: null,
    };
  }
  if (!input.startAt || !input.endAt) {
    return failure("MISSING_PARAM", "startAt and endAt are required without campaignId");
  }
  const result = await getOrderSnapshotTool.execute({
    startDate: toKstYmd(new Date(input.startAt)),
    endDate: toKstYmd(new Date(input.endAt)),
  });
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

async function campaignFinancials(input: CampaignFinancialsInput): Promise<OperationOutcome> {
  const result = await getCampaignFinancialsTool.execute({ campaignId: input.campaignId });
  if (!result.ok) return toolFailure(result);
  const { campaignId, status, actualSales, derived, isDepositReceived, isPayoutCompleted } = result.data;
  return {
    status: "SUCCEEDED",
    summary: boundSummary(
      `get_campaign_financials campaign=${campaignId} status=${status} actualSales=${actualSales} derived=${JSON.stringify(derived)} deposit=${isDepositReceived} payout=${isPayoutCompleted}`,
    ),
    evidenceRefs: boundEvidence([campaignId]),
    actionProposalId: null,
  };
}

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

async function createActionProposal(input: CreateActionProposalInput): Promise<OperationOutcome> {
  const { action, ...args } = input;
  const definition = WRITE_ACTIONS[action];
  const intentTool = WRITE_INTENT_TOOLS[action as keyof typeof WRITE_INTENT_TOOLS];
  if (!definition || !intentTool) {
    return failure("WRITE_ACTION_NOT_ALLOWED", "action is not in WRITE_ACTIONS");
  }
  const parsedArgs = definition.argsSchema.safeParse(args);
  if (!parsedArgs.success) {
    return failure("INVALID_INPUT", "action args failed validation");
  }
  const intentResult = (await intentTool.execute(parsedArgs.data as never)) as ToolResult<{ writeIntent: WriteIntent }>;
  if (!intentResult.ok) return toolFailure(intentResult);
  const intent = intentResult.data.writeIntent;

  const prisma = getPrisma();
  const proposalId = await prisma.$transaction(async (tx) => {
    if (!(await targetExists(intent, tx))) return null;
    const created = await tx.actionProposal.create({
      data: serializeJsonFields({
        requestType: getRequestTypeForAction(intent.action),
        kind: "WRITE",
        status: "DRAFT",
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
    await ActionProposalRepository.transition(created.id, "PENDING_APPROVAL", {
      tx,
      expectedFrom: "DRAFT",
      actor: ACTOR,
      note: "agent worker 기안 상신, 관리자 승인 대기",
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
  get_order_snapshot: (input, now) => orderSnapshot(input as OrderSnapshotInput, now),
  get_campaign_financials: (input) => campaignFinancials(input as CampaignFinancialsInput),
  create_action_proposal: (input) => createActionProposal(input as CreateActionProposalInput),
};

function buildResult(
  job: AgentJobRecord,
  decision: RouterDecision,
  fields: Pick<AgentJobResult, "status" | "validationResult" | "resultSummary" | "actionProposalId" | "evidenceRefs">,
): AgentJobResult {
  return AgentJobResultSchema.parse({
    schemaVersion: 1,
    jobId: job.id,
    route: decision.route,
    modelUsed: decision.model,
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
    result: buildResult(job, decision, {
      status: "NEEDS_EXTERNAL_EXECUTOR",
      validationResult: "not_validated",
      resultSummary: boundSummary(`external executor required (route=${decision.route}, reason=${escalationReason})`),
      actionProposalId: null,
      evidenceRefs: [],
    }),
  };
}

export async function executeAgentJob(job: AgentJobRecord, deps: ExecutionDeps): Promise<ExecutionOutcome> {
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

  let outcome: OperationOutcome;
  try {
    outcome = await OPERATION_REGISTRY[job.payload.operation](job.payload.input, now());
  } catch (error) {
    return {
      kind: "retryable",
      errorClass: error instanceof Error ? error.name : "UnknownError",
      route: decision.route,
      model: decision.model,
    };
  }

  if (outcome.status === "RETRY") {
    return { kind: "retryable", errorClass: outcome.errorClass, route: decision.route, model: decision.model };
  }
  if (outcome.status === "FAILED_FINAL") {
    return {
      kind: "terminal",
      toStatus: "FAILED_FINAL",
      route: decision.route,
      model: decision.model,
      escalationReason: null,
      errorClass: outcome.errorClass,
      result: buildResult(job, decision, {
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
    route: decision.route,
    model: decision.model,
    escalationReason: null,
    errorClass: null,
    result: buildResult(job, decision, {
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
export const DEFAULT_ROUTER_PYTHON = "python3";
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
