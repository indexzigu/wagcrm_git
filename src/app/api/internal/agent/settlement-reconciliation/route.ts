import { NextResponse } from "next/server";
import { agentInternalNotFound, verifyAgentInternalRequest } from "@/lib/agent-internal/auth";
import {
  agentInternalFailure,
  httpStatusForFailure,
  settlementReconciliationRequestSchema,
} from "@/lib/agent-internal/api-contract";
import { getSettlementReconciliation } from "@/lib/agent-internal/settlement-reconciliation";

/**
 * POST /api/internal/agent/settlement-reconciliation — 봇 내부 창구: 판매캠페인의 브랜드 정산 메일(첨부 피벗) ↔ 품목 줄
 * 옵션 대조. 봇 작업 `get_settlement_reconciliation` 이 루프백으로 부른다. 인증·닫힘 규칙은 `agent-internal/auth.ts` 가
 * 정본이다. 읽기만 한다(메일함 읽기 전용 · DB 쓰기 없음).
 *
 * ⛔ 핸들러 전체를 고정 실패로 감싼다 — 예외가 프레임워크 오류 보고(Sentry onRequestError)로 새면 그 문구에 메일·셀
 *    값이 섞일 수 있다. 로그에도 고정 코드만 남긴다.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!verifyAgentInternalRequest(request)) return agentInternalNotFound();
    const body: unknown = await request.json().catch(() => null);
    const parsed = settlementReconciliationRequestSchema.safeParse(body);
    if (!parsed.success) {
      const failure = agentInternalFailure("INVALID_INPUT", "요청 모양이 올바르지 않습니다.");
      return NextResponse.json(failure, { status: httpStatusForFailure(failure.code) });
    }
    const result = await getSettlementReconciliation(parsed.data.campaignId);
    return NextResponse.json(result, { status: result.ok ? 200 : httpStatusForFailure(result.code) });
  } catch {
    console.warn("[agent-internal] settlement-reconciliation: RECONCILE_FAILED");
    const failure = agentInternalFailure("RECONCILE_FAILED", "정산 대조 중 오류가 났습니다.");
    return NextResponse.json(failure, { status: httpStatusForFailure(failure.code) });
  }
}
