import { z } from "zod";
import type { SettlementTarget } from "@/lib/settlement-status";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { missingParam, ok } from "./types";

const inputSchema = z.object({
  campaignId: z.string().min(1).describe("정산 상태를 확정할 캠페인(SalesCampaign)의 ID"),
  target: z
    .enum(["deposit", "payout"])
    .describe(
      "확정할 정산 축. deposit=입금확정(예정→확정), payout=지급완료(확정→지급완료). " +
        "지급완료는 입금확정이 선행돼야 합니다."
    ),
});

export type ConfirmSettlementInput = z.infer<typeof inputSchema>;

export type ConfirmSettlementData = {
  writeIntent: WriteIntent;
};

/**
 * 청사진 §0-1 / §3-a: 이 도구는 실제 정산 확정도, ActionProposal 기안 생성도, 캠페인
 * 조회도 하지 않는다. execute(input)는 userId를 모르므로(AgentTool 계약) 구조화된
 * writeIntent만 반환하고, /api/assistant route가 userId를 채워 단일 지점에서 기안을
 * 생성한다. 정산 상태기계(전진 전용) 검증과 status 자동전이는 승인 시점에
 * write-executor.handleConfirmSettlement에서 수행된다 — 이 도구는 args 형식만 검증한다.
 *
 * 🔴 금전 영향: approval.rules.json에서 settlement_confirm은 alwaysManual(자동승인 영구
 * 제외). 이 도구가 만든 기안은 반드시 관리자 수동 승인을 거친다.
 */
async function execute(input: ConfirmSettlementInput): Promise<ToolResult<ConfirmSettlementData>> {
  const { campaignId, target } = input;

  if (!campaignId || !campaignId.trim()) {
    return missingParam("정산을 확정할 캠페인 ID가 필요합니다.", { campaignId, target });
  }

  const targetLabel = target === "deposit" ? "입금확정" : "지급완료";

  const writeIntent: WriteIntent = {
    action: "confirm_settlement",
    args: { campaignId, target } satisfies { campaignId: string; target: SettlementTarget },
    summary: `캠페인(${campaignId}) 정산 ${targetLabel} 처리`,
    targetEntityType: "CAMPAIGN",
    targetEntityId: campaignId,
  };

  // READ 도구와 달리 실조회가 없으므로 dataSources는 빈 배열이다 — 승인 전에는 아무
  // 데이터도 조회/변경하지 않았다는 사실을 evidence에 그대로 반영한다.
  return ok({ writeIntent }, [], { campaignId, target });
}

export const confirmSettlementTool: AgentTool<ConfirmSettlementInput, ConfirmSettlementData> = {
  name: "confirm_settlement",
  description:
    "특정 캠페인의 정산 상태를 전진시킵니다(입금확정 → 지급완료). 캠페인 ID가 필요하며 " +
    "(get_settlement_report로 먼저 조회), 사용자가 정산 확정을 명시적으로 요청할 때만 사용합니다. " +
    "target=deposit(입금확정: 예정→확정), target=payout(지급완료: 확정→지급완료). " +
    "지급완료는 입금확정이 선행돼야 하며, 되돌리기(확정 취소)는 이 도구로 할 수 없습니다. " +
    "금전 관련이라 실제로 바꾸지 않고 승인 대기 기안을 생성합니다 — 관리자 승인 후에만 실제 반영됩니다.",
  inputSchema,
  execute,
};
