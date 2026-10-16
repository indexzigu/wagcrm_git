import { NextResponse } from "next/server";
import { withProxySource } from "@/lib/order-converter/proxy-usage";
import { agentInternalNotFound, verifyAgentInternalRequest } from "@/lib/agent-internal/auth";
import {
  agentInternalFailure,
  httpStatusForFailure,
  storeProductOptionsRequestSchema,
} from "@/lib/agent-internal/api-contract";
import { getStoreProductOptions } from "@/lib/agent-internal/store-product-options";

/**
 * POST /api/internal/agent/store-product-options — 봇 내부 창구: 주문캠페인의 네이버 등록 옵션 + 지금 매핑 값.
 * 봇 작업 `get_store_product_options` 가 루프백으로 부른다. 인증·닫힘 규칙은 `agent-internal/auth.ts` 가 정본이다.
 * 이 요청 안의 프록시(Fixie) 요청은 설정 창 옵션 조회와 같은 product-options 로 센다(상품 목록은 product-search).
 */
async function handle(request: Request): Promise<Response> {
  if (!verifyAgentInternalRequest(request)) return agentInternalNotFound();
  const body: unknown = await request.json().catch(() => null);
  const parsed = storeProductOptionsRequestSchema.safeParse(body);
  if (!parsed.success) {
    const failure = agentInternalFailure("INVALID_INPUT", "요청 모양이 올바르지 않습니다.");
    return NextResponse.json(failure, { status: httpStatusForFailure(failure.code) });
  }
  const result = await getStoreProductOptions(parsed.data.orderCampaignId);
  return NextResponse.json(result, { status: result.ok ? 200 : httpStatusForFailure(result.code) });
}

export const POST = withProxySource("product-options", handle);
