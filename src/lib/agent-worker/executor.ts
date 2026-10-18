import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { isPermissionDeniedError } from "@/lib/db-permission-denied";
import { containsSearch } from "@/lib/prisma-search";
import { DEAL_STATUSES } from "@/lib/deal-status";
import { toKstYmd } from "@/lib/date-utils";
import type { SettlementAmountField } from "@/lib/settlement-amount-fields";
import {
  aggregateCoversCampaigns,
  composeSalesDetailFromAggregates,
  parseSnapshotDailyAggregate,
  resolveLiveWindowKeys,
  type SnapshotDailyAggregate,
} from "@/lib/order-converter/daily-aggregate";
import { dealRepository } from "@/repositories/dealRepository";
import { PartnerRepository } from "@/repositories/partnerRepository";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import { getPipelineStatusTool } from "@/lib/agent/tools/pipeline-status";
import { getOrderSnapshotTool } from "@/lib/agent/tools/order-snapshot";
import { getSettlementReportTool } from "@/lib/agent/tools/settlement-report";
import { getCampaignFinancialsTool } from "@/lib/agent/tools/campaign-financials";
import { addEntityMemoTool } from "@/lib/agent/tools/add-entity-memo";
import { changeDealStatusTool } from "@/lib/agent/tools/change-deal-status";
import { confirmSettlementTool } from "@/lib/agent/tools/confirm-settlement";
import { createPartnerTool } from "@/lib/agent/tools/create-partner";
import { createDealTool } from "@/lib/agent/tools/create-deal";
import { updateSettlementAmountTool } from "@/lib/agent/tools/update-settlement-amount";
import { updateRecordTool } from "@/lib/agent/tools/update-record";
import { upsertProductMappingsTool } from "@/lib/agent/tools/upsert-product-mappings";
import type { AgentTool, ToolResult, WriteIntent } from "@/lib/agent/tools/types";
import { WRITE_ACTIONS } from "@/lib/agent/write-executor";
import {
  AGENT_WORKER_ACTOR,
  insertAgentWorkerProposal,
  snapshotProductMappingExpected,
  type UpsertProductMappingsRequestArgs,
} from "@/lib/agent/agent-worker-proposal";
import { deriveClaims } from "@/lib/order-converter/claim-derive";
import {
  CLAIM_WINDOW_DAYS,
  loadClaimSourceOrders,
  resolveClaimWindowKeys,
} from "@/lib/order-converter/claim-source-loader";
import { getLastChangeSyncMs, resolveLastOrderSyncIso } from "@/lib/order-converter/order-auto-sync";
import { toDateKeyKst } from "@/lib/mobile-pulse-data";
import { naverOrderSnapshotRepository } from "@/repositories/naverOrderSnapshotRepository";
import { toKstYearMonth } from "@/lib/campaign-invoices";
import { AUTO_CONFIRM_SEED_LOOKBACK_DAYS } from "@/lib/tax-filing-auto-confirm";
import { loadTaxInvoiceAutoConfirmed, loadTaxInvoiceWorkBoard } from "@/lib/tax-invoice-board-data";
import {
  AgentJobResultSchema,
  DEFAULT_STORE_STATUS_CLAIMS,
  DEFAULT_WORK_RECORDS_LIMIT,
  MAX_EVIDENCE_REFS,
  ROOM_KEY_PATTERN,
  MAX_AGENT_JOB_JSON_BYTES,
  MAX_RESULT_SUMMARY_CHARS,
  MAX_STRUCTURED_DATA_BYTES,
  sameOrderCampaignName,
  upsertProductMappingsRequestArgsSchema,
  type AgentJobPayload,
  type AgentJobResult,
  type AgentJobRoute,
  type AgentJobStructuredData,
} from "./contracts";
import { MAX_READ_RESULT_BYTES, recordReadResult, type ReadResultRecord } from "./read-result-record";
import {
  boundWorkRecords,
  assignSpeakerAliases,
  buildBoundedSummary,
  collectKnownNamesByOrder,
  countClaimsByType,
  flattenLineBreaks,
  formatStoreClaimLine,
  formatWorkRecordLine,
  selectOpenClaims,
  toWorkRecordView,
} from "./read-projections";
import {
  buildTaxInvoiceStatus,
  ISSUE_CONFIRM_JOB_KEY,
  toIssueConfirmRunView,
  toTaxInvoiceAutoConfirmedViews,
  toTaxInvoicePendingViews,
} from "./tax-invoice-status";
import {
  buildOrderCampaignMappingsRecordPayload,
  buildOrderCampaignMappingsStructuredData,
  buildOrderCampaignMappingsSummary,
  readOrderCampaignMappings,
} from "./order-campaign-mappings";
import { parseRouterDecision, type RouterDecisionParseResult } from "./router";
import { callAgentInternalApi } from "./internal-api-client";
import {
  AGENT_INTERNAL_PATHS,
  applyProductMappingsResponseSchema,
  storeProductOptionsResponseSchema,
} from "@/lib/agent-internal/api-contract";
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
 *   ChatRoomMapping and WorkRecord; for the tax-invoice status read also
 *   CampaignSettlementItem, CampaignInvoice and — column- and row-limited — ActivityLog
 *   and SystemTaskLog; for the order-campaign mapping read — column-limited —
 *   OrderCampaign and ProductMapping) by reusing existing pure calculations over narrow
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
  /**
   * 봇이 읽는 구조화 결과(`AgentJobResult.structuredData`, get_order_campaign_mappings 만). 바이트 예산을 받아
   * 그 안에 맞춘 값을 돌려준다 — 예산은 실행기가 결과 전체 상한(`MAX_AGENT_JOB_JSON_BYTES`)의 남은 자리로 정한다.
   */
  structuredData?: (maxBytes: number) => AgentJobStructuredData | null;
};
type OperationFailure = {
  status: "FAILED_FINAL";
  errorClass: string;
  summary: string;
  /**
   * 봇이 받는 결과 요약(`… failed: <errorClass>`) 뒤에 괄호로 붙일 한 문장. 같은 실패 코드 안에서 봇이 다음
   * 행동을 갈라야 할 때만 싣는다(예: 주문캠페인 이름 불일치 — 다시 조회하면 풀린다). 없으면 요약은 그대로다.
   */
  detail?: string;
};
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
type TaxInvoiceStatusInput = { month?: string };
type OrderCampaignMappingsInput = { orderCampaignId?: string; query?: string };
type StoreProductOptionsInput = { orderCampaignId: string };
type ApplyProductMappingsInput = {
  orderCampaignId: string;
  mappings: Array<{ optionName: string; brandCode: string; price: number }>;
};
type ProposalScalar = string | number | boolean | null;
type ProposalNestedValue = ProposalScalar | Record<string, ProposalScalar>;
/**
 * 기안 입력 한 칸에 담길 수 있는 값 — 계약의 `jobInputValueSchema` 와 **같은 깊이 2**.
 * 스칼라만 적어 두면 계약이 허용하는 거래처 객체·옵션 배열을 타입이 부인하게 된다
 * (런타임은 zod 가 막지만, 거짓말하는 타입은 다음 사람이 캐스트로 뚫는다).
 */
