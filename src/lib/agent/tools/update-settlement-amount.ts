import type { z } from "zod";
import { updateSettlementAmountArgsSchema } from "@/lib/agent-worker/contracts";
import {
  SETTLEMENT_AMOUNT_FIELD_LABELS,
  formatSettlementAmountKrw,
} from "@/lib/settlement-amount-fields";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { missingParam, ok } from "./types";

export type UpdateSettlementAmountInput = z.infer<typeof updateSettlementAmountArgsSchema>;

export type UpdateSettlementAmountData = {
  writeIntent: WriteIntent;
};

/**
 * 정산 금액 칸 정정의 **기안 의도**만 만든다 — 캠페인을 조회하지도, 값을 바꾸지도 않는다
 * (`confirm-settlement.ts` 도구와 같은 계약). 현재 값 대조·정산 확정 거부·파생 재계산은 승인
 * 시점에 `write-actions/update-settlement-amount.ts` 가 한다.
 *
 * 요약 줄은 결재함 카드 제목이 된다 — 무엇을 무엇으로 바꾸는지(칸 이름·기안자가 본 값·새 값)를
 * 한 줄에 싣는다. 승인자가 판단할 값이 제목에 없으면 승인 게이트가 내용을 모른 채 누르는 버튼이
 * 된다(`proposal-payload-preview.tsx` 머리 주석).
 */
async function execute(input: UpdateSettlementAmountInput): Promise<ToolResult<UpdateSettlementAmountData>> {
  const { campaignId, field, expectedCurrentKrw, newAmountKrw, memo } = input;

  if (!campaignId || !campaignId.trim()) {
    return missingParam("금액을 고칠 캠페인 ID가 필요합니다.", { campaignId, field });
  }

  const label = SETTLEMENT_AMOUNT_FIELD_LABELS[field];
  const args = {
    campaignId,
    field,
    expectedCurrentKrw,
    newAmountKrw,
    ...(memo !== undefined ? { memo } : {}),
  } satisfies UpdateSettlementAmountInput;

  const writeIntent: WriteIntent = {
    action: "update_settlement_amount",
    args,
    summary:
      `캠페인(${campaignId}) 정산 금액 수정: ${label} ` +
      `${formatSettlementAmountKrw(expectedCurrentKrw)} → ${formatSettlementAmountKrw(newAmountKrw)}`,
    targetEntityType: "CAMPAIGN",
    targetEntityId: campaignId,
  };

  // 실조회가 없으므로 dataSources 는 비어 있다(승인 전에는 아무것도 읽거나 바꾸지 않았다).
  return ok({ writeIntent }, [], { campaignId, field });
}

export const updateSettlementAmountTool: AgentTool<UpdateSettlementAmountInput, UpdateSettlementAmountData> = {
  name: "update_settlement_amount",
  description:
    "정산이 확정되기 전인 캠페인의 금액 칸 하나(총 거래액·영업 수익·판매대행비·제세공과금·공동 운영 비용·" +
    "기타 조정 비용·공급가액·물품대금)를 고치는 기안을 올립니다. expectedCurrentKrw 에는 지금 보이는 값" +
    "(비어 있으면 null, 0 과 다릅니다)을 넣어야 하며, 승인 시점의 실제 값이 다르면 실행되지 않습니다. " +
    "금전 관련이라 실제로 바꾸지 않고 승인 대기 기안만 만듭니다. 관리자 승인 후에만 반영됩니다.",
  inputSchema: updateSettlementAmountArgsSchema,
  execute,
};
