import { z } from "zod";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { missingParam, ok } from "./types";

const ENTITY_TYPES = ["PARTNER", "SELLER", "DEAL", "CAMPAIGN"] as const;

const inputSchema = z.object({
  entityType: z.enum(ENTITY_TYPES).describe("메모를 남길 대상 엔티티 유형"),
  entityId: z.string().min(1).describe("대상 엔티티의 ID"),
  content: z.string().min(1).max(4000).describe("남길 메모 내용 (최대 4,000자)"),
});

export type AddEntityMemoInput = z.infer<typeof inputSchema>;

export type AddEntityMemoData = {
  writeIntent: WriteIntent;
};

const ENTITY_TYPE_LABELS: Record<(typeof ENTITY_TYPES)[number], string> = {
  PARTNER: "거래처",
  SELLER: "셀러",
  DEAL: "딜",
  CAMPAIGN: "캠페인",
};

/**
 * 청사진 §0-1: 이 도구는 실제 메모 쓰기도, ActionProposal 기안 생성도 하지 않는다.
 * execute(input)는 userId를 알지 못하므로(AgentTool 계약), 구조화된 writeIntent만
 * 반환하고 /api/assistant route가 userId를 채워 단일 지점에서 기안을 생성한다.
 */
async function execute(input: AddEntityMemoInput): Promise<ToolResult<AddEntityMemoData>> {
  const { entityType, entityId, content } = input;

  if (!entityId || !entityId.trim()) {
    return missingParam("메모를 남길 대상 엔티티 ID가 필요합니다.", { entityType, entityId, content });
  }
  if (!content || !content.trim()) {
    return missingParam("남길 메모 내용이 필요합니다.", { entityType, entityId, content });
  }

  const label = ENTITY_TYPE_LABELS[entityType];
  const writeIntent: WriteIntent = {
    action: "add_entity_memo",
    args: { entityType, entityId, content },
    summary: `${label}(${entityId})에 메모 추가: "${content}"`,
    targetEntityType: entityType,
    targetEntityId: entityId,
  };

  // READ 도구와 달리 실조회가 없으므로 dataSources는 빈 배열이다 — 승인 전에는
  // 아무 데이터도 조회/변경하지 않았다는 사실을 evidence에 그대로 반영한다.
  return ok({ writeIntent }, [], { entityType, entityId });
}

export const addEntityMemoTool: AgentTool<AddEntityMemoInput, AddEntityMemoData> = {
  name: "add_entity_memo",
  description:
    "사용자가 특정 거래처/셀러/딜/캠페인에 메모를 남겨달라고 명시적으로 요청할 때만 사용합니다. " +
    "실제로 메모를 쓰지 않고 승인 대기 기안을 생성합니다 — 저위험 메모는 자동승인 규칙에 따라 " +
    "즉시 기록될 수 있으며, 그 외 요청은 관리자 승인 후 반영됩니다.",
  inputSchema,
  execute,
};
