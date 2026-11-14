import { z } from "zod";
import {
  AgentJobSlackOriginSchema,
  applyProductMappingRowSchema,
  createOrderCampaignArgsSchema,
  salesCampaignRoundArgsObjectSchema,
  refineSalesRoundPeriod,
  createSalesCampaignRoundRequestSchema,
  refineSalesCampaignRoundRequest,
  salesCampaignGroupRoundArgsObjectSchema,
  createSalesCampaignGroupRoundRequestSchema,
  refineSalesCampaignGroupRoundRequest,
  createOrderCampaignRequestSchema,
  MAX_PRODUCT_MAPPING_ROWS,
  opaqueIdSchema,
  productMappingsAppliedStructuredDataSchema,
  refineDistinctMappingOptionNames,
  refineOrderCampaignProductTarget,
  storeProductOptionsStructuredDataSchema,
} from "@/lib/agent-worker/contracts";

/**
 * 봇 내부 창구의 요청·응답 모양 — 창구(앱)와 부르는 쪽(봇 작업 실행기)이 같은 스키마를 import 한다.
 * 결과 데이터 모양의 정본은 작업 계약(`agent-worker/contracts.ts`)이다 — 봇이 받는 structuredData 와 같은 값이다.
 */
/** 비밀값을 싣는 헤더 — 창구 인증(`agent-internal/auth.ts`)과 부르는 쪽(`agent-worker/internal-api-client.ts`)이 함께 쓴다. */
export const AGENT_INTERNAL_SECRET_HEADER = "x-agent-internal-secret";

/** 루프백 호스트 이름 — 창구의 Host 검사(`auth.ts`)와 워커 클라이언트의 주소 검사가 같은 목록을 쓴다. */
export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const AGENT_INTERNAL_PATHS = {
  storeProductOptions: "/api/internal/agent/store-product-options",
  applyProductMappings: "/api/internal/agent/apply-product-mappings",
  orderCampaignDraft: "/api/internal/agent/order-campaign-draft",
  salesCampaignRoundDraft: "/api/internal/agent/sales-campaign-round-draft",
  salesCampaignGroupRoundDraft: "/api/internal/agent/sales-campaign-group-round-draft",
  slackDecision: "/api/internal/agent/slack-decision",
} as const;

export const storeProductOptionsRequestSchema = z
  .object({
    orderCampaignId: opaqueIdSchema,
  })
  .strict();

export type StoreProductOptionsRequest = z.infer<typeof storeProductOptionsRequestSchema>;

/** 매핑 기안 요청 — 작업 입력에 슬랙 위치(기안 출처 칸)를 더했다. */
export const applyProductMappingsRequestSchema = z
  .object({
    orderCampaignId: opaqueIdSchema,
    mappings: z.array(applyProductMappingRowSchema).min(1).max(MAX_PRODUCT_MAPPING_ROWS),
    slack: AgentJobSlackOriginSchema.optional(),
  })
  .strict()
  .superRefine(refineDistinctMappingOptionNames);

export type ApplyProductMappingsRequest = z.infer<typeof applyProductMappingsRequestSchema>;

/** 주문캠페인 기안 초안 요청 — 봇 기안 입력에서 메모만 뺀 것(메모는 실행기가 저장 args 에 붙인다). */
export const orderCampaignDraftRequestSchema = createOrderCampaignRequestSchema
  .omit({ memo: true })
  .strict()
  .superRefine(refineOrderCampaignProductTarget);

export type OrderCampaignDraftRequest = z.infer<typeof orderCampaignDraftRequestSchema>;

/** 초안 = 저장 args(메모 제외). 실행기가 메모를 붙여 저장 스키마로 다시 잰다. */
export const orderCampaignDraftDataSchema = createOrderCampaignArgsSchema.omit({ memo: true }).strict();

export type OrderCampaignDraftData = z.infer<typeof orderCampaignDraftDataSchema>;

