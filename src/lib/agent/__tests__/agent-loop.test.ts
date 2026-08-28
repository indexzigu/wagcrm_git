import { describe, expect, it, vi, beforeEach } from "vitest";
import { promises as fsPromises } from "fs";

const callGeminiWithToolsMock = vi.fn();

vi.mock("../gemini-client", () => ({
  callGeminiWithTools: (...args: unknown[]) => callGeminiWithToolsMock(...args),
}));

vi.mock("../knowledge-loader", () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue("MOCK_SYSTEM_PROMPT"),
}));

const settlementExecuteMock = vi.fn();
const dealsExecuteMock = vi.fn();
const addMemoExecuteMock = vi.fn();

vi.mock("../tools", async () => {
  const { z } = await import("zod");
  const settlementTool = {
    name: "get_settlement_report",
    description: "정산 리포트 조회",
    inputSchema: z.object({ month: z.string().optional() }),
    execute: (input: unknown) => settlementExecuteMock(input),
  };
  const dealsTool = {
    name: "search_deals",
    description: "딜 검색",
    inputSchema: z.object({ keyword: z.string().optional() }),
    execute: (input: unknown) => dealsExecuteMock(input),
  };
  const addMemoTool = {
    name: "add_entity_memo",
    description: "메모 추가 (WRITE, intent만 반환)",
    inputSchema: z.object({
      entityType: z.string(),
      entityId: z.string(),
      content: z.string(),
    }),
    execute: (input: unknown) => addMemoExecuteMock(input),
  };
  return {
    AGENT_TOOLS: [settlementTool, dealsTool, addMemoTool],
    findTool: (name: string) => [settlementTool, dealsTool, addMemoTool].find((t) => t.name === name),
    toGeminiTools: () => [
      { name: settlementTool.name, description: settlementTool.description, parameters: {} },
      { name: dealsTool.name, description: dealsTool.description, parameters: {} },
      { name: addMemoTool.name, description: addMemoTool.description, parameters: {} },
    ],
  };
});

import { runAgent, lintResponseText, clearLintCache } from "../agent-loop";

function textOnlyResult(text: string) {
  return {
    content: { role: "model", parts: [{ text }] },
    functionCalls: [],
    text,
    usage: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    model: "gemini-3.6-flash",
    latencyMs: 100,
  };
}

function functionCallResult(name: string, args: Record<string, unknown>) {
  return {
    content: { role: "model", parts: [{ functionCall: { name, args } }] },
    functionCalls: [{ name, args }],
    text: "",
    usage: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 },
    model: "gemini-3.6-flash",
    latencyMs: 150,
  };
}

describe("runAgent — 도구 미사용(일반 대화/즉시 답변)", () => {
  beforeEach(() => {
    callGeminiWithToolsMock.mockReset();
    settlementExecuteMock.mockReset();
    dealsExecuteMock.mockReset();
  });

  it("functionCall 없이 텍스트만 오면 즉시 종료하고 도구 호출 기록이 비어있다", async () => {
    callGeminiWithToolsMock.mockResolvedValueOnce(textOnlyResult("안녕하세요! 무엇을 도와드릴까요?"));

    const result = await runAgent("안녕", []);

    expect(result.toolCalls).toHaveLength(0);
    expect(result.stepCount).toBe(1);
    expect(result.finalText).toContain("안녕하세요");
  });
});

