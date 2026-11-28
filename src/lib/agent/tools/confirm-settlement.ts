import { z } from "zod";
import { SETTLEMENT_TARGETS, type SettlementTarget } from "@/lib/settlement-status";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { missingParam, ok } from "./types";

const inputSchema = z.object({
  campaignId: z.string().min(1).describe("정산 상태를 확정할 캠페인(SalesCampaign)의 ID"),
  target: z
    .enum(SETTLEMENT_TARGETS)
    .describe(
      "완료로 표시할 대금 칸. 판매채널마다 뜻이 다릅니다 — " +
        "자사몰: supplierPayout=공급사(브랜드·거래처) 지급(먼저), payout=셀러 지급(공급사 지급 뒤), deposit 없음. " +
        "브랜드몰: deposit=공급사(브랜드) 입금(먼저), payout=셀러 지급. " +
        "셀러몰: deposit=셀러 입금(먼저), payout=공급사 지급(지급 칸이 하나뿐), supplierPayout 없음."
    ),
  completedOn: z
    .string()
    .date()
    .optional()
    .describe(
      "오너가 말한 지급일·입금일(YYYY-MM-DD, 한국 날짜). 오너가 날짜를 말했으면 넣습니다. " +
        "없으면 승인한 날로 기록합니다. 미래 날짜는 넣지 말고 오너에게 날짜를 되묻습니다."
    ),
});

export type ConfirmSettlementInput = z.infer<typeof inputSchema>;

export type ConfirmSettlementData = {
  writeIntent: WriteIntent;
};

/**
 * 기안 요약용 타깃 이름. 이 도구는 캠페인을 읽지 않아 채널을 모른다 — 그래서 상대(셀러·공급사)를 지어내지 않고
 * 축만 적는다(자사몰 `payout` = 셀러 지급, 셀러몰 `payout` = 공급사 지급). 정확한 칸 이름은 승인 시점 실행기
 * 결과 요약(`settlementSlotLabel`)과 슬랙 카드가 슬롯에서 적는다. 이 요약은 카드에 싣지 않는다(카드 R5).
 */
const TARGET_INTENT_LABEL: Record<SettlementTarget, string> = {
  deposit: "입금확정",
  payout: "지급완료",
  supplierPayout: "공급사 지급완료",
};

/**
 * 청사진 §0-1 / §3-a: 이 도구는 실제 정산 확정도, ActionProposal 기안 생성도, 캠페인
 * 조회도 하지 않는다. execute(input)는 userId를 모르므로(AgentTool 계약) 구조화된
 * writeIntent만 반환하고, 호출자(agent worker 실행기)가 userId를 채워 단일 지점에서
 * 기안을 생성한다. 정산 상태기계(전진 전용) 검증과 status 자동전이는 승인 시점에
 * write-executor.handleConfirmSettlement에서 수행된다 — 이 도구는 args 형식만 검증한다.
 *
 * 🔴 금전 영향: approval.rules.json에서 settlement_confirm은 alwaysManual(자동승인 영구
 * 제외). 이 도구가 만든 기안은 반드시 관리자 수동 승인을 거친다.
 */
async function execute(input: ConfirmSettlementInput): Promise<ToolResult<ConfirmSettlementData>> {
  const { campaignId, target, completedOn } = input;

  if (!campaignId || !campaignId.trim()) {
    return missingParam("정산을 확정할 캠페인 ID가 필요합니다.", { campaignId, target });
  }

  const targetLabel = TARGET_INTENT_LABEL[target];
  // 날짜는 받은 그대로 싣는다 — 미래 날짜 거부는 실행기(`checkSettlementCompletedOn`)가 승인 시점의 「오늘」로 한다.
  const args: { campaignId: string; target: SettlementTarget; completedOn?: string } = completedOn
    ? { campaignId, target, completedOn }
    : { campaignId, target };

  const writeIntent: WriteIntent = {
    action: "confirm_settlement",
    args,
    summary: `캠페인(${campaignId}) 정산 ${targetLabel} 처리${completedOn ? ` (${completedOn})` : ""}`,
    targetEntityType: "CAMPAIGN",
    targetEntityId: campaignId,
  };

  // READ 도구와 달리 실조회가 없으므로 dataSources는 빈 배열이다 — 승인 전에는 아무
  // 데이터도 조회/변경하지 않았다는 사실을 evidence에 그대로 반영한다.
  return ok({ writeIntent }, [], { campaignId, target, ...(completedOn ? { completedOn } : {}) });
}

export const confirmSettlementTool: AgentTool<ConfirmSettlementInput, ConfirmSettlementData> = {
  name: "confirm_settlement",
  description:
    "특정 캠페인의 대금 칸 하나를 완료로 표시합니다. 캠페인 ID가 필요하며 " +
    "(get_settlement_report로 먼저 조회), 사용자가 입금·지급을 마쳤다고 명시적으로 말할 때만 사용합니다. " +
    "칸은 판매채널(salesChannel)마다 다릅니다 — " +
    "자사몰(OWN_MALL_*): 입금 칸이 없고 지급 칸이 둘입니다. target=supplierPayout(공급사·브랜드·거래처 지급, 먼저) → " +
    "target=payout(셀러 지급, 공급사 지급이 끝나야 가능). " +
    "브랜드몰(BRAND_MALL): target=deposit(공급사·브랜드 입금, 먼저) → target=payout(셀러 지급). " +
    "셀러몰(그 밖의 채널): target=deposit(셀러 입금, 먼저) → target=payout(공급사 지급). 이 채널에는 supplierPayout 이 없습니다. " +
    "오너가 공급사·브랜드에 돈을 보냈다고 하면 자사몰은 supplierPayout, 셀러몰은 payout 입니다. " +
    "오너가 지급일·입금일을 말했으면 completedOn(YYYY-MM-DD)에 넣습니다. 그 날짜가 오늘보다 뒤면 기안하지 말고 오너에게 날짜를 되묻습니다. " +
    "순서를 건너뛰거나 이미 끝난 칸, 금액이 비어 있거나 0원인 칸은 승인해도 적용되지 않습니다. " +
    "되돌리기(완료 취소)는 이 도구로 할 수 없습니다. " +
    "금전 관련이라 실제로 바꾸지 않고 승인 대기 기안을 생성합니다 — 관리자 승인 후에만 실제 반영됩니다.",
  inputSchema,
  execute,
};
