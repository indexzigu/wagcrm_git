import { z } from "zod";
import { DEAL_STATUSES, type DealStatus } from "@/lib/deal-status";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { missingParam, ok } from "./types";

const inputSchema = z.object({
  dealId: z.string().min(1).describe("상태를 변경할 딜의 ID"),
  newStatus: z
    .enum(DEAL_STATUSES as [DealStatus, ...DealStatus[]])
    .describe("변경할 딜의 새 상태 (SOURCING, NEGOTIATING, SAMPLE_TESTING, CONFIRMED, ARCHIVED, DROPPED)"),
});

export type ChangeDealStatusInput = z.infer<typeof inputSchema>;

export type ChangeDealStatusData = {
  writeIntent: WriteIntent;
};

/**
 * 청사진 §0-1: 이 도구는 실제 딜 상태 변경도, ActionProposal 기안 생성도, 딜 조회도
 * 하지 않는다. execute(input)는 userId를 알지 못하므로(AgentTool 계약), 구조화된
 * writeIntent만 반환하고 /api/assistant route가 userId를 채워 단일 지점에서 기안을
 * 생성한다. 딜 상태기계(isValidTransition) 검증은 승인 시점에 write-executor에서
 * 수행된다 — 이 도구는 args 형식(enum) 검증만 한다.
 */
async function execute(input: ChangeDealStatusInput): Promise<ToolResult<ChangeDealStatusData>> {
  const { dealId, newStatus } = input;

  if (!dealId || !dealId.trim()) {
    return missingParam("상태를 변경할 딜 ID가 필요합니다.", { dealId, newStatus });
  }

  const writeIntent: WriteIntent = {
    action: "change_deal_status",
    args: { dealId, newStatus },
    summary: `딜(${dealId})의 상태를 ${newStatus}(으)로 변경`,
    targetEntityType: "DEAL",
    targetEntityId: dealId,
  };

  // READ 도구와 달리 실조회가 없으므로 dataSources는 빈 배열이다 — 승인 전에는
  // 아무 데이터도 조회/변경하지 않았다는 사실을 evidence에 그대로 반영한다.
  return ok({ writeIntent }, [], { dealId, newStatus });
}

export const changeDealStatusTool: AgentTool<ChangeDealStatusInput, ChangeDealStatusData> = {
  name: "change_deal_status",
  description:
    "특정 딜의 진행 상태를 변경합니다. 딜 ID가 필요하며(search_deals로 먼저 조회), " +
    "사용자가 상태 변경을 명시적으로 요청할 때만 사용합니다. " +
    "가능한 상태값: SOURCING(소싱), NEGOTIATING(협상), SAMPLE_TESTING(샘플테스트), " +
    "CONFIRMED(확정), ARCHIVED(보관), DROPPED(폐기 — 되돌릴 수 없음). " +
    "실제로 상태를 바꾸지 않고 승인 대기 기안을 생성합니다 — 관리자 승인 후에만 실제 반영됩니다.",
  inputSchema,
  execute,
};