describe("runAgent — MISSING_PARAM 되묻기 조기종료", () => {
  beforeEach(() => {
    callGeminiWithToolsMock.mockReset();
    settlementExecuteMock.mockReset();
    dealsExecuteMock.mockReset();
  });

  it("도구가 MISSING_PARAM을 반환하면 되묻는 답변으로 조기종료하고, 이후 도구를 더 실행하지 않는다", async () => {
    // 1) 모델이 campaignId 없이 재무 도구 대신 정산 도구를 잘못된 인자로 호출한다고 가정
    callGeminiWithToolsMock
      .mockResolvedValueOnce(functionCallResult("get_settlement_report", {}))
      .mockResolvedValueOnce(textOnlyResult("어느 기간의 정산을 조회할지 알려주시겠어요?"));

    settlementExecuteMock.mockResolvedValue({
      ok: false,
      error: { code: "MISSING_PARAM", message: "month가 필요합니다." },
      evidence: { dataSources: [], query: {} },
    });

    const result = await runAgent("정산 알려줘", []);

    expect(result.isClarification).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.finalText).toContain("알려주시겠어요");
    // 모델 호출은 도구실행 유발 1회 + 되묻기 생성 1회 = 2회여야 하고, 그 이상 도구를 돌리지 않는다.
    expect(callGeminiWithToolsMock).toHaveBeenCalledTimes(2);
    expect(settlementExecuteMock).toHaveBeenCalledTimes(1);
  });

  it("m3: 되묻기 재호출 시 tools를 빈 배열로 전달해 불필요한 functionCall 여지를 없앤다", async () => {
    callGeminiWithToolsMock
      .mockResolvedValueOnce(functionCallResult("get_settlement_report", {}))
      .mockResolvedValueOnce(textOnlyResult("어느 기간의 정산을 조회할지 알려주시겠어요?"));

    settlementExecuteMock.mockResolvedValue({
      ok: false,
      error: { code: "MISSING_PARAM", message: "month가 필요합니다." },
      evidence: { dataSources: [], query: {} },
    });

    await runAgent("정산 알려줘", []);

    expect(callGeminiWithToolsMock).toHaveBeenCalledTimes(2);
    // 두 번째 호출(되묻기 생성)의 세 번째 인자(tools)가 빈 배열이어야 한다.
    const clarifyCallArgs = callGeminiWithToolsMock.mock.calls[1];
    expect(clarifyCallArgs[2]).toEqual([]);
    // 첫 번째 호출(도구 유발)은 정상적으로 도구 목록을 전달받아야 한다.
    const firstCallArgs = callGeminiWithToolsMock.mock.calls[0];
    expect(firstCallArgs[2].length).toBeGreaterThan(0);
  });
});

describe("runAgent — NOT_FOUND/QUERY_FAILED 시 수치 생성 중단", () => {
  beforeEach(() => {
    callGeminiWithToolsMock.mockReset();
    settlementExecuteMock.mockReset();
    dealsExecuteMock.mockReset();
  });

  it("NOT_FOUND 응답을 받으면 모델에게 실패가 그대로 전달되고, 모델이 숫자 없이 실패를 알리는 답변을 생성한다", async () => {
    callGeminiWithToolsMock
      .mockResolvedValueOnce(functionCallResult("get_settlement_report", { month: "2099-01" }))
      .mockResolvedValueOnce(textOnlyResult("2099년 1월 정산 데이터가 없습니다. 확인 필요합니다."));

    settlementExecuteMock.mockResolvedValue({
      ok: false,
      error: { code: "NOT_FOUND", message: "해당 기간에 정산 캠페인이 없습니다." },
      evidence: { dataSources: ["SalesCampaign"], query: { month: "2099-01" } },
    });

    const result = await runAgent("2099년 1월 정산 알려줘", []);

    expect(result.toolCalls[0].result.ok).toBe(false);
    expect(result.finalText).not.toMatch(/\d+원/); // 근거 없는 금액 수치를 생성하지 않아야 함
    expect(result.isClarification).toBe(false);

    // functionResponse로 error가 그대로 전달됐는지 확인 — 두 번째 호출의 contents 인자를 검사.
    const secondCallArgs = callGeminiWithToolsMock.mock.calls[1];
    const contents = secondCallArgs[1] as any[];
    const functionResponsePart = contents.at(-1).parts[0].functionResponse;
    expect(functionResponsePart.response.ok).toBe(false);
    expect(functionResponsePart.response.error.code).toBe("NOT_FOUND");
  });

  it("QUERY_FAILED 응답도 동일하게 실패로 전달된다", async () => {
    callGeminiWithToolsMock
      .mockResolvedValueOnce(functionCallResult("search_deals", { keyword: "x" }))
      .mockResolvedValueOnce(textOnlyResult("딜 검색 중 오류가 발생해 결과를 알려드릴 수 없습니다."));

    dealsExecuteMock.mockResolvedValue({
      ok: false,
      error: { code: "QUERY_FAILED", message: "DB 연결 실패" },
      evidence: { dataSources: [], query: { keyword: "x" } },
    });

    const result = await runAgent("x 딜 찾아줘", []);
    expect(result.toolCalls[0].result.ok).toBe(false);
    expect(result.finalText).toContain("오류");
  });
});

