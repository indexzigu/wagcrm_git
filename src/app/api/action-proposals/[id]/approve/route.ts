import { NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { approveProposal } from "@/lib/agent/approve-proposal";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * POST /api/action-proposals/[id]/approve — 승인 + 실행 (청사진 §0-4/§0-5/§0-6/§0-7).
 *
 * 승인 트랜잭션(tx1 CAS → tx2 실행+EXECUTED → 실패 시 FAILED → 커밋 뒤 후속 처리)과
 * self-approval 게이트는 `approveProposal`(`src/lib/agent/approve-proposal.ts`)이 소유한다 —
 * 일괄 승인 라우트(`../../bulk-approve`)와 같은 함수를 쓰기 위해 옮겼다. 이 라우트는 인가와
 * 판정→HTTP 응답 변환만 한다. 응답 코드·문구는 옮기기 전과 같다.
 */
export async function POST(_request: Request, context: Context) {
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const outcome = await approveProposal(id, auth.context.userId);

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.httpStatus });
  }
  return NextResponse.json({ proposal: outcome.proposal, result: outcome.result });
}
