/**
 * Gemini REST function-calling 클라이언트 (Phase 2 청사진 §gemini-client.ts).
 *
 * Vercel AI SDK를 쓰지 않는 이유: `ai`/`@ai-sdk/google`이 미설치이고, `@ai-sdk/google`은
 * 단일 GOOGLE_GENERATIVE_AI_API_KEY만 읽어 기존 GEMINI_API_KEY+BACKUP_GEMINI_API_KEY
 * 키로테이션(extract-info/route.ts:49-84, partnerService.ts:319-334 패턴)과 충돌한다.
 * v1은 조회 5도구·2~4턴이라 REST 직접호출로 충분하다.
 *
 * 모델은 `src/lib/gemini-model.ts`의 주모델 SSOT(`gemini-3.6-flash`)를 따른다.
 * flash-lite는 function-calling 미지원 가능성이 있어 주모델(full flash)만 쓴다 — 청사진 R1.
 * thinking은 LOW로 고정한다 — 도구 선택/멀티턴 추론 품질을 지키는 하한(오너 재배치 2026-07-24).
 */

import { GEMINI_PRIMARY_MODEL, GEMINI_THINK_LOW } from "@/lib/gemini-model";
import type { GeminiSurface } from "@/lib/agent/gemini-usage";
import {
  describeGeminiKey,
  recordGeminiFailure,
  truncateGeminiReason,
  NO_HTTP_RESPONSE,
} from "@/lib/agent/gemini-usage";

const GEMINI_MODEL = GEMINI_PRIMARY_MODEL;
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiRole = "user" | "model" | "function";

export type GeminiFunctionCall = {
  name: string;
  args: Record<string, unknown>;
};

export type GeminiFunctionResponse = {
  name: string;
  response: Record<string, unknown>;
};

export type GeminiPart =
  | { text: string }
  | { functionCall: GeminiFunctionCall }
  | { functionResponse: GeminiFunctionResponse };

export type GeminiContent = {
  role: GeminiRole;
  parts: GeminiPart[];
};

export type GeminiToolDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
};

export type CallGeminiWithToolsResult = {
  content: GeminiContent | null;
  functionCalls: GeminiFunctionCall[];
  text: string;
  usage: GeminiUsageMetadata | null;
  model: string;
  latencyMs: number;
};

// 환경변수 파싱 이슈(주석 포함 등)로 키가 오염되는 경우를 방지 — extract-info/route.ts:49-51 패턴.
function cleanApiKey(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw.split("#")[0].trim();
}

/**
 * 설정된 Gemini API 키를 **선언 순서대로** 모은다(순수 함수).
 *
 * 계정을 여러 개 돌려 쓰는 이유는 **계정별 월 지출 상한** 때문이다 — 한 계정이
 * 상한에 걸리면 그 키의 모든 모델이 429가 된다(2026-07-30 실측: 3.6-flash·
 * 2.5-flash·2.5-flash-lite 전부 429, 무과금 models.list 만 200). 키가 하나뿐이면
 * 그 순간 전 AI 기능이 멈춘다.
 *
 * env 규약 — **변수 하나에 콤마로 여러 개**(오너 결정 2026-07-30):
 *   GEMINI_API_KEY="key1,key2,key3"
 *   BACKUP_GEMINI_API_KEY="key4"   ← 기존 이름 유지(하위 호환), 뒤에 이어 붙는다
 *
 * 슬롯을 번호로 늘리는 방식(_3.._6) 대신 콤마를 쓰는 이유는 배포 환경 관리다 —
 * Vercel 에서 변수 하나만 편집하면 계정을 늘리고 줄일 수 있고, 코드에 개수
 * 상한이 박히지 않는다. Gemini 키에는 콤마가 들어가지 않아 구분자로 안전하다.
 *
 * 같은 키를 두 번 넣으면 폴백이 무의미하므로 중복을 제거한다.
 */
