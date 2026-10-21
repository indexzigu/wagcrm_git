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
 *
 * [캘린더수집] 기안 `sourceRef.calendarInbound` 가 있으면(캘린더에서 들어온 기안) 커밋 뒤 후속 처리 **전에**
 * 원본 이벤트를 장부에 넘겨받고 수집 행을 ADOPTED 로 적는다 — 그래야 후속 동기화가 새 이벤트를 만들지
 * 않고 원본을 제자리에서 갱신한다. 실행이 FAILED 로 끝나면 수집 행을 재판정 대기로 되돌린다.
 * 두 일 모두 실패해도 판정을 바꾸지 않는다(console.error 로 보고).
 */
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { ActionProposalRepository, ConcurrentModificationError } from "@/repositories/actionProposalRepository";
import { executeWriteAction } from "@/lib/agent/write-executor";
import { applyWriteActionEffects } from "@/lib/agent/write-action-effects";
import { parseStoredJson } from "@/lib/stored-json";
import { adoptCalendarEventIntoLedger } from "@/lib/google-calendar-sync";
import {
  claimInboundRowForApproval,
  findInboundRow,
  markInboundAdopted,
  readCalendarInboundRef,
  resetInboundForRetry,
  type CalendarInboundRef,
} from "@/lib/calendar-inbound/adopt";
import { INBOUND_SKIP_ADOPT_FAILED, inboundSkipReasonForAdoptOutcome } from "@/lib/calendar-inbound/status";
import { partnerEnrichmentSchema } from "@/lib/agent/partner-enrichment-schema";
import {
  PARTNER_ENRICHMENT_LABELS,
  applyPartnerEnrichment,
  type PartnerEnrichment,
} from "@/lib/agent/partner-enrichment";
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
  | "INVALID_ENRICHMENT"
  | "EXECUTION_FAILED"
  /** [캘린더수집] 같은 일정이 새 기안으로 다시 올라왔다 — 옛 기안은 승인하지 않는다. */
  | "SUPERSEDED";

/** [캘린더수집] tx1 안에서 수집 행을 잡지 못했다 — 트랜잭션을 되돌리고 SUPERSEDED 로 답한다. */
class InboundSupersededError extends Error {
  constructor() {
    super("캘린더 수집 행이 다른 기안으로 넘어갔습니다");
    this.name = "InboundSupersededError";
  }
}

/** [캘린더수집] SUPERSEDED 문구 — 단건 응답과 일괄 결과 창이 같은 문장을 쓴다. */
const SUPERSEDED_MESSAGE = "이 캘린더 일정은 새 기안으로 다시 올라왔습니다. 새 기안을 승인해 주세요.";

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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * [캘린더수집] 넘겨받을 캠페인 — 새 회차면 방금 만든 캠페인, 기록 수정이면 기안이 가리킨 캠페인.
 * 그 밖의 모양은 캘린더 수집이 만들지 않는다 — null(장부는 건드리지 않고 처리 끝으로만 적는다).
 */
function inboundCampaignId(payload: ProposalPayload, result: ExecutionResult): string | null {
  if (payload.action === "create_campaign_round") return result.refId;
  if (payload.action === "update_record" && payload.args.entityType === "CAMPAIGN") {
    const entityId = payload.args.entityId;
    return typeof entityId === "string" && entityId ? entityId : null;
  }
  return null;
}

/**
 * [캘린더수집] 커밋 뒤 넘겨받기 — 장부 기록(ref.adopt 일 때만) → 수집 행 ADOPTED.
 * ⛔ 던지지 않는다 — 이 시점의 쓰기는 이미 커밋됐다(아래 후속 처리와 같은 이유). 장부에 적지 못한 경우
 * (충돌·다른 장부가 이미 가리킴·다음 동기화가 남기지 않을 칸·오류)도 처리 끝으로 적고 사유를 남긴다 —
 * 같은 일정을 다시 기안하지 않게 하려는 것이다. 오너 원본은 평범한 일정으로 남는다.
 */
