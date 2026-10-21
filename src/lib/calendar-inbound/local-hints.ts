// [캘린더수집] 규칙 파서가 실패한 일정 제목을 이 맥의 로컬 모델(ollama)로 먼저 해석한다.
// Gemini 호출 수를 줄이려는 1차 단계 — 여기서 못 푼 것만 Gemini 일괄로 넘어간다.
// 지시문·스키마·근거 방벽은 llm-hints.ts 의 것을 그대로 쓴다(경로별 복제 금지).
// Gemini 가 아니므로 recordGeminiFailure 계측은 하지 않는다.
import {
  HintsSchema,
  NONE,
  UNAVAILABLE,
  buildHintPrompt,
  groundHints,
  type TitleHintsResult,
} from "./llm-hints";

export const DEFAULT_LOCAL_LLM_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_CALENDAR_INBOUND_LOCAL_MODEL = "qwen3.5:4b";
/** 호출당 시간 제한 — 회차 예산(55초) 안에서 로컬 단계가 다음 제목을 시작할지 가늠하는 단위. */
export const LOCAL_HINT_TIMEOUT_MS = 30_000;

type LocalFailureKind = "network" | "timeout" | "http" | "parse" | "empty";
const warned = new Set<LocalFailureKind>();

/** 실패 종류마다 한 번만 경고한다(제목 텍스트는 로그에 남기지 않는다). */
function warnOnce(kind: LocalFailureKind, detail: string): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  console.warn(`[calendar-inbound] 로컬 모델 힌트 실패 (${kind}: ${detail})`);
}

function isRetryableLocalStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function extractTitleHintsLocal(
  summary: string,
  deps: {
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
  } = {},
): Promise<TitleHintsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = (
    deps.baseUrl ??
    process.env.LOCAL_LLM_BASE_URL ??
    DEFAULT_LOCAL_LLM_BASE_URL
  ).replace(/\/+$/, "");
  const model =
    deps.model ??
    process.env.CALENDAR_INBOUND_LOCAL_MODEL ??
    DEFAULT_CALENDAR_INBOUND_LOCAL_MODEL;
  const timeoutMs = deps.timeoutMs ?? LOCAL_HINT_TIMEOUT_MS;

  const body = JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content: "너는 JSON 객체 하나만 출력한다. 설명·코드블록 없이.",
      },
      { role: "user", content: buildHintPrompt(summary) },
    ],
    // qwen3.5 의 사고(thinking)를 끄는 유일한 경로. think:false·chat_template_kwargs 는
    // 이 ollama 에서 조용히 무시되고, 그러면 답이 message.reasoning 으로 가서 content 가 빈다.
    reasoning_effort: "none",
    temperature: 0,
    response_format: { type: "json_object" },
    max_tokens: 120,
    stream: false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    // 연결 거부(서버 꺼짐)·시간 초과 — 일시 장애. 호출부는 Gemini 단계로 넘긴다.
    if (controller.signal.aborted) warnOnce("timeout", `${timeoutMs}ms`);
    else warnOnce("network", err instanceof Error ? err.message : String(err));
    return UNAVAILABLE;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    warnOnce("http", `status=${res.status}`);
    return isRetryableLocalStatus(res.status) ? UNAVAILABLE : NONE;
  }

  let content: unknown;
  try {
    content = (
      JSON.parse(text) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      }
    )?.choices?.[0]?.message?.content;
  } catch {
    warnOnce("parse", "응답 봉투가 JSON 아님");
    return NONE;
  }
  if (typeof content !== "string" || content.trim() === "") {
    warnOnce("empty", "content 비어 있음(사고 미해제 의심)");
    return NONE;
  }

  const parsed = (() => {
    try {
      return HintsSchema.safeParse(JSON.parse(content));
    } catch {
      return null;
    }
  })();
  if (!parsed?.success) {
    warnOnce("parse", "content 가 비JSON 또는 스키마 불일치");
    return NONE;
  }
  return groundHints(parsed.data, summary);
}
