/**
 * ActionProposal 승인+실행 SSOT (청사진 §0-4/§0-5/§0-6/§0-7).
 *
 * 단건 승인 라우트(`POST /api/action-proposals/[id]/approve`)와 일괄 승인 라우트
 * (`POST /api/action-proposals/bulk-approve`)가 **같은 함수**를 부른다. 승인 트랜잭션을
 * 두 군데에 손으로 두면 한쪽만 self-approval 게이트·CAS·FAILED 기록을 갖는 상태가
 * 생긴다 — 그 부류가 이 레포에서 반복된 사고다(`write-action-effects.ts` 헤더 참조).
 *
 * 상태기계상 PENDING_APPROVAL→FAILED는 불가(TRANSITIONS: PENDING→[APPROVED,REJECTED]만)이므로
 * 승인과 실행을 2개의 트랜잭션으로 분리한다:
 *   tx1: PENDING_APPROVAL(또는 재시도 시 FAILED) → APPROVED 조건부 커밋(expectedFrom).
 *        커밋됨 = 승인은 사람이 내린 확정 결정.
 *   tx2: executeWriteAction(payload, approver, tx) + APPROVED→EXECUTED를 한 트랜잭션으로 원자화.
 *        실행 throw 시 tx2 전체 롤백(APPROVED 유지) → 별도로 APPROVED→FAILED 기록.
 *
 * self-approval(기안자===승인자)은 하드 게이트로 차단한다(§0-7) — 현재 4계정 전부
 * role 미설정=admin(auth-context.ts 기본값)이라 이 코드 게이트가 최소 통제선이다.
 *
 * 반환은 HTTP 가 아니라 **판정**이다. 단건 라우트는 `httpStatus`·`error` 를 그대로 응답에
 * 싣고(응답 문구·코드는 이 함수로 옮기기 전과 같다), 일괄 라우트는 `code` 로 건별
 * 실행/실패/건너뜀을 가른다.
 *
 * ⚠️ 예외를 던지는 경로가 둘 남아 있다(옮기기 전과 같다): ①tx2 실패 뒤 FAILED 기록 자체가
 * 실패할 때 ②커밋 뒤 후속 처리(`applyWriteActionEffects`)가 던질 때. 단건 라우트는 그대로
 * 500 이 되고, 일괄 라우트는 그 건만 잡아 상태를 다시 읽는다(`bulkApproveProposals`).
 */
import { getPrisma } from "@/lib/prisma";
import { ActionProposalRepository, ConcurrentModificationError } from "@/repositories/actionProposalRepository";
import { executeWriteAction } from "@/lib/agent/write-executor";
import { applyWriteActionEffects } from "@/lib/agent/write-action-effects";
import {
  BULK_APPROVE_MAX_IDS,
  countBulkApproveResults,
  type BulkApproveItemResult,
  type BulkApproveResponse,
} from "@/lib/action-proposal-bulk";

type ProposalPayload = {
  action: string;
  args: Record<string, unknown>;
};

type ExecutedProposal = Awaited<ReturnType<typeof ActionProposalRepository.transition>>;
type ExecutionResult = Awaited<ReturnType<typeof executeWriteAction>>;

export type ApproveProposalFailureCode =
  | "NOT_FOUND"
  | "SELF_APPROVAL"
  | "INVALID_STATUS"
  | "CONFLICT"
  | "APPROVE_ERROR"
  | "EMPTY_PAYLOAD"
  | "EXECUTION_FAILED";

export type ApproveProposalOutcome =
  | {
      ok: true;
      action: string;
      proposal: ExecutedProposal;
      result: ExecutionResult;
    }
  | {
      ok: false;
      code: ApproveProposalFailureCode;
      /** 단건 라우트가 그대로 응답하는 HTTP 상태 코드. */
      httpStatus: number;
      /** 단건 라우트가 그대로 응답하는 한글 오류 문구. */
      error: string;
      /**
       * 이 함수가 아는 마지막 상태. CONFLICT 는 다른 요청이 바꾼 뒤라 **실제 상태를 모른다**
       * (조회 전 값이 담긴다) — 정확한 값이 필요하면 호출부가 다시 읽는다.
       */
      status: string | null;
    };

