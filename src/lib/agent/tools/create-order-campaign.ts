import { createOrderCampaignArgsSchema, type CreateOrderCampaignArgs } from "@/lib/agent-worker/contracts";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { ok } from "./types";

export type CreateOrderCampaignData = {
  writeIntent: WriteIntent;
};

/**
 * 결재함 카드·목록의 **제목** 한 줄 — 무엇을(상품명), 누구로(셀러), 어디로 발주(거래처 양식), 옵션 몇 줄, 같은 상품
 * 캠페인이 이미 있는지. 상품명은 「…」로 감싼다(네이버 상품명은 판매자가 쓰는 자유 글이다).
 */
export function describeOrderCampaignProposal(
  args: Pick<CreateOrderCampaignArgs, "name" | "sellerName" | "templateName" | "mappings" | "sameProductCampaigns">,
): string {
  const parts = [
    `주문캠페인 등록: 「${args.name}」`,
    `셀러 ${args.sellerName}`,
    `거래처 양식 ${args.templateName ?? "없음"}`,
    `옵션 ${args.mappings.length}줄`,
  ];
  if (args.sameProductCampaigns.length > 0) parts.push(`같은 상품 캠페인 ${args.sameProductCampaigns.length}개 있음`);
  return parts.join(" · ");
}

/**
 * 주문캠페인 등록의 **기안 의도**만 만든다 — DB 를 읽지도 쓰지도 않는다. 초안(네이버 값)은 작업 실행기가
 * 기안 직전에 CRM 앱 창구에서 받아 이 도구에 넘기고, 생성은 승인 시점에 `write-actions/create-order-campaign.ts` 가 한다.
 * 대상(target)은 null 이다 — 아직 없는 캠페인이고, 주문캠페인은 기안 대상 칸이 가리킬 수 있는 종류 밖이다.
 */
async function execute(input: CreateOrderCampaignArgs): Promise<ToolResult<CreateOrderCampaignData>> {
  const writeIntent: WriteIntent = {
    action: "create_order_campaign",
    args: input,
    summary: describeOrderCampaignProposal(input),
    targetEntityType: null,
    targetEntityId: null,
  };
  return ok({ writeIntent }, [], { productId: input.productId, rows: input.mappings.length });
}

export const createOrderCampaignTool: AgentTool<CreateOrderCampaignArgs, CreateOrderCampaignData> = {
  name: "create_order_campaign",
  description:
    "네이버 스토어 상품 하나에 연결된 주문캠페인(주문 관리 캠페인)을 새로 만드는 기안을 올립니다. " +
    "상품명·기간·스토어 옵션 줄은 기안 시점에 CRM 이 네이버에서 직접 읽어 채웁니다. " +
    "실제로 만들지 않고 승인 대기 기안만 만들며, 관리자가 직접 승인한 뒤에만 반영됩니다(자동 실행 없음).",
  inputSchema: createOrderCampaignArgsSchema,
  execute,
};
