import {
  getGeminiApiKeys,
  isRetryableGeminiStatus,
} from "@/lib/agent/gemini-client";
import { GEMINI_PRIMARY_MODEL, GEMINI_THINK_LOW } from "@/lib/gemini-model";

/**
 * 상품자료 → 클레임 후보 추출 (C1 M3).
 *
 * 규율 3가지 — 이 셋이 무너지면 레지스트리가 "AI가 지어낸 근거"의 통로가 된다:
 *  1. **후보는 자료에 실제로 있는 문구만.** 그럴듯한 소구점을 창작하지 않는다.
 *  2. **근거 유형은 자료에 근거가 명시된 경우에만 상향.** 기본은 NEEDS_SOURCE 이고,
 *     시험성적서·인증번호가 자료에 있을 때만 MEASURED/USER_PROVIDED 로 제안한다.
 *  3. **DB 를 직접 쓰지 않는다.** 후보를 반환할 뿐이고 등록은 운영자가 고른 것만
 *     PROPOSED 로 들어간다(C1 §2-3 — 승인은 물론 등록조차 사람이 연다).
 *
 * 실패는 삼키지 않고 throw 한다 — 호출부가 사용자에게 그대로 알린다.
 */

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
const EXTRACT_MODEL = GEMINI_PRIMARY_MODEL;
const FETCH_TIMEOUT_MS = 45_000;
/** 프롬프트 폭주·비용 방지. 초과분은 잘라서 보낸다(잘림 사실은 호출부가 안내). */
export const MAX_SOURCE_CHARS = 12_000;
/** 한 번에 받을 후보 상한 — 검토 부담이 곧 무시로 이어진다. */
const MAX_CANDIDATES = 20;

export class ClaimExtractError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ClaimExtractError";
  }
}

export type ClaimCandidate = {
  kind: "APPROVED_CLAIM" | "BANNED_PHRASE" | "REQUIRED_DISCLOSURE";
  text: string;
  evidence: string | null;
  evidenceType: "MEASURED" | "USER_PROVIDED" | "NEEDS_SOURCE";
  /** 자료 어디서 나왔는지 — 운영자가 원문을 대조할 수 있게. */
  quote: string | null;
};

const KINDS = new Set([
  "APPROVED_CLAIM",
  "BANNED_PHRASE",
  "REQUIRED_DISCLOSURE",
]);
const EVIDENCE_TYPES = new Set(["MEASURED", "USER_PROVIDED", "NEEDS_SOURCE"]);

function buildPrompt(source: string, category: string | null): string {
  const categoryLine = category
    ? `이 상품의 카테고리는 ${category} 이다.`
    : "카테고리는 지정되지 않았다.";
  return `너는 한국 공동구매 운영자를 돕는 광고 표현 검토 보조자다.
아래 상품자료에서 **자료에 실제로 등장하는** 문구만 뽑아 클레임 후보를 만든다.

${categoryLine}

## 절대 규칙
- 자료에 없는 소구점을 만들어내지 마라. 없으면 후보를 적게 반환하거나 빈 배열을 반환한다.
- 각 후보의 quote 에는 자료 원문 조각을 그대로 넣는다(창작 금지). 원문에서 찾을 수 없으면 그 후보를 버린다.
- evidenceType 은 기본 "NEEDS_SOURCE" 다. 자료에 시험성적서 번호·인증번호·검사기관명 등
  구체적 근거가 **명시된 경우에만** "MEASURED", 브랜드가 제공한 사실 서술이면 "USER_PROVIDED".
  근거가 없는데 상향하지 마라.
- 최대 ${MAX_CANDIDATES}개까지만 반환한다.

## 후보 종류(kind)
- "APPROVED_CLAIM": 판매에 쓸 만한 소구점(성분·용량·원산지·인증 등 사실 진술)
- "BANNED_PHRASE": 이 상품에서 쓰면 위험한 표현(효능 단정·질병 언급·과장 최상급 등)
- "REQUIRED_DISCLOSURE": 반드시 함께 표기해야 하는 고지(주의사항·섭취 제한·경제적 이해관계 등)

## 출력(JSON만)
{"candidates":[{"kind":"...","text":"...","evidence":null 또는 "근거 설명","evidenceType":"...","quote":"자료 원문 조각"}]}

## 상품자료
${source}`;
}