export async function approveProposal(id: string, approverId: string): Promise<ApproveProposalOutcome> {
  const proposal = await ActionProposalRepository.findById(id);
  if (!proposal) {
    return { ok: false, code: "NOT_FOUND", httpStatus: 404, error: "해당 기안을 찾을 수 없습니다.", status: null };
  }

  // §0-7: self-approval 하드 게이트. 기안자 본인은 자기 기안을 승인할 수 없다.
  if (proposal.createdBy === approverId) {
    return {
      ok: false,
      code: "SELF_APPROVAL",
      httpStatus: 403,
      error: "본인이 기안한 요청은 본인이 승인할 수 없습니다 (self-approval 금지).",
      status: proposal.status,
    };
  }

  // 승인 가능한 현재 상태: PENDING_APPROVAL(최초 승인) 또는 FAILED(재시도, TRANSITIONS상 허용).
  const currentStatus = proposal.status;
  if (currentStatus !== "PENDING_APPROVAL" && currentStatus !== "FAILED") {
    return {
      ok: false,
      code: "INVALID_STATUS",
      httpStatus: 409,
      error: `현재 상태(${currentStatus})에서는 승인할 수 없습니다.`,
      status: currentStatus,
    };
  }

  // payload는 승인 전이로 바뀌지 않으므로 최초 조회한 proposal 것을 그대로 쓴다
  // (transition()의 반환값 형태에 의존하지 않아 더 견고하다).
  const payload = proposal.payload as unknown as ProposalPayload | null;

  // tx1: 조건부 승인 커밋 (§0-5 동시성 — 더블클릭/2인 동시 승인/일괄과 단건의 겹침 방어).
  try {
    await ActionProposalRepository.transition(id, "APPROVED", {
      actor: approverId,
      note: currentStatus === "FAILED" ? "재시도 승인" : "관리자 승인",
      expectedFrom: currentStatus,
    });
  } catch (err) {
    if (err instanceof ConcurrentModificationError) {
      return {
        ok: false,
        code: "CONFLICT",
        httpStatus: 409,
        error: "이미 처리된 기안입니다 (동시 요청).",
        status: currentStatus,
      };
    }
    console.error(`[approveProposal ${id}] tx1 Error:`, err);
    return {
      ok: false,
      code: "APPROVE_ERROR",
      httpStatus: 500,
      error: "승인 처리 중 오류가 발생했습니다.",
      status: currentStatus,
    };
  }

  if (!payload || !payload.action) {
    // 승인은 확정됐으나 payload가 비어 있으면 실행할 것이 없다 — 즉시 FAILED로 기록.
    await ActionProposalRepository.transition(id, "FAILED", {
      actor: approverId,
      note: "실행 실패: payload가 비어 있음",
      data: { errorMessage: "payload가 비어 있어 실행할 액션이 없습니다." },
    });
    return {
      ok: false,
      code: "EMPTY_PAYLOAD",
      httpStatus: 422,
      error: "기안에 실행 가능한 payload가 없습니다.",
      status: "FAILED",
    };
  }

  // tx2: 실행(executeWriteAction)과 APPROVED→EXECUTED 전이를 하나의 트랜잭션으로 원자화한다
  // (apply-executor.ts M1 패턴과 동일 — 전이 실패 시 실행 결과도 함께 롤백돼야 상태-DB 불일치가 없다).
  const prisma = getPrisma();
  let outcome: { executed: ExecutedProposal; result: ExecutionResult };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const result = await executeWriteAction(payload.action, payload.args, approverId, tx);
      // m3 [Minor, 방어심층]: tx1 배타선점(§0-5)으로 이 시점 상태는 이미 APPROVED로 안전하지만,
      // tx1/tx2 사이에 예외적인 상태 변경이 있더라도 조건부 전이가 한 번 더 걸러내도록
      // expectedFrom:"APPROVED"를 명시한다 — 다층 방어.
      const executed = await ActionProposalRepository.transition(id, "EXECUTED", {
        actor: approverId,
        note: `실행 완료: ${result.summary}`,
        data: {
          executedBy: approverId,
          executedAt: new Date(),
          executionResult: result,
          executedRefType: result.refType,
          executedRefId: result.refId,
        },
        expectedFrom: "APPROVED",
        tx,
      });
      return { executed, result };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // tx2가 실패했으므로 실행(쓰기)과 EXECUTED 전이 모두 롤백된 상태다. 별도의(정상 동작하는)
    // 트랜잭션으로 APPROVED->FAILED를 기록해 재시도 가능하게 만든다(TRANSITIONS: FAILED->APPROVED).
    await ActionProposalRepository.transition(id, "FAILED", {
      actor: approverId,
      note: "실행 중 오류: 실행 및 EXECUTED 전이 전체 롤백됨(부분반영 없음)",
      data: { errorMessage: message },
    });
    console.error(`[approveProposal ${id}] tx2 Error:`, err);
    return {
      ok: false,
      code: "EXECUTION_FAILED",
      httpStatus: 502,
      error: `실행 실패: ${message}`,
      status: "FAILED",
    };
  }

  // 커밋 후속 처리 — 캐시 무효화 + (정산 확정이면) 캘린더 재동기화. 정본 버튼 경로가
  // 쓰기 뒤에 하는 일과 같은 짝이며, 액션별 대상은 write-executor 의 effects 명세가 정한다.
  // ⛔ **위 try 안으로 옮기지 말 것** — 이 시점의 쓰기는 이미 커밋됐는데, 여기서 난 문제를
  // 저 catch 가 잡으면 성공한 실행을 FAILED 로 되돌려 운영자가 반영된 정산을 재시도하게 된다.
  applyWriteActionEffects(payload.action, outcome.result);

  return { ok: true, action: payload.action, proposal: outcome.executed, result: outcome.result };
}

