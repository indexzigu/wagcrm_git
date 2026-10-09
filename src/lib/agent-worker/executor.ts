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
import { PartnerRepository } from "@/repositories/partnerRepository";
import { serializeJsonFields } from "@/repositories/actionProposalRepository";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import { getPipelineStatusTool } from "@/lib/agent/tools/pipeline-status";
import { getOrderSnapshotTool } from "@/lib/agent/tools/order-snapshot";
import { getSettlementReportTool } from "@/lib/agent/tools/settlement-report";
import { addEntityMemoTool } from "@/lib/agent/tools/add-entity-memo";
import { changeDealStatusTool } from "@/lib/agent/tools/change-deal-status";
import { confirmSettlementTool } from "@/lib/agent/tools/confirm-settlement";
import { createPartnerTool } from "@/lib/agent/tools/create-partner";
import { createDealTool } from "@/lib/agent/tools/create-deal";
import { updateSettlementAmountTool } from "@/lib/agent/tools/update-settlement-amount";
import type { AgentTool, ToolResult, WriteIntent } from "@/lib/agent/tools/types";
import { WRITE_ACTIONS } from "@/lib/agent/write-executor";
import { getRequestTypeForAction } from "@/lib/agent/approval-policy";
import { deriveClaims } from "@/lib/order-converter/claim-derive";
import { loadClaimSourceOrders, resolveClaimWindowKeys } from "@/lib/order-converter/claim-source-loader";
import { getLastChangeSyncMs, resolveLastOrderSyncIso } from "@/lib/order-converter/order-auto-sync";
import { toDateKeyKst } from "@/lib/mobile-pulse-data";
import { naverOrderSnapshotRepository } from "@/repositories/naverOrderSnapshotRepository";
import {
  AgentJobResultSchema,
  DEFAULT_STORE_STATUS_CLAIMS,
  DEFAULT_WORK_RECORDS_LIMIT,
  MAX_EVIDENCE_REFS,
  MAX_RESULT_SUMMARY_CHARS,
  type AgentJobPayload,
  type AgentJobResult,
  type AgentJobRoute,
} from "./contracts";
import { recordReadResult, type ReadResultRecord } from "./read-result-record";
import {
  boundWorkRecords,
  buildBoundedSummary,
  collectKnownNamesByOrder,
  countClaimsByType,
  flattenLineBreaks,
  formatStoreClaimLine,
  formatWorkRecordLine,
  selectOpenClaims,
  toWorkRecordView,
} from "./read-projections";
import { parseRouterDecision, type RouterDecisionParseResult } from "./router";
import {
  hasShadowValidator,
  runLocalShadow,
  shadowAuditFields,
  type ShadowAuditFields,
  type ShadowDeps,
  type ShadowValidatorRegistry,
} from "./shadow";

/**
 * Agent worker executor (plan Task 5, contracts 4/5/7).
 *
 * - exact operation registry for the frozen operations the contract declares
 * - every read stays inside the worker role's SELECT scope (SalesCampaign, Deal,
 *   Partner, Seller, NaverOrderSnapshot, CampaignGroup, ActionProposal rows this
 *   worker created, and — column- and row-limited to whitelisted Kakao rooms —
 *   ChatRoomMapping and WorkRecord) by reusing existing pure calculations over narrow
 *   projections; no business formula is copied here
 * - `create_action_proposal` validates WRITE_ACTIONS + Zod args + target existence,
 *   then INSERTs the proposal as PENDING_APPROVAL plus its initial event in one
 *   transaction — never an UPDATE, never an approval/execution function
 * - route behavior follows contract 7; a router failure has no fallback
 * - the abort signal is honored: nothing is committed after lease loss/timeout/shutdown
 */
export type TerminalStatus = AgentJobResult["status"];

/**
 * Contract-7 interpretation (Director ruling 14, Task 5 re-review LOW-5): the five
 * operations are deterministic, so on `python`/`gemini`/`local_shadow` only the
 * in-process registry runs and no model is invoked; on every
 * `NEEDS_EXTERNAL_EXECUTOR` path nothing ran at all. `modelUsed` and the audit
 * `model` then carry this sentinel; `route` stays exactly as the router decided.
 */
export const NO_MODEL_INVOKED = "none";

/**
 * Route recorded when the router itself could not answer (timeout, non-zero exit,
 * spawn failure). Contract 7 defines `director` as "return the
 * result waiting for high-risk judgment", which is exactly what an undecided job
 * needs; no other route is inferred and nothing is executed.
 */
export const ROUTER_UNAVAILABLE_ROUTE: AgentJobRoute = "director";

export type ExecutionOutcome =
  | {
      kind: "terminal";
      toStatus: TerminalStatus;
      result: AgentJobResult;
      route: AgentJobRoute;
      model: string;
      escalationReason: string | null;
      errorClass: string | null;
      /** Present only for `local_shadow`: the shadow verdict for the audit line (never in `result`). */
      shadow?: Pick<ShadowAuditFields, "validationResult" | "correction">;
    }
  | { kind: "security"; errorClass: string }
  | { kind: "retryable"; errorClass: string; route: AgentJobRoute | null; model: string | null };

export type RouterUnavailableClass = "ROUTER_TIMEOUT" | "ROUTER_EXIT_NONZERO" | "ROUTER_SPAWN_FAILED";

/** Task 4 parser verdict, or a process-level failure of the router spawn itself. */
export type RouterInvocationResult =
  | RouterDecisionParseResult
  | { status: "ROUTER_UNAVAILABLE"; errorClass: RouterUnavailableClass };

export type ExecutionDeps = {
  decideRoute: (payload: AgentJobPayload) => Promise<RouterInvocationResult>;
  now?: () => Date;
  /** Local shadow wiring; absent ≡ no registered validator (no local call is possible). */
  shadow?: ShadowDeps;
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
  /** 읽기 작업의 결재함 기록 페이로드 — 있으면 실행기가 성공 직후 READ 산출물로 남긴다(§3-A). */
  record?: ReadResultRecord;
};
type OperationFailure = { status: "FAILED_FINAL"; errorClass: string; summary: string };
type OperationRetry = { status: "RETRY"; errorClass: string };
type OperationOutcome = OperationSuccess | OperationFailure | OperationRetry;

type OperationContext = { now: Date; signal: AbortSignal; origin: AgentJobPayload["origin"] };
type OperationHandler = (input: AgentJobPayload["input"], context: OperationContext) => Promise<OperationOutcome>;

