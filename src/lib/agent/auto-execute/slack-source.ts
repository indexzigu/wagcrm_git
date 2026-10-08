/**
 * 슬랙 원문 대조 — 「Muse 가 실제로 이 요청을 했다」를 CRM 이 **스스로** 확인한다.
 *
 * 설계 정본: Hermes `docs/wag-bridge-phase2-plan.md` §3(오너 승인 2026-10-09).
 *
 * 기안의 출처 칸(`ActionProposal.sourceRef.slack`)은 작업 통로로 기안을 올린 쪽이 **스스로 적은**
 * 값이다. 그래서 그 값을 믿는 대신 그 위치의 메시지를 CRM 의 읽기 토큰으로 직접 가져와,
 * 작성자가 Muse 봇(3중 일치)이고 메시지 안 `muse-req` 블록이 기안 내용과 **정확히** 같을 때만
 * 통과시킨다. 사용자명·아이콘은 위조 가능하므로 보지 않는다.
 *
 * ⛔ 토큰 값을 로그·오류 문구·판정 기록 어디에도 넣지 말 것 — 오류 문구에는 슬랙이 돌려준
 *    오류 코드(`invalid_auth` 등)만 싣는다.
 * ⛔ 새 npm 의존성 없이 전역 `fetch` 만 쓴다. 모든 호출에 시간 제한을 건다.
 */

/** 슬랙 메시지에서 판정에 쓰는 칸만. 나머지 칸은 읽지 않는다. */
export type SlackMessage = {
  ts?: unknown;
  thread_ts?: unknown;
  user?: unknown;
  bot_id?: unknown;
  bot_profile?: { app_id?: unknown } | null;
  subtype?: unknown;
  edited?: unknown;
  text?: unknown;
};

export type SlackFetchResult =
  | { kind: "found"; message: SlackMessage }
  | { kind: "not_found" }
  | { kind: "error"; code: string };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SLACK_API = "https://slack.com/api";
/** 호출 한 번의 시간 제한. 회차 전체 예산은 호출부(자동 실행 회차)가 따로 건다. */
export const SLACK_FETCH_TIMEOUT_MS = 8_000;
/** 스레드 답글을 찾을 때 넘겨 볼 최대 쪽 수(쪽당 200건). */
const MAX_REPLY_PAGES = 3;
const REPLY_PAGE_SIZE = 200;

/** 슬랙의 `ok:false` 중 「그 메시지가 없다」로 확정되는 코드. 나머지는 재시도할 오류다. */
const NOT_FOUND_CODES = new Set(["thread_not_found", "message_not_found"]);

type SlackListResponse = {
  ok?: unknown;
  error?: unknown;
  messages?: unknown;
  response_metadata?: { next_cursor?: unknown } | null;
};