function splitKeyList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => cleanApiKey(part))
    .filter((key) => key.length > 0);
}

export function collectGeminiApiKeys(): string[] {
  const raw = [
    ...splitKeyList(process.env.GEMINI_API_KEY),
    ...splitKeyList(process.env.BACKUP_GEMINI_API_KEY),
  ];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of raw) {
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** 시작점을 `cursor` 만큼 밀어 회전시킨다(순수 함수). */
export function rotateKeys<T>(keys: readonly T[], cursor: number): T[] {
  if (keys.length <= 1) return [...keys];
  const start = ((cursor % keys.length) + keys.length) % keys.length;
  return [...keys.slice(start), ...keys.slice(0, start)];
}

/**
 * 호출마다 **시작 키를 한 칸씩 돌린다** — 첫 키에만 부하가 몰려 그 계정만
 * 먼저 상한에 닿는 것을 막는다(오너 지시 2026-07-30 "3개 계정을 돌려가며").
 * 실패 시 나머지 키로 넘어가는 폴백은 그대로다(각 호출부의 for 루프).
 *
 * 서버리스라 인스턴스마다 커서가 독립이지만, 인스턴스가 여럿이면 시작점이
 * 흩어져 분산 효과는 그대로 난다.
 */
let keyCursor = 0;
export function getGeminiApiKeys(): string[] {
  const keys = collectGeminiApiKeys();
  if (keys.length <= 1) return keys;
  const rotated = rotateKeys(keys, keyCursor);
  keyCursor = (keyCursor + 1) % keys.length;
  return rotated;
}

/** 테스트 전용 — 커서를 0으로 되돌린다(회전 순서를 결정적으로 만들기 위함). */
export function __resetGeminiKeyCursorForTest(): void {
  keyCursor = 0;
}

function getApiKeys(): string[] {
  return getGeminiApiKeys();
}

/**
 * SDK(`@google/genai`) 호출부용 키 로테이션 래퍼.
 *
 * raw REST 호출부는 각자 for 루프로 키를 순회하지만, SDK 호출부는 모듈 최상위에
 * `new GoogleGenAI({apiKey})` 를 상수로 두고 있어 **키가 하나로 박혀 폴백이
 * 없었다**(2026-07-30 적발). 이 헬퍼로 감싸면 같은 로테이션·폴백을 받는다.
 *
 * @param run 키 하나를 받아 실제 호출을 수행한다. 429/503/5xx 로 판정되는
 *            오류면 다음 키로 재시도하고, 그 외 오류는 즉시 던진다.
 */
export async function withGeminiKeyRotation<T>(
  run: (apiKey: string) => Promise<T>,
  /**
   * 호출부의 모델·표면. **생략하면 텍스트 기본값으로 기록된다** — 그러면 이미지
   * 실패가 `gemini-3.6-flash:generateContent` 로 남아 **텍스트 경로가 깨진 것처럼
   * 보인다.** 실사고 2026-08-01: 그 라벨 때문에 "이미지 호출이 텍스트 경로로 샌다"고
   * 오진했고, 실제 원인(`delivery` 파라미터 거부)에 도달하는 데 한 사이클을 썼다.
   * 비텍스트 호출부는 반드시 넘길 것.
   */
  label?: { model?: string; surface?: GeminiSurface },
): Promise<T> {
  const model = label?.model ?? GEMINI_MODEL;
  const surface = label?.surface;
  const keys = getGeminiApiKeys();
  const startedAt = Date.now();
  if (keys.length === 0) {
    await recordGeminiFailure({
      kind: "NO_KEYS",
      model,
      surface,
      statusCode: NO_HTTP_RESPONSE,
      keysTried: 0,
      lastKeyFingerprint: null,
      elapsedMs: Date.now() - startedAt,
      reason: "Gemini API 키가 서버에 설정되지 않았습니다 (GEMINI_API_KEY)",
    });
    throw new GeminiClientError(
      "Gemini API 키가 서버에 설정되지 않았습니다 (GEMINI_API_KEY)",
    );
  }
  let lastError: unknown;
  for (let i = 0; i < keys.length; i++) {
    try {
      return await run(keys[i]);
    } catch (error) {
      lastError = error;
      const status = extractErrorStatus(error);
      const retryable = status !== null && shouldRetryWithNextKey(status);
      // 종국 실패만 계측한다 — 다음 키로 넘어가는 중간 실패는 남기지 않는다
      // (P7 볼륨 규율: 재시도로 이어지는 일시적 실패는 행을 만들지 않는다).
      if (!retryable || i === keys.length - 1) {
        await recordGeminiFailure({
          kind: retryable ? "KEYS_EXHAUSTED" : "HTTP",
          model,
          surface,
          statusCode: status ?? NO_HTTP_RESPONSE,
          keysTried: i + 1,
          lastKeyFingerprint: describeGeminiKey(keys[i]),
          elapsedMs: Date.now() - startedAt,
          reason: truncateGeminiReason(error),
        });
        throw error;
      }
    }
  }
  throw lastError;
}

/**
 * SDK 오류에서 HTTP 상태를 뽑는다. `@google/genai` 는 오류 형태가 버전마다
 * 달라 status 필드 → code 필드 → 메시지 숫자 순으로 훑는다(추측 금지 원칙상
 * 못 찾으면 null 을 반환해 **재시도하지 않는다** — 인증 오류를 키 소진으로
 * 오인해 전 키를 태우는 것이 더 위험하다).
 */
export function extractErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof e.status === "number") return e.status;
  if (typeof e.code === "number") return e.code;
  if (typeof e.message === "string") {
    const match = e.message.match(/\b(429|5\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * status 코드로 "다음 키로 재시도할 가치가 있는지"를 판정하는 순수 함수 export.
 * shouldRetryWithNextKey()와 동일 로직 재사용 — pricesheet-extract-client.ts에서 사용.
 */
export function isRetryableGeminiStatus(status: number): boolean {
  return shouldRetryWithNextKey(status);
}

export class GeminiClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "GeminiClientError";
  }
}

function shouldRetryWithNextKey(status: number): boolean {
  // 429(쿼터 초과)·503(과부하)·5xx는 다음 키로 재시도할 가치가 있다.
  return status === 429 || status === 503 || status >= 500;
}

// 추가 지적: Gemini 호출이 hang되는 경우(네트워크 지연/서버 무응답) API 라우트가 영원히
// 대기하지 않도록 AbortController로 60초 타임아웃을 건다.
const FETCH_TIMEOUT_MS = 60_000;

async function fetchGenerateContent(
  apiKey: string,
  body: Record<string, unknown>
): Promise<{ res: Response; text: string }> {
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * system prompt + 대화 히스토리 + 도구 선언을 받아 Gemini generateContent를 호출한다.
 * 키 로테이션: GEMINI_API_KEY 실패(429/503/5xx) 시 BACKUP_GEMINI_API_KEY로 1회 재시도.
 * 모델은 주모델 SSOT(gemini-model.ts)를 따른다 — 여기서 하드코딩하지 않는다.
 */
export async function callGeminiWithTools(
  system: string,
  history: GeminiContent[],
  tools: GeminiToolDeclaration[],
  // 하위호환 옵션 — thinking 토큰이 maxOutputTokens를 잠식해(구 2.5-flash 실측 1,100~1,650)
  // 긴 산출물(콘텐츠 가이드 등)이 2048에서 잘리던 케이스. 3.6-flash+think:low로 thinking
  // 예산이 줄어 여유가 생겼으나, 기존 호출부의 override 동작은 그대로 유지한다.
  options?: { maxOutputTokens?: number }
): Promise<CallGeminiWithToolsResult> {
  const apiKeys = getApiKeys();
  const callStartedAt = Date.now();
  if (apiKeys.length === 0) {
    await recordGeminiFailure({
      kind: "NO_KEYS",
      model: GEMINI_MODEL,
      statusCode: NO_HTTP_RESPONSE,
      keysTried: 0,
      lastKeyFingerprint: null,
      elapsedMs: Date.now() - callStartedAt,
      reason: "Gemini API 키가 서버에 설정되지 않았습니다 (GEMINI_API_KEY)",
    });
    throw new GeminiClientError(
      "Gemini API 키가 서버에 설정되지 않았습니다. (.env의 GEMINI_API_KEY를 확인해주세요)"
    );
  }

  const requestBody: Record<string, unknown> = {
    systemInstruction: { role: "system", parts: [{ text: system }] },
    contents: history,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: options?.maxOutputTokens ?? 2048,
      thinkingConfig: { thinkingLevel: GEMINI_THINK_LOW },
    },
  };

  if (tools.length > 0) {
    requestBody.tools = [{ functionDeclarations: tools }];
  }

  const startedAt = Date.now();
  let lastError: { status: number; text: string } | null = null;

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    let res: Response;
    let bodyText: string;
    try {
      ({ res, text: bodyText } = await fetchGenerateContent(apiKey, requestBody));
    } catch (networkErr) {
      // 네트워크 레벨 오류는 다음 키로 넘어가되, 마지막 키였다면 던진다.
      if (i === apiKeys.length - 1) {
        await recordGeminiFailure({
          kind: "NETWORK",
          model: GEMINI_MODEL,
          statusCode: NO_HTTP_RESPONSE,
          keysTried: i + 1,
          lastKeyFingerprint: describeGeminiKey(apiKey),
          elapsedMs: Date.now() - callStartedAt,
          reason: truncateGeminiReason(networkErr),
        });
        throw new GeminiClientError("Gemini API 호출에 실패했습니다 (네트워크 오류)", undefined, networkErr);
      }
      continue;
    }

    if (!res.ok) {
      lastError = { status: res.status, text: bodyText };
      if (shouldRetryWithNextKey(res.status) && i < apiKeys.length - 1) {
        continue;
      }
      await recordGeminiFailure({
        kind: "HTTP",
        model: GEMINI_MODEL,
        statusCode: res.status,
        keysTried: i + 1,
        lastKeyFingerprint: describeGeminiKey(apiKey),
        elapsedMs: Date.now() - callStartedAt,
        reason: bodyText,
      });
      throw new GeminiClientError(
        `Gemini API 오류 (status=${res.status}): ${bodyText.slice(0, 500)}`,
        res.status
      );
    }

    const latencyMs = Date.now() - startedAt;
    const data = JSON.parse(bodyText);
    return parseGeminiResponse(data, latencyMs);
  }

  // 모든 키가 재시도 대상 오류로 소진된 경우
  await recordGeminiFailure({
    kind: "KEYS_EXHAUSTED",
    model: GEMINI_MODEL,
    statusCode: lastError?.status ?? NO_HTTP_RESPONSE,
    keysTried: apiKeys.length,
    lastKeyFingerprint: describeGeminiKey(apiKeys[apiKeys.length - 1]),
    elapsedMs: Date.now() - callStartedAt,
    reason: lastError?.text ?? "모든 키 소진(마지막 오류 본문 없음)",
  });
  throw new GeminiClientError(
    `Gemini API 오류 (모든 키 소진, status=${lastError?.status}): ${lastError?.text.slice(0, 500)}`,
    lastError?.status
  );
}

