/**
 * 가격표 인제스트 전용 멀티모달 Gemini 클라이언트 (Phase 3 청사진 §2).
 *
 * gemini-client.ts(Phase 2, 함수콜링 5도구 전용)를 확장하지 않고 별도 파일로 분리한다 —
 * 청사진 지시: "gemini-client 확장 금지, 키로테이션 헬퍼 export만 받아 재사용".
 * 여기서는 단발 generateContent 호출(텍스트 전용 또는 텍스트+inlineData)만 다룬다.
 *
 * mock-안전 패턴: partnerService.ts:319-421과 동일하게 API 키 미설정/모든 모델·키 실패 시
 * throw만 하고 절대 DB에 쓰지 않는다 — 호출부(extract-path-a/b)가 PriceSheet.status를
 * EXTRACT_FAILED로 남긴다.
 */
import { getGeminiApiKeys, isRetryableGeminiStatus } from "@/lib/agent/gemini-client";
import { GEMINI_PRIMARY_MODEL, GEMINI_THINK_LOW } from "@/lib/gemini-model";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// 멀티모달(이미지/pdf inlineData) 입력을 지원하는 주모델(SSOT)만 사용한다.
const EXTRACT_MODEL = GEMINI_PRIMARY_MODEL;
const FETCH_TIMEOUT_MS = 60_000;

export class PriceSheetLlmError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "PriceSheetLlmError";
  }
}

export type InlinePart = {
  mimeType: string;
  data: string; // base64
};

/**
 * 텍스트 프롬프트(+ 선택적 inlineData 1개)로 Gemini generateContent를 단발 호출하고,
 * responseMimeType=application/json으로 강제해 JSON 텍스트를 반환받는다.
 * 실패(키 소진/네트워크/비-JSON 응답)는 전부 throw — 호출부에서 rawCells 보존 + EXTRACT_FAILED 처리.
 */
export async function callPriceSheetExtractLlm(
  prompt: string,
  inlinePart?: InlinePart
): Promise<{ text: string; latencyMs: number }> {
  const apiKeys = getGeminiApiKeys();
  if (apiKeys.length === 0) {
    throw new PriceSheetLlmError(
      "Gemini API 키가 서버에 설정되지 않았습니다. (.env의 GEMINI_API_KEY를 확인해주세요)"
    );
  }

  const parts: Array<{ text: string } | { inlineData: InlinePart }> = [{ text: prompt }];
  if (inlinePart) {
    parts.push({ inlineData: inlinePart });
  }

  const requestBody = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      // 표 구조화 추출 — think:low(재배치). 주모델이 3.x라 thinkingLevel 유효.
      thinkingConfig: { thinkingLevel: GEMINI_THINK_LOW },
    },
  };

  const startedAt = Date.now();
  let lastError: { status: number; text: string } | null = null;

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    const url = `${GEMINI_API_BASE}/${EXTRACT_MODEL}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res: Response;
    let bodyText: string;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      bodyText = await res.text();
    } catch (networkErr) {
      if (i === apiKeys.length - 1) {
        throw new PriceSheetLlmError("가격표 추출 LLM 호출에 실패했습니다 (네트워크 오류)", networkErr);
      }
      continue;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      lastError = { status: res.status, text: bodyText };
      if (isRetryableGeminiStatus(res.status) && i < apiKeys.length - 1) {
        continue;
      }
      throw new PriceSheetLlmError(
        `가격표 추출 LLM 오류 (status=${res.status}): ${bodyText.slice(0, 500)}`
      );
    }

    const latencyMs = Date.now() - startedAt;
    let data: unknown;
    try {
      data = JSON.parse(bodyText);
    } catch (parseErr) {
      throw new PriceSheetLlmError("가격표 추출 LLM 응답이 JSON이 아닙니다", parseErr);
    }

    const text = extractResponseText(data);
    if (!text) {
      throw new PriceSheetLlmError("가격표 추출 LLM 응답에 텍스트가 없습니다");
    }
    return { text, latencyMs };
  }

  throw new PriceSheetLlmError(
    `가격표 추출 LLM 오류 (모든 키 소진, status=${lastError?.status}): ${lastError?.text.slice(0, 500)}`
  );
}

function extractResponseText(data: unknown): string {
  const candidate = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
    ?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  return parts
    .filter((p): p is { text: string } => typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

export { EXTRACT_MODEL };