async function callSlack(
  fetchImpl: FetchLike,
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<{ ok: true; body: SlackListResponse } | { ok: false; code: string }> {
  const url = `${SLACK_API}/${method}?${new URLSearchParams(params).toString()}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    // 시간 초과·네트워크 오류. 오류 객체의 메시지는 요청 URL 을 담을 수 있어 이름만 남긴다.
    const name = error instanceof Error ? error.name : "unknown";
    return { ok: false, code: `fetch_${name}` };
  }
  if (!response.ok) return { ok: false, code: `http_${response.status}` };
  let body: SlackListResponse;
  try {
    body = (await response.json()) as SlackListResponse;
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  if (body?.ok !== true) {
    const code = typeof body?.error === "string" ? body.error.slice(0, 64) : "not_ok";
    return { ok: false, code };
  }
  return { ok: true, body };
}

function messagesOf(body: SlackListResponse): SlackMessage[] {
  return Array.isArray(body.messages)
    ? body.messages.filter((m): m is SlackMessage => m !== null && typeof m === "object")
    : [];
}

/**
 * 출처 위치의 메시지를 정확히 그 ts 로 가져온다.
 * - 최상위 글(threadTs === messageTs): `conversations.history`(latest=ts, inclusive, limit=1)
 * - 스레드 답글: `conversations.replies`(ts=threadTs)에서 정확히 messageTs 를 고른다.
 */
export async function fetchSlackSourceMessage(input: {
  fetchImpl: FetchLike;
  token: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
}): Promise<SlackFetchResult> {
  const { fetchImpl, token, channelId, threadTs, messageTs } = input;

  if (threadTs === messageTs) {
    const res = await callSlack(fetchImpl, token, "conversations.history", {
      channel: channelId,
      latest: messageTs,
      inclusive: "true",
      limit: "1",
    });
    if (!res.ok) return NOT_FOUND_CODES.has(res.code) ? { kind: "not_found" } : { kind: "error", code: res.code };
    const message = messagesOf(res.body).find((m) => m.ts === messageTs);
    return message ? { kind: "found", message } : { kind: "not_found" };
  }

  let cursor: string | undefined;
  for (let page = 0; page < MAX_REPLY_PAGES; page += 1) {
    const res = await callSlack(fetchImpl, token, "conversations.replies", {
      channel: channelId,
      ts: threadTs,
      limit: String(REPLY_PAGE_SIZE),
      ...(cursor ? { cursor } : {}),
    });
    if (!res.ok) return NOT_FOUND_CODES.has(res.code) ? { kind: "not_found" } : { kind: "error", code: res.code };
    const message = messagesOf(res.body).find((m) => m.ts === messageTs);
    if (message) return { kind: "found", message };
    const next = res.body.response_metadata?.next_cursor;
    if (typeof next !== "string" || next === "") return { kind: "not_found" };
    cursor = next;
  }
  // 쪽 상한을 넘겼다 — 없다고 단정하지 않는다(재시도할 오류로 둔다).
  return { kind: "error", code: "reply_page_limit" };
}

export type MuseIdentity = { botId: string; appId: string; userId: string };

/**
 * 작성자·상태 검사. 통과면 null, 아니면 판정 이름과 사람용 사유.
 * 작성자 = Muse 봇 **3중 일치**(bot_id · bot_profile.app_id · user) — Hermes 브리지 인증 규칙과 같다.
 */
export function checkMuseAuthorship(
  message: SlackMessage,
  expected: { identity: MuseIdentity; threadTs: string; messageTs: string },
): { verdict: "not_muse" | "edited" | "has_subtype" | "message_not_found"; detail: string } | null {
  if (message.ts !== expected.messageTs) {
    return { verdict: "message_not_found", detail: "가져온 메시지의 ts 가 출처와 다릅니다" };
  }
  // 답글이면 그 스레드 소속이어야 하고, 최상위 글이면 다른 스레드의 답글이 아니어야 한다.
  const threadOk =
    expected.threadTs === expected.messageTs
      ? message.thread_ts === undefined || message.thread_ts === expected.messageTs
      : message.thread_ts === expected.threadTs;
  if (!threadOk) {
    return { verdict: "message_not_found", detail: "메시지의 스레드가 출처와 다릅니다" };
  }
  const { identity } = expected;
  const appId = message.bot_profile && typeof message.bot_profile === "object" ? message.bot_profile.app_id : undefined;
  if (message.bot_id !== identity.botId || appId !== identity.appId || message.user !== identity.userId) {
    return { verdict: "not_muse", detail: "작성자가 Muse 봇(3중 일치)이 아닙니다" };
  }
  if (message.edited !== undefined) {
    return { verdict: "edited", detail: "수정된 메시지입니다" };
  }
  if (message.subtype !== undefined) {
    const subtype = typeof message.subtype === "string" ? message.subtype.slice(0, 40) : "?";
    return { verdict: "has_subtype", detail: `subtype 이 있는 메시지입니다(${subtype})` };
  }
  return null;
}

// Hermes `gateway/bridge/protocol.py` 의 `_BLOCK_RE`·`_MARKER_RE` 와 같은 모양.
const BLOCK_RE = /```muse-req[ \t]*\r?\n([\s\S]*?)```/g;
const MARKER_RE = /```muse-req\b/g;
export const MAX_BLOCK_BYTES = 16_384;

/**
 * 슬랙이 본문에서 바꾸는 세 글자(`& < >`)만 되돌린다. `&amp;` 를 **마지막에** 풀어야
 * `&amp;lt;` 가 `<` 로 두 번 풀리지 않는다(파이썬 `html.unescape` 의 한 번 풀기와 같은 결과).
 */
export function unescapeSlackText(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export type MuseRequestBlock = { v: unknown; rid: unknown; action: unknown; params: unknown };

/** 메시지 본문에서 `muse-req` 블록 **정확히 1개**를 꺼내 JSON 으로 읽는다. */
export function parseMuseRequestBlock(text: unknown): { ok: true; request: MuseRequestBlock } | { ok: false; detail: string } {
  if (typeof text !== "string") return { ok: false, detail: "메시지 본문이 없습니다" };
  const markers = text.match(MARKER_RE)?.length ?? 0;
  const blocks = Array.from(text.matchAll(BLOCK_RE), (m) => m[1]);
  if (markers === 0) return { ok: false, detail: "muse-req 블록이 없습니다" };
  if (markers !== 1 || blocks.length !== 1) return { ok: false, detail: "muse-req 블록이 정확히 1개가 아닙니다" };
  const body = unescapeSlackText(blocks[0]).trim();
  if (Buffer.byteLength(body, "utf8") > MAX_BLOCK_BYTES) return { ok: false, detail: "muse-req 블록이 너무 큽니다" };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, detail: "muse-req 블록이 JSON 이 아닙니다" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "muse-req 블록이 객체가 아닙니다" };
  }
  const obj = raw as Record<string, unknown>;
  return { ok: true, request: { v: obj.v, rid: obj.rid, action: obj.action, params: obj.params } };
}

/** 정산 금액 수정 기안 payload 의 args 로 허용되는 칸. 이 밖의 칸이 있으면 불일치다. */
const SETTLEMENT_PARAM_KEYS = new Set(["campaignId", "field", "expectedCurrentKrw", "newAmountKrw", "memo"]);

/**
 * 요청 params 와 기안 args 가 **정확히** 같은가 — 칸 집합(메모가 없으면 양쪽 다 없어야 한다)과
 * 값(엄격 비교, 스칼라만)이 모두 같아야 한다. 하나라도 다르면 칸 이름을 돌려준다.
 */
export function diffSettlementParams(params: unknown, args: Record<string, unknown>): string | null {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return "params";
  const p = params as Record<string, unknown>;
  const keys = new Set([...Object.keys(p), ...Object.keys(args)]);
  for (const key of keys) {
    if (!SETTLEMENT_PARAM_KEYS.has(key)) return key;
    if (Object.hasOwn(p, key) !== Object.hasOwn(args, key)) return key;
    const a = p[key];
    const b = args[key];
    if ((a !== null && typeof a === "object") || (b !== null && typeof b === "object")) return key;
    if (a !== b) return key;
  }
  return null;
}

/** 슬랙 ts(`1791476048.261769`) → epoch ms. 모양이 다르면 null. */
export function slackTsToMs(ts: string): number | null {
  const m = /^(\d{10})\.(\d{6})$/.exec(ts);
  if (!m) return null;
  return Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000);
}
