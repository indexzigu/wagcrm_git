import { approveProposal } from "@/lib/agent/approve-proposal";
import { rejectProposal } from "@/lib/agent/reject-proposal";
import { AGENT_WORKER_ACTOR } from "@/lib/agent/agent-worker-proposal";
import type { WriteActionName } from "@/lib/agent/write-actions";
import { parseStoredJsonObject } from "@/lib/stored-json";
import { ActionProposalRepository } from "@/repositories/actionProposalRepository";
import type {
  SlackDecisionExecutedRef,
  SlackDecisionRequest,
  SlackDecisionResponse,
  SlackPreviewResponse,
} from "./api-contract";
import { buildSlackApprovalBrief, type BriefDeps } from "./slack-approval-brief";
import { SLACK_OWNER_APPROVAL_ACTOR } from "./actors";

/**
 * 슬랙 버튼 승인·반려(오너 결정 2026-11-14 「버튼 승인」) — 슬랙 카드의 [승인]·[반려] 를 웹 결재함과 같은 본체로 처리한다.
 * 누가 눌렀는지(오너 슬랙 ID 하나)는 hermes 버튼 처리기가 판정하고, 이 모듈은 **무엇을** 슬랙에서 결정해도 되는지를 판정한다:
 *  ① 봇이 올린 기안(`createdBy === AGENT_WORKER`)만 — 캘린더 수집·사람 기안은 결재함에서.
 *  ② 액션이 `SLACK_DECIDABLE_ACTIONS` 에 있을 때만. 오너 결정 2026-11-28 로 돈이 걸린 5종(정산 금액·정산 확정·기록 수정·
 *     거래처 등록·회차 생성)도 슬랙에서 바로 적용한다 — 결재함에서 한 번 더 누르는 이중 승인을 없앤다. 그 대가로 카드가
 *     결재함 표 없이도 「지금 값 → 바꿀 값」을 보여야 하므로, 카드 글은 `previewProposalForSlack`(→ `slack-approval-brief.ts`)이
 *     실행 명세에서 만든다. hermes 는 이 글을 못 받으면 버튼 없는 카드를 올린다(돈 기안 버튼은 글과 함께만).
 *     모든 액션은 두 목록 중 하나에 있어야 한다 — 새 액션이 생기면 분류 계약 테스트가 실패해 판단을 강제한다(기본 = 제외).
 *  ③ 대기 중(`PENDING_APPROVAL`)이 아닌 기안은 승인·반려를 시도하지 않는다(최종 방어는 여전히 본체의 상태 전이 CAS). 승인은 `PENDING_APPROVAL` 에서만(실패 기안 재실행은 결재함에서). 중복 클릭은 승인 본체의 상태 전이(CAS)가 막고,
 *     이미 처리된 기안이면 현재 상태를 다시 읽어 돌려준다(CONFLICT 의 상태는 낡은 값이라).
 * 승인자·반려자는 `SLACK_OWNER_APPROVAL_ACTOR` — 결재함이 「슬랙에서 승인」으로 표시한다. 이 값은 사람 승인으로 다뤄져
 * 정산 확정 뒤 금액 수정도 통과한다(`isAutomatedActor`) — 카드의 주의 줄이 그 확인을 오너에게 맡긴다.
 * 거래처 등록은 결재함 승인에서만 계산서 정보 보강(`partnerEnrichment`)이 붙는다 — 슬랙 승인은 보강 없이 등록하고 카드가 그렇게 적는다.
 */
export const SLACK_DECIDABLE_ACTIONS: ReadonlySet<WriteActionName> = new Set<WriteActionName>([
  "create_sales_campaign_round",
  "create_sales_campaign_group_round",
  "create_order_campaign",
  "upsert_product_mappings",
  "add_campaign_items",
  "create_deal",
  "change_deal_status",
  "add_entity_memo",
  "confirm_settlement",
  "update_settlement_amount",
  "update_record",
  "create_partner",
  "create_campaign_round",
]);

