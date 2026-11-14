import { approveProposal } from "@/lib/agent/approve-proposal";
import { rejectProposal } from "@/lib/agent/reject-proposal";
import { AGENT_WORKER_ACTOR } from "@/lib/agent/agent-worker-proposal";
import type { WriteActionName } from "@/lib/agent/write-actions";
import { parseStoredJsonObject } from "@/lib/stored-json";
import { ActionProposalRepository } from "@/repositories/actionProposalRepository";
import type { SlackDecisionRequest, SlackDecisionResponse } from "./api-contract";
import { SLACK_OWNER_APPROVAL_ACTOR } from "./actors";

/**
 * 슬랙 버튼 승인·반려(오너 결정 2026-11-14 「버튼 승인」) — 슬랙 카드의 [승인]·[반려] 를 웹 결재함과 같은 본체로 처리한다.
 * 누가 눌렀는지(오너 슬랙 ID 하나)는 hermes 버튼 처리기가 판정하고, 이 모듈은 **무엇을** 슬랙에서 결정해도 되는지를 판정한다:
 *  ① 봇이 올린 기안(`createdBy === AGENT_WORKER`)만 — 캘린더 수집·사람 기안은 결재함에서.
 *  ② 액션이 `SLACK_DECIDABLE_ACTIONS` 에 있을 때만 — 돈·정산 칸·계산서 보강이 걸린 액션은 표를 보고 결재함에서 승인한다.
 *     (`update_record` 는 정산 금액·입금/지급 완료 칸까지 고칠 수 있어 제외 — 독립 검토 2026-11-14 지적.)
 *     모든 액션은 두 목록 중 하나에 있어야 한다 — 새 액션이 생기면 분류 계약 테스트가 실패해 판단을 강제한다(기본 = 제외).
 *  ③ 대기 중(`PENDING_APPROVAL`)이 아닌 기안은 승인·반려를 시도하지 않는다(최종 방어는 여전히 본체의 상태 전이 CAS). 승인은 `PENDING_APPROVAL` 에서만(실패 기안 재실행은 결재함에서). 중복 클릭은 승인 본체의 상태 전이(CAS)가 막고,
 *     이미 처리된 기안이면 현재 상태를 다시 읽어 돌려준다(CONFLICT 의 상태는 낡은 값이라).
 * 승인자·반려자는 `SLACK_OWNER_APPROVAL_ACTOR` — 결재함이 「슬랙에서 승인」으로 표시한다.
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
]);

/** 슬랙 버튼을 붙이지 않는 액션 — 결재함에서만 승인한다. 이유는 위 헤더 ②. */
export const SLACK_EXCLUDED_ACTIONS: ReadonlySet<WriteActionName> = new Set<WriteActionName>([
  "confirm_settlement",
  "update_settlement_amount",
  "update_record",
  "create_partner",
  "create_campaign_round",
]);

const ALREADY_DECIDED_CODES = new Set(["CONFLICT", "INVALID_STATUS", "SUPERSEDED"]);

export type SlackDecisionDeps = {
  findProposal: (id: string) => Promise<{ createdBy: string; status: string; payload: unknown } | null>;
  approve: typeof approveProposal;
  reject: typeof rejectProposal;
};

const defaultDeps: SlackDecisionDeps = {
  findProposal: (id) => ActionProposalRepository.findById(id),
  approve: approveProposal,
  reject: rejectProposal,
};

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

export async function decideProposalFromSlack(
  request: SlackDecisionRequest,
  deps: SlackDecisionDeps = defaultDeps,
): Promise<SlackDecisionResponse> {
  const { proposalId, decision } = request;
  const proposal = await deps.findProposal(proposalId);
  if (!proposal) return { ok: false, code: "NOT_FOUND", status: null };

  const action = parseStoredJsonObject(proposal.payload).action;
  const eligible =
    proposal.createdBy === AGENT_WORKER_ACTOR &&
    typeof action === "string" &&
    SLACK_DECIDABLE_ACTIONS.has(action as WriteActionName);
  if (!eligible) return { ok: false, code: "NOT_ELIGIBLE", status: proposal.status };
  // 대기 중이 아닌 기안은 승인·반려를 시도조차 하지 않는다 — 실패(FAILED) 기안은 일부 실행됐을 수 있어 결재함에서 본다.
  if (proposal.status !== "PENDING_APPROVAL") return { ok: false, code: "ALREADY_DECIDED", status: proposal.status };

  if (decision === "reject") {
    let outcome: Awaited<ReturnType<SlackDecisionDeps["reject"]>>;
    try {
      outcome = await deps.reject(proposalId, SLACK_OWNER_APPROVAL_ACTOR, "슬랙에서 반려");
    } catch (err) {
      return failureFromThrow(deps, proposalId, err);
    }
    if (outcome.ok) return { ok: true, status: "REJECTED" };
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
  if (outcome.ok) return { ok: true, status: "EXECUTED" };
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
