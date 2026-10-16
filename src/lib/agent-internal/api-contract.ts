import { z } from "zod";
import {
  AgentJobSlackOriginSchema,
  applyProductMappingRowSchema,
  MAX_PRODUCT_MAPPING_ROWS,
  opaqueIdSchema,
  productMappingsAppliedStructuredDataSchema,
  refineDistinctMappingOptionNames,
  storeProductOptionsStructuredDataSchema,
} from "@/lib/agent-worker/contracts";

/**
 * 봇 내부 창구의 요청·응답 모양 — 창구(앱)와 부르는 쪽(봇 작업 실행기)이 같은 스키마를 import 한다.
 * 결과 데이터 모양의 정본은 작업 계약(`agent-worker/contracts.ts`)이다 — 봇이 받는 structuredData 와 같은 값이다.
 */
/** 비밀값을 싣는 헤더 — 창구 인증(`agent-internal/auth.ts`)과 부르는 쪽(`agent-worker/internal-api-client.ts`)이 함께 쓴다. */
export const AGENT_INTERNAL_SECRET_HEADER = "x-agent-internal-secret";

export const AGENT_INTERNAL_PATHS = {
  storeProductOptions: "/api/internal/agent/store-product-options",
  applyProductMappings: "/api/internal/agent/apply-product-mappings",
} as const;

export const storeProductOptionsRequestSchema = z
  .object({
    orderCampaignId: opaqueIdSchema,
  })
  .strict();

export type StoreProductOptionsRequest = z.infer<typeof storeProductOptionsRequestSchema>;

/** 즉시 저장 요청 — 작업 입력에 슬랙 위치(기안 출처 칸)를 더했다. */
export const applyProductMappingsRequestSchema = z
  .object({
    orderCampaignId: opaqueIdSchema,
    mappings: z.array(applyProductMappingRowSchema).min(1).max(MAX_PRODUCT_MAPPING_ROWS),
    slack: AgentJobSlackOriginSchema.optional(),
  })
  .strict()
  .superRefine(refineDistinctMappingOptionNames);

export type ApplyProductMappingsRequest = z.infer<typeof applyProductMappingsRequestSchema>;

/**
 * 창구 실패 코드. 봇 작업 결과 요약에 그대로 실린다(`… failed: <code> (<message>)`).
 * - CAMPAIGN_NOT_FOUND: 주문캠페인 없음
 * - NO_STORE_OPTIONS: 캠페인에 연결된 스토어 상품이 없거나(목록에서 번호 불일치) 그 상품에 이름 있는 옵션이 없음
 * - STORE_FETCH_FAILED: 네이버 조회 실패
 * - OPTIONS_TOO_LARGE: 옵션 표가 결과 상한을 넘음(잘라서 주지 않는다)
 * - DUPLICATE_MAPPING · OUT_OF_RANGE: 지금 매핑 줄을 기안 값으로 옮길 수 없음(화면에서 정리)
 * - APPLY_FAILED: 저장 실행이 실패함(결재함에 FAILED 기록이 남는다)
 * - INVALID_INPUT: 요청 모양이 틀림
 */
export const AGENT_INTERNAL_FAILURE_CODES = [
  "CAMPAIGN_NOT_FOUND",
  "NO_STORE_OPTIONS",
  "STORE_FETCH_FAILED",
  "OPTIONS_TOO_LARGE",
  "DUPLICATE_MAPPING",
  "OUT_OF_RANGE",
  "APPLY_FAILED",
  "INVALID_INPUT",
] as const;

export type AgentInternalFailureCode = (typeof AGENT_INTERNAL_FAILURE_CODES)[number];

/** 실패 문구 상한 — 봇 결과 요약(2000자) 안에 들어가게 한다. */
export const MAX_AGENT_INTERNAL_MESSAGE_CHARS = 300;

const failureSchema = z
  .object({
    ok: z.literal(false),
    code: z.enum(AGENT_INTERNAL_FAILURE_CODES),
    message: z.string().max(MAX_AGENT_INTERNAL_MESSAGE_CHARS),
  })
  .strict();

export type AgentInternalFailure = z.infer<typeof failureSchema>;

export const storeProductOptionsResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: storeProductOptionsStructuredDataSchema }).strict(),
  failureSchema,
]);

export const applyProductMappingsResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: productMappingsAppliedStructuredDataSchema }).strict(),
  failureSchema,
]);

export function agentInternalFailure(code: AgentInternalFailureCode, message: string): AgentInternalFailure {
  return { ok: false, code, message: message.slice(0, MAX_AGENT_INTERNAL_MESSAGE_CHARS) };
}

/** 실패 코드별 HTTP 상태 — 부르는 쪽은 본문으로 가르지만, 로그·모니터링이 읽기 쉽게 맞춘다. */
export function httpStatusForFailure(code: AgentInternalFailureCode): number {
  switch (code) {
    // CAMPAIGN_NOT_FOUND 도 422 다 — 404 는 인증 실패(본문 없음)가 쓰므로 겹치지 않게 한다.
    case "STORE_FETCH_FAILED":
      return 502;
    case "APPLY_FAILED":
      return 502;
    case "INVALID_INPUT":
      return 400;
    default:
      return 422;
  }
}