describe("runAgent — 2단계 도구 체이닝", () => {
  beforeEach(() => {
    callGeminiWithToolsMock.mockReset();
    settlementExecuteMock.mockReset();
    dealsExecuteMock.mockReset();
  });

  it("첫 도구 성공 후 두 번째 도구를 호출하고 최종 텍스트로 종료한다", async () => {
    callGeminiWithToolsMock
      .mockResolvedValueOnce(functionCallResult("search_deals", { keyword: "락토핏" }))
      .mockResolvedValueOnce(functionCallResult("get_settlement_report", { month: "2026-07" }))
      .mockResolvedValueOnce(textOnlyResult("락토핏 딜의 7월 정산 예정 금액은 ~입니다 (예정)."));

    dealsExecuteMock.mockResolvedValue({
      ok: true,
      data: { items: [{ id: "deal1", dealName: "락토핏 골드" }], count: 1, truncated: false },
      evidence: { dataSources: ["Deal"], query: { keyword: "락토핏" } },
    });
    settlementExecuteMock.mockResolvedValue({
      ok: true,
      data: { period: "2026-07", summary: { totalRevenue: 1000000 }, campaigns: [], stateCounts: {} },
      evidence: { dataSources: ["SalesCampaign"], query: { month: "2026-07" } },
    });

    const result = await runAgent("락토핏 딜 7월 정산 상태 알려줘", []);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolName).toBe("search_deals");
    expect(result.toolCalls[1].toolName).toBe("get_settlement_report");
    expect(result.stepCount).toBe(3);
    expect(result.isClarification).toBe(false);
    expect(callGeminiWithToolsMock).toHaveBeenCalledTimes(3);
  });
});

describe("runAgent — writeIntents 수집 (Phase 5 HITL §0-1/§0-2)", () => {
  beforeEach(() => {
    callGeminiWithToolsMock.mockReset();
    settlementExecuteMock.mockReset();
    dealsExecuteMock.mockReset();
    addMemoExecuteMock.mockReset();
  });

  it("WRITE 도구(add_entity_memo)만 호출되면 writeIntents에 1건이 수집된다", async () => {
    callGeminiWithToolsMock
      .mockResolvedValueOnce(
        functionCallResult("add_entity_memo", {
          entityType: "DEAL",
          entityId: "deal-1",
          content: "재입고 확인",
        })
      )
      .mockResolvedValueOnce(textOnlyResult("메모 기안을 생성했습니다. 승인 후 반영됩니다."));

    addMemoExecuteMock.mockResolvedValue({
      ok: true,
      data: {
        writeIntent: {
          action: "add_entity_memo",
          args: { entityType: "DEAL", entityId: "deal-1", content: "재입고 확인" },
          summary: "딜(deal-1)에 메모 추가",
          targetEntityType: "DEAL",
          targetEntityId: "deal-1",
        },
      },
      evidence: { dataSources: [], query: {} },
    });

    const result = await runAgent("deal-1에 메모 남겨줘", []);

    expect(result.writeIntents).toHaveLength(1);
    expect(result.writeIntents[0]).toMatchObject({
      action: "add_entity_memo",
      targetEntityType: "DEAL",
      targetEntityId: "deal-1",
    });
    expect(result.toolCalls).toHaveLength(1);
  });

  it("READ 도구만 호출되면 writeIntents는 빈 배열이다", async () => {
    callGeminiWithToolsMock
      .mockResolvedValueOnce(functionCallResult("search_deals", { keyword: "락토핏" }))
      .mockResolvedValueOnce(textOnlyResult("락토핏 딜을 찾았습니다."));

    dealsExecuteMock.mockResolvedValue({
      ok: true,
      data: { items: [{ id: "deal1" }], count: 1, truncated: false },
      evidence: { dataSources: ["Deal"], query: { keyword: "락토핏" } },
    });

    const result = await runAgent("락토핏 딜 찾아줘", []);

    expect(result.writeIntents).toEqual([]);
    expect(result.toolCalls).toHaveLength(1);
  });

  it("WRITE 도구 호출이 실패(ok:false)하면 writeIntent가 수집되지 않는다", async () => {
    callGeminiWithToolsMock
      .mockResolvedValueOnce(
        functionCallResult("add_entity_memo", { entityType: "DEAL", entityId: "", content: "" })
      )
      .mockResolvedValueOnce(textOnlyResult("어떤 딜에 메모를 남길지 알려주시겠어요?"));

    addMemoExecuteMock.mockResolvedValue({
      ok: false,
      error: { code: "MISSING_PARAM", message: "entityId가 필요합니다." },
      evidence: { dataSources: [], query: {} },
    });

    const result = await runAgent("메모 남겨줘", []);

    expect(result.writeIntents).toEqual([]);
    expect(result.isClarification).toBe(true);
  });

  it("READ+WRITE 도구가 함께 호출되면 writeIntents에는 WRITE분만 수집된다", async () => {
    callGeminiWithToolsMock
      .mockResolvedValueOnce(functionCallResult("search_deals", { keyword: "락토핏" }))
      .mockResolvedValueOnce(
        functionCallResult("add_entity_memo", {
          entityType: "DEAL",
          entityId: "deal-1",
          content: "메모",
        })
      )
      .mockResolvedValueOnce(textOnlyResult("검색 후 메모 기안을 생성했습니다."));

    dealsExecuteMock.mockResolvedValue({
      ok: true,
      data: { items: [{ id: "deal-1" }], count: 1, truncated: false },
      evidence: { dataSources: ["Deal"], query: { keyword: "락토핏" } },
    });
    addMemoExecuteMock.mockResolvedValue({
      ok: true,
      data: {
        writeIntent: {
          action: "add_entity_memo",
          args: { entityType: "DEAL", entityId: "deal-1", content: "메모" },
          summary: "딜(deal-1)에 메모 추가",
          targetEntityType: "DEAL",
          targetEntityId: "deal-1",
        },
      },
      evidence: { dataSources: [], query: {} },
    });

    const result = await runAgent("락토핏 딜에 메모 남겨줘", []);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.writeIntents).toHaveLength(1);
    expect(result.writeIntents[0].targetEntityId).toBe("deal-1");
  });
});