async function adoptInboundAfterCommit(
  id: string,
  ref: CalendarInboundRef,
  payload: ProposalPayload,
  result: ExecutionResult,
): Promise<void> {
  const campaignId = inboundCampaignId(payload, result);
  let skipReason: string | null = null;
  try {
    if (ref.adopt && campaignId) {
      const adopted = await adoptCalendarEventIntoLedger({
        campaignId,
        kind: ref.ledgerKind,
        eventId: ref.eventId,
        calendarId: ref.calendarId,
      });
      skipReason = inboundSkipReasonForAdoptOutcome(adopted);
      if (adopted === "not_found") {
        console.error(`[approveProposal ${id}] 넘겨받을 캠페인 ${campaignId} 를 찾지 못함 — 장부 기록 생략`);
      }
    } else if (ref.adopt) {
      // 액션 이름만 싣는다 — 기안 내용(args)은 로그에 남기지 않는다(`resident-number-exposure.contract.test.ts`).
      const action = payload.action;
      console.error(`[approveProposal ${id}] ${action} 기안에서 넘겨받을 캠페인을 정하지 못함 — 장부 기록 생략`);
    }
  } catch (err) {
    console.error(`[approveProposal ${id}] 캘린더 원본 넘겨받기 실패 (쓰기는 이미 커밋됨):`, err);
    skipReason = INBOUND_SKIP_ADOPT_FAILED;
  }
  try {
    await markInboundAdopted(ref.inboundId, id, campaignId, { skipReason });
  } catch (err) {
    console.error(`[approveProposal ${id}] 캘린더 수집 행 처리 끝 표기 실패:`, err);
  }
}

/** [캘린더수집] 실행 실패 — 수집 행을 재판정 대기로. 실패해도 판정(FAILED)은 그대로 돌려준다. */
async function resetInboundAfterFailure(id: string, ref: CalendarInboundRef | null): Promise<void> {
  if (!ref) return;
  try {
    await resetInboundForRetry(ref.inboundId, id);
  } catch (err) {
    console.error(`[approveProposal ${id}] 캘린더 수집 행 재판정 대기 표기 실패:`, err);
  }
}

export type ApproveProposalOptions = {
  /**
   * 넘기면 현재 상태가 **이 값일 때만** 승인한다(FAILED 재시도 경로를 닫는다). 자동 실행기
   * (`auto-execute/settlement-auto-execute.ts`)가 「승인 대기만 집는다」를 이 함수 안에서도
   * 지키게 하려고 둔다 — 후보를 읽은 뒤 사람이 승인·실패시킨 기안을 자동으로 재시도하면 안 된다.
   */
  expectedStatus?: "PENDING_APPROVAL";
  /**
   * 「거래처 등록」 기안을 승인하면서 계산서에서 찾은 사업자 정보로 **빈 칸만** 채운다
   * (`partner-enrichment.ts`, 결재 카드가 보낸다). 다른 기안에 오면 승인하지 않고 거부한다.
   * 채운 결과는 tx1 에서 기안의 payload 에 함께 저장된다 — 실행이 실패해도 재시도가 같은
   * 값으로 돌고, 무엇을 승인했는지가 기안 기록에 남는다.
   */
  partnerEnrichment?: unknown;
};

type EnrichmentResult =
  | { ok: true; payload: ProposalPayload | null; filledLabels: string[] }
  | { ok: false; error: string };

/** 승인 전에 보강 값을 검사하고 기안 payload 에 합친다. 보강 값이 없으면 payload 그대로. */
function enrichPayload(payload: ProposalPayload | null, raw: unknown): EnrichmentResult {
  if (raw === undefined) return { ok: true, payload, filledLabels: [] };
  const partner = payload?.args?.partner;
  if (payload?.action !== "create_partner" || typeof partner !== "object" || partner === null) {
    return { ok: false, error: "계산서 정보 채우기는 거래처 등록 기안에만 쓸 수 있습니다." };
  }
  const parsed = partnerEnrichmentSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "계산서에서 가져온 값의 형식이 올바르지 않습니다. 다시 찾아 주세요." };
  }
  const applied = applyPartnerEnrichment(partner as Record<string, unknown>, parsed.data as PartnerEnrichment);
  if (applied.filled.length === 0) return { ok: true, payload, filledLabels: [] };
  return {
    ok: true,
    payload: { ...payload, args: { ...payload.args, partner: applied.partner } },
    filledLabels: applied.filled.map((field) => PARTNER_ENRICHMENT_LABELS[field]),
  };
}