/**
 * Per-operation input shapes. `AgentJobPayload.input` is a scalar record whose
 * operation-specific shape was already enforced by the contract's Zod superRefine
 * at submit time and again at the repository read boundary, so the handlers narrow
 * by cast instead of re-declaring the frozen schemas here.
 */
type SearchDealsInput = { query?: string; status?: string; partnerId?: string };
type SearchPartnersInput = { name?: string; type?: string };
type GetActionProposalInput = { proposalId: string };
type OrderSnapshotInput = { campaignId?: string; startAt?: string; endAt?: string };
type CampaignFinancialsInput = { campaignId: string };
type SettlementReportInput = { month?: string; year?: string; sellerName?: string; statusFilter?: "SETTLEMENT_IN_PROGRESS" | "COMPLETED" | "ALL" };
type StoreStatusInput = { claimsLimit?: number; since?: string };
type WorkRecordsInput = { roomKey: string; since: string; until?: string; limit?: number };
type ProposalScalar = string | number | boolean | null;
type ProposalNestedValue = ProposalScalar | Record<string, ProposalScalar>;
/**
 * 기안 입력 한 칸에 담길 수 있는 값 — 계약의 `jobInputValueSchema` 와 **같은 깊이 2**.
 * 스칼라만 적어 두면 계약이 허용하는 거래처 객체·옵션 배열을 타입이 부인하게 된다
 * (런타임은 zod 가 막지만, 거짓말하는 타입은 다음 사람이 캐스트로 뚫는다).
 */
type ProposalArgValue = ProposalNestedValue | ProposalNestedValue[];
type CreateActionProposalInput = { action: string } & Record<string, ProposalArgValue>;

const ACTOR = "AGENT_WORKER";
const SEARCH_TAKE_LIMIT = 20;
// 실패한 기안의 오류 문구는 봇이 오너에게 그대로 옮기므로 앞부분만 싣는다.
const PROPOSAL_ERROR_EXCERPT_CHARS = 300;
// `get_action_proposal` 둘째 줄의 실행자 값 — 읽는 쪽이 한 줄 정규식으로 받을 수 있는 글자만.
const EXECUTED_BY_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
// 사람 승인자의 id(로그인 계정 uuid) 모양. 봇에게는 "사람이 승인했다"만 필요하므로 id 자체는
// 넘기지 않는다 — 봇의 대화 맥락·슬랙 회신으로 계정 식별자가 흘러갈 길을 만들지 않는다.
const HUMAN_ACTOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 실행자 값을 봇에게 보낼 한 낱말로 옮긴다: 사람 승인자 id → `HUMAN`, 시스템 actor(토큰 글자)는
 * 그대로, 그 밖의 값(이메일 등) → `UNKNOWN`. 실행되지 않은 기안(값 없음)은 null — 줄을 싣지 않는다.
 */
function executedByLabel(executedBy: string | null): string | null {
  if (!executedBy) return null;
  if (HUMAN_ACTOR_ID.test(executedBy)) return "HUMAN";
  return EXECUTED_BY_TOKEN.test(executedBy) ? executedBy : "UNKNOWN";
}

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

/**
 * 봇이 올린 기안 하나의 현재 상태. 오너가 CRM 화면에서 승인·반려하는데 그 결과가 봇에게
 * 돌아올 길이 없어서, 봇이 이 조회로 결정을 확인한다(2026-09-10).
 *
 * ⛔ 봇이 올린 기안(`createdBy = ACTOR`)만 돌려준다. **없는 기안과 남이 올린 기안은 같은
 *    답**을 받는다 — 다르게 답하면 id 를 넣어 보는 것만으로 사람이 올린 기안이 있는지를
 *    알아낼 수 있다.
 * 🔎 `executedRef` 가 이 조회의 판단 가치다. 거래처 기안이 완료되면 그 값이 **방금 만든
 *    거래처의 정확한 id** 라, 이어지는 딜 기안이 이름 검색 없이 붙는다.
 */
async function getActionProposal(input: GetActionProposalInput): Promise<OperationOutcome> {
  const proposal = await getPrisma().actionProposal.findUnique({
    where: { id: input.proposalId },
    select: {
      id: true,
      status: true,
      title: true,
      createdBy: true,
      executedRefType: true,
      executedRefId: true,
      executedBy: true,
      errorMessage: true,
    },
  });
  if (!proposal || proposal.createdBy !== ACTOR) {
    return failure("PROPOSAL_NOT_FOUND", "no proposal by this worker with that id");
  }
  // ⛔ 기계가 읽는 사실(상태·만들어진 대상)은 **첫 줄에만** 싣는다. 제목은 봇이 사진에서
  //    읽은 글로 만들어져, 제목 속 줄바꿈 뒤의 "executedRef=PARTNER:<남의 id>" 가 진짜 줄보다
  //    앞에 서면 딜이 엉뚱한 거래처에 붙는다. 첫 줄은 DB 가 만든 값만으로 이뤄지고, 사람이
  //    읽는 둘째 줄 이후는 줄바꿈을 눌러 한 줄씩으로 둔다.
  // ⛔ 첫 줄 끝에 무엇도 덧붙이지 말 것 — 읽는 쪽 두 곳(hermes `gateway/bridge/worker.py`
  //    `_PROPOSAL_LINE` · `plugins/wag-operator/approval_watch.py` `_RESULT_LINE`)이 그 줄을
  //    `$` 로 닫힌 정규식으로 통째 대조하므로, 칸 하나만 늘어도 모든 결정이 "읽을 수 없음"이 된다.
  const executedRef =
    proposal.executedRefType && proposal.executedRefId
      ? ` executedRef=${proposal.executedRefType}:${proposal.executedRefId}`
      : "";
  const lines = [`get_action_proposal: ${proposal.id} status=${proposal.status}${executedRef}`];
  // 누가 실행했는가(사람 승인 vs 자동 실행)는 **둘째 줄 고정 자리**에 싣는다 — `executedBy` 가
  // 있을 때만(실행이 끝난 기안). 값은 DB 가 쓴 것을 `executedByLabel` 로 옮긴 한 낱말이다.
  // 제목 줄보다 **앞에** 두는 이유: 제목은 줄바꿈이 눌려 한 줄이라 이 자리를 흉내낼 수 없다.
  // 읽는 쪽은 둘째 줄만 `^executedBy=…$` 로 대조한다(아래 줄들을 훑어 `executedBy=` 를 찾으면
  // 제목이 그 글자를 담을 수 있다).
  const executedBy = executedByLabel(proposal.executedBy);
  if (executedBy) {
    lines.push(`executedBy=${executedBy}`);
  }
  lines.push(`title=${flattenLineBreaks(proposal.title)}`);
  if (proposal.status === "FAILED" && proposal.errorMessage) {
    lines.push(`error=${flattenLineBreaks(proposal.errorMessage.slice(0, PROPOSAL_ERROR_EXCERPT_CHARS))}`);
  }
  return {
    status: "SUCCEEDED",
    summary: boundSummary(lines.join("\n")),
    evidenceRefs: boundEvidence(
      proposal.executedRefId ? [proposal.id, proposal.executedRefId] : [proposal.id],
    ),
    actionProposalId: null,
  };
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
 * Runs a reused agent tool through its own contract: the tool's own
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
  const summary = boundSummary(
    `search_deals: ${items.length} deal(s)${truncated ? " (truncated at 20)" : ""}\n${lines.join("\n")}`,
  );
  return {
    status: "SUCCEEDED",
    summary,
    evidenceRefs: boundEvidence(items.map((row) => row.id)),
    actionProposalId: null,
    record: {
      title: `딜 검색 ${items.length}건`,
      resultSummary: summary,
      structuredResult: {
        items: items.map((row) => ({
          id: row.id,
          dealName: row.dealName,
          brandName: row.brandName,
          status: row.status,
          partnerId: row.partnerId,
          updatedAt: row.updatedAt.toISOString(),
        })),
        // ⚠️ 이 값은 envelope 의 `truncated`(64KB 상한 초과로 데이터가 통째로 마커로 바뀌었는가)
        // 와 다른 개념이다 — 이건 "행 목록이 20건 상한에 걸렸는가"다. 이름을 겹치게 두면 결재함
        // 화면·감사 로그가 어느 절단인지 헷갈린다.
        rowLimitReached: truncated,
      },
      dataSources: ["Deal"],
      query: { ...input },
    },
  };
}