/**
 * 응답 파싱은 순수 함수라 계약 테스트가 직접 부른다 — 모델명 출처(아래 modelVersion
 * 우선 규칙)는 감사 기록으로 흘러가므로 fetch 목킹 없이 고정할 가치가 있다.
 */
export function parseGeminiResponse(data: any, latencyMs: number): CallGeminiWithToolsResult {
  const candidate = data?.candidates?.[0];
  const content: GeminiContent | null = candidate?.content ?? null;
  const parts: GeminiPart[] = content?.parts ?? [];

  const functionCalls: GeminiFunctionCall[] = parts
    .filter((p: any): p is { functionCall: GeminiFunctionCall } => !!p.functionCall)
    .map((p) => p.functionCall);

  const text = parts
    .filter((p: any): p is { text: string } => typeof p.text === "string")
    .map((p) => p.text)
    .join("");

  const usage: GeminiUsageMetadata | null = data?.usageMetadata
    ? {
        promptTokenCount: data.usageMetadata.promptTokenCount,
        candidatesTokenCount: data.usageMetadata.candidatesTokenCount,
        totalTokenCount: data.usageMetadata.totalTokenCount,
      }
    : null;

  /**
   * ⚠️ **요청한 모델과 응답한 모델은 같지 않을 수 있다.** Gemini API 는 응답 최상위에
   * `modelVersion` 으로 **실제 서빙된 모델**을 돌려준다 — 별칭(`-latest` 류)이 걸린
   * 경우나 구글이 마이너 리비전을 굴린 경우 요청 문자열과 갈린다.
   *
   * 여기서 상수를 반향하면 호출부는 "설정된 모델"을 받아 놓고 "실제 응답한 모델"로
   * 착각한다. 그 값이 `DealAssetDraft.model` 같은 **감사 기록**으로 흘러가면(C3 §6
   * 평가 루프가 모델 교체 전후를 가르는 축), 모델이 실제로 바뀐 구간을 못 가른다 —
   * 기록은 남았는데 틀린 값이라 오히려 더 나쁘다.
   *
   * 그래서 응답 값을 우선하고, 없을 때만 요청 상수로 떨어진다.
   */
  return {
    content,
    functionCalls,
    text,
    usage,
    model:
      typeof data?.modelVersion === "string" && data.modelVersion.trim()
        ? data.modelVersion.trim()
        : GEMINI_MODEL,
    latencyMs,
  };
}