/**
 * 일괄 승인에서 「이미 처리됐거나 승인할 상태가 아님」은 실패가 아니라 건너뜀이다 —
 * 운영자가 할 일이 없다. self-approval 거부는 정책 거부라 운영자가 알아야 하므로 실패로 센다.
 */
const SKIPPED_CODES: ReadonlySet<ApproveProposalFailureCode> = new Set([
  "NOT_FOUND",
  "INVALID_STATUS",
  "CONFLICT",
]);

/** 운영자가 읽는 상태 이름 — 결과 창에 `EXECUTED` 같은 식별자를 내보내지 않는다. */
const STATUS_LABELS: Record<string, string> = {
  DRAFT: "초안",
  PENDING_APPROVAL: "승인 대기",
  APPROVED: "승인됨",
  EXECUTED: "실행 완료",
  REJECTED: "반려됨",
  FAILED: "실패",
};

/**
 * 일괄 결과 창에 싣는 사유. 단건 라우트의 응답 문구(`outcome.error`)는 바꾸지 않는다 — 그쪽은
 * 기존 계약이고, 여기는 여러 건을 한 번에 훑는 운영자가 「다시 할지·넘길지」를 바로 가를 수
 * 있게 쓴 별도 문구다. 실행 실패는 실행기 메시지가 곧 원인이라 그대로 둔다.
 */