describe("lintResponseText — settlement.rules.json forbiddenPatterns 정규식 린트", () => {
  beforeEach(() => {
    clearLintCache();
  });

  it("정산 완료 단정 표현(예정 병기 없이)에 경고를 남긴다", async () => {
    const warnings = await lintResponseText("이번 캠페인은 정산 완료되었습니다.");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("예정 병기가 있으면 해당 패턴은 걸리지 않는다", async () => {
    const warnings = await lintResponseText("이번 캠페인은 정산 완료되었습니다 (예정).");
    // settlement-status-disclosure 규칙 패턴은 부정형 lookahead로 (예정)이 있으면 매치되지 않는다.
    const hasCompletionWarning = warnings.some((w) => w.includes("정산"));
    expect(hasCompletionWarning).toBe(false);
  });

  it("입금/지급 확인 근거 없이 확정되었다고 쓰면 경고를 남긴다", async () => {
    const warnings = await lintResponseText("정산이 확정되었습니다.");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("정상적인 표현(예정/확정/지급완료 분리 표기)은 경고가 없다", async () => {
    const warnings = await lintResponseText(
      "이번 캠페인의 정산은 예정 상태입니다. 아직 입금이 확인되지 않았습니다."
    );
    expect(warnings).toHaveLength(0);
  });

  it("규칙 파일 로드 실패 시 응답을 죽이지 않고, 로그와 로드 실패 경고로 드러낸다", async () => {
    const readSpy = vi
      .spyOn(fsPromises, "readFile")
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const warnings = await lintResponseText("이번 캠페인은 정산 완료되었습니다.");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("로드 실패");
      expect(errorSpy).toHaveBeenCalled();

      // 실패는 캐시되지 않는다 — 다음 호출은 실제 파일로 재시도해 정상 린트가 복구된다.
      readSpy.mockRestore();
      const retried = await lintResponseText("이번 캠페인은 정산 완료되었습니다.");
      expect(retried.some((w) => w.includes("금지 표현"))).toBe(true);
    } finally {
      readSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