/**
 * 거래처를 이름으로 찾아 **id 를 돌려준다**. `create_deal` 이 이미 등록된 거래처에 붙으려면
 * 그 id 가 필요한데 라우터가 얻을 길이 없었다 — `search_deals` 는 딜 id 만 돌려주고, 딜이
 * 아직 없는 거래처는 결과에 나오지도 않는다(2026-09-10).
 *
 * ⛔ Deal 과 조인하지 말 것. 조인하는 순간 「거래처 먼저 등록 → 그 거래처에 단가표」 갈래가
 *    다시 막힌다 — 방금 만든 거래처에는 딜이 없다.
 * 🔎 `type` 은 여기서 다시 검사하지 않는다. 계약이 `AgentJobPartnerTypeSchema` 로 이미
 *    고정하기 때문이다(`search_deals.status` 는 계약에서 자유 문자열이라 실행기가 유일한
 *    관문이고, 그래서 그쪽에만 검사가 있다).
 */
async function searchPartners(input: SearchPartnersInput): Promise<OperationOutcome> {
  const where: Prisma.PartnerWhereInput = {
    ...(input.type ? { type: input.type } : {}),
    ...(input.name ? { name: containsSearch(input.name) } : {}),
  };
  const rows = await PartnerRepository.findMany({
    where,
    select: { id: true, name: true, type: true, businessNumber: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: SEARCH_TAKE_LIMIT + 1,
  });
  const truncated = rows.length > SEARCH_TAKE_LIMIT;
  const items = rows.slice(0, SEARCH_TAKE_LIMIT);
  // 상호가 같은 거래처를 사람이 가려낼 수 있도록 사업자번호도 함께 보인다(있을 때만).
  const lines = items.map(
    (row) =>
      `${row.name} [${row.type}]${row.businessNumber ? ` 사업자번호 ${row.businessNumber}` : ""} id=${row.id}`,
  );
  const summary = boundSummary(
    `search_partners: ${items.length} partner(s)${truncated ? " (truncated at 20)" : ""}\n${lines.join("\n")}`,
  );
  return {
    status: "SUCCEEDED",
    summary,
    evidenceRefs: boundEvidence(items.map((row) => row.id)),
    actionProposalId: null,
    record: {
      title: `거래처 검색 ${items.length}건`,
      resultSummary: summary,
      structuredResult: {
        items: items.map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type,
          businessNumber: row.businessNumber,
          updatedAt: row.updatedAt.toISOString(),
        })),
        // envelope 의 `truncated`(64KB 상한)와 다른 개념 — "행 목록이 20건 상한에 걸렸는가".
        rowLimitReached: truncated,
      },
      dataSources: ["Partner"],
      query: { ...input },
    },
  };
}

