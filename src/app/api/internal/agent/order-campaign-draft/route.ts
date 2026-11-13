import { NextResponse } from "next/server";
import { withProxySource } from "@/lib/order-converter/proxy-usage";
import { agentInternalNotFound, verifyAgentInternalRequest } from "@/lib/agent-internal/auth";
import {
  agentInternalFailure,
  httpStatusForFailure,
  orderCampaignDraftRequestSchema,
} from "@/lib/agent-internal/api-contract";
import { buildOrderCampaignDraft } from "@/lib/agent-internal/order-campaign-draft";

/**
 * POST /api/internal/agent/order-campaign-draft — 봇 내부 창구: 주문캠페인 새로 만들기 기안의 초안(네이버 상품 →
 * 캠페인 칸·스토어 옵션 줄·거래처 양식). 봇 작업 `create_action_proposal`(action `create_order_campaign`)이 기안을
 * 만들기 전에 루프백으로 부른다. **읽기만 한다** — 캠페인은 결재함 승인 때 만들어진다.
 * 인증·닫힘 규칙은 `agent-internal/auth.ts` 가 정본이다. 프록시(Fixie) 요청은 등록 창 옵션 조회와 같은 product-options 로
 * 센다(상품 목록은 product-search).
 */
async function handle(request: Request): Promise<Response> {
  if (!verifyAgentInternalRequest(request)) return agentInternalNotFound();
  const body: unknown = await request.json().catch(() => null);
  const parsed = orderCampaignDraftRequestSchema.safeParse(body);
  if (!parsed.success) {
    const failure = agentInternalFailure("INVALID_INPUT", "요청 모양이 올바르지 않습니다.");
    return NextResponse.json(failure, { status: httpStatusForFailure(failure.code) });
  }
  const result = await buildOrderCampaignDraft(parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : httpStatusForFailure(result.code) });
}

export const POST = withProxySource("product-options", handle);
