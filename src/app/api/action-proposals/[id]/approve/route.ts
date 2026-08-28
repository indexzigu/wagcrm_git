import { NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { ActionProposalRepository, ConcurrentModificationError } from "@/repositories/actionProposalRepository";
import { executeWriteAction } from "@/lib/agent/write-executor";
import { applyWriteActionEffects } from "@/lib/agent/write-action-effects";

type Context = {
  params: Promise<{ id: string }>;
};

type ProposalPayload = {
  action: string;
  args: Record<string, unknown>;
};

/**
 * POST /api/action-proposals/[id]/approve — 승인 + 실행 (청사진 §0-4/§0-5/§0-6/§0-7).
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
 */
export async function POST(_request: Request, context: Context) {
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const approverId = auth.context.userId;

  const proposal = await ActionProposalRepository.findById(id);
  if (!proposal) {
    return NextResponse.json({ error: "해당 기안을 찾을 수 없습니다." }, { status: 404 });
  }

  // §0-7: self-approval 하드 게이트. 기안자 본인은 자기 기안을 승인할 수 없다.
  if (proposal.createdBy === approverId) {
    return NextResponse.json(
      { error: "본인이 기안한 요청은 본인이 승인할 수 없습니다 (self-approval 금지)." },
      { status: 403 }
    );
  }

  // 승인 가능한 현재 상태: PENDING_APPROVAL(최초 승인) 또는 FAILED(재시도, TRANSITIONS상 허용).
  const currentStatus = proposal.status;
  if (currentStatus !== "PENDING_APPROVAL" && currentStatus !== "FAILED") {
    return NextResponse.json(
      { error: `현재 상태(${currentStatus})에서는 승인할 수 없습니다.` },
      { status: 409 }
    );
  }

  // payload는 승인 전이로 바뀌지 않으므로 최초 조회한 proposal 것을 그대로 쓴다
  // (transition()의 반환값 형태에 의존하지 않아 더 견고하다).
  const payload = proposal.payload as unknown as ProposalPayload | null;

  // tx1: 조건부 승인 커밋 (§0-5 동시성 — 더블클릭/2인 동시 승인 방어).
  try {
    await ActionProposalRepository.transition(id, "APPROVED", {
      actor: approverId,
      note: currentStatus === "FAILED" ? "재시도 승인" : "관리자 승인",
      expectedFrom: currentStatus,
    });
  } catch (err) {
    if (err instanceof ConcurrentModificationError) {
      return NextResponse.json(
        { error: "이미 처리된 기안입니다 (동시 요청)." },
        { status: 409 }
      );
    }
    console.error(`[POST /api/action-proposals/${id}/approve] tx1 Error:`, err);
    return NextResponse.json({ error: "승인 처리 중 오류가 발생했습니다." }, { status: 500 });
  }

  if (!payload || !payload.action) {
    // 승인은 확정됐으나 payload가 비어 있으면 실행할 것이 없다 — 즉시 FAILED로 기록.
    await ActionProposalRepository.transition(id, "FAILED", {
      actor: approverId,
      note: "실행 실패: payload가 비어 있음",
      data: { errorMessage: "payload가 비어 있어 실행할 액션이 없습니다." },
    });
    return NextResponse.json({ error: "기안에 실행 가능한 payload가 없습니다." }, { status: 422 });
  }

  // tx2: 실행(executeWriteAction)과 APPROVED→EXECUTED 전이를 하나의 트랜잭션으로 원자화한다
  // (apply-executor.ts M1 패턴과 동일 — 전이 실패 시 실행 결과도 함께 롤백돼야 상태-DB 불일치가 없다).
  const prisma = getPrisma();
  let outcome: {
    executed: Awaited<ReturnType<typeof ActionProposalRepository.transition>>;
    result: Awaited<ReturnType<typeof executeWriteAction>>;
  };
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
    console.error(`[POST /api/action-proposals/${id}/approve] tx2 Error:`, err);
    return NextResponse.json({ error: `실행 실패: ${message}` }, { status: 502 });
  }

  // 커밋 후속 처리 — 캐시 무효화 + (정산 확정이면) 캘린더 재동기화. 정본 버튼 경로가
  // 쓰기 뒤에 하는 일과 같은 짝이며, 액션별 대상은 write-executor 의 effects 명세가 정한다.
  // ⛔ **위 try 안으로 옮기지 말 것** — 이 시점의 쓰기는 이미 커밋됐는데, 여기서 난 문제를
  // 저 catch 가 잡으면 성공한 실행을 FAILED 로 되돌려 운영자가 반영된 정산을 재시도하게 된다.
  applyWriteActionEffects(payload.action, outcome.result);

  return NextResponse.json({ proposal: outcome.executed, result: outcome.result });
}