/** 슬랙 버튼을 붙이지 않는 액션 — 결재함에서만 승인한다. 2026-11-28 부터 비어 있다(위 헤더 ②). 새 액션의 기본 자리다. */
export const SLACK_EXCLUDED_ACTIONS: ReadonlySet<WriteActionName> = new Set<WriteActionName>([]);

const ALREADY_DECIDED_CODES = new Set(["CONFLICT", "INVALID_STATUS", "SUPERSEDED"]);

type SlackProposalRow = {
  createdBy: string;
  status: string;
  payload: unknown;
  resultSummary?: string | null;
  targetEntityType?: string | null;
  targetEntityId?: string | null;
};

export type SlackDecisionDeps = {
  findProposal: (id: string) => Promise<SlackProposalRow | null>;
  approve: typeof approveProposal;
  reject: typeof rejectProposal;
};

const defaultDeps: SlackDecisionDeps = {
  findProposal: (id) => ActionProposalRepository.findById(id),
  approve: approveProposal,
  reject: rejectProposal,
};

const REF_TYPE_RE = /^[A-Z_]{1,32}$/;
const REF_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 실행 결과 참조 — 결재함 조회가 `executedRefType`·`executedRefId` 로 남기는 값과 같다(`approve-proposal.ts` 전이 데이터).
 * 형식이 어긋나면 싣지 않는다(`null`) — hermes 는 이 값을 봇 대화 줄에 넣으므로 자유 글자가 섞일 길을 닫는다.
 */
function executedRefOf(result: { refType?: unknown; refId?: unknown } | undefined): SlackDecisionExecutedRef | null {
  const type = result?.refType;
  const id = result?.refId;
  if (typeof type !== "string" || typeof id !== "string") return null;
  return REF_TYPE_RE.test(type) && REF_ID_RE.test(id) ? { type, id } : null;
}

async function currentStatus(deps: SlackDecisionDeps, id: string): Promise<string | null> {
  return (await deps.findProposal(id))?.status ?? null;
}

/**
 * 승인·반려 본체가 던졌을 때 — 상태를 다시 읽어, 이미 끝난 상태(커밋 뒤 예외)면 ALREADY_DECIDED 로 알린다
 * (카드가 「실패」로 남아 다시 누르게 되지 않게). 아직 대기 중이거나 읽지 못하면 INTERNAL(카드는 「결재함에서 확인」).
 */
async function failureFromThrow(deps: SlackDecisionDeps, id: string, err: unknown): Promise<SlackDecisionResponse> {
  console.error(`[slack-decision] ${id} 처리 중 예외:`, err);
  const status = await currentStatus(deps, id).catch(() => null);
  if (status !== null && status !== "PENDING_APPROVAL" && status !== "APPROVED") {
    return { ok: false, code: "ALREADY_DECIDED", status };
  }
  return { ok: false, code: "INTERNAL", status };
}

function isSlackEligible(proposal: SlackProposalRow): boolean {
  const action = parseStoredJsonObject(proposal.payload).action;
  return (
    proposal.createdBy === AGENT_WORKER_ACTOR &&
    typeof action === "string" &&
    SLACK_DECIDABLE_ACTIONS.has(action as WriteActionName)
  );
}

/**
 * 카드 글 조회 — hermes 가 카드를 올리기 전에 부른다. 승인 판정과 같은 자격(①②③)을 먼저 본다: 자격이 없으면 글을 주지 않아
 * hermes 가 버튼 없는 카드를 올린다. 아무것도 쓰지 않는다.
 */
