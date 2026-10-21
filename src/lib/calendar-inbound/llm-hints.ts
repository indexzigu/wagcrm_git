// [캘린더수집] 규칙 파서가 실패한 일정 제목에서 LLM 으로 힌트(문자열)만 뽑는다.
// 모델은 DB id 를 고르지 않고, 제목에 실제로 있는 문자열만 인정한다(주입 차단).
// 실패는 삼키지 않되 던지지도 않는다 — 결과 종류로 돌려주고, 실패는 ApiCallLog 로 계측.
import { z } from "zod";
import {
  getGeminiApiKeys,
  isRetryableGeminiStatus,
} from "@/lib/agent/gemini-client";
import {
  NO_HTTP_RESPONSE,
  describeGeminiKey,
  recordGeminiFailure,
  truncateGeminiReason,
} from "@/lib/agent/gemini-usage";
import { GEMINI_LITE_MODEL } from "@/lib/gemini-model";
import { DEPOSIT_RE, PAYOUT_RE, ROUND_RE, normalizeToken } from "./parse-title";
import type { TitleHints } from "./types";

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
const FETCH_TIMEOUT_MS = 20_000;

const HintsSchema = z.object({
  sellerHint: z.string().nullish(),
  brandHint: z.string().nullish(),
  round: z.number().int().positive().max(99).nullish(),
  kind: z.enum(["campaign", "deposit", "payout"]).nullish(),
});

function buildPrompt(summary: string): string {
  return `아래는 한국 인플루언서 공동구매 운영자가 구글 캘린더에 적은 일정 제목이다.
여기서 다음을 뽑아 JSON 하나로만 답하라.
- sellerHint: 셀러(사람·닉네임) 이름
- brandHint: 브랜드·상품 이름
- round: "N차" 의 N (정수)
- kind: 입금 관련이면 "deposit", 지급·송금·정산금이면 "payout", 그 외 "campaign"
확실하지 않으면 null. 제목에 없는 이름을 절대 지어내지 말 것. 이름은 제목에 적힌 글자 그대로 옮길 것.
응답 형식: {"sellerHint":string|null,"brandHint":string|null,"round":number|null,"kind":string|null}

제목: ${summary}`;
}

function responseText(data: unknown): string {
  const parts =
    (
      data as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      }
    )?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
}

/** 제목(정규화)에 실제로 들어 있는 힌트만 남긴다. */
function grounded(
  hint: string | null | undefined,
  normTitle: string,
): string | null {
  if (!hint) return null;
  const n = normalizeToken(hint);
  return n.length >= 2 && normTitle.includes(n) ? hint.trim() : null;
}

function groundedRound(
  round: number | null | undefined,
  title: string,
): number | null {
  if (round == null) return null;
  const m = ROUND_RE.exec(title.normalize("NFC"));
  return m && Number(m[1]) === round ? round : null;
}

function groundedKind(
  kind: TitleHints["kind"] | undefined,
  title: string,
): TitleHints["kind"] {
  if (!kind) return null;
  const t = title.normalize("NFC");
  if (kind === "deposit") return DEPOSIT_RE.test(t) ? kind : null;
  if (kind === "payout") return PAYOUT_RE.test(t) ? kind : null;
  return kind;
}

/**
 * 힌트 추출 결과.
 * - `hints`: 제목에 근거 있는 힌트가 하나 이상 있다.
 * - `none`: 다시 물어도 같다 — 키 미설정 · 재시도해도 안 될 HTTP 오류 · 응답이 비JSON/스키마 불일치 ·
 *   근거 있는 힌트 없음. 호출부는 이 일정을 해석 실패로 닫아도 된다.
 * - `unavailable`: 일시 장애(네트워크 예외·시간 초과 · 429/5xx · 키 전부 소진) — 호출부는 닫지 말고
 *   다음 회차에 다시 물어야 한다(닫으면 장애 한 번에 그 일정이 영영 해석 실패로 남는다).
 */
export type TitleHintsResult =
  | { kind: "hints"; hints: TitleHints }
  | { kind: "none" }
  | { kind: "unavailable" };

const NONE: TitleHintsResult = { kind: "none" };
const UNAVAILABLE: TitleHintsResult = { kind: "unavailable" };

export async function extractTitleHints(
  summary: string,
  deps: { fetchImpl?: typeof fetch; apiKey?: string } = {},
): Promise<TitleHintsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const keys = deps.apiKey ? [deps.apiKey] : getGeminiApiKeys();
  const startedAt = Date.now();
  const fail = async (
    kind: "NO_KEYS" | "NETWORK" | "HTTP" | "KEYS_EXHAUSTED",
    statusCode: number,
    keysTried: number,
    lastKey: string | undefined,
    reason: unknown,
  ) => {
    console.error(
      `[calendar-inbound] 힌트 추출 실패 (${kind}, status=${statusCode})`,
    );
    await recordGeminiFailure({
      kind,
      model: GEMINI_LITE_MODEL,
      statusCode,
      keysTried,
      lastKeyFingerprint: describeGeminiKey(lastKey),
      elapsedMs: Date.now() - startedAt,
      reason: truncateGeminiReason(reason),
    });
  };

  if (keys.length === 0) {
    await fail(
      "NO_KEYS",
      NO_HTTP_RESPONSE,
      0,
      undefined,
      "GEMINI_API_KEY 미설정",
    );
    return NONE;
  }

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: buildPrompt(summary) }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  });

  for (let i = 0; i < keys.length; i++) {
    const isLast = i === keys.length - 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(
        `${GEMINI_API_BASE}/${GEMINI_LITE_MODEL}:generateContent?key=${keys[i]}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        },
      );
      text = await res.text();
    } catch (err) {
      if (isLast) {
        await fail("NETWORK", NO_HTTP_RESPONSE, i + 1, keys[i], err);
        return UNAVAILABLE;
      }
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const retryable = isRetryableGeminiStatus(res.status);
      if (retryable && !isLast) continue;
      await fail(
        i > 0 && retryable ? "KEYS_EXHAUSTED" : "HTTP",
        res.status,
        i + 1,
        keys[i],
        text,
      );
      // 429/5xx(키 하나여도)는 일시 장애 — 다음 회차에 다시 묻는다. 그 밖의 HTTP 오류는 다시 물어도 같다.
      return retryable ? UNAVAILABLE : NONE;
    }

    try {
      const inner = responseText(JSON.parse(text));
      const parsed = HintsSchema.parse(JSON.parse(inner));
      const norm = normalizeToken(summary);
      const hints: TitleHints = {
        sellerHint: grounded(parsed.sellerHint, norm),
        brandHint: grounded(parsed.brandHint, norm),
        // 회차·종류도 제목에 근거가 있을 때만 인정한다(지어낸 값이 엉뚱한 회차/종류를
        // 고치지 못하게). "campaign" 은 기본값이라 그대로 통과시킨다.
        round: groundedRound(parsed.round, summary),
        kind: groundedKind(parsed.kind, summary),
      };
      const empty =
        hints.sellerHint === null &&
        hints.brandHint === null &&
        hints.round === null &&
        hints.kind === null;
      return empty ? NONE : { kind: "hints", hints };
    } catch {
      console.error(
        "[calendar-inbound] 힌트 응답을 해석하지 못했습니다 (비JSON 또는 스키마 불일치)",
      );
      return NONE;
    }
  }
  return NONE;
}
