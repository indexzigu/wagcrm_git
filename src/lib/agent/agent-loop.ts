/**
 * 대화형 조회 에이전트 루프 (청사진 §agent-loop.ts).
 *
 * MAX_STEPS=4 안에서 functionCall ↔ functionResponse를 왕복한다.
 * - functionCall이 없으면 즉시 종료(최종 답변).
 * - 도구가 MISSING_PARAM을 반환하면 그 자리에서 되묻기로 조기종료한다 (더 이상 도구를 돌리지 않음).
 * - 도구가 NOT_FOUND/QUERY_FAILED를 반환하면 모델에게 실패를 그대로 전달하고,
 *   실패를 감추고 수치를 지어내지 않도록 유도한다 (functionResponse.error로 전달).
 */

import { promises as fs } from "fs";
import path from "path";
import {
  callGeminiWithTools,
  type GeminiContent,
  type GeminiFunctionCall,
  type GeminiUsageMetadata,
} from "./gemini-client";
import { buildSystemPrompt } from "./knowledge-loader";
import { AGENT_TOOLS, findTool, toGeminiTools } from "./tools";
import type { ToolResult, WriteIntent } from "./tools/types";
import { WRITE_TOOL_NAMES } from "./tools/types";

const MAX_STEPS = 4;

export type AgentToolCallRecord = {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult<unknown>;
};

export type AgentRunResult = {
  /** 최종 사용자 노출 텍스트 (되묻기 또는 요약 답변) */
  finalText: string;
  /** 이번 턴에서 실행된 도구 호출 기록 (되묻기만 있었던 경우 빈 배열) */
  toolCalls: AgentToolCallRecord[];
  /**
   * 이번 턴에서 WRITE 도구가 반환한 writeIntent 모음 (청사진 §0-1/§0-2).
   * 비어 있지 않으면 /api/assistant route가 READ 자동-EXECUTED 경로를 건너뛰고
   * 각 intent별로 WRITE ActionProposal(PENDING_APPROVAL)을 생성한다.
   */
  writeIntents: WriteIntent[];
  /** MISSING_PARAM으로 조기종료되어 사용자에게 되물은 경우 true */
  isClarification: boolean;
  /** 실행된 스텝(모델 호출) 수 */
  stepCount: number;
  usage: GeminiUsageMetadata | null;
  model: string;
  latencyMs: number;
  /** 후처리 린트에서 걸린 금지 표현 매치 (경고 — v1은 하드 차단하지 않음) */
  lintWarnings: string[];
};

export type AgentHistoryTurn = {
  role: "user" | "model";
  text: string;
};

function historyToGeminiContents(history: AgentHistoryTurn[]): GeminiContent[] {
  return history.map((turn) => ({
    role: turn.role,
    parts: [{ text: turn.text }],
  }));
}

// settlement.rules.json의 forbiddenPatterns를 로드해 캐싱한다.
let forbiddenPatternsCache: RegExp[] | null = null;

async function loadForbiddenPatterns(): Promise<RegExp[]> {
  if (forbiddenPatternsCache) return forbiddenPatternsCache;

  const rulesPath = path.resolve(process.cwd(), "knowledge", "rules", "settlement.rules.json");
  const raw = await fs.readFile(rulesPath, "utf-8");
  const parsed = JSON.parse(raw) as {
    rules: Array<{ forbiddenPatterns?: string[] }>;
  };

  const patterns: RegExp[] = [];
  for (const rule of parsed.rules) {
    for (const p of rule.forbiddenPatterns ?? []) {
      try {
        patterns.push(new RegExp(p));
      } catch {
        // 유효하지 않은 정규식은 무시 — 린트 실패로 전체 응답을 막지 않는다.
      }
    }
  }

  forbiddenPatternsCache = patterns;
  return patterns;
}

/** 테스트에서 캐시를 초기화할 수 있도록 export */
export function clearLintCache(): void {
  forbiddenPatternsCache = null;
}

/**
 * settlement.rules.json의 forbiddenPatterns로 최종 텍스트를 검사한다 (3중 방어 ③, v1은 경고만).
 */
