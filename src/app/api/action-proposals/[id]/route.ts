import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { ActionProposalRepository, deserializeJsonField } from "@/repositories/actionProposalRepository";
import { resolveEntityLabel } from "@/lib/agent/resolve-entity-label";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/action-proposals/[id] — 상세(events 포함, entity명 해석) (청사진 §2).
 */
export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;

  const proposal = await ActionProposalRepository.findById(id, { events: true });
  if (!proposal) {
    return NextResponse.json({ error: "해당 기안을 찾을 수 없습니다." }, { status: 404 });
  }

  const targetEntityName = await resolveEntityLabel(
    proposal.targetEntityType,
    proposal.targetEntityId
  );

  // payload/executionResult는 SQLite에서 문자열로 저장되므로 UI가 payload.action 등을 읽으려면
  // 역직렬화해야 한다(Postgres 객체엔 no-op). 안 하면 dev:local에서 카드 라벨이 "알 수 없는 액션"이 된다.
  return NextResponse.json({
    ...proposal,
    payload: deserializeJsonField(proposal.payload),
    executionResult: deserializeJsonField(proposal.executionResult),
    targetEntityName,
  });
}
