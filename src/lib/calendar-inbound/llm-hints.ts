// [캘린더수집] 규칙 파서가 실패한 일정 제목에서 LLM 으로 힌트(문자열)만 뽑는다.
// 모델은 DB id 를 고르지 않고, 제목에 실제로 있는 문자열만 인정한다(주입 차단).
// 실패는 삼키지 않되 던지지도 않는다 — 결과 종류로 돌려주고, 실패는 ApiCallLog 로 계측.
//
// 이 파일은 로컬 모델(local-hints.ts)과 Gemini 일괄이 함께 쓰는 조각 — 지시문,
// 응답 스키마, 근거 방벽(groundHints) — 의 정본이다. 경로마다 복제하면 한쪽만 고쳐져
// 모델이 지어낸 이름이 그 경로로만 새어 들어간다.
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
/** Gemini 키 하나당 요청 시간 제한. 호출부(수집 스캔)가 일괄을 시작할지 가늠하는 단위이기도 하다. */
export const GEMINI_FETCH_TIMEOUT_MS = 20_000;

/**
 * Gemini 일괄 호출 한 번에 담는 제목 수 상한. 넘기면 호출 전에 던진다 — 나누는 것은
 * 호출부 몫이다(회차당 Gemini 1번 규약이라, 여기서 몰래 여러 번 부르면 그 규약이 깨진다).
 */
export const MAX_GEMINI_BATCH = 30;

export const HintsSchema = z.object({
  sellerHint: z.string().nullish(),
  brandHint: z.string().nullish(),
  round: z.number().int().positive().max(99).nullish(),
  kind: z.enum(["campaign", "deposit", "payout"]).nullish(),
});
export type RawHints = z.infer<typeof HintsSchema>;

/** 모든 경로 공통 지시 — 필드 정의와 「지어내지 말 것」. */
export const HINT_FIELD_RULES = `- sellerHint: 셀러(사람·닉네임) 이름
- brandHint: 브랜드·상품 이름
- round: "N차" 의 N (정수). 제목에 "N차" 가 없으면 null
- kind: 입금 관련이면 "deposit", 지급·송금·정산금이면 "payout", 그 외 "campaign"
확실하지 않으면 null. 제목에 없는 이름을 절대 지어내지 말 것. 이름은 제목에 적힌 글자 그대로 옮길 것.`;

const TITLE_CONTEXT =
  "한국 인플루언서 공동구매 운영자가 구글 캘린더에 적은 일정 제목";

/** 제목 하나용 지시문(로컬 모델용 — 일괄 지시문과 필드 규칙을 공유한다). */
export function buildHintPrompt(summary: string): string {
  return `아래는 ${TITLE_CONTEXT}이다.
여기서 다음을 뽑아 JSON 하나로만 답하라.
${HINT_FIELD_RULES}
응답 형식: {"sellerHint":string|null,"brandHint":string|null,"round":number|null,"kind":string|null}

제목: ${summary}`;
}

function buildBatchPrompt(items: ReadonlyArray<{ id: string; summary: string }>): string {
  // 제목은 JSON 문자열로 넣는다 — 제목 안의 따옴표·줄바꿈이 지시문 구조를 흔들지 못하게.
  const list = JSON.stringify(items.map((it) => ({ id: it.id, title: it.summary })));
  return `아래 JSON 배열의 각 항목은 ${TITLE_CONTEXT}이다(id 로 구분).
각 항목의 title 에서 다음을 뽑아라.
${HINT_FIELD_RULES}
각 항목은 그 항목 자신의 title 만 보고 판단할 것(다른 항목의 이름을 옮기지 말 것).
응답은 JSON 배열 하나로만: [{"id":string,"sellerHint":string|null,"brandHint":string|null,"round":number|null,"kind":string|null}, ...]
id 는 입력의 id 를 그대로 쓸 것.

항목: ${list}`;
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

export const NONE: TitleHintsResult = { kind: "none" };
export const UNAVAILABLE: TitleHintsResult = { kind: "unavailable" };

/**
 * 근거 방벽 — 모델이 준 값 중 그 제목에 근거가 있는 것만 남긴다. 하나도 없으면 none.
 * 회차·종류도 제목에 근거가 있을 때만 인정한다(지어낸 값이 엉뚱한 회차/종류를
 * 고치지 못하게). "campaign" 은 기본값이라 그대로 통과시킨다.
 */
export function groundHints(raw: RawHints, summary: string): TitleHintsResult {
  const norm = normalizeToken(summary);
  const hints: TitleHints = {
    sellerHint: grounded(raw.sellerHint, norm),
    brandHint: grounded(raw.brandHint, norm),
    round: groundedRound(raw.round, summary),
    kind: groundedKind(raw.kind, summary),
  };
  const empty =
    hints.sellerHint === null &&
    hints.brandHint === null &&
    hints.round === null &&
    hints.kind === null;
  return empty ? NONE : { kind: "hints", hints };
}

type GeminiDeps = {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  /**
   * 키 회전 전체에 거는 시간 한도(ms, 호출 시작부터). 키마다 20초씩 새로 주면 키 수 × 20초가 되어 호출부의 시간
   * 예산을 넘는다 — 한도가 지나면 다음 키로 넘어가지 않고 unavailable(일시 장애)로 끝낸다. 없으면 키당 20초만.
   */
  totalTimeoutMs?: number;
};

/**
 * Gemini generateContent 1회(키 회전 포함). 성공이면 모델이 낸 텍스트, 아니면
 * none(다시 물어도 같다)/unavailable(일시 장애). 실패만 계측한다(성공 행 금지).
 */
async function callGemini(
  prompt: string,
  deps: GeminiDeps,
): Promise<{ kind: "text"; text: string } | { kind: "none" } | { kind: "unavailable" }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const keys = deps.apiKey ? [deps.apiKey] : getGeminiApiKeys();
  const startedAt = Date.now();
  const deadline = deps.totalTimeoutMs === undefined ? Infinity : startedAt + deps.totalTimeoutMs;
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
    return { kind: "none" };
  }

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  });

  for (let i = 0; i < keys.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // 첫 키 전에 이미 한도가 지났다(호출부 예산 계산 실수) — 부르지 않았으니 계측할 실패도 없다.
      console.error("[calendar-inbound] 힌트 호출 시간 한도가 이미 지나 부르지 않음");
      return { kind: "unavailable" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(GEMINI_FETCH_TIMEOUT_MS, remaining));
    // 다음 키로 넘어갈 수 있는지는 이 시도가 끝난 뒤에 판단한다 — 한도가 지났으면 이 키가 마지막이다.
    const isLastAttempt = () => i === keys.length - 1 || Date.now() >= deadline;
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
      if (isLastAttempt()) {
        await fail("NETWORK", NO_HTTP_RESPONSE, i + 1, keys[i], err);
        return { kind: "unavailable" };
      }
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const retryable = isRetryableGeminiStatus(res.status);
      if (retryable && !isLastAttempt()) continue;
      await fail(
        i > 0 && retryable ? "KEYS_EXHAUSTED" : "HTTP",
        res.status,
        i + 1,
        keys[i],
        text,
      );
      // 429/5xx(키 하나여도)는 일시 장애 — 다음 회차에 다시 묻는다. 그 밖의 HTTP 오류는 다시 물어도 같다.
      return retryable ? { kind: "unavailable" } : { kind: "none" };
    }

    try {
      return { kind: "text", text: responseText(JSON.parse(text)) };
    } catch {
      console.error(
        "[calendar-inbound] 힌트 응답 봉투가 JSON 이 아닙니다",
      );
      return { kind: "none" };
    }
  }
  return { kind: "none" };
}