export async function lintResponseText(text: string): Promise<string[]> {
  let patterns: RegExp[];
  try {
    patterns = await loadForbiddenPatterns();
  } catch (err) {
    // 규칙 파일 로드 실패가 (이미 생성된) 답변 전체를 500으로 죽이지 않게 격리하되,
    // 조용히 삼키지 않는다 — 서버 로그 + lintWarnings(API 응답과 ActionProposal.assumptions로
    // 노출됨)로 실패를 드러낸다. 캐시는 채우지 않으므로 다음 호출에서 재시도된다.
    console.error("[agent-loop] settlement.rules.json 로드 실패 — 정산 린트 미수행:", err);
    return ["정산 린트 규칙(settlement.rules.json) 로드 실패: 금지 표현 검사가 수행되지 않았습니다."];
  }
  const warnings: string[] = [];
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      warnings.push(`금지 표현 패턴에 매치됨: ${pattern.source}`);
    }
  }
  return warnings;
}

/**
 * 사용자 메시지와 대화 히스토리를 받아 에이전트 루프를 실행한다.
 * @param message 이번 턴의 사용자 입력
 * @param history 이전 턴들 (이번 메시지는 포함하지 않음)
 */
export async function runAgent(
  message: string,
  history: AgentHistoryTurn[] = []
): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const system = await buildSystemPrompt();
  const geminiTools = toGeminiTools(AGENT_TOOLS);

  const contents: GeminiContent[] = [
    ...historyToGeminiContents(history),
    { role: "user", parts: [{ text: message }] },
  ];

  const toolCalls: AgentToolCallRecord[] = [];
  let stepCount = 0;
  let lastUsage: GeminiUsageMetadata | null = null;
  let modelName = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    stepCount++;
    const result = await callGeminiWithTools(system, contents, geminiTools);
    lastUsage = result.usage;
    modelName = result.model;

    if (result.functionCalls.length === 0) {
      // 도구 호출 없이 텍스트로 답했다 — 되묻기이거나 일반 대화 응답.
      const finalText = result.text.trim();
      const lintWarnings = await lintResponseText(finalText);
      return {
        finalText,
        toolCalls,
        writeIntents: collectWriteIntents(toolCalls),
        isClarification: toolCalls.length === 0 && looksLikeClarification(finalText),
        stepCount,
        usage: lastUsage,
        model: modelName,
        latencyMs: Date.now() - startedAt,
        lintWarnings,
      };
    }

    // 모델의 functionCall 파트를 히스토리에 추가.
    if (result.content) {
      contents.push(result.content);
    }

    let hadMissingParam = false;

    for (const call of result.functionCalls) {
      const toolResult = await executeTool(call);
      toolCalls.push({ toolName: call.name, args: call.args, result: toolResult });

      contents.push({
        role: "function",
        parts: [
          {
            functionResponse: {
              name: call.name,
              response: toResponsePayload(toolResult),
            },
          },
        ],
      });

      if (!toolResult.ok && toolResult.error.code === "MISSING_PARAM") {
        hadMissingParam = true;
      }
    }

    if (hadMissingParam) {
      // MISSING_PARAM 발생 시 한 번 더 모델을 호출해 되묻는 문장을 받고 즉시 종료한다.
      // (모델이 functionResponse.error를 보고 스스로 되묻기를 생성하도록 유도)
      // m3: 이 호출은 텍스트 되묻기만 필요하므로 tools: []로 전달해 불필요한 functionCall
      // 여지와 도구 선언 토큰을 제거한다.
      const clarifyResult = await callGeminiWithTools(system, contents, []);
      stepCount++;
      lastUsage = clarifyResult.usage;
      const finalText = clarifyResult.text.trim() || "필요한 정보가 부족합니다. 조금 더 구체적으로 알려주시겠어요?";
      const lintWarnings = await lintResponseText(finalText);
      return {
        finalText,
        toolCalls,
        // MISSING_PARAM으로 조기종료된 턴은 writeIntent가 있어도 아직 확정된 의도가
        // 아니므로(모델이 되묻는 중) 기안을 만들지 않는다 — 실패한 도구 호출에서는
        // 애초에 writeIntent 자체가 나오지 않으므로(ok:false) 이 값은 항상 빈 배열이다.
        writeIntents: collectWriteIntents(toolCalls),
        isClarification: true,
        stepCount,
        usage: lastUsage,
        model: modelName,
        latencyMs: Date.now() - startedAt,
        lintWarnings,
      };
    }
  }

  // MAX_STEPS 도달 — 마지막으로 한 번 더 호출해 텍스트 요약을 받되, 도구는 더 이상 실행하지 않는다.
  const finalResult = await callGeminiWithTools(system, contents, []);
  stepCount++;
  const finalText =
    finalResult.text.trim() || "요청을 처리하는 데 예상보다 많은 단계가 필요합니다. 질문을 더 구체적으로 나눠 주시겠어요?";
  const lintWarnings = await lintResponseText(finalText);

  return {
    finalText,
    toolCalls,
    writeIntents: collectWriteIntents(toolCalls),
    isClarification: false,
    stepCount,
    usage: finalResult.usage ?? lastUsage,
    model: finalResult.model,
    latencyMs: Date.now() - startedAt,
    lintWarnings,
  };
}