/** 응답 배열을 계약 형태로만 통과시킨다 — 모델이 형식을 흔들어도 화면이 죽지 않게. */
export function parseCandidates(raw: unknown): ClaimCandidate[] {
  const list = (raw as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) return [];
  const out: ClaimCandidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const kind = typeof c.kind === "string" ? c.kind : "";
    const text = typeof c.text === "string" ? c.text.trim() : "";
    if (!KINDS.has(kind) || !text) continue;
    const evidenceType =
      typeof c.evidenceType === "string" && EVIDENCE_TYPES.has(c.evidenceType)
        ? (c.evidenceType as ClaimCandidate["evidenceType"])
        : "NEEDS_SOURCE";
    out.push({
      kind: kind as ClaimCandidate["kind"],
      text: text.slice(0, 500),
      evidence:
        typeof c.evidence === "string" && c.evidence.trim()
          ? c.evidence.trim().slice(0, 1000)
          : null,
      evidenceType,
      quote:
        typeof c.quote === "string" && c.quote.trim()
          ? c.quote.trim().slice(0, 300)
          : null,
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * 한 문구가 자료에 근거를 두는지 판정한다.
 *
 * 통째로 들어있으면 통과. 아니면 **모든 어절이 원문에 있어야** 통과한다 —
 * 모델이 자료 문장을 축약·재배열하는 것("국내산 유기농 원료를 사용했습니다"
 * → "국내산 유기농 원료 사용")은 정상이지만, 원문에 없는 단어를 하나라도
 * 얹는 것("국내산 최고 품질")은 창작이다.
 */
function isGrounded(phrase: string, compactSource: string): boolean {
  const compact = phrase.replace(/\s+/g, "").toLowerCase();
  if (compact.length === 0) return false;
  if (compactSource.includes(compact)) return true;
  const tokens = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => compactSource.includes(token));
}

/**
 * 자료에 실제로 없는 문구를 지어낸 후보를 떨어낸다.
 *
 * 모델이 규칙을 어겨도 여기서 걸린다 — 프롬프트는 지시일 뿐 보증이 아니다.
 * 공백을 무시하고 대조하므로 줄바꿈·들여쓰기 차이는 통과시킨다.
 *
 * ⚠️ **실제로 등록되는 것은 `text` 다** — `quote` 만 대조하면 진짜 원문 조각을
 * 붙여 놓고 `text` 에 과장을 얹는 우회가 열린다(코드리뷰 HIGH, 2026-07-30).
 * 그래서 `text` 를 항상 검증하고, `quote` 를 제시했다면 그것도 함께 본다.
 */
export function dropUngroundedCandidates(
  candidates: ClaimCandidate[],
  source: string,
): ClaimCandidate[] {
  const compactSource = source.replace(/\s+/g, "").toLowerCase();
  return candidates.filter((candidate) => {
    // 금지 표현·고지는 "자료에 없는 것을 새로 경고"하는 게 정상이라 대조하지 않는다.
    // (모델이 kind 를 위장해 창작을 끼워넣어도 그건 승인 소구점이 아니라
    //  경고 후보로 들어가므로, 운영자가 승인하지 않으면 아무 데도 쓰이지 않는다.)
    if (candidate.kind !== "APPROVED_CLAIM") return true;
    if (!isGrounded(candidate.text, compactSource)) return false;
    if (candidate.quote && !isGrounded(candidate.quote, compactSource)) {
      return false;
    }
    return true;
  });
}

export async function extractClaimCandidates(
  source: string,
  category: string | null,
): Promise<{ candidates: ClaimCandidate[]; truncated: boolean }> {
  const trimmed = source.trim();
  if (!trimmed) {
    // 자료가 없으면 지어내지 않는다(C1 NEEDS_INPUT 원칙).
    throw new ClaimExtractError("상품자료가 비어 있습니다");
  }
  const apiKeys = getGeminiApiKeys();
  if (apiKeys.length === 0) {
    throw new ClaimExtractError(
      "Gemini API 키가 서버에 설정되지 않았습니다 (.env의 GEMINI_API_KEY 확인)",
    );
  }

  const truncated = trimmed.length > MAX_SOURCE_CHARS;
  const payloadSource = truncated
    ? trimmed.slice(0, MAX_SOURCE_CHARS)
    : trimmed;

  const body = JSON.stringify({
    contents: [
      { role: "user", parts: [{ text: buildPrompt(payloadSource, category) }] },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1,
      thinkingConfig: { thinkingLevel: GEMINI_THINK_LOW },
    },
  });

  let lastError: { status: number; text: string } | null = null;
  for (let i = 0; i < apiKeys.length; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(
        `${GEMINI_API_BASE}/${EXTRACT_MODEL}:generateContent?key=${apiKeys[i]}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        },
      );
    } catch (err) {
      if (i === apiKeys.length - 1) {
        throw new ClaimExtractError("클레임 추출 호출에 실패했습니다", err);
      }
      continue;
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await res.text();
    if (!res.ok) {
      lastError = { status: res.status, text: bodyText };
      if (isRetryableGeminiStatus(res.status) && i < apiKeys.length - 1)
        continue;
      throw new ClaimExtractError(
        `클레임 추출 LLM 오류 (status=${res.status}): ${bodyText.slice(0, 300)}`,
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(bodyText);
    } catch (err) {
      throw new ClaimExtractError("클레임 추출 응답이 JSON이 아닙니다", err);
    }
    const text = extractResponseText(data);
    if (!text)
      throw new ClaimExtractError("클레임 추출 응답에 텍스트가 없습니다");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ClaimExtractError(
        "클레임 추출 결과를 해석하지 못했습니다",
        err,
      );
    }
    return {
      candidates: dropUngroundedCandidates(
        parseCandidates(parsed),
        payloadSource,
      ),
      truncated,
    };
  }

  throw new ClaimExtractError(
    `클레임 추출 LLM 오류 (모든 키 소진, status=${lastError?.status})`,
  );
}

function extractResponseText(data: unknown): string {
  const parts =
    (
      data as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      }
    )?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p): p is { text: string } => typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}
