import { NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { approveProposal } from "@/lib/agent/approve-proposal";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * 요청 본문은 선택이다. 비어 있으면 종전 그대로 승인하고, `{ partnerEnrichment }` 가 오면
 * 거래처 등록 기안의 빈 칸을 계산서 값으로 채워 승인한다(검사·병합은 `approveProposal`).
 */
async function readPartnerEnrichment(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const raw = await request.text();
  if (raw.trim().length === 0) return { ok: true, value: undefined };
  try {
    const body: unknown = JSON.parse(raw);
    const value =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>).partnerEnrichment
        : undefined;
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * POST /api/action-proposals/[id]/approve — 승인 + 실행 (청사진 §0-4/§0-5/§0-6/§0-7).
 *
 * 승인 트랜잭션(tx1 CAS → tx2 실행+EXECUTED → 실패 시 FAILED → 커밋 뒤 후속 처리)과
 * self-approval 게이트는 `approveProposal`(`src/lib/agent/approve-proposal.ts`)이 소유한다 —
 * 일괄 승인 라우트(`../../bulk-approve`)와 같은 함수를 쓰기 위해 옮겼다. 이 라우트는 인가와
 * 판정→HTTP 응답 변환만 한다. 응답 코드·문구는 옮기기 전과 같다.
 */
export async function POST(request: Request, context: Context) {
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  const body = await readPartnerEnrichment(request);
  if (!body.ok) {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다(JSON 형식 오류)." }, { status: 400 });
  }

  const { id } = await context.params;
  const outcome = await approveProposal(
    id,
    auth.context.userId,
    body.value === undefined ? {} : { partnerEnrichment: body.value },
  );

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.httpStatus });
  }
  return NextResponse.json({ proposal: outcome.proposal, result: outcome.result });
}