/**
 * 이번 턴 도구 호출 기록에서 WRITE 도구(WRITE_TOOL_NAMES)가 성공적으로 반환한
 * writeIntent만 모은다. READ 도구 결과나 실패(ok:false)한 WRITE 호출은 제외된다 —
 * writeIntent 자체가 도구 성공 시에만 data에 실리기 때문이다(add-entity-memo.ts 참고).
 */
function collectWriteIntents(toolCalls: AgentToolCallRecord[]): WriteIntent[] {
  const intents: WriteIntent[] = [];
  for (const call of toolCalls) {
    if (!WRITE_TOOL_NAMES.has(call.toolName)) continue;
    if (!call.result.ok) continue;
    const data = call.result.data as { writeIntent?: WriteIntent } | undefined;
    if (data?.writeIntent) {
      intents.push(data.writeIntent);
    }
  }
  return intents;
}

async function executeTool(call: GeminiFunctionCall): Promise<ToolResult<unknown>> {
  const tool = findTool(call.name);
  if (!tool) {
    return {
      ok: false,
      error: { code: "QUERY_FAILED", message: `알 수 없는 도구입니다: ${call.name}` },
      evidence: { dataSources: [], query: call.args ?? {} },
    };
  }

  const parsed = tool.inputSchema.safeParse(call.args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return {
      ok: false,
      error: { code: "MISSING_PARAM", message: `입력값이 올바르지 않습니다 (${issues})` },
      evidence: { dataSources: [], query: call.args ?? {} },
    };
  }

  try {
    return await tool.execute(parsed.data);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "QUERY_FAILED",
        message: err instanceof Error ? err.message : "도구 실행 중 알 수 없는 오류가 발생했습니다.",
      },
      evidence: { dataSources: [], query: call.args ?? {} },
    };
  }
}

/**
 * ToolResult를 Gemini functionResponse.response 페이로드로 변환한다.
 * 실패 시(NOT_FOUND/QUERY_FAILED/MISSING_PARAM) error 필드로 명시해 모델이
 * 수치를 지어내지 않고 실패 사실을 그대로 전달하도록 유도한다.
 */
function toResponsePayload(result: ToolResult<unknown>): Record<string, unknown> {
  if (result.ok) {
    return { ok: true, data: result.data, evidence: result.evidence };
  }
  return {
    ok: false,
    error: result.error,
    evidence: result.evidence ?? { dataSources: [], query: {} },
  };
}

// 모델이 되묻는 응답인지 휴리스틱으로 판정한다 (한국어 의문형 종결/물음표 등).
function looksLikeClarification(text: string): boolean {
  if (!text) return false;
  return /\?|알려주시|말씀해|가요\??$|나요\??$|되나요/.test(text);
}