function bulkReason(outcome: Extract<ApproveProposalOutcome, { ok: false }>, status: string | null): string {
  switch (outcome.code) {
    case "NOT_FOUND":
      return "기안을 찾을 수 없습니다. 이미 지워졌을 수 있습니다.";
    case "CONFLICT":
      return "이미 다른 곳에서 처리된 기안입니다.";
    case "INVALID_STATUS":
      return `승인 대기 상태가 아닙니다 (현재: ${STATUS_LABELS[status ?? ""] ?? status ?? "알 수 없음"}).`;
    case "SELF_APPROVAL":
      return "본인이 올린 기안은 본인이 승인할 수 없습니다.";
    case "EMPTY_PAYLOAD":
      return "기안에 실행할 내용이 없어 실패로 기록했습니다.";
    case "APPROVE_ERROR":
      return "승인을 기록하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    case "EXECUTION_FAILED":
      return outcome.error;
  }
}

async function readStatus(id: string): Promise<string | null> {
  try {
    const current = await ActionProposalRepository.findById(id);
    return current ? current.status : null;
  } catch (err) {
    console.error(`[bulkApproveProposals ${id}] 상태 재조회 실패:`, err);
    return null;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 기안 여러 건을 **주어진 순서대로 한 건씩** 승인+실행한다.
 *
 * 각 건은 `approveProposal` 을 그대로 탄다(self-approval 게이트 · CAS · tx2 · FAILED 기록 ·
 * 후속 처리). 한 건의 실패·예외가 나머지를 멈추지 않는다. 같은 기안을 두 번 실행하지 않는
 * 근거는 tx1 의 CAS 다 — 이미 EXECUTED 면 상태 검사에서, 동시 요청이면 CAS 에서 건너뜀이 된다.
 *
 * 병렬로 돌리지 않는 이유: 같은 거래처·캠페인을 건드리는 기안이 섞일 수 있고, 운영자가 고른
 * 순서가 곧 실행 순서여야 결과를 읽을 수 있다.
 */
export async function bulkApproveProposals(
  ids: readonly string[],
  approverId: string
): Promise<BulkApproveResponse> {
  if (ids.length > BULK_APPROVE_MAX_IDS) {
    throw new Error(`한 번에 최대 ${BULK_APPROVE_MAX_IDS}건까지 승인할 수 있습니다.`);
  }

  const results: BulkApproveItemResult[] = [];
  for (const id of ids) {
    let outcome: ApproveProposalOutcome;
    try {
      outcome = await approveProposal(id, approverId);
    } catch (err) {
      // 예외 경로(FAILED 기록 실패 · 커밋 뒤 후속 처리 예외)는 실행 여부를 이 자리에서 알 수
      // 없다 — 상태를 다시 읽어 판정한다. EXECUTED 면 쓰기는 이미 커밋된 것이다.
      console.error(`[bulkApproveProposals ${id}] 처리 중 예외:`, err);
      const status = await readStatus(id);
      if (status === "EXECUTED") {
        results.push({
          id,
          ok: true,
          outcome: "executed",
          status,
          error: `실행은 완료됐지만 후속 처리 중 오류가 났습니다: ${describeError(err)}`,
        });
      } else {
        results.push({
          id,
          ok: false,
          outcome: "failed",
          status,
          error: `처리 중 오류가 났습니다. 목록에서 상태를 확인해 주세요 (${describeError(err)}).`,
        });
      }
      continue;
    }

    if (outcome.ok) {
      results.push({ id, ok: true, outcome: "executed", status: "EXECUTED" });
      continue;
    }

    if (SKIPPED_CODES.has(outcome.code)) {
      // CONFLICT 는 다른 요청이 바꾼 뒤라 실제 상태를 다시 읽어 보고한다.
      const status = outcome.code === "CONFLICT" ? await readStatus(id) : outcome.status;
      results.push({ id, ok: false, outcome: "skipped", status, error: bulkReason(outcome, status) });
      continue;
    }

    results.push({
      id,
      ok: false,
      outcome: "failed",
      status: outcome.status,
      error: bulkReason(outcome, outcome.status),
    });
  }

  return { results, counts: countBulkApproveResults(results) };
}