/** 판매캠페인 다음 회차 기안 초안 요청 — 봇 기안 입력에서 메모만 뺀 것(메모는 실행기가 저장 args 에 붙인다). */
export const salesCampaignRoundDraftRequestSchema = createSalesCampaignRoundRequestSchema
  .omit({ memo: true })
  .strict()
  .superRefine(refineSalesCampaignRoundRequest);

export type SalesCampaignRoundDraftRequest = z.infer<typeof salesCampaignRoundDraftRequestSchema>;

/** 초안 = 저장 args(메모 제외). 실행기가 메모를 붙여 저장 스키마로 다시 잰다. */
export const salesCampaignRoundDraftDataSchema = salesCampaignRoundArgsObjectSchema
  .omit({ memo: true })
  .strict()
  .superRefine(refineSalesRoundPeriod);

export type SalesCampaignRoundDraftData = z.infer<typeof salesCampaignRoundDraftDataSchema>;

/** 판매캠페인 그룹 다음 회차 기안 초안 요청 — 단건과 같이 메모만 뺀다. */
export const salesCampaignGroupRoundDraftRequestSchema = createSalesCampaignGroupRoundRequestSchema
  .omit({ memo: true })
  .strict()
  .superRefine(refineSalesCampaignGroupRoundRequest);

export type SalesCampaignGroupRoundDraftRequest = z.infer<typeof salesCampaignGroupRoundDraftRequestSchema>;

export const salesCampaignGroupRoundDraftDataSchema = salesCampaignGroupRoundArgsObjectSchema
  .omit({ memo: true })
  .strict()
  .superRefine(refineSalesRoundPeriod);

export type SalesCampaignGroupRoundDraftData = z.infer<typeof salesCampaignGroupRoundDraftDataSchema>;

/**
 * 창구 실패 코드. 봇 작업 결과 요약에 그대로 실린다(`… failed: <code> (<message>)`).
 * - CAMPAIGN_NOT_FOUND: 주문캠페인 없음
 * - NO_STORE_OPTIONS: 캠페인에 연결된 스토어 상품이 없거나(목록에서 번호 불일치) 그 상품에 이름 있는 옵션이 없음
 * - STORE_FETCH_FAILED: 네이버 조회 실패(주문캠페인 초안은 거래처 양식·같은 상품 캠페인 DB 조회 실패도)
 * - OPTIONS_TOO_LARGE: 옵션 표가 결과 상한을 넘음(잘라서 주지 않는다)
 * - DUPLICATE_MAPPING · OUT_OF_RANGE: 지금 매핑 줄을 기안 값으로 옮길 수 없음(화면에서 정리)
 * - APPLY_FAILED: 저장 실행이 실패함(결재함에 FAILED 기록이 남는다)
 * - INVALID_INPUT: 요청 모양이 틀림
 * - PRODUCT_NOT_FOUND: 상품명 일부·상품번호에 맞는 스토어 상품이 없음
 * - PRODUCT_AMBIGUOUS: 상품명 일부가 여러 상품에 걸림(문구에 후보 이름·번호를 싣는다 — 봇이 오너에게 고르게 한다)
 * - ORDER_BRAND_NOT_FOUND: 발주 거래처(거래처 양식)를 찾지 못했거나 여럿에 걸림
 * - SELLER_NAME_REQUIRED: 셀러 이름을 상품명에서 찾지 못했고 입력에도 없음
 * - PRODUCT_REQUIRED: 판매캠페인 회차 기안에서 상품 지목이 없고 이전 회차에 연결된 스토어 상품도 없음
 * - SALE_PERIOD_UNAVAILABLE: 스토어 판매 기간이 없거나(미등록·기간 미정·끝 없음) 이미 끝남 — 날짜를 받아 다시 올린다
 * - ROUND_ALREADY_EXISTS: 같은 판매 조건·셀러에 같은 기간의 캠페인이 이미 있음
 * - PREVIOUS_GROUP_NOT_FOUND: 그룹 회차 기안에서 지목한 캠페인이 그룹에 속하지 않았거나, 같은 스토어 상품을 쓴 지난 그룹이 없음
 * (판매캠페인 회차 기안의 이전 회차가 없으면 CAMPAIGN_NOT_FOUND)
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
  "PRODUCT_NOT_FOUND",
  "PRODUCT_AMBIGUOUS",
  "ORDER_BRAND_NOT_FOUND",
  "SELLER_NAME_REQUIRED",
  "PRODUCT_REQUIRED",
  "SALE_PERIOD_UNAVAILABLE",
  "ROUND_ALREADY_EXISTS",
  "PREVIOUS_GROUP_NOT_FOUND",
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

export const orderCampaignDraftResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: orderCampaignDraftDataSchema }).strict(),
  failureSchema,
]);

export const salesCampaignRoundDraftResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: salesCampaignRoundDraftDataSchema }).strict(),
  failureSchema,
]);

export const salesCampaignGroupRoundDraftResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: salesCampaignGroupRoundDraftDataSchema }).strict(),
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
    case "APPLY_FAILED":
      return 502;
    case "INVALID_INPUT":
      return 400;
    default:
      return 422;
  }
}

/**
 * 슬랙 버튼 결정 요청 — 기안 ID 와 결정 둘뿐(그 밖의 칸은 거부). 슬랙 채널·메시지 좌표는 싣지 않는다 —
 * CRM 에 슬랙 식별자를 새로 남기지 않는다(카드 좌표는 hermes 로컬 상태에만 있다).
 */