export async function approveProposal(
  id: string,
  approverId: string,
  options: ApproveProposalOptions = {},
): Promise<ApproveProposalOutcome> {
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
  const outsideExpected = options.expectedStatus !== undefined && currentStatus !== options.expectedStatus;
  if (outsideExpected || (currentStatus !== "PENDING_APPROVAL" && currentStatus !== "FAILED")) {
    return {
      ok: false,
      code: "INVALID_STATUS",
      httpStatus: 409,
      error: `현재 상태(${currentStatus})에서는 승인할 수 없습니다.`,
      status: currentStatus,
    };
  }

  // payload는 최초 조회한 proposal 것을 쓴다(transition()의 반환값 형태에 의존하지 않아 더 견고하다).
  // 승인 전이가 payload 를 바꾸는 경우는 계산서 보강 하나뿐이고, 그때는 tx1 에 저장하는 값과
  // tx2 가 실행하는 값이 같은 변수(`payload`)다.
  // 🪤 읽기는 `parseStoredJson` 으로 — SQLite 레인은 Json 을 **문자열로** 저장하므로(저장소 이원화)
  // 그대로 캐스팅하면 `payload.action` 이 undefined 가 되어 승인이 EMPTY_PAYLOAD 로 실패한다
  // (자동 실행기 실 SQLite 테스트가 잡았다). Postgres 의 객체는 그대로 통과한다.
  const storedPayload = parseStoredJson<ProposalPayload>(proposal.payload);

  // 보강 값은 승인을 확정하기 **전에** 검사한다 — tx1 뒤에 거부하면 승인만 남고 실행할 길이 없다.
  const enrichment = enrichPayload(storedPayload, options.partnerEnrichment);
  if (!enrichment.ok) {
    return {
      ok: false,
      code: "INVALID_ENRICHMENT",
      httpStatus: 400,
      error: enrichment.error,
      status: currentStatus,
    };
  }
  const payload = enrichment.payload;
  const enriched = enrichment.filledLabels.length > 0;
  const inboundRef = readCalendarInboundRef(proposal.sourceRef);

  // [캘린더수집] 재기안으로 대체된 기안은 승인하지 않는다 — tx1 전에 먼저 거른다(빠른 길. 경합까지 막는 정본 판정은
  // tx1 안의 조건부 잡기 `claimInboundRowForApproval`). 재판정 대기 행을 스캔이
  // 다시 기안하면 수집 행의 `proposalId` 가 새 기안으로 바뀐다. 옛 기안(FAILED 재시도 등)까지 실행되면 같은
  // 일정이 두 번 반영된다(새 회차라면 캠페인이 둘). 행이 없어도 같다 — 넘겨받기 근거가 사라졌다.
  // 전역 상태기계(TRANSITIONS)는 건드리지 않고 이 판정만 더한다.
  if (inboundRef) {
    let row: { proposalId: string | null } | null;
    try {
      row = await findInboundRow(inboundRef.inboundId);
    } catch (err) {
      console.error(`[approveProposal ${id}] 캘린더 수집 행 조회 실패:`, err);
      return {
        ok: false,
        code: "APPROVE_ERROR",
        httpStatus: 500,
        error: "승인 처리 중 오류가 발생했습니다.",
        status: currentStatus,
      };
    }
    if (!row || row.proposalId !== proposal.id) {
      return { ok: false, code: "SUPERSEDED", httpStatus: 409, error: SUPERSEDED_MESSAGE, status: currentStatus };
    }
  }
  const baseNote = currentStatus === "FAILED" ? "재시도 승인" : "관리자 승인";

  // tx1: 조건부 승인 커밋 (§0-5 동시성 — 더블클릭/2인 동시 승인/일괄과 단건의 겹침 방어).
  // 보강했으면 합친 payload 를 같은 조건부 쓰기로 저장한다 — 승인과 「무엇을 승인했나」가 한 번에 굳는다.
  const approveTransition = (tx?: Prisma.TransactionClient) =>
    ActionProposalRepository.transition(id, "APPROVED", {
      actor: approverId,
      note: enriched ? `${baseNote} · 계산서로 채움: ${enrichment.filledLabels.join("·")}` : baseNote,
      expectedFrom: currentStatus,
      // ProposalPayload 는 JSON 으로 왕복한 값(`parseStoredJson`)이라 JSON 입력으로 넘겨도 안전하다.
      ...(enriched && payload ? { data: { payload: payload as unknown as Prisma.InputJsonObject } } : {}),
      ...(tx ? { tx } : {}),
    });
  try {
    if (inboundRef) {
      // [캘린더수집] 위 사전 확인은 빠른 길일 뿐이고 판정의 정본은 여기다 — 수집 행을 이 기안 앞으로 조건부로 잡는
      // 쓰기와 승인 전이를 한 트랜잭션에 묶는다. 그 사이 재판정 스캔이 행을 새 기안으로 넘겼으면 잡기가 0건이고
      // 전이도 함께 취소된다(옛 기안과 새 기안이 둘 다 실행되면 같은 일정이 두 번 반영된다).
      await getPrisma().$transaction(async (tx) => {
        if (!(await claimInboundRowForApproval(tx, inboundRef.inboundId, proposal.id))) {
          throw new InboundSupersededError();
        }
        await approveTransition(tx);
      });
    } else {
      await approveTransition();
    }
  } catch (err) {
    if (err instanceof InboundSupersededError) {
      return { ok: false, code: "SUPERSEDED", httpStatus: 409, error: SUPERSEDED_MESSAGE, status: currentStatus };
    }
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
    await resetInboundAfterFailure(id, inboundRef);
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
    const message = describeError(err);
    // tx2가 실패했으므로 실행(쓰기)과 EXECUTED 전이 모두 롤백된 상태다. 별도의(정상 동작하는)
    // 트랜잭션으로 APPROVED->FAILED를 기록해 재시도 가능하게 만든다(TRANSITIONS: FAILED->APPROVED).
    await ActionProposalRepository.transition(id, "FAILED", {
      actor: approverId,
      note: "실행 중 오류: 실행 및 EXECUTED 전이 전체 롤백됨(부분반영 없음)",
      data: { errorMessage: message },
    });
    console.error(`[approveProposal ${id}] tx2 Error:`, err);
    await resetInboundAfterFailure(id, inboundRef);
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
  // [캘린더수집] 넘겨받기는 후속 처리 **앞**이다 — 장부에 원본 id 가 먼저 있어야 후속 동기화가 그 이벤트를
  // 갱신한다(뒤면 새 이벤트를 만들어 일정이 둘이 된다).
  if (inboundRef) {
    await adoptInboundAfterCommit(id, inboundRef, payload, outcome.result);
  }
  applyWriteActionEffects(payload.action, outcome.result);

  return { ok: true, action: payload.action, proposal: outcome.executed, result: outcome.result };
}

/**
 * 일괄 승인에서 「이미 처리됐거나 승인할 상태가 아님」은 실패가 아니라 건너뜀이다 —
 * 운영자가 할 일이 없다. self-approval 거부는 정책 거부라 운영자가 알아야 하므로 실패로 센다.
 * 없는 id 도 실패로 센다 — 건너뜀으로 접으면 잘못 보낸 id 가 조용히 묻힌다.
 */
const SKIPPED_CODES: ReadonlySet<ApproveProposalFailureCode> = new Set(["INVALID_STATUS", "CONFLICT", "SUPERSEDED"]);

/**
 * 운영자가 읽는 상태 이름 — 결과 창에 `EXECUTED` 같은 식별자를 내보내지 않는다. 낱말은 결재함
 * 탭 이름(`approvals-tabs.ts` 대기·완료·실패·반려)과 같게 둔다(상태 낱말 기준 2026-10-08 —
 * 같은 상태를 두 화면이 다른 말로 부르지 않는다).
 */
const STATUS_LABELS: Record<string, string> = {
  DRAFT: "초안",
  PENDING_APPROVAL: "대기",
  APPROVED: "승인",
  EXECUTED: "완료",
  REJECTED: "반려",
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
    case "INVALID_ENRICHMENT":
      return outcome.error;
    case "APPROVE_ERROR":
      return "승인을 기록하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    case "EXECUTION_FAILED":
      return outcome.error;
    case "SUPERSEDED":
      return SUPERSEDED_MESSAGE;
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
