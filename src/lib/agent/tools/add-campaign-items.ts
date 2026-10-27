import { addCampaignItemsArgsSchema, type AddCampaignItemsArgs } from "@/lib/agent-worker/contracts";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { missingParam, ok } from "./types";

export type AddCampaignItemsData = {
  writeIntent: WriteIntent;
};

/** 제목에 줄을 몇 개까지 펼쳐 싣는지 — 나머지는 「외 k줄」로 접는다(제목은 200자에서 잘린다). */
const TITLE_ROW_PREVIEW = 3;

/**
 * 결재함 카드·목록·일괄 승인 목록의 **제목**이 되는 한 줄. 새로 만들 하위품목은 이름과 판매가, 연결할 하위품목은
 * 건수만 싣는다 — 연결 줄의 id 는 승인자가 읽을 수 없어 제목에 넣지 않는다(이름은 미리보기가 서버 해석으로 보인다).
 * 어느 캠페인인지는 대상(target) 라벨이 보여 준다.
 *
 * 하위품목 이름은 「…」로 감싼다: 봇이 넘긴 자유 글이라, 감싸지 않으면 이름 안에 「· 9,900원」 같은 글을 넣어
 * 제목에 없는 값이 있는 것처럼 꾸밀 수 있다(`upsert-product-mappings.ts` 도구와 같은 규칙).
 */
export function describeCampaignItemsProposal(args: Pick<AddCampaignItemsArgs, "items">): string {
  const created = args.items.filter((row) => !row.dealId);
  const linked = args.items.length - created.length;
  const shown = created
    .slice(0, TITLE_ROW_PREVIEW)
    .map((row) => `「${row.dealName}」` + (row.sellingPrice !== undefined ? ` ${row.sellingPrice.toLocaleString("ko-KR")}원` : ""));
  const rest = created.length - shown.length;
  const parts = [
    ...(shown.length > 0 ? [`새 하위품목 ${shown.join(" · ")}${rest > 0 ? ` 외 ${rest}건` : ""}`] : []),
    ...(linked > 0 ? [`기존 하위품목 연결 ${linked}건`] : []),
  ];
  return `캠페인 품목 ${args.items.length}건 추가: ${parts.join(" / ")}`;
}

/**
 * 판매캠페인 품목 추가의 **기안 의도**만 만든다 — DB 를 읽지도 쓰지도 않는다(`upsert-product-mappings.ts` 도구와
 * 같은 계약). 캠페인 존재·판매 조건·하위품목 소속 확인은 작업 실행기(`agent-worker/executor.ts` 의 기안 생성)가,
 * 반영은 승인 시점에 `write-actions/add-campaign-items.ts` 가 한다.
 */
async function execute(input: AddCampaignItemsArgs): Promise<ToolResult<AddCampaignItemsData>> {
  const { campaignId, mainDealId, items, memo } = input;
  if (!campaignId || !campaignId.trim()) {
    return missingParam("판매캠페인 ID가 필요합니다.", { campaignId });
  }

  const args = {
    campaignId,
    mainDealId,
    items,
    ...(memo !== undefined ? { memo } : {}),
  } satisfies AddCampaignItemsArgs;

  const writeIntent: WriteIntent = {
    action: "add_campaign_items",
    args,
    summary: describeCampaignItemsProposal(args),
    targetEntityType: "CAMPAIGN",
    targetEntityId: campaignId,
  };

  // 실조회가 없으므로 dataSources 는 비어 있다(승인 전에는 아무것도 읽거나 바꾸지 않았다).
  return ok({ writeIntent }, [], { campaignId, rows: items.length });
}

export const addCampaignItemsTool: AgentTool<AddCampaignItemsArgs, AddCampaignItemsData> = {
  name: "add_campaign_items",
  description:
    "판매캠페인 하나의 품목(매출 상세내역 줄)에 하위품목을 덧붙이는 기안을 올립니다. mainDealId 에는 그 캠페인의 지금 " +
    "판매 조건 id 를 넣습니다(get_campaign_items 로 확인). 줄마다 이미 있는 하위품목이면 dealId, 새 하위품목이면 " +
    "dealName·sellingPrice(선택: totalCommissionRate %, unitQuantity)를 넣습니다. dealName 은 옵션 이름(예: 3개입)만 넣어도 " +
    "CRM 이 판매 조건 화면과 같이 「판매 조건 이름 - 옵션 이름」으로 저장합니다. 기존 품목은 고치거나 지우지 않습니다. " +
    "실제로 바꾸지 않고 승인 대기 기안만 만들며, 관리자가 직접 승인한 뒤에만 반영됩니다(자동 실행 없음).",
  inputSchema: addCampaignItemsArgsSchema,
  execute,
};
