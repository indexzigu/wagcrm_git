import { z } from "zod";
import type { GeminiToolDeclaration } from "../gemini-client";
import type { AgentTool } from "./types";
import { getSettlementReportTool } from "./settlement-report";
import { searchDealsTool } from "./search-deals";
import { getPipelineStatusTool } from "./pipeline-status";
import { getCampaignFinancialsTool } from "./campaign-financials";
import { getOrderSnapshotTool } from "./order-snapshot";
import { addEntityMemoTool } from "./add-entity-memo";
import { changeDealStatusTool } from "./change-deal-status";
import { confirmSettlementTool } from "./confirm-settlement";

/**
 * READ 5종 + WRITE 3종(add_entity_memo, change_deal_status, confirm_settlement) 도구
 * 레지스트리 (청사진 §2-3, Phase 5 §2). 자유 SQL 금지 — 전부 기존 report/repository
 * 래퍼만 호출. WRITE 도구는 실제 쓰기를 하지 않고 writeIntent만 반환한다(§0-1).
 */
export const AGENT_TOOLS: AgentTool[] = [
  getSettlementReportTool,
  searchDealsTool,
  getPipelineStatusTool,
  getCampaignFinancialsTool,
  getOrderSnapshotTool,
  addEntityMemoTool,
  changeDealStatusTool,
  confirmSettlementTool,
];

export function findTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

/**
 * zod 스키마 → Gemini functionDeclarations.parameters(JSON Schema) 변환.
 * zod v4 내장 z.toJSONSchema()를 사용하되, Gemini가 지원하지 않는 최상위 키
 * ($schema, additionalProperties)는 제거한다.
 */
function zodToGeminiParameters(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  // 최상위 $schema/additionalProperties도 stripUnsupportedKeys가 재귀로 걷어낸다
  // (UNSUPPORTED_KEYS에 포함) — 여기서 따로 구조분해로 덜어낼 필요가 없다.
  return stripUnsupportedKeys(jsonSchema);
}

// Gemini function-calling 스키마는 OpenAPI 3.0 서브셋에 가깝다.
// JSON Schema의 일부 키(예: $schema, additionalProperties, const)는 지원되지 않으므로
// 재귀적으로 제거해 400 오류를 예방한다.
const UNSUPPORTED_KEYS = new Set(["$schema", "additionalProperties", "const", "$ref", "$defs"]);

function stripUnsupportedKeys(value: unknown): any {
  if (Array.isArray(value)) {
    return value.map(stripUnsupportedKeys);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (UNSUPPORTED_KEYS.has(key)) continue;
      result[key] = stripUnsupportedKeys(val);
    }
    return result;
  }
  return value;
}

export function toGeminiTools(tools: AgentTool[] = AGENT_TOOLS): GeminiToolDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: zodToGeminiParameters(tool.inputSchema),
  }));
}

export type { AgentTool, ToolResult, ToolError, ToolErrorCode, ToolEvidence, WriteIntent } from "./types";
export { WRITE_TOOL_NAMES } from "./types";
