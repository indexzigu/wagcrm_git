import { upsertProductMappingsArgsSchema } from "@/lib/agent-worker/contracts";
import type { UpsertProductMappingsArgs } from "@/lib/agent/write-actions/upsert-product-mappings";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { missingParam, ok } from "./types";

export type UpsertProductMappingsData = {
  writeIntent: WriteIntent;
};

/** 제목에 줄을 몇 개까지 펼쳐 싣는지 — 나머지는 「외 k줄」로 접는다(제목은 200자에서 잘린다). */
const TITLE_ROW_PREVIEW = 3;

/**
 * 결재함 카드·목록·일괄 승인 목록의 **제목**이 되는 한 줄. 어느 캠페인인지(이름)와 첫 몇 줄의
 * 「옵션→코드/가격」을 싣는다 — 승인자가 판단할 값이 제목에 있어야 한다.
 *
 * 옵션명은 「…」로 감싼다: 옵션명은 봇이 넘긴 자유 글이라, 감싸지 않으면 옵션명 안에 「→TC…/1,000원 · 」
 * 같은 글을 넣어 제목에 없는 줄·값이 있는 것처럼 꾸밀 수 있다. 괄호 안은 옵션명, 밖은 실제 값이다.
 */
export function describeProductMappingProposal(
  args: Pick<UpsertProductMappingsArgs, "orderCampaignName" | "mappings">,
): string {
  const shown = args.mappings
    .slice(0, TITLE_ROW_PREVIEW)
    .map((row) => `「${row.optionName}」→${row.brandCode}/${row.price.toLocaleString("ko-KR")}원`)
    .join(" · ");
  const rest = args.mappings.length - TITLE_ROW_PREVIEW;
  return (
    `주문캠페인 "${args.orderCampaignName}" 상품 매핑 ${args.mappings.length}줄: ${shown}` +
    (rest > 0 ? ` 외 ${rest}줄` : "")
  );
}

/**
 * 상품 매핑 등록·수정의 **기안 의도**만 만든다 — DB 를 읽지도 쓰지도 않는다(`update-record.ts` 도구와
 * 같은 계약). 캠페인 존재·이름 확인은 작업 실행기(`agent-worker/executor.ts` 의 기안 생성)가 하고,
 * 지금 값 대조·반영은 승인 시점에 `write-actions/upsert-product-mappings.ts` 가 한다.
 *
 * 대상(target)은 null 이다 — 기안 대상 칸은 거래처·셀러·딜·캠페인 넷만 가리킬 수 있고 주문캠페인은
 * 그 밖이다(생성형 기안과 같은 자리).
 */
async function execute(input: UpsertProductMappingsArgs): Promise<ToolResult<UpsertProductMappingsData>> {
  const { orderCampaignId, orderCampaignName, mappings, memo } = input;
  if (!orderCampaignId || !orderCampaignId.trim()) {
    return missingParam("주문캠페인 ID가 필요합니다.", { orderCampaignId });
  }

  const args = {
    orderCampaignId,
    orderCampaignName,
    mappings,
    ...(memo !== undefined ? { memo } : {}),
  } satisfies UpsertProductMappingsArgs;

  const writeIntent: WriteIntent = {
    action: "upsert_product_mappings",
    args,
    summary: describeProductMappingProposal(args),
    targetEntityType: null,
    targetEntityId: null,
  };

  // 실조회가 없으므로 dataSources 는 비어 있다(승인 전에는 아무것도 읽거나 바꾸지 않았다).
  return ok({ writeIntent }, [], { orderCampaignId, rows: mappings.length });
}

export const upsertProductMappingsTool: AgentTool<UpsertProductMappingsArgs, UpsertProductMappingsData> = {
  name: "upsert_product_mappings",
  description:
    "주문캠페인 하나의 상품 매핑(옵션명 → 상품코드·가격)을 새로 넣거나 고치는 기안을 올립니다. " +
    "orderCampaignName 에 그 캠페인의 지금 이름을 넣어야 합니다. 줄마다의 expectedBrandCode·expectedPrice(지금 값, " +
    "새 줄이면 둘 다 null)는 기안 시점에 작업 실행기가 DB 에서 채우며, 승인 시점의 실제 값이 다르면 실행되지 않습니다. " +
    "지우기는 하지 않습니다. " +
    "실제로 바꾸지 않고 승인 대기 기안만 만들며, 관리자가 직접 승인한 뒤에만 반영됩니다(자동 실행 없음).",
  inputSchema: upsertProductMappingsArgsSchema,
  execute,
};