export const slackDecisionRequestSchema = z
  .object({
    proposalId: opaqueIdSchema,
    decision: z.enum(["approve", "reject"]),
  })
  .strict();

export type SlackDecisionRequest = z.infer<typeof slackDecisionRequestSchema>;

/**
 * 슬랙 버튼 결정 응답 — hermes 가 이 값으로 카드를 고친다(`plugins/wag-operator` 사본 계약).
 *  - `ok:true` → `status` 는 처리 뒤 상태(`EXECUTED`·`REJECTED`). `executedRef` 는 실행이 남긴 결과 참조(예: 새 딜
 *    `DEAL:<id>`) — 결재함 조회(`get_action_proposal` 첫 줄의 `executedRef=`)와 같은 값이다. 반려·참조 없음이면 `null`.
 *    hermes 는 이 값으로 버튼을 누른 즉시 봇 대화에 결과 줄을 넣는다 — 칸이 **있다는 것**이 「이 CRM 은 참조를 싣는다」는
 *    신호라, 값이 없어도 칸은 항상 싣는다(빠지면 hermes 는 확인 작업 경로로 되돌아간다).
 *  - `NOT_FOUND` 기안 없음 · `NOT_ELIGIBLE` 봇 기안이 아니거나 버튼 허용 액션이 아님(결재함에서 승인)
 *  - `ALREADY_DECIDED` 이미 처리됨 — `status` 는 다시 읽은 현재 상태
 *  - `EXECUTION_FAILED` 승인했으나 실행 실패(`status` = `FAILED`) · `INVALID_INPUT` 모양 오류 · `INTERNAL` 그 밖의 오류
 */
export const SLACK_DECISION_FAILURE_CODES = [
  "NOT_FOUND",
  "NOT_ELIGIBLE",
  "ALREADY_DECIDED",
  "EXECUTION_FAILED",
  "INVALID_INPUT",
  "INTERNAL",
] as const;

export type SlackDecisionFailureCode = (typeof SLACK_DECISION_FAILURE_CODES)[number];

/** 실행 결과 참조 — 종류는 대문자·밑줄, id 는 불투명 id 글자만(hermes 가 같은 형식으로 다시 검사한다). */
export type SlackDecisionExecutedRef = { type: string; id: string };

export type SlackDecisionResponse =
  | { ok: true; status: "EXECUTED"; executedRef: SlackDecisionExecutedRef | null }
  | { ok: true; status: "REJECTED"; executedRef: null }
  | { ok: false; code: SlackDecisionFailureCode; status: string | null };
