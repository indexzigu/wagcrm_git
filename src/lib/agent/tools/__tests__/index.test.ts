import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, findTool, toGeminiTools } from "../index";
import { WRITE_TOOL_NAMES } from "../types";

describe("AGENT_TOOLS 레지스트리", () => {
  it("READ 5종 + WRITE 3종(add_entity_memo, change_deal_status, confirm_settlement) 총 8종이 등록되어 있다 (Phase 5 HITL)", () => {
    const names = AGENT_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_entity_memo",
        "change_deal_status",
        "confirm_settlement",
        "get_campaign_financials",
        "get_order_snapshot",
        "get_pipeline_status",
        "get_settlement_report",
        "search_deals",
      ].sort()
    );
  });

  it("findTool은 이름으로 도구를 찾는다", () => {
    expect(findTool("get_settlement_report")?.name).toBe("get_settlement_report");
    expect(findTool("존재하지않는도구")).toBeUndefined();
  });

  it("WRITE_TOOL_NAMES에 add_entity_memo, change_deal_status, confirm_settlement가 등록되어 agent-loop가 writeIntent를 걷어낼 수 있다", () => {
    expect(WRITE_TOOL_NAMES.has("add_entity_memo")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("change_deal_status")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("confirm_settlement")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("search_deals")).toBe(false);
  });
});

describe("toGeminiTools — zod → JSON Schema 변환", () => {
  it("각 도구가 name/description/parameters를 갖는다", () => {
    const geminiTools = toGeminiTools();
    expect(geminiTools).toHaveLength(8);
    for (const tool of geminiTools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toHaveProperty("type", "object");
    }
  });

  it("Gemini가 지원하지 않는 JSON Schema 키($schema 등)를 제거한다", () => {
    const geminiTools = toGeminiTools();
    const serialized = JSON.stringify(geminiTools);
    expect(serialized).not.toContain("$schema");
    expect(serialized).not.toContain("additionalProperties");
  });

  it("get_campaign_financials의 campaignId가 필수 파라미터로 표시된다", () => {
    const geminiTools = toGeminiTools();
    const tool = geminiTools.find((t) => t.name === "get_campaign_financials");
    expect(tool).toBeDefined();
    const params = tool!.parameters as { required?: string[] };
    expect(params.required).toContain("campaignId");
  });
});
