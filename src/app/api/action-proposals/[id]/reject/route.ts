import { NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { ActionProposalRepository, ConcurrentModificationError } from "@/repositories/actionProposalRepository";
import { markInboundRejected, readCalendarInboundRef } from "@/lib/calendar-inbound/adopt";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * POST /api/action-proposals/[id]/reject — 반려 (청사진 §2).
 * requireRole("admin") + 조건부 PENDING_APPROVAL→REJECTED. 쓰기(실행) 없음.
 * self-approval 게이트는 승인(approve)에만 적용되고 반려는 기안자 본인도 할 수 있다
 * (반려는 실행 권한이 아니라 "이 요청을 취소한다"는 의사표시이므로 approve와 위험도가 다르다).
 *
 * [캘린더수집] 캘린더에서 온 기안(`sourceRef.calendarInbound`)이면 반려 뒤 수집 행을 REJECTED 로 적어
 * 같은 일정을 다시 기안하지 않게 한다. 이 표기가 실패해도 반려(이미 커밋됨)는 성공으로 응답한다.
 */
export async function POST(_request: Request, context: Context) {
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;

  const proposal = await ActionProposalRepository.findById(id);
  if (!proposal) {
    return NextResponse.json({ error: "해당 기안을 찾을 수 없습니다." }, { status: 404 });
  }

  try {
    const rejected = await ActionProposalRepository.transition(id, "REJECTED", {
      actor: auth.context.userId,
      note: "관리자 반려",
      expectedFrom: "PENDING_APPROVAL",
    });

    const inboundRef = readCalendarInboundRef(proposal.sourceRef);
    if (inboundRef) {
      try {
        await markInboundRejected(inboundRef.inboundId);
      } catch (markError) {
        console.error(`[POST /api/action-proposals/${id}/reject] 캘린더 수집 행 반려 표기 실패:`, markError);
      }
    }

    return NextResponse.json({ proposal: rejected });
  } catch (err) {
    if (err instanceof ConcurrentModificationError) {
      return NextResponse.json(
        { error: "이미 처리된 기안입니다 (동시 요청)." },
        { status: 409 }
      );
    }
    console.error(`[POST /api/action-proposals/${id}/reject] Error:`, err);
    return NextResponse.json({ error: "반려 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
