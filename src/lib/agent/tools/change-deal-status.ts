import { z } from "zod";
import { DEAL_STATUSES, dealStatusLabels, getValidNextStatuses } from "@/lib/deal-status";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { missingParam, ok } from "./types";

const inputSchema = z.object({
  dealId: z.string().min(1).describe("상태를 변경할 딜의 ID"),
  newStatus: z
    .enum(DEAL_STATUSES)
    .describe(`변경할 딜의 새 상태 (${DEAL_STATUSES.join(", ")})`),
});

export type ChangeDealStatusInput = z.infer<typeof inputSchema>;

export type ChangeDealStatusData = {
  writeIntent: WriteIntent;
};

/**
 * 청사진 §0-1: 이 도구는 실제 딜 상태 변경도, ActionProposal 기안 생성도, 딜 조회도
 * 하지 않는다. execute(input)는 userId를 알지 못하므로(AgentTool 계약), 구조화된
 * writeIntent만 반환하고 호출자(agent worker 실행기)가 userId를 채워 단일 지점에서
 * 기안을 생성한다. 딜 상태기계(isValidTransition) 검증은 승인 시점에 write-executor에서
 * 수행된다 — 이 도구는 args 형식(enum) 검증만 한다.
 */
async function execute(input: ChangeDealStatusInput): Promise<ToolResult<ChangeDealStatusData>> {
  const { dealId, newStatus } = input;

  if (!dealId || !dealId.trim()) {
    return missingParam("상태를 변경할 판매 조건 ID가 필요합니다.", { dealId, newStatus });
  }

  const writeIntent: WriteIntent = {
    action: "change_deal_status",
    args: { dealId, newStatus },
    summary: `판매 조건(${dealId})의 상태를 ${newStatus}(으)로 변경`,
    targetEntityType: "DEAL",
    targetEntityId: dealId,
  };

  // READ 도구와 달리 실조회가 없으므로 dataSources는 빈 배열이다 — 승인 전에는
  // 아무 데이터도 조회/변경하지 않았다는 사실을 evidence에 그대로 반영한다.
  return ok({ writeIntent }, [], { dealId, newStatus });
}

// 낱말은 화면과 같은 `dealStatusLabels`, 허용 변경은 실제 전이표(`getValidNextStatuses`)에서 뽑는다.
// 손으로 적어 두었던 설명은 화면과 다른 낱말(협상·보관·폐기)을 썼고, 어떤 변경이 되는지 알려 주지
// 않아 봇이 거절될 기안을 만들 수 있었다(전이 검증은 승인 시점에야 돈다).
const STATUS_GLOSSARY = DEAL_STATUSES.map((status) => `${status}(${dealStatusLabels[status]})`).join(", ");
const TRANSITION_GUIDE = DEAL_STATUSES.map((status) => {
  const next = getValidNextStatuses(status);
  return next.length > 0 ? `${status} → ${next.join(" 또는 ")}` : `${status} → 없음(되돌릴 수 없음)`;
}).join("; ");

export const changeDealStatusTool: AgentTool<ChangeDealStatusInput, ChangeDealStatusData> = {
  name: "change_deal_status",
  description:
    "특정 딜의 진행 상태를 변경합니다. 딜 ID가 필요하며(search_deals로 먼저 조회), " +
    "사용자가 상태 변경을 명시적으로 요청할 때만 사용합니다. " +
    `가능한 상태값: ${STATUS_GLOSSARY}. ` +
    `허용되는 변경(현재 → 다음): ${TRANSITION_GUIDE}. 그 밖의 변경과 되돌리기는 승인 단계에서 거절됩니다. ` +
    "실제로 상태를 바꾸지 않고 승인 대기 기안을 생성합니다 — 관리자 승인 후에만 실제 반영됩니다.",
  inputSchema,
  execute,
};