/**
 * 순수 텍스트 스트리밍 응답이 필요한 경우(예: 되묻기 메시지의 타이핑 효과 등)를 위한 헬퍼.
 * v1 UI는 non-streaming 폴백도 허용하므로, 이 함수는 SSE 청크를 그대로 상위에 전달하는
 * ReadableStream을 반환한다. 실패 시(키 소진 등) 에러를 던진다 — 상위에서 텍스트 폴백 처리.
 */
export async function streamGeminiText(
  system: string,
  history: GeminiContent[]
): Promise<ReadableStream<Uint8Array>> {
  const apiKeys = getApiKeys();
  if (apiKeys.length === 0) {
    throw new GeminiClientError(
      "Gemini API 키가 서버에 설정되지 않았습니다. (.env의 GEMINI_API_KEY를 확인해주세요)"
    );
  }

  const requestBody = {
    systemInstruction: { role: "system", parts: [{ text: system }] },
    contents: history,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingLevel: GEMINI_THINK_LOW },
    },
  };

  let lastError: { status: number; text: string } | null = null;

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch (networkErr) {
      if (i === apiKeys.length - 1) {
        throw new GeminiClientError("Gemini 스트리밍 호출에 실패했습니다 (네트워크 오류)", undefined, networkErr);
      }
      continue;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      lastError = { status: res.status, text };
      if (shouldRetryWithNextKey(res.status) && i < apiKeys.length - 1) {
        continue;
      }
      throw new GeminiClientError(
        `Gemini 스트리밍 오류 (status=${res.status}): ${text.slice(0, 500)}`,
        res.status
      );
    }

    return res.body;
  }

  throw new GeminiClientError(
    `Gemini 스트리밍 오류 (모든 키 소진, status=${lastError?.status}): ${lastError?.text.slice(0, 500)}`,
    lastError?.status
  );
}

export { GEMINI_MODEL };
