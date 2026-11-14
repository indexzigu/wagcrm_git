import { NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { rejectProposal } from "@/lib/agent/reject-proposal";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * POST /api/action-proposals/[id]/reject — 반려 (청사진 §2).
 * requireRole("admin") 뒤 반려 본체(`lib/agent/reject-proposal.ts` — 캘린더 수집 행 표기 포함)를 부른다.
 * self-approval 게이트는 승인(approve)에만 적용되고 반려는 기안자 본인도 할 수 있다.
 */
export async function POST(_request: Request, context: Context) {
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;

  try {
    const outcome = await rejectProposal(id, auth.context.userId, "관리자 반려");
    if (outcome.ok) return NextResponse.json({ proposal: outcome.proposal });
    if (outcome.code === "NOT_FOUND") {
      return NextResponse.json({ error: "해당 기안을 찾을 수 없습니다." }, { status: 404 });
    }
    return NextResponse.json({ error: "이미 처리된 기안입니다 (동시 요청)." }, { status: 409 });
  } catch (err) {
    console.error(`[POST /api/action-proposals/${id}/reject] Error:`, err);
    return NextResponse.json({ error: "반려 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
