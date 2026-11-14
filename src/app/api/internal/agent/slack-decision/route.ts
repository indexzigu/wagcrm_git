import { NextResponse } from "next/server";
import { agentInternalNotFound, verifySlackDecisionRequest } from "@/lib/agent-internal/auth";
import { slackDecisionRequestSchema, type SlackDecisionResponse } from "@/lib/agent-internal/api-contract";
import { decideProposalFromSlack } from "@/lib/agent-internal/slack-decision";

/**
 * POST /api/internal/agent/slack-decision — 슬랙 버튼 승인·반려 창구. hermes 버튼 처리기가 루프백으로 부른다.
 * 인증은 전용 비밀값(`verifySlackDecisionRequest` — 워커 비밀값으로는 안 열림), 판정 규칙은
 * `agent-internal/slack-decision.ts` 헤더가 정본이다. 응답은 본체 결과를 그대로(200) — 실패도 카드 문구를 정하는 값이라
 * HTTP 오류로 숨기지 않는다. 예외만 500.
 */
export async function POST(request: Request): Promise<Response> {
  if (!verifySlackDecisionRequest(request)) return agentInternalNotFound();
  const body: unknown = await request.json().catch(() => null);
  const parsed = slackDecisionRequestSchema.safeParse(body);
  if (!parsed.success) {
    const failure: SlackDecisionResponse = { ok: false, code: "INVALID_INPUT", status: null };
    return NextResponse.json(failure, { status: 400 });
  }
  try {
    return NextResponse.json(await decideProposalFromSlack(parsed.data));
  } catch (err) {
    console.error("[POST /api/internal/agent/slack-decision] Error:", err);
    const failure: SlackDecisionResponse = { ok: false, code: "INTERNAL", status: null };
    return NextResponse.json(failure, { status: 500 });
  }
}
