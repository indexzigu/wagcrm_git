import { NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { closeFailedProposal } from "@/lib/agent/reject-proposal";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * POST /api/action-proposals/[id]/close — 실패 기안 종결.
 * 다른 경로로 이미 처리했거나 더 필요 없는 실패(FAILED) 기안을 실패 탭에서 빼 반려 탭에 「종결됨」으로 남긴다.
 * 쓰기(실행)는 없다. 반려와 같은 권한(admin)이고, 실패 상태가 아니면(그 사이 재시도 등) 409.
 */
export async function POST(_request: Request, context: Context) {
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;

  try {
    const outcome = await closeFailedProposal(id, auth.context.userId);
    if (outcome.ok) return NextResponse.json({ ok: true });
    if (outcome.code === "NOT_FOUND") {
      return NextResponse.json({ error: "해당 기안을 찾을 수 없습니다." }, { status: 404 });
    }
    return NextResponse.json({ error: "실패 상태가 아닌 기안이라 종결할 수 없습니다(이미 처리됨)." }, { status: 409 });
  } catch (err) {
    console.error(`[POST /api/action-proposals/${id}/close] Error:`, err);
    return NextResponse.json({ error: "종결 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