const BatchEntrySchema = z.object({ id: z.string() }).passthrough();

/** 모델이 배열을 `{results:[...]}` 로 감싸 오는 경우도 받아 준다. */
function batchArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  const inner = (parsed as { results?: unknown } | null)?.results;
  return Array.isArray(inner) ? inner : null;
}

export type TitleHintsBatchResult =
  | { kind: "ok"; results: Map<string, TitleHintsResult> }
  | { kind: "unavailable" };

/**
 * 여러 제목을 Gemini 1회로 해석한다(최대 MAX_GEMINI_BATCH 개, 넘기거나 입력 id 가 겹치면 RangeError).
 * - 응답 배열은 순서가 아니라 id 로 매칭한다. 응답에 없는 id 는 none, 입력에 없는 id 는
 *   무시, 같은 id 가 여러 번이면 첫 것만 쓴다.
 * - 근거 방벽은 항목마다 **그 항목 자신의 제목**으로 판정한다(옆 제목의 이름이 건너오지 못하게).
 * - 일시 장애(네트워크·시간 초과·429/5xx·키 소진)는 unavailable — 호출부는 닫지 말고 다음
 *   회차에 다시 묻는다. 키 없음·비JSON·배열 아님은 ok + 전부 none(다시 물어도 같다).
 * - 결과 Map 에는 입력 id 가 빠짐없이 들어 있다.
 */
export async function extractTitleHintsBatch(
  items: ReadonlyArray<{ id: string; summary: string }>,
  deps: GeminiDeps = {},
): Promise<TitleHintsBatchResult> {
  if (items.length > MAX_GEMINI_BATCH) {
    throw new RangeError(
      `extractTitleHintsBatch: 한 번에 최대 ${MAX_GEMINI_BATCH}개 (받은 수 ${items.length})`,
    );
  }
  // 같은 id 가 둘이면 응답을 어느 제목에 붙일지 정할 수 없다(근거 방벽도 엉뚱한 제목으로 판정된다).
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) {
      throw new RangeError(`extractTitleHintsBatch: 입력 id 중복 (${it.id})`);
    }
    seen.add(it.id);
  }
  const results = new Map<string, TitleHintsResult>();
  if (items.length === 0) return { kind: "ok", results };
  const allNone = () => {
    for (const it of items) results.set(it.id, NONE);
    return { kind: "ok" as const, results };
  };

  const r = await callGemini(buildBatchPrompt(items), deps);
  if (r.kind === "unavailable") return { kind: "unavailable" };
  if (r.kind === "none") return allNone();

  let entries: unknown[] | null;
  try {
    entries = batchArray(JSON.parse(r.text));
  } catch {
    entries = null;
  }
  if (!entries) {
    console.error(
      "[calendar-inbound] 일괄 힌트 응답을 해석하지 못했습니다 (비JSON 또는 배열 아님)",
    );
    return allNone();
  }

  const summaryById = new Map(items.map((it) => [it.id, it.summary]));
  for (const entry of entries) {
    const head = BatchEntrySchema.safeParse(entry);
    if (!head.success) continue;
    const { id } = head.data;
    const summary = summaryById.get(id);
    if (summary === undefined || results.has(id)) continue;
    const parsed = HintsSchema.safeParse(entry);
    results.set(id, parsed.success ? groundHints(parsed.data, summary) : NONE);
  }
  for (const it of items) if (!results.has(it.id)) results.set(it.id, NONE);
  return { kind: "ok", results };
}
