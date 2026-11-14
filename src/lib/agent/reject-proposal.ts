import { ActionProposalRepository, ConcurrentModificationError } from "@/repositories/actionProposalRepository";
import { findInboundRow, markInboundRejected, readCalendarInboundRef } from "@/lib/calendar-inbound/adopt";

/**
 * 기안 반려 본체 — 웹 결재함 반려 라우트와 슬랙 버튼 반려(`agent-internal/slack-decision.ts`)가 함께 부른다.
 * 조건부 PENDING_APPROVAL→REJECTED 한 번이고 쓰기(실행)는 없다. 자기 반려 금지는 두지 않는다
 * (반려는 실행 권한이 아니라 "이 요청을 취소한다"는 의사표시라 승인과 위험도가 다르다).
 *
 * [캘린더수집] 캘린더에서 온 기안(`sourceRef.calendarInbound`)이면 반려 뒤 수집 행을 REJECTED 로 적어
 * 같은 일정을 다시 기안하지 않게 한다. 이 표기가 실패해도 반려(이미 커밋됨)는 성공이다.
 * 단 수집 행이 **이 기안을 가리킬 때만** 적는다 — 재기안으로 대체된 옛 카드를 반려했는데 행을 REJECTED 로
 * 덮으면 살아 있는 새 기안의 행이 닫혀 버린다(승인 쪽 SUPERSEDED 가드와 같은 `findInboundRow` 비교).
 */
export type RejectProposalOutcome =
  | { ok: true; proposal: Awaited<ReturnType<typeof ActionProposalRepository.transition>> }
  | { ok: false; code: "NOT_FOUND" | "CONFLICT" };

export async function rejectProposal(id: string, actor: string, note: string): Promise<RejectProposalOutcome> {
  const proposal = await ActionProposalRepository.findById(id);
  if (!proposal) return { ok: false, code: "NOT_FOUND" };

  let rejected;
  try {
    rejected = await ActionProposalRepository.transition(id, "REJECTED", {
      actor,
      note,
      expectedFrom: "PENDING_APPROVAL",
    });
  } catch (err) {
    if (err instanceof ConcurrentModificationError) return { ok: false, code: "CONFLICT" };
    throw err;
  }

  const inboundRef = readCalendarInboundRef(proposal.sourceRef);
  if (inboundRef) {
    try {
      const row = await findInboundRow(inboundRef.inboundId);
      if (row?.proposalId === proposal.id) await markInboundRejected(inboundRef.inboundId, proposal.id);
    } catch (markError) {
      console.error(`[rejectProposal ${id}] 캘린더 수집 행 반려 표기 실패:`, markError);
    }
  }
  return { ok: true, proposal: rejected };
}