async function pipelineStatus(): Promise<OperationOutcome> {
  const result = await runTool(getPipelineStatusTool, {});
  if (isOperationFailure(result)) return result;
  if (!result.ok) {
    if (result.error.code !== "NOT_FOUND") return toolFailure(result);
    const emptySummary = "get_pipeline_status: no campaigns";
    return {
      status: "SUCCEEDED",
      summary: emptySummary,
      evidenceRefs: [],
      actionProposalId: null,
      record: {
        title: "파이프라인 현황 총 0건",
        resultSummary: emptySummary,
        structuredResult: { totalCount: 0, statusCounts: [], campaigns: [] },
        dataSources: ["SalesCampaign"],
        query: {},
      },
    };
  }
  const counts = result.data.statusCounts.map((entry) => `${entry.status}=${entry.count}`).join(", ");
  const summary = boundSummary(`get_pipeline_status: total=${result.data.totalCount}; ${counts}`);
  return {
    status: "SUCCEEDED",
    summary,
    evidenceRefs: boundEvidence(result.data.campaigns.map((campaign) => campaign.id)),
    actionProposalId: null,
    record: {
      title: `파이프라인 현황 총 ${result.data.totalCount}건`,
      resultSummary: summary,
      structuredResult: result.data,
      dataSources: result.evidence.dataSources,
      query: result.evidence.query,
    },
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
    const noLinkSummary = `get_order_snapshot campaign=${campaign.id} source=none (no linked order campaign)`;
    return {
      status: "SUCCEEDED",
      summary: noLinkSummary,
      evidenceRefs: boundEvidence([campaign.id]),
      actionProposalId: null,
      record: {
        title: `캠페인 주문 스냅샷 ${campaign.id} (주문캠페인 연결 없음)`,
        resultSummary: noLinkSummary,
        structuredResult: { campaignId: campaign.id, source: "none" },
        dataSources: ["SalesCampaign"],
        query: { campaignId: campaign.id },
      },
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
  const summary = boundSummary(
    `get_order_snapshot campaign=${campaign.id} window=${window.startKey}..${window.todayKey} truncated=${window.truncated} uncoveredRows=${uncovered} cumulative=${JSON.stringify(detail.cumulative)} today=${JSON.stringify(detail.today)} days=${detail.daily.length}`,
  );
  return {
    status: "SUCCEEDED",
    summary,
    evidenceRefs: boundEvidence([campaign.id, ...detail.daily.map((point) => point.date)]),
    actionProposalId: null,
    record: {
      title: `캠페인 주문 스냅샷 ${campaign.id}`,
      resultSummary: summary,
      structuredResult: {
        campaignId: campaign.id,
        window: { startKey: window.startKey, todayKey: window.todayKey, truncated: window.truncated },
        uncoveredRows: uncovered,
        detail,
      },
      dataSources: ["SalesCampaign", "NaverOrderSnapshot"],
      query: { campaignId: campaign.id },
    },
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
  const startDate = toKstYmd(new Date(input.startAt));
  const endDate = toKstYmd(new Date(input.endAt));
  const result = await runTool(getOrderSnapshotTool, { startDate, endDate });
  if (isOperationFailure(result)) return result;
  if (!result.ok) {
    if (result.error.code !== "NOT_FOUND") return toolFailure(result);
    const emptySummary = "get_order_snapshot: no snapshot rows in window";
    return {
      status: "SUCCEEDED",
      summary: emptySummary,
      evidenceRefs: [],
      actionProposalId: null,
      record: {
        title: `주문 스냅샷 ${startDate}~${endDate}`,
        resultSummary: emptySummary,
        structuredResult: { days: [], totals: null },
        dataSources: ["NaverOrderSnapshot"],
        query: { startDate, endDate },
      },
    };
  }
  const summary = boundSummary(`get_order_snapshot days=${result.data.days.length} totals=${JSON.stringify(result.data.totals)}`);
  return {
    status: "SUCCEEDED",
    summary,
    evidenceRefs: boundEvidence(result.data.days.map((day) => day.snapshotDate)),
    actionProposalId: null,
    record: {
      title: `주문 스냅샷 ${startDate}~${endDate}`,
      resultSummary: summary,
      structuredResult: result.data,
      dataSources: result.evidence.dataSources,
      query: result.evidence.query,
    },
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
      sellerFeeBasisOverride: true,
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
    // 수동 정산 기준액. ⚠️ 품목 요율 자격(`resolveEffectiveSellerFeeBasis`)은 여기서 판정하지 못한다 —
    // 워커 role(`wag_agent_worker`)에는 CampaignDeal SELECT 권한이 없고(최소권한, AgentJob 마이그레이션
    // GRANT 블록) 위 select 계약 테스트도 campaignDeals 조회를 금지한다. 요율이 섞인 상태의 기준액은
    // 캠페인 PATCH 가 400 으로 막아 앱 경로로는 생기지 않으므로 저장값을 그대로 넘긴다.
    sellerFeeBasisOverride: toNullableNumber(campaign.sellerFeeBasisOverride),
  });
  const summary = boundSummary(
    `get_campaign_financials campaign=${campaign.id} deal=${campaign.deal?.dealName ?? ""} seller=${campaign.seller?.name ?? ""} status=${campaign.status} actualSales=${toNumber(campaign.actualSales)} derived=${JSON.stringify(derived)} deposit=${campaign.isDepositReceived} payout=${campaign.isPayoutCompleted}`,
  );
  return {
    status: "SUCCEEDED",
    summary,
    evidenceRefs: boundEvidence([campaign.id]),
    actionProposalId: null,
    record: {
      title: `캠페인 재무 ${campaign.deal?.dealName ?? ""} / ${campaign.seller?.name ?? ""}`,
      resultSummary: summary,
      structuredResult: {
        campaignId: campaign.id,
        dealName: campaign.deal?.dealName ?? null,
        sellerName: campaign.seller?.name ?? null,
        status: campaign.status,
        actualSales: toNumber(campaign.actualSales),
        isDepositReceived: campaign.isDepositReceived,
        isPayoutCompleted: campaign.isPayoutCompleted,
        derived,
      },
      dataSources: ["SalesCampaign", "Deal", "Seller", "Partner"],
      query: { campaignId: input.campaignId },
    },
  };
}

/**
 * 정산 리포트(§3-E). 웹 어시스턴트 도구를 `runTool` 로 그대로 재사용한다 — 도구가 읽는
 * 표(SalesCampaign·Deal·Seller·Partner(agency)·CampaignGroup)는 전부 워커 역할의 SELECT
 * 범위 안이라 권한 변경이 없다(`settlementService.ts` `getSettlementReport` 실독).
 */
async function settlementReport(input: SettlementReportInput): Promise<OperationOutcome> {
  const result = await runTool(getSettlementReportTool, input);
  if (isOperationFailure(result)) return result;
  if (!result.ok) {
    if (result.error.code !== "NOT_FOUND") return toolFailure(result);
    const periodLabel = input.month ?? input.year ?? "이번 달";
    const emptySummary = "get_settlement_report: no campaigns in period";
    return {
      status: "SUCCEEDED",
      summary: emptySummary,
      evidenceRefs: [],
      actionProposalId: null,
      record: {
        title: `정산 리포트 ${periodLabel} (0건)`,
        resultSummary: emptySummary,
        structuredResult: { period: periodLabel, campaigns: [], stateCounts: { pending: 0, confirmed: 0, paid: 0 } },
        dataSources: ["SalesCampaign"],
        query: { ...input },
      },
    };
  }
  const { period, summary: totals, stateCounts, campaigns } = result.data;
  const lines = campaigns.map(
    (campaign) =>
      `${campaign.dealName} / ${campaign.sellerName} [${campaign.state}] sales=${campaign.actualSales} payout=${campaign.sellerPayoutAmount} id=${campaign.id}`,
  );
  const summary = boundSummary(
    `get_settlement_report period=${period} campaigns=${totals.campaignCount} revenue=${totals.totalRevenue} margin=${totals.totalMargin} payouts=${totals.totalSellerPayouts} states=${JSON.stringify(stateCounts)}\n${lines.join("\n")}`,
  );
  return {
    status: "SUCCEEDED",
    summary,
    evidenceRefs: boundEvidence(campaigns.map((campaign) => campaign.id)),
    actionProposalId: null,
    record: {
      title: `정산 리포트 ${period} (${totals.campaignCount}건)`,
      resultSummary: summary,
      structuredResult: result.data,
      dataSources: result.evidence.dataSources,
      query: result.evidence.query,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 3 ②⑧ (2026-10-09) — 스토어 현황 · 카톡 업무기록 읽기
//
// 셋 다 **저장된 값만** 읽는다(네이버·카톡을 부르지 않는다). 그래서 실시간이 아니고, 결과마다
// 기준 시각(주문 동기화 시각 · 방의 마지막 수집 시각)을 싣는다. 밖으로 나가는 모양과 가림은
// `read-projections.ts` 가 정한다 — 여기서 행을 그대로 넘기지 않는다.
// ---------------------------------------------------------------------------

/** `get_store_status` 의 `since` 를 비웠을 때 보는 기간(일). */
export const STORE_STATUS_DEFAULT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * 화이트리스트 = 카톡 자동 수집(katok)이 실제로 훑는 방. 러너 게이트
 * (`ChatRoomMappingRepository.listWithCursors`)와 같은 조건이다 — 수집이 꺼진 방(excluded)·직원
 * txt 업로드 방(KAKAO_TXT 네임스페이스)은 여기 들지 않는다.
 */
const WORK_RECORD_SOURCE = "KAKAO";
const WORK_RECORD_COLLECTOR = "KATOK_AUTO";
const MAX_WORK_RECORD_ROOMS = 200;

/**
 * 네이버 스토어 전체의 신규·발송대기·배송중 건수와 진행 중 취소·반품·교환.
 *
 * - 건수: 스냅샷의 일별 카운트 칸(`findRangeCounts`) 합 — orders 블롭을 읽지 않는다(P7 egress 계약).
 *   신규 = 결제완료·발주 전(`countStatuses` 의 newOrdersCount), 발송대기 = DISPATCH_WAIT.
 * - 클레임: 주문 관리 「반품/교환」과 같은 소스·같은 파생(`loadClaimSourceOrders` → `deriveClaims`),
 *   진행 중 = `!isCompleted`. 캠페인 귀속은 하지 않는다(워커 role 은 OrderCampaign 을 못 읽고, 스토어
 *   전체 질문에는 필요 없다).
 * - 창: 스냅샷 날짜(KST 주문일) 기준 `since` ~ 오늘. 스냅샷은 30일만 남으므로 그보다 앞은 30일로 당기고
 *   `clamped` 로 알린다.
 */
async function storeStatus(input: StoreStatusInput, now: Date): Promise<OperationOutcome> {
  const claimsLimit = input.claimsLimit ?? DEFAULT_STORE_STATUS_CLAIMS;
  const requestedSince = input.since
    ? new Date(input.since)
    : new Date(now.getTime() - STORE_STATUS_DEFAULT_DAYS * DAY_MS);
  if (requestedSince.getTime() > now.getTime()) {
    return failure("INVALID_INPUT", "since must not be in the future");
  }
  const claimWindow = resolveClaimWindowKeys(now);
  const requestedStartKey = toDateKeyKst(requestedSince);
  const clamped = requestedStartKey < claimWindow.startDateKey;
  const startKey = clamped ? claimWindow.startDateKey : requestedStartKey;
  const endKey = claimWindow.endDateKey;

  const [countRows, claimOrders, syncMeta, lastChangeSyncMs] = await Promise.all([
    naverOrderSnapshotRepository.findRangeCounts(startKey, endKey),
    loadClaimSourceOrders(startKey, endKey, "agent-worker-store-status"),
    naverOrderSnapshotRepository.latestSyncMeta(),
    getLastChangeSyncMs(),
  ]);

  const orders = countRows.reduce(
    (acc, row) => ({
      ordersCount: acc.ordersCount + row.ordersCount,
      newOrders: acc.newOrders + row.newOrdersCount,
      awaitingShipment: acc.awaitingShipment + row.preparingCount,
      delivering: acc.delivering + row.deliveringCount,
    }),
    { ordersCount: 0, newOrders: 0, awaitingShipment: 0, delivering: 0 },
  );
  const claims = deriveClaims(claimOrders);
  const claimCounts = countClaimsByType(claims);
  const openTotal = claimCounts.CANCEL.open + claimCounts.RETURN.open + claimCounts.EXCHANGE.open;
  const listed = selectOpenClaims(claims, claimsLimit, collectKnownNamesByOrder(claimOrders));
  // 주문 관리 툴바 「마지막 동기화」와 같은 값(변경피드 커서 우선, 없으면 마지막 호출 시각).
  const syncedAt = resolveLastOrderSyncIso(lastChangeSyncMs, syncMeta?.lastCallTime ?? null);
  const latestSnapshotDate = countRows.length > 0 ? countRows[countRows.length - 1].snapshotDate : null;

  const { summary } = buildBoundedSummary(
    (shown) =>
      `get_store_status window=${startKey}..${endKey}${clamped ? " clamped=true" : ""} syncedAt=${syncedAt ?? "unknown"} realtime=false snapshotDays=${countRows.length} newOrders=${orders.newOrders} awaitingShipment=${orders.awaitingShipment} delivering=${orders.delivering} openCancel=${claimCounts.CANCEL.open} openReturn=${claimCounts.RETURN.open} openExchange=${claimCounts.EXCHANGE.open} claimsShown=${shown}/${openTotal}`,
    listed.map(formatStoreClaimLine),
  );
  return {
    status: "SUCCEEDED",
    summary: boundSummary(summary),
    evidenceRefs: boundEvidence([startKey, endKey]),
    actionProposalId: null,
    record: {
      title: `스토어 현황 ${startKey}~${endKey}`,
      resultSummary: boundSummary(summary),
      structuredResult: {
        window: { startKey, endKey, clamped },
        freshness: { syncedAt, latestSnapshotDate, realtime: false },
        orders,
        claims: { counts: claimCounts, openTotal, items: listed },
      },
      dataSources: ["NaverOrderSnapshot"],
      query: { since: input.since ?? null, claimsLimit },
    },
  };
}

/**
 * 수집 중(화이트리스트)인 카톡 방 목록.
 *
 * ⛔ `roomName` 은 싣지 않는다 — 카톡 방 이름은 사람이 붙인 글이고, 1:1 방은 대개 상대의 이름이다.
 *    방을 가리키는 표지는 매핑된 거래처·셀러의 이름(셀러는 별칭 우선 — P2)으로 대신한다. 그 둘은 이
 *    워커가 이미 다른 조회(`search_partners`·`get_settlement_report`)로 내보내는 값이다.
 *    DB 권한도 같은 결이다 — 워커 role 에는 `roomName` 칸의 SELECT 가 없다(20261009150000 마이그레이션).
 */
async function listWorkRecordRooms(): Promise<OperationOutcome> {
  const prisma = getPrisma();
  const rows = await prisma.chatRoomMapping.findMany({
    where: { source: WORK_RECORD_SOURCE, collectorType: WORK_RECORD_COLLECTOR, excluded: false },
    select: { roomKey: true, roomType: true, entityType: true, entityId: true, campaignId: true, lastSyncedAt: true },
    orderBy: { roomKey: "asc" },
    take: MAX_WORK_RECORD_ROOMS + 1,
  });
  const rowLimitReached = rows.length > MAX_WORK_RECORD_ROOMS;
  const rooms = rows.slice(0, MAX_WORK_RECORD_ROOMS);
  const idsOf = (type: string) =>
    Array.from(new Set(rooms.filter((room) => room.entityType === type && room.entityId).map((room) => room.entityId as string)));
  const partnerIds = idsOf("PARTNER");
  const sellerIds = idsOf("SELLER");
  const [partners, sellers] = await Promise.all([
    partnerIds.length > 0
      ? prisma.partner.findMany({ where: { id: { in: partnerIds } }, select: { id: true, name: true } })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    sellerIds.length > 0
      ? prisma.seller.findMany({ where: { id: { in: sellerIds } }, select: { id: true, name: true, alias: true } })
      : Promise.resolve([] as Array<{ id: string; name: string; alias: string | null }>),
  ]);
  const labels = new Map<string, string>();
  for (const partner of partners) labels.set(`PARTNER:${partner.id}`, partner.name);
  for (const seller of sellers) labels.set(`SELLER:${seller.id}`, seller.alias?.trim() || seller.name);

  const items = rooms.map((room) => {
    const label = room.entityType && room.entityId ? labels.get(`${room.entityType}:${room.entityId}`) : undefined;
    return {
      roomKey: room.roomKey,
      roomType: room.roomType,
      entityType: room.entityType,
      entityId: room.entityId,
      entityLabel: label ? flattenLineBreaks(label) : null,
      campaignId: room.campaignId,
      lastCollectedAt: room.lastSyncedAt?.toISOString() ?? null,
    };
  });
  const lines = items.map((item) => {
    const entity = item.entityType
      ? `${item.entityType} ${item.entityLabel ?? "(이름 없음)"} id=${item.entityId ?? ""}`
      : "미매핑";
    return `${item.roomKey} [${item.roomType ?? "?"}] ${entity} lastCollected=${item.lastCollectedAt ?? "none"}`;
  });
  const { summary } = buildBoundedSummary(
    (shown) =>
      `list_work_record_rooms: ${items.length} room(s)${rowLimitReached ? ` (truncated at ${MAX_WORK_RECORD_ROOMS})` : ""} shown=${shown}`,
    lines,
  );
  return {
    status: "SUCCEEDED",
    summary: boundSummary(summary),
    evidenceRefs: boundEvidence(items.map((item) => item.roomKey)),
    actionProposalId: null,
    record: {
      title: `카톡 수집 방 ${items.length}개`,
      resultSummary: boundSummary(summary),
      structuredResult: { items, rowLimitReached },
      dataSources: ["ChatRoomMapping", "Partner", "Seller"],
      query: {},
    },
  };
}

/**
 * 화이트리스트 방 하나의 업무기록을 보낸 시각 순으로. 요약은 Muse(봇)가 한다 — 여기는 원문 줄만.
 *
 * ⛔ 화이트리스트 밖(없는 방·수집이 꺼진 방·txt 방)은 **같은 답**으로 거부한다. 다르게 답하면 방
 *    번호를 넣어 보는 것만으로 등록 여부를 알아낼 수 있다.
 * 🔎 넘침은 두 겹이다: 행 상한(`limit`)과 본문 상한(30k 글자 · 결재함 64KB 아래). 넘치면 다음
 *    조회의 시작점 `nextSince`(싣지 못한 첫 기록의 시각, `since` 는 포함 비교)를 준다. 요약 글은
 *    2,000자라 그보다 더 일찍 끊기며, 머리 줄의 `nextSince` 는 **요약에 안 들어간** 첫 기록이다.
 */
async function getWorkRecords(input: WorkRecordsInput, now: Date): Promise<OperationOutcome> {
  const prisma = getPrisma();
  const mapping = await prisma.chatRoomMapping.findUnique({
    where: { source_roomKey: { source: WORK_RECORD_SOURCE, roomKey: input.roomKey } },
    select: { roomKey: true, collectorType: true, excluded: true, lastSyncedAt: true },
  });
  if (!mapping || mapping.collectorType !== WORK_RECORD_COLLECTOR || mapping.excluded) {
    return failure("ROOM_NOT_WHITELISTED", "room is not an active whitelisted room");
  }

  const limit = input.limit ?? DEFAULT_WORK_RECORDS_LIMIT;
  const since = new Date(input.since);
  const until = input.until ? new Date(input.until) : now;
  const rows = await prisma.workRecord.findMany({
    where: { source: WORK_RECORD_SOURCE, roomKey: mapping.roomKey, sentAt: { gte: since, lte: until } },
    select: {
      sentAt: true,
      sender: true,
      rawText: true,
      isMasked: true,
      entityType: true,
      entityId: true,
      campaignId: true,
    },
    orderBy: [{ sentAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const rowLimitReached = rows.length > limit;
  const views = rows.slice(0, limit).map(toWorkRecordView);
  const bounded = boundWorkRecords(views);
  const records = bounded.records;
  const nextSince =
    records.length < views.length
      ? views[records.length].sentAt
      : rowLimitReached
        ? rows[limit].sentAt.toISOString()
        : null;
  const collectedThrough = mapping.lastSyncedAt?.toISOString() ?? null;
  const remaskedCount = records.filter((record) => record.remasked).length;

  const { summary } = buildBoundedSummary((shown) => {
    const summaryNext = shown < records.length ? records[shown].sentAt : nextSince;
    return `get_work_records room=${mapping.roomKey} window=${since.toISOString()}..${until.toISOString()} collectedThrough=${collectedThrough ?? "unknown"} realtime=false records=${records.length} shown=${shown} more=${summaryNext !== null} nextSince=${summaryNext ?? "none"}`;
  }, records.map(formatWorkRecordLine));
  return {
    status: "SUCCEEDED",
    summary: boundSummary(summary),
    evidenceRefs: boundEvidence([mapping.roomKey]),
    actionProposalId: null,
    record: {
      title: `카톡 업무기록 ${mapping.roomKey} ${records.length}건`,
      resultSummary: boundSummary(summary),
      structuredResult: {
        roomKey: mapping.roomKey,
        window: { since: since.toISOString(), until: until.toISOString() },
        freshness: { collectedThrough, realtime: false },
        records,
        rowLimitReached,
        textCapReached: bounded.textCapReached,
        truncated: nextSince !== null,
        nextSince,
        totalTextChars: bounded.totalTextChars,
        remaskedCount,
      },
      dataSources: ["ChatRoomMapping", "WorkRecord"],
      query: { roomKey: mapping.roomKey, since: input.since, until: input.until ?? null, limit },
    },
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
  create_partner: createPartnerTool,
  create_deal: createDealTool,
  update_settlement_amount: updateSettlementAmountTool,
} as const;

async function targetExists(entityType: string, entityId: string, client: ProposalTx): Promise<boolean> {
  const where = { where: { id: entityId }, select: { id: true } } as const;
  switch (entityType) {
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

/**
 * 생성 액션(create_partner, 거래처를 동봉한 create_deal)은 가리킬 대상이 애초에 없다 —
 * **둘 다 null 일 때만** 존재 검사를 건너뛴다. 한쪽만 null 인 의도는 대상을 지목해 놓고
 * 찾을 수 없는 것과 같으므로 기존 세 액션과 똑같이 막는다.
 */
async function targetResolves(intent: WriteIntent, client: ProposalTx): Promise<boolean> {
  const { targetEntityType, targetEntityId } = intent;
  if (targetEntityType === null && targetEntityId === null) return true;
  if (targetEntityType === null || targetEntityId === null) return false;
  return targetExists(targetEntityType, targetEntityId, client);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExecutionAbortedError();
}

/**
 * 기안의 출처 칸(`ActionProposal.sourceRef`). 작업에 슬랙 위치가 있을 때만 만든다 — 없으면
 * 칸을 아예 넘기지 않아 DB 기본값 NULL 로 남는다(출처 없는 기안은 지금과 같다).
 * 계약이 이미 `.strict()` 로 모양을 검사했지만 네 칸만 골라 **새 객체로** 옮긴다 — 받은 객체를
 * 그대로 넘기면 계약이 넓어질 때 그 칸이 검토 없이 DB 까지 따라 들어간다.
 */
function proposalSourceRef(
  origin: AgentJobPayload["origin"],
): { sourceRef: Prisma.InputJsonValue } | Record<string, never> {
  if (!origin.slack) return {};
  const { channelId, threadTs, messageTs, rid } = origin.slack;
  return { sourceRef: { slack: { channelId, threadTs, messageTs, rid } } };
}

async function createActionProposal(
  input: CreateActionProposalInput,
  { signal, origin }: OperationContext,
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
    if (!(await targetResolves(intent, tx))) return null;
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
        ...proposalSourceRef(origin),
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

/** Exact registry — the only dispatch surface for the operations the contract declares. */
export const OPERATION_REGISTRY: Record<AgentJobPayload["operation"], OperationHandler> = {
  search_deals: (input) => searchDeals(input as SearchDealsInput),
  get_pipeline_status: () => pipelineStatus(),
  get_order_snapshot: (input, context) => orderSnapshot(input as OrderSnapshotInput, context.now),
  get_campaign_financials: (input) => campaignFinancials(input as CampaignFinancialsInput),
  create_action_proposal: (input, context) => createActionProposal(input as CreateActionProposalInput, context),
  search_partners: (input) => searchPartners(input as SearchPartnersInput),
  get_action_proposal: (input) => getActionProposal(input as GetActionProposalInput),
  get_settlement_report: (input) => settlementReport(input as SettlementReportInput),
  get_store_status: (input, context) => storeStatus(input as StoreStatusInput, context.now),
  list_work_record_rooms: () => listWorkRecordRooms(),
  get_work_records: (input, context) => getWorkRecords(input as WorkRecordsInput, context.now),
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

function externalExecutor(
  job: AgentJobRecord,
  route: AgentJobRoute,
  escalationReason: string,
  errorClass: string | null = null,
): ExecutionOutcome {
  return {
    kind: "terminal",
    toStatus: "NEEDS_EXTERNAL_EXECUTOR",
    route,
    model: NO_MODEL_INVOKED,
    escalationReason,
    errorClass,
    result: buildResult(job, route, NO_MODEL_INVOKED, {
      status: "NEEDS_EXTERNAL_EXECUTOR",
      validationResult: "not_validated",
      resultSummary: boundSummary(`external executor required (route=${route}, reason=${escalationReason})`),
      actionProposalId: null,
      evidenceRefs: [],
    }),
  };
}

/**
 * Router transport failure (timeout / non-zero exit / spawn failure): the job ends
 * `NEEDS_EXTERNAL_EXECUTOR` carrying the failure class. There is deliberately no
 * local, python, or inferred-route fallback (plan Task 7, ruling 24).
 */
function routerUnavailable(job: AgentJobRecord, errorClass: RouterUnavailableClass): ExecutionOutcome {
  return externalExecutor(job, ROUTER_UNAVAILABLE_ROUTE, errorClass.toLowerCase(), errorClass);
}

export async function executeAgentJob(
  job: AgentJobRecord,
  deps: ExecutionDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<ExecutionOutcome> {
  const now = deps.now ?? (() => new Date());
  const decision = await deps.decideRoute(job.payload);
  if (decision.status === "ROUTER_UNAVAILABLE") {
    return routerUnavailable(job, decision.errorClass);
  }
  if (decision.status !== "ACCEPTED") {
    // Output the Task 4 parser rejects (malformed, unknown route, wrong mode, …) is a
    // security failure, not an outage: durable FAILED_SECURITY, no escalation (Sol ruling 5).
    return { kind: "security", errorClass: "ROUTER_OUTPUT_REJECTED" };
  }

  switch (decision.route) {
    case "gpt_luna":
    case "director":
      return externalExecutor(job, decision.route, decision.reason);
    case "local":
      // Contract 7: local runs only after owner promotion + validator + threshold.
      // Nothing is promoted in this scope, so the route fails closed.
      return externalExecutor(job, decision.route, "local_route_not_active");
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
    outcome = await OPERATION_REGISTRY[job.payload.operation](job.payload.input, {
      now: now(),
      signal,
      origin: job.payload.origin,
    });
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
  // §3-A: 읽기 성공은 결재함 READ 산출물로 남긴다. 조회(READ) 자체는 멱등이지만 이 기록의
  // INSERT 는 아니다 — 커밋이 끝난 뒤 응답이 유실되면 재시도가 같은 조회를 한 번 더 기록해
  // 카드가 중복될 수 있다. 그래도 재시도를 허용하는 이유는 조회가 값싸고, 오너 입장에서는
  // "전체 보기" 링크가 조용히 빠진 답보다는 중복 카드가 낫기 때문이다. 중복이 생기면
  // structuredResult.jobId 로 같은 작업이 남긴 카드임을 식별할 수 있다.
  let actionProposalId = outcome.actionProposalId;
  if (outcome.status === "SUCCEEDED" && outcome.record) {
    try {
      assertNotAborted(signal);
      actionProposalId = await recordReadResult(job.payload.operation, outcome.record, now(), { jobId: job.id });
    } catch (error) {
      if (error instanceof ExecutionAbortedError) throw error;
      return { kind: "retryable", errorClass: error instanceof Error ? error.name : "UnknownError", route, model };
    }
  }
  const result = buildResult(job, route, model, {
    status: outcome.status,
    validationResult: "pass",
    resultSummary: outcome.summary,
    actionProposalId,
    evidenceRefs: outcome.evidenceRefs,
  });
  if (route !== "local_shadow" || outcome.status !== "SUCCEEDED") {
    return { kind: "terminal", toStatus: outcome.status, route, model, escalationReason: null, errorClass: null, result };
  }

  // local_shadow: the canonical result above is final and unchanged. The local
  // model runs only now, only for a registered validator, and only its verdict is
  // kept for the audit line. NEEDS_APPROVAL (proposal insert) is not shadowed.
  const shadow = deps.shadow
    ? await runLocalShadow({ payload: job.payload, decision, canonical: result, deps: deps.shadow, signal })
    : ({ status: "skipped", reason: "validator_missing" } as const);
  const audit = shadowAuditFields(shadow);
  return {
    kind: "terminal",
    toStatus: outcome.status,
    route,
    // Audit-only truth (re-review LOW-1): the local model was actually invoked on
    // validated/errored shadows; `result.modelUsed` stays `none` (registry made the result).
    model: shadow.status === "skipped" ? model : decision.model,
    escalationReason: audit.escalationReason,
    errorClass: audit.errorClass,
    shadow: { validationResult: audit.validationResult, correction: audit.correction },
    result,
  };
}

// ---------------------------------------------------------------------------
// Router invocation — fixed argv, shell=false, stdout parsed by Task 4's parser.
// ---------------------------------------------------------------------------

export const DEFAULT_ROUTER_SCRIPT_PATH = path.join(homedir(), ".gemini", "bin", "local-llm-route.py");
/** Absolute so a minimal launchd PATH cannot change which interpreter runs (review LOW-4). */
export const DEFAULT_ROUTER_PYTHON = "/usr/bin/python3";
/**
 * Pinned router spawn budget. `decide` is a config read plus a table lookup
 * (measured well under 1 s); 15 s leaves room for a cold interpreter on a loaded
 * host while staying far inside the 120 s lease. On expiry the child is killed and
 * the job ends NEEDS_EXTERNAL_EXECUTOR (`router_timeout`).
 */
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

/**
 * `--validator` is passed only when this worker holds a validator for the skill;
 * the script then still requires `validator_skills` membership before it may
 * answer `local_shadow` (registry semantics live in the script, not here).
 */
export function buildRouterArgv(
  payload: AgentJobPayload,
  scriptPath: string,
  pythonPath: string,
  validators?: ShadowValidatorRegistry,
): { file: string; args: string[] } {
  const args = [scriptPath, "decide", "--task-type", payload.taskType, "--skill", payload.skill];
  if (validators && hasShadowValidator(validators, payload.skill)) args.push("--validator");
  return { file: pythonPath, args };
}

/** Node's execFile error shape: `killed` on timeout, numeric `code` on exit, string `code` (ENOENT…) on spawn failure. */
function classifyRouterSpawnError(error: unknown): RouterUnavailableClass {
  const failure = error as { killed?: unknown; code?: unknown } | null;
  if (failure?.killed === true) return "ROUTER_TIMEOUT";
  if (typeof failure?.code === "number") return "ROUTER_EXIT_NONZERO";
  return "ROUTER_SPAWN_FAILED";
}

export async function runRouterDecision(
  payload: AgentJobPayload,
  options: {
    scriptPath?: string;
    pythonPath?: string;
    execFile?: ExecFileLike;
    timeoutMs?: number;
    validators?: ShadowValidatorRegistry;
  } = {},
): Promise<RouterInvocationResult> {
  const argv = buildRouterArgv(
    payload,
    options.scriptPath ?? DEFAULT_ROUTER_SCRIPT_PATH,
    options.pythonPath ?? DEFAULT_ROUTER_PYTHON,
    options.validators,
  );
  let stdout: string;
  try {
    ({ stdout } = await (options.execFile ?? defaultExecFile)(argv.file, argv.args, {
      shell: false,
      timeout: options.timeoutMs ?? ROUTER_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    // A `decide` answer is ~80 bytes; stdout past `maxBuffer` is output the parser
    // must reject, not a transport failure (re-review MEDIUM-2, ruling 28).
    if ((error as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { status: "FAILED_SECURITY" };
    }
    return { status: "ROUTER_UNAVAILABLE", errorClass: classifyRouterSpawnError(error) };
  }
  return parseRouterDecision(stdout.trim());
}