export async function previewProposalForSlack(
  proposalId: string,
  deps: Pick<SlackDecisionDeps, "findProposal"> = defaultDeps,
  briefDeps?: BriefDeps,
): Promise<SlackPreviewResponse> {
  const proposal = await deps.findProposal(proposalId);
  if (!proposal) return { ok: false, code: "NOT_FOUND", status: null };
  if (!isSlackEligible(proposal)) return { ok: false, code: "NOT_ELIGIBLE", status: proposal.status };
  if (proposal.status !== "PENDING_APPROVAL") return { ok: false, code: "ALREADY_DECIDED", status: proposal.status };
  const brief = await buildSlackApprovalBrief(
    {
      payload: proposal.payload,
      resultSummary: proposal.resultSummary ?? null,
      targetEntityType: proposal.targetEntityType ?? null,
      targetEntityId: proposal.targetEntityId ?? null,
    },
    briefDeps,
  );
  return { ok: true, status: "PENDING_APPROVAL", brief };
}

export async function decideProposalFromSlack(
  request: SlackDecisionRequest & { decision: "approve" | "reject" },
  deps: SlackDecisionDeps = defaultDeps,
): Promise<SlackDecisionResponse> {
  const { proposalId, decision } = request;
  // 글 조회(`preview`)가 승인으로 새지 않게 — 타입이 막지만 런타임에도 한 번 더 막는다(아래는 reject 아니면 approve 로 간다).
  if (decision !== "approve" && decision !== "reject") return { ok: false, code: "INVALID_INPUT", status: null };
  const proposal = await deps.findProposal(proposalId);
  if (!proposal) return { ok: false, code: "NOT_FOUND", status: null };

  if (!isSlackEligible(proposal)) return { ok: false, code: "NOT_ELIGIBLE", status: proposal.status };
  // 대기 중이 아닌 기안은 승인·반려를 시도조차 하지 않는다 — 실패(FAILED) 기안은 일부 실행됐을 수 있어 결재함에서 본다.
  if (proposal.status !== "PENDING_APPROVAL") return { ok: false, code: "ALREADY_DECIDED", status: proposal.status };

  if (decision === "reject") {
    let outcome: Awaited<ReturnType<SlackDecisionDeps["reject"]>>;
    try {
      outcome = await deps.reject(proposalId, SLACK_OWNER_APPROVAL_ACTOR, "슬랙에서 반려");
    } catch (err) {
      return failureFromThrow(deps, proposalId, err);
    }
    if (outcome.ok) return { ok: true, status: "REJECTED", executedRef: null };
    if (outcome.code === "NOT_FOUND") return { ok: false, code: "NOT_FOUND", status: null };
    return { ok: false, code: "ALREADY_DECIDED", status: await currentStatus(deps, proposalId) };
  }

  let outcome: Awaited<ReturnType<SlackDecisionDeps["approve"]>>;
  try {
    outcome = await deps.approve(proposalId, SLACK_OWNER_APPROVAL_ACTOR, { expectedStatus: "PENDING_APPROVAL" });
  } catch (err) {
    // 승인 본체는 커밋 뒤(실행 후속 효과 등)에도 던질 수 있다 — 상태를 다시 읽어 실은 EXECUTED 인지 알려 준다.
    return failureFromThrow(deps, proposalId, err);
  }
  if (outcome.ok) return { ok: true, status: "EXECUTED", executedRef: executedRefOf(outcome.result) };
  if (outcome.code === "NOT_FOUND") return { ok: false, code: "NOT_FOUND", status: null };
  if (ALREADY_DECIDED_CODES.has(outcome.code)) {
    return { ok: false, code: "ALREADY_DECIDED", status: await currentStatus(deps, proposalId) };
  }
  if (outcome.code === "EXECUTION_FAILED" || outcome.code === "EMPTY_PAYLOAD") {
    return { ok: false, code: "EXECUTION_FAILED", status: await currentStatus(deps, proposalId) };
  }
  console.error(`[slack-decision] ${proposalId} 승인 실패: ${outcome.code} ${outcome.error}`);
  return { ok: false, code: "INTERNAL", status: await currentStatus(deps, proposalId) };
}
