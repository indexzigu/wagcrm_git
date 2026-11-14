import { NextResponse } from "next/server";
import { withProxySource } from "@/lib/order-converter/proxy-usage";
import { agentInternalNotFound, verifyAgentInternalRequest } from "@/lib/agent-internal/auth";
import {
  agentInternalFailure,
  httpStatusForFailure,
  salesCampaignRoundDraftRequestSchema,
} from "@/lib/agent-internal/api-contract";
import { buildSalesCampaignRoundDraft } from "@/lib/agent-internal/sales-campaign-round-draft";

/**
 * POST /api/internal/agent/sales-campaign-round-draft — 봇 내부 창구: 판매캠페인 다음 회차 기안의 초안(이전 회차 +
 * 이번 스토어 상품 → 새 캠페인 칸). 봇 작업 `create_action_proposal`(action `create_sales_campaign_round`)이 기안을
 * 만들기 전에 루프백으로 부른다. **읽기만 한다** — 캠페인은 결재함 승인 때 만들어진다.
 * 인증·닫힘 규칙은 `agent-internal/auth.ts` 가 정본이다. 프록시(Fixie) 요청은 상품 목록 조회라 product-search 로 센다.
 */
async function handle(request: Request): Promise<Response> {
  if (!verifyAgentInternalRequest(request)) return agentInternalNotFound();
  const body: unknown = await request.json().catch(() => null);
  const parsed = salesCampaignRoundDraftRequestSchema.safeParse(body);
  if (!parsed.success) {
    const failure = agentInternalFailure("INVALID_INPUT", "요청 모양이 올바르지 않습니다.");
    return NextResponse.json(failure, { status: httpStatusForFailure(failure.code) });
  }
  const result = await buildSalesCampaignRoundDraft(parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : httpStatusForFailure(result.code) });
}

export const POST = withProxySource("product-search", handle);
