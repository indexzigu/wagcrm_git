import { NextResponse } from "next/server";
import { withProxySource } from "@/lib/order-converter/proxy-usage";
import { agentInternalNotFound, verifyAgentInternalRequest } from "@/lib/agent-internal/auth";
import {
  agentInternalFailure,
  applyProductMappingsRequestSchema,
  httpStatusForFailure,
} from "@/lib/agent-internal/api-contract";
import { applyProductMappings } from "@/lib/agent-internal/apply-product-mappings";

/**
 * POST /api/internal/agent/apply-product-mappings — 봇 내부 창구: 스토어 옵션 줄의 상품코드·가격 즉시 저장.
 * 봇 작업 `apply_product_mappings` 가 루프백으로 부른다. 무엇을 거르고 어떻게 저장·기록하는지는
 * `agent-internal/apply-product-mappings.ts` 헤더가 정본이다. 인증·닫힘 규칙은 `agent-internal/auth.ts`.
 */
async function handle(request: Request): Promise<Response> {
  if (!verifyAgentInternalRequest(request)) return agentInternalNotFound();
  const body: unknown = await request.json().catch(() => null);
  const parsed = applyProductMappingsRequestSchema.safeParse(body);
  if (!parsed.success) {
    const failure = agentInternalFailure("INVALID_INPUT", "요청 모양이 올바르지 않습니다.");
    return NextResponse.json(failure, { status: httpStatusForFailure(failure.code) });
  }
  const result = await applyProductMappings(parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : httpStatusForFailure(result.code) });
}

export const POST = withProxySource("product-options", handle);
