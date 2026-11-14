import {
  createSalesCampaignGroupRoundArgsSchema,
  type CreateSalesCampaignGroupRoundArgs,
} from "@/lib/agent-worker/contracts";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { ok } from "./types";

export type CreateSalesCampaignGroupRoundData = {
  writeIntent: WriteIntent;
};

/**
 * 결재함 카드·목록의 **제목** 한 줄 — 어느 셀러의 그룹을 캠페인 몇 개로, 언제, 어느 스토어 상품으로.
 * 상품명은 「…」로 감싼다(네이버 상품명은 판매자가 쓰는 자유 글이다).
 */
export function describeSalesCampaignGroupRoundProposal(
  args: Pick<CreateSalesCampaignGroupRoundArgs, "sellerName" | "members" | "startDate" | "endDate" | "product">,
): string {
  return [
    `판매캠페인 그룹 회차 등록: ${args.sellerName} · 캠페인 ${args.members.length}개`,
    `${args.startDate} ~ ${args.endDate}`,
    `스토어 상품 「${args.product.name.slice(0, 40)}」`,
  ].join(" · ");
}

/**
 * 판매캠페인 그룹 다음 회차 등록의 **기안 의도**만 만든다 — DB 를 읽지도 쓰지도 않는다. 초안(지난 그룹 + 스토어 값)은
 * 작업 실행기가 기안 직전에 CRM 앱 창구에서 받아 이 도구에 넘기고, 생성은 승인 시점에
 * `write-actions/create-sales-campaign-group-round.ts` 가 한다. 대상(target)은 null — 아직 없는 캠페인·그룹이다.
 */
async function execute(
  input: CreateSalesCampaignGroupRoundArgs,
): Promise<ToolResult<CreateSalesCampaignGroupRoundData>> {
  const writeIntent: WriteIntent = {
    action: "create_sales_campaign_group_round",
    args: input,
    summary: describeSalesCampaignGroupRoundProposal(input),
    targetEntityType: null,
    targetEntityId: null,
  };
  return ok({ writeIntent }, [], { previousGroupId: input.previousGroupId, members: input.members.length });
}

export const createSalesCampaignGroupRoundTool: AgentTool<
  CreateSalesCampaignGroupRoundArgs,
  CreateSalesCampaignGroupRoundData
> = {
  name: "create_sales_campaign_group_round",
  description:
    "지난 회차 캠페인 그룹(한 셀러의 판매 조건 여럿을 묶은 것)을 이어 다음 회차 캠페인들과 새 그룹을 한 번에 만드는 기안을 올립니다. " +
    "판매 조건·채널·마진·하위품목은 지난 그룹의 캠페인마다, 판매 기간·상품 링크는 기안 시점에 CRM 이 네이버 스토어에서 직접 읽어 채웁니다. " +
    "실제로 만들지 않고 승인 대기 기안만 만들며, 관리자가 직접 승인한 뒤에만 반영됩니다(자동 실행 없음).",
  inputSchema: createSalesCampaignGroupRoundArgsSchema,
  execute,
};