type ProposalArgValue = ProposalNestedValue | ProposalNestedValue[];
type CreateActionProposalInput = { action: string } & Record<string, ProposalArgValue>;

const ACTOR = AGENT_WORKER_ACTOR;
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

function failure(errorClass: string, summary: string, detail?: string): OperationFailure {
  return detail === undefined
    ? { status: "FAILED_FINAL", errorClass, summary }
    : { status: "FAILED_FINAL", errorClass, summary, detail };
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
      title: `판매 조건 검색 ${items.length}건`,
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
 * 캠페인 손익 조회 — 웹 어시스턴트 도구(`getCampaignFinancialsTool`)를 `runTool` 로 그대로 재사용한다.
 * 저장값만 내는 규칙(재계산 금지·null ≠ 0·영업이익 폴백)과 조회 칸(워커 role GRANT 범위 안)은
 * 그 도구 한 곳에 있다 — 여기서 prisma 를 따로 조회하거나 칸을 다시 고르지 말 것(같은 판정의 두 번째
 * 사본이 다시 어긋난다).
 */
async function campaignFinancials(input: CampaignFinancialsInput): Promise<OperationOutcome> {
  const result = await runTool(getCampaignFinancialsTool, input);
  if (isOperationFailure(result)) return result;
  if (!result.ok) return toolFailure(result);
  const data = result.data;

  // 줄 순서가 곧 우선순위다 — 슬랙 쪽(hermes)은 요약을 한 줄 ~200자로 접으며 첫 줄을 늘 싣고,
  // 뒤 줄은 들어가는 만큼만 싣되 빠진 줄 수를 적는다. 그래서 정산 금액 수정에서 가장 자주
  // 대조하는 칸을 첫 줄에, 식별·플래그·안내를 뒤에 둔다. 값 표기는 `field=값`(필드 키 그대로 —
  // 기안의 `field` 인자와 같은 글자), 빈 칸은 `null`(0 과 다르다).
  const amountText = (field: SettlementAmountField) => `${field}=${data[field] ?? "null"}`;
  const summary = boundSummary(
    [
      `stored ${amountText("settlementSales")} ${amountText("sellerExpense")} ${amountText("taxExpense")}`,
      `operatingProfit=${data.operatingProfit}(${data.operatingProfitSource}) ${amountText("operatingExpense")} ${amountText("miscExpense")}`,
      `${amountText("actualSales")} ${amountText("settlementSupplyCost")} ${amountText("settlementGoodsCost")}`,
      `campaign=${data.campaignId} deal=${data.dealName ?? ""} seller=${data.sellerName ?? ""} status=${data.status} deposit=${data.isDepositReceived} payout=${data.isPayoutCompleted}`,
      `manual: settlementSales=${data.isManualSettlementSales} sellerExpense=${data.isManualSellerExpense} taxExpense=${data.isManualTaxExpense} sellerFeeBasisOverride=${data.sellerFeeBasisOverride ?? "null"}`,
      "note: saved values = what update_settlement_amount compares as expectedCurrentKrw; null=empty (not 0); not recomputed",
    ].join("\n"),
  );
  return {
    status: "SUCCEEDED",
    summary,
    evidenceRefs: boundEvidence([data.campaignId]),
    actionProposalId: null,
    record: {
      title: `캠페인 재무 ${data.dealName ?? ""} / ${data.sellerName ?? ""}`,
      resultSummary: summary,
      // 결재함 카드(`tool-result-views.tsx`)가 이 모양(`GetCampaignFinancialsStoredData`)을 읽는다.
      structuredResult: data,
      dataSources: result.evidence.dataSources,
      query: result.evidence.query,
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
 * - 창이 둘이다. 클레임은 **언제나** 주문 관리 「반품/교환」과 같은 30일 창(`resolveClaimWindowKeys`) —
 *   클레임은 주문일 스냅샷에 실리므로, 창을 좁히면 오래된 주문에 새로 들어온 반품이 빠진다.
 *   `since` 는 주문 건수의 창(스냅샷 KST 주문일 `since` ~ 오늘)에만 걸리고, 비우면 같은 30일이다.
 *   스냅샷은 30일만 남으므로 그보다 앞은 30일로 당기고 `clamped` 로 알린다.
 */
async function storeStatus(input: StoreStatusInput, now: Date): Promise<OperationOutcome> {
  const claimsLimit = input.claimsLimit ?? DEFAULT_STORE_STATUS_CLAIMS;
  const requestedSince = input.since
    ? new Date(input.since)
    : new Date(now.getTime() - CLAIM_WINDOW_DAYS * DAY_MS);
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
    loadClaimSourceOrders(claimWindow.startDateKey, claimWindow.endDateKey, "agent-worker-store-status"),
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
      `get_store_status ordersWindow=${startKey}..${endKey}${clamped ? " clamped=true" : ""} claimsWindow=${claimWindow.startDateKey}..${claimWindow.endDateKey} syncedAt=${syncedAt ?? "unknown"} realtime=false snapshotDays=${countRows.length} newOrders=${orders.newOrders} awaitingShipment=${orders.awaitingShipment} delivering=${orders.delivering} openCancel=${claimCounts.CANCEL.open} openReturn=${claimCounts.RETURN.open} openExchange=${claimCounts.EXCHANGE.open} claimsShown=${shown}/${openTotal}`,
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
        window: {
          orders: { startKey, endKey, clamped },
          claims: { startKey: claimWindow.startDateKey, endKey: claimWindow.endDateKey },
        },
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
  // 계약의 방 키 규칙에 맞지 않는 행은 내보내지 않는다 — 그 키로는 `get_work_records` 를 부를 수도 없고,
  // 요약 줄에 그대로 끼우면 줄바꿈 등으로 머리 줄을 흉내낼 수 있다.
  const rooms = rows.slice(0, MAX_WORK_RECORD_ROOMS).filter((room) => ROOM_KEY_PATTERN.test(room.roomKey));
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
      roomType: room.roomType === null ? null : flattenLineBreaks(room.roomType),
      entityType: room.entityType === null ? null : flattenLineBreaks(room.entityType),
      entityId: room.entityId === null ? null : flattenLineBreaks(room.entityId),
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
  // 요약 글(슬랙·Muse 행)은 화자 번호로, 결재함 기록(records[].sender)은 진짜 보낸 사람으로.
  const speakerAliases = assignSpeakerAliases(records);

  const { summary } = buildBoundedSummary((shown) => {
    const summaryNext = shown < records.length ? records[shown].sentAt : nextSince;
    return `get_work_records room=${flattenLineBreaks(mapping.roomKey)} speakers=pseudonymized window=${since.toISOString()}..${until.toISOString()} collectedThrough=${collectedThrough ?? "unknown"} realtime=false records=${records.length} shown=${shown} more=${summaryNext !== null} nextSince=${summaryNext ?? "none"}`;
  }, records.map((record) => formatWorkRecordLine(record, speakerAliases)));
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
// get_tax_invoice_status (2026-10-14) — 세금계산서 발행 대조 현황 읽기
// ---------------------------------------------------------------------------

/**
 * 오너가 정산 「세무 처리」 보드와 시스템 레이더에서 보는 그림을 봇에게 그대로 준다.
 *
 * - lastRun: 발행 자동 확정 크론의 마지막 `SystemTaskLog`(이 잡의 줄만 — DB 정책도 같은 선이다).
 * - pending · autoConfirmed: 오너 화면과 **같은 함수**(`@/lib/tax-invoice-board-data`)로 만든다 —
 *   의무 판정을 여기서 다시 쓰지 않는다. 보드 라우트가 덧붙이는 원천징수 경고(지급일 미기록 등)는
 *   지급월 축이라 싣지 않는다.
 * - 밖으로 나가는 칸은 `tax-invoice-status.ts` 가 정한다(사업자번호·대표자·연락처·승인번호 없음).
 */
async function taxInvoiceStatus(input: TaxInvoiceStatusInput, now: Date): Promise<OperationOutcome> {
  const prisma = getPrisma();
  const month = input.month ?? toKstYearMonth(now);
  const [lastRunRow, boardData] = await Promise.all([
    prisma.systemTaskLog.findFirst({
      where: { jobKey: ISSUE_CONFIRM_JOB_KEY },
      orderBy: { createdAt: "desc" },
      select: { status: true, details: true, createdAt: true },
    }),
    loadTaxInvoiceWorkBoard(prisma, month),
  ]);
  const autoConfirmed = await loadTaxInvoiceAutoConfirmed(prisma, boardData.campaignRows, now);
  const { summary, structuredResult, evidenceCampaignIds } = buildTaxInvoiceStatus({
    month,
    lastRun: toIssueConfirmRunView(lastRunRow, now),
    board: boardData.board,
    pending: toTaxInvoicePendingViews(boardData.board.rows, boardData.campaignRows),
    autoConfirmed: toTaxInvoiceAutoConfirmedViews(autoConfirmed),
    autoConfirmWindowDays: AUTO_CONFIRM_SEED_LOOKBACK_DAYS,
  });
  return {
    status: "SUCCEEDED",
    summary: boundSummary(summary),
    evidenceRefs: boundEvidence(evidenceCampaignIds),
    actionProposalId: null,
    record: {
      title: `세금계산서 발행 대조 ${month}`,
      resultSummary: boundSummary(summary),
      structuredResult,
      dataSources: [
        "SystemTaskLog",
        "SalesCampaign",
        "Deal",
        "Partner",
        "Seller",
        "CampaignGroup",
        "CampaignSettlementItem",
        "CampaignInvoice",
        "ActivityLog",
      ],
      query: { month: input.month ?? null },
    },
  };
}

// ---------------------------------------------------------------------------
// get_order_campaign_mappings (2026-10-15) — 주문캠페인과 그 상품 매핑 읽기
// ---------------------------------------------------------------------------

/**
 * 봇이 매핑 변경 기안을 올리기 전에 지금 값을 본다. 읽기·내보낼 칸은 `order-campaign-mappings.ts` 가
 * 정한다(칸 단위 GRANT 라 모든 호출이 명시 select). 없는 id 는 오류가 아니라 0건이다.
 */
async function orderCampaignMappings(input: OrderCampaignMappingsInput, now: Date): Promise<OperationOutcome> {
  const result = await readOrderCampaignMappings(input, getPrisma(), now);
  const { summary, mappingCount } = buildOrderCampaignMappingsSummary(result);
  return {
    status: "SUCCEEDED",
    summary: boundSummary(summary),
    evidenceRefs: boundEvidence(result.campaigns.map((campaign) => campaign.id)),
    actionProposalId: null,
    structuredData: (maxBytes) => buildOrderCampaignMappingsStructuredData(result, maxBytes),
    record: {
      title: `주문캠페인 ${result.campaigns.length}건 · 매핑 ${mappingCount}줄`,
      resultSummary: boundSummary(summary),
      // 기록 상한(64KB)을 넘으면 기록 모듈이 표 전체를 마커로 바꾼다 — 스토어 옵션부터 덜어 매핑 표를 남긴다.
      structuredResult: buildOrderCampaignMappingsRecordPayload(result, MAX_READ_RESULT_BYTES) ?? result,
      dataSources: ["OrderCampaign", "ProductMapping", "SalesCampaign", "NaverOrderSnapshot"],
      query: { orderCampaignId: input.orderCampaignId ?? null, query: input.query ?? null },
    },
  };
}

/** 구조화 결과를 바이트 예산 안에서만 싣는다 — 창구가 이미 상한(12KB) 안으로 만들어 보낸다. */
function fitStructuredData<T>(data: T): (maxBytes: number) => T | null {
  return (maxBytes) => (Buffer.byteLength(JSON.stringify(data), "utf8") <= maxBytes ? data : null);
}

/**
 * 주문캠페인의 네이버 등록 옵션 + 지금 매핑 값(2026-10-16). 실행 주체는 CRM 앱의 봇 내부 창구다 — 이 실행기는
 * 네이버 열쇠가 없다(`internal-api-client.ts`). 창구 실패 코드(NO_STORE_OPTIONS 등)는 그대로 실패 코드가 되고,
 * 창구 문구가 괄호 안 한 문장으로 붙는다 — 봇이 「설정 창에서 상품을 먼저 연결해 주세요」를 그대로 옮긴다.
 */
async function storeProductOptions(
  input: StoreProductOptionsInput,
  { signal }: OperationContext,
): Promise<OperationOutcome> {
  assertNotAborted(signal);
  const call = await callAgentInternalApi(
    AGENT_INTERNAL_PATHS.storeProductOptions,
    { orderCampaignId: input.orderCampaignId },
    storeProductOptionsResponseSchema,
    signal,
  );
  if (!call.ok) return failure(call.errorClass, "store options call failed", call.detail);
  if (!call.body.ok) return failure(call.body.code, "store options refused", call.body.message);
  const { data } = call.body;
  const coded = data.options.filter((option) => option.currentBrandCode !== null && option.currentBrandCode !== "").length;
  return {
    status: "SUCCEEDED",
    summary: boundSummary(
      `주문캠페인 "${data.orderCampaign.name}" 스토어 옵션 ${data.options.length}줄 · 상품코드 있는 옵션 ${coded}줄` +
        (data.mappingsNotInStore > 0 ? ` · 스토어에 없는 매핑 ${data.mappingsNotInStore}줄` : ""),
    ),
    evidenceRefs: boundEvidence([data.orderCampaign.id]),
    actionProposalId: null,
    structuredData: fitStructuredData(data),
  };
}

/**
 * 스토어 옵션 줄의 상품코드·가격 즉시 저장(2026-10-16, 오너 결정: 짝 확인 「응」 한 번 = 승인). 실행 주체는 CRM 앱의
 * 봇 내부 창구이고, 결재함에는 그 창구가 EXECUTED 기록 1건을 남긴다(`actionProposalId`).
 *
 * ⚠️ 쓰기라 연결·시간 초과도 재시도하지 않고 최종 실패로 끝낸다 — 앱이 이미 저장했는지 여기서는 모른다.
 *    다시 요청해도 안전하다: 창구는 이미 같은 값인 줄을 「그대로」로 세고 기록을 만들지 않는다.
 * ⚠️ 요청을 보낸 뒤 임대가 끊겨도(중단 신호) 앱 쪽 저장은 되돌릴 수 없다 — 보내기 직전에만 중단을 확인한다.
 */
async function applyProductMappingsOperation(
  input: ApplyProductMappingsInput,
  { signal, origin }: OperationContext,
): Promise<OperationOutcome> {
  assertNotAborted(signal);
  const call = await callAgentInternalApi(
    AGENT_INTERNAL_PATHS.applyProductMappings,
    {
      orderCampaignId: input.orderCampaignId,
      mappings: input.mappings.map(({ optionName, brandCode, price }) => ({ optionName, brandCode, price })),
      ...(origin.slack ? { slack: origin.slack } : {}),
    },
    applyProductMappingsResponseSchema,
    signal,
  );
  if (!call.ok) return failure(call.errorClass, "apply call failed", call.detail);
  if (!call.body.ok) return failure(call.body.code, "apply refused", call.body.message);
  const { data } = call.body;
  const saved = data.created + data.updated;
  return {
    status: "SUCCEEDED",
    summary: boundSummary(
      `주문캠페인 "${data.orderCampaign.name}" 상품 매핑 저장 ${saved}줄(새로 ${data.created} · 바꿈 ${data.updated}) · ` +
        `그대로 ${data.unchanged}줄 · 저장 안 함 ${data.rejected.length}줄`,
    ),
    evidenceRefs: boundEvidence([data.orderCampaign.id, data.proposalId]),
    actionProposalId: data.proposalId,
    structuredData: fitStructuredData(data),
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
  update_record: updateRecordTool,
  upsert_product_mappings: upsertProductMappingsTool,
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

/** 기안 시점 이름 대조가 어긋났을 때 봇에게 주는 한 문장 — 캠페인이 없을 때와 갈라 다시 조회하게 한다. */
const ORDER_CAMPAIGN_NAME_MISMATCH_DETAIL = "주문캠페인 이름이 지금 이름과 다릅니다. 조회로 이름을 다시 읽어 주세요.";

/** 기안 시점 확인 결과: 통과, 대상 없음, 또는 대상은 있으나 이름이 다름. */
type ProposalSubjectCheck = "RESOLVES" | "NOT_FOUND" | "NAME_MISMATCH";

/**
 * 대상 칸(`targetEntityType`)으로 가리킬 수 없는 기안의 기안 시점 확인. 상품 매핑 기안은 주문캠페인을
 * 고치지만 대상 칸이 null 이라(`targetResolves` 는 통과) 여기서 그 캠페인이 있는지, 기안이 적은 이름이
 * 지금 이름과 같은지 본다 — 없거나 다르면 기존 「대상 없음」 실패(TARGET_NOT_FOUND)로 기안을 만들지 않는다.
 * 이름만 다를 때는 결과 요약에 `ORDER_CAMPAIGN_NAME_MISMATCH_DETAIL` 을 붙여 봇이 「없음」과 가를 수 있게 한다.
 * 실행 역할은 봇 작업 역할이라 GRANT 된 칸(id·name)만 고른다(마이그레이션 20261016120000).
 */
async function orderCampaignSubjectResolves(
  args: { orderCampaignId: string; orderCampaignName: string },
  client: ProposalTx,
): Promise<ProposalSubjectCheck> {
  const campaign = await client.orderCampaign.findUnique({
    where: { id: args.orderCampaignId },
    select: { id: true, name: true },
  });
  if (campaign === null) return "NOT_FOUND";
  return sameOrderCampaignName(campaign.name, args.orderCampaignName) ? "RESOLVES" : "NAME_MISMATCH";
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExecutionAbortedError();
}

/** 기안 트랜잭션의 결과 — 만든 기안 id, 또는 만들지 않은 이유. */
type ProposalTxOutcome =
  | { kind: "CREATED"; proposalId: string; intent: WriteIntent }
  | { kind: "NOT_FOUND" }
  | { kind: "NAME_MISMATCH" }
  // 지금 값을 채울 수 없는 줄(같은 옵션 여러 줄 · 범위 밖 지금 값) — 기안을 만들지 않고 이유를 돌려준다.
  | { kind: "UNUSABLE_MAPPING"; detail: string }
  | { kind: "INTENT_FAILED"; result: Extract<ToolResult, { ok: false }> };

type IntentTool = (typeof WRITE_INTENT_TOOLS)[keyof typeof WRITE_INTENT_TOOLS];

async function buildWriteIntent(
  intentTool: IntentTool,
  args: unknown,
): Promise<{ ok: true; intent: WriteIntent } | { ok: false; result: Extract<ToolResult, { ok: false }> }> {
  const intentResult = (await intentTool.execute(args as never)) as ToolResult<{ writeIntent: WriteIntent }>;
  return intentResult.ok ? { ok: true, intent: intentResult.data.writeIntent } : { ok: false, result: intentResult };
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
  // 상품 매핑 기안은 봇 입력에 지금 값이 없다 — 봇 입력 스키마로 받고, 트랜잭션 안에서 지금 값을 채운 뒤
  // 저장 스키마(`definition.argsSchema`)로 다시 잰다. 나머지 액션은 봇 입력 = 저장 args 다.
  const snapshotsMappings = action === "upsert_product_mappings";
  const parsedArgs = (snapshotsMappings ? upsertProductMappingsRequestArgsSchema : definition.argsSchema).safeParse(args);
  if (!parsedArgs.success) {
    return failure("INVALID_INPUT", "action args failed validation");
  }
  let preparedIntent: WriteIntent | null = null;
  if (!snapshotsMappings) {
    const built = await buildWriteIntent(intentTool, parsedArgs.data);
    if (!built.ok) return toolFailure(built.result);
    preparedIntent = built.intent;
  }

  // No commit after lease loss / timeout / shutdown (review MEDIUM-2).
  assertNotAborted(signal);
  const prisma = getPrisma();
  const outcome = await prisma.$transaction(async (tx): Promise<ProposalTxOutcome> => {
    let intent: WriteIntent;
    let storedArgs: unknown = parsedArgs.data;
    if (preparedIntent !== null) {
      intent = preparedIntent;
      if (!(await targetResolves(intent, tx))) return { kind: "NOT_FOUND" };
    } else {
      const requestArgs = parsedArgs.data as UpsertProductMappingsRequestArgs;
      const subject = await orderCampaignSubjectResolves(requestArgs, tx);
      if (subject !== "RESOLVES") return { kind: subject };
      const snapshot = await snapshotProductMappingExpected(requestArgs, tx);
      if (snapshot.kind !== "READY") return { kind: "UNUSABLE_MAPPING", detail: snapshot.detail };
      storedArgs = snapshot.args;
      const built = await buildWriteIntent(intentTool, storedArgs);
      if (!built.ok) return { kind: "INTENT_FAILED", result: built.result };
      intent = built.intent;
      if (!(await targetResolves(intent, tx))) return { kind: "NOT_FOUND" };
    }
    assertNotAborted(signal);
    const proposalId = await insertAgentWorkerProposal(tx, {
      intent,
      storedArgs,
      slack: origin.slack,
      note: "agent worker 기안 상신, 관리자 승인 대기",
    });
    return { kind: "CREATED", proposalId, intent };
  });
  switch (outcome.kind) {
    case "NOT_FOUND":
      return failure("TARGET_NOT_FOUND", "proposal target does not exist");
    case "NAME_MISMATCH":
      return failure("TARGET_NOT_FOUND", "order campaign name differs from the proposal", ORDER_CAMPAIGN_NAME_MISMATCH_DETAIL);
    case "UNUSABLE_MAPPING":
      return failure("TARGET_NOT_FOUND", "current mapping value cannot be snapshotted", outcome.detail);
    case "INTENT_FAILED":
      return toolFailure(outcome.result);
    case "CREATED":
      break;
  }
  const { proposalId, intent } = outcome;

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
  get_tax_invoice_status: (input, context) => taxInvoiceStatus(input as TaxInvoiceStatusInput, context.now),
  get_order_campaign_mappings: (input, context) => orderCampaignMappings(input as OrderCampaignMappingsInput, context.now),
  get_store_product_options: (input, context) => storeProductOptions(input as StoreProductOptionsInput, context),
  apply_product_mappings: (input, context) =>
    applyProductMappingsOperation(input as unknown as ApplyProductMappingsInput, context),
};

/** 결과 JSON 에 structuredData 칸이 붙을 때 더해지는 글자(앞 쉼표 + 키 + 콜론). */
const STRUCTURED_DATA_KEY = ',"structuredData":';

function buildResult(
  job: AgentJobRecord,
  route: AgentJobRoute,
  modelUsed: string,
  fields: Pick<AgentJobResult, "status" | "validationResult" | "resultSummary" | "actionProposalId" | "evidenceRefs" | "structuredData">,
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

// 권한 거부(42501) 판정은 재사용 도구(`agent/tools/*`)도 써야 해서 중립 모듈(`@/lib/db-permission-denied`)로 옮겼다.

export const DB_PERMISSION_DENIED = "DB_PERMISSION_DENIED";

function finalFailure(
  job: AgentJobRecord,
  route: AgentJobRoute,
  model: string,
  errorClass: string,
  detail?: string,
): ExecutionOutcome {
  return {
    kind: "terminal",
    toStatus: "FAILED_FINAL",
    route,
    model,
    escalationReason: null,
    errorClass,
    result: buildResult(job, route, model, {
      status: "FAILED_FINAL",
      validationResult: "fail",
      resultSummary: boundSummary(`${job.payload.operation} failed: ${errorClass}${detail ? ` (${detail})` : ""}`),
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
    if (isPermissionDeniedError(error)) return finalFailure(job, route, model, DB_PERMISSION_DENIED);
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
    return finalFailure(job, route, model, outcome.errorClass, outcome.detail);
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
      if (isPermissionDeniedError(error)) return finalFailure(job, route, model, DB_PERMISSION_DENIED);
      return { kind: "retryable", errorClass: error instanceof Error ? error.name : "UnknownError", route, model };
    }
  }
  const baseFields = {
    status: outcome.status,
    validationResult: "pass" as const,
    resultSummary: outcome.summary,
    actionProposalId,
    evidenceRefs: outcome.evidenceRefs,
  };
  let result = buildResult(job, route, model, baseFields);
  if (outcome.structuredData) {
    // 결과 전체가 큐 상한(16KB) 안이어야 한다 — 요약(최대 2000자, 한글이면 ~6KB)이 쓰고 남은 자리와
    // MAX_STRUCTURED_DATA_BYTES 중 작은 쪽에 맞춘다. 맞출 수 없으면(null) 칸 없이 낸다.
    const remaining =
      MAX_AGENT_JOB_JSON_BYTES -
      Buffer.byteLength(JSON.stringify(result), "utf8") -
      Buffer.byteLength(STRUCTURED_DATA_KEY, "utf8");
    const structuredData = outcome.structuredData(Math.min(MAX_STRUCTURED_DATA_BYTES, remaining));
    if (structuredData) result = buildResult(job, route, model, { ...baseFields, structuredData });
  }
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
