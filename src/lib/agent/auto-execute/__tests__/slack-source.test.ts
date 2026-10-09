/**
 * 슬랙 원문 대조 부품 — 네트워크 없이(가짜 fetch) 고정한다.
 * 회차 전체(후보·한도·잠금·실행)는 `settlement-auto-execute.realdb.test.ts` 가 본다.
 */
import { describe, expect, it, vi } from "vitest";
import {
  checkMuseAuthorship,
  diffSettlementParams,
  fetchSlackSourceMessage,
  parseMuseRequestBlock,
  parseRequestExpiry,
  slackTsToMs,
  unescapeSlackText,
  type FetchLike,
} from "../slack-source";

const IDENTITY = { botId: "BMUSE0001", appId: "AMUSE0001", userId: "UMUSE0001" };
const TS = "1791476048.261769";

function museMessage(overrides: Record<string, unknown> = {}) {
  return {
    ts: TS,
    user: IDENTITY.userId,
    bot_id: IDENTITY.botId,
    bot_profile: { app_id: IDENTITY.appId },
    text: "x",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("parseMuseRequestBlock", () => {
  it("블록 1개를 꺼내고 슬랙이 바꾼 & < > 를 되돌린다", () => {
    const text = '요청입니다.\n```muse-req\n{"v":1,"rid":"R","action":"a.b","params":{"memo":"A&amp;B &lt;x&gt;"}}\n```';
    const parsed = parseMuseRequestBlock(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.params).toEqual({ memo: "A&B <x>" });
  });

  it("&amp;lt; 는 한 번만 풀린다(파이썬 html.unescape 와 같은 결과)", () => {
    expect(unescapeSlackText("&amp;lt;")).toBe("&lt;");
  });

  it("블록이 없거나 둘이면 거부한다", () => {
    expect(parseMuseRequestBlock("그냥 글").ok).toBe(false);
    const two = "```muse-req\n{}\n```\n```muse-req\n{}\n```";
    expect(parseMuseRequestBlock(two).ok).toBe(false);
  });

  it("닫히지 않은 블록·JSON 아님·배열은 거부한다", () => {
    expect(parseMuseRequestBlock("```muse-req\n{\"v\":1}").ok).toBe(false);
    expect(parseMuseRequestBlock("```muse-req\nnot json\n```").ok).toBe(false);
    expect(parseMuseRequestBlock("```muse-req\n[1]\n```").ok).toBe(false);
  });

  it("16KB 를 넘는 블록은 거부한다", () => {
    const big = `\`\`\`muse-req\n{"v":1,"pad":"${"a".repeat(17_000)}"}\n\`\`\``;
    expect(parseMuseRequestBlock(big).ok).toBe(false);
  });
});

describe("checkMuseAuthorship", () => {
  const expected = { identity: IDENTITY, threadTs: TS, messageTs: TS };

  it("Muse 3중 일치 · 수정 없음 · subtype 없음이면 통과", () => {
    expect(checkMuseAuthorship(museMessage(), expected)).toBeNull();
  });

  it("같은 형식이라도 Wag 봇이 쓴 글은 not_muse", () => {
    const wag = museMessage({ bot_id: "BWAG00001", bot_profile: { app_id: "AWAG00001" }, user: "UWAG00001" });
    expect(checkMuseAuthorship(wag, expected)?.verdict).toBe("not_muse");
  });

  it("3중 중 하나만 달라도 not_muse(app_id 만 다름)", () => {
    expect(checkMuseAuthorship(museMessage({ bot_profile: { app_id: "AOTHER001" } }), expected)?.verdict).toBe(
      "not_muse",
    );
    expect(checkMuseAuthorship(museMessage({ bot_profile: null }), expected)?.verdict).toBe("not_muse");
  });

  it("수정된 메시지는 edited, subtype 이 있으면 has_subtype", () => {
    expect(checkMuseAuthorship(museMessage({ edited: { ts: "1" } }), expected)?.verdict).toBe("edited");
    expect(checkMuseAuthorship(museMessage({ subtype: "bot_message" }), expected)?.verdict).toBe("has_subtype");
  });

  it("ts 가 다르거나 다른 스레드의 답글이면 message_not_found", () => {
    expect(checkMuseAuthorship(museMessage({ ts: "1791476048.000001" }), expected)?.verdict).toBe(
      "message_not_found",
    );
    expect(checkMuseAuthorship(museMessage({ thread_ts: "1791470000.000001" }), expected)?.verdict).toBe(
      "message_not_found",
    );
  });
});

describe("diffSettlementParams", () => {
  const args = { campaignId: "c1", field: "settlementSales", expectedCurrentKrw: 100, newAmountKrw: 200 };

  it("완전히 같으면 null", () => {
    expect(diffSettlementParams({ ...args }, args)).toBeNull();
  });

  it("칸 하나만 달라도 그 칸 이름", () => {
    expect(diffSettlementParams({ ...args, newAmountKrw: 201 }, args)).toBe("newAmountKrw");
    expect(diffSettlementParams({ ...args, expectedCurrentKrw: null }, args)).toBe("expectedCurrentKrw");
  });

  it("메모 유무가 다르면 불일치(없음 ≠ 있음)", () => {
    expect(diffSettlementParams({ ...args, memo: "m" }, args)).toBe("memo");
    expect(diffSettlementParams(args, { ...args, memo: "m" })).toBe("memo");
  });

  it("정의 밖 칸·중첩 값·params 아님은 불일치", () => {
    expect(diffSettlementParams({ ...args, extra: 1 }, args)).toBe("extra");
    expect(diffSettlementParams({ ...args, newAmountKrw: { v: 200 } }, args)).toBe("newAmountKrw");
    expect(diffSettlementParams(null, args)).toBe("params");
  });
});

describe("parseRequestExpiry", () => {
  it("시간대가 있는 ISO 만 읽는다(브리지와 같은 규칙)", () => {
    expect(parseRequestExpiry("2026-10-09T03:00:00+09:00")).toBe(Date.parse("2026-10-08T18:00:00Z"));
    expect(parseRequestExpiry("2026-10-08T18:00:00Z")).toBe(Date.parse("2026-10-08T18:00:00Z"));
    expect(parseRequestExpiry("2026-10-09T03:00:00")).toBeNull();
    expect(parseRequestExpiry("내일")).toBeNull();
    expect(parseRequestExpiry(undefined)).toBeNull();
  });
});

describe("slackTsToMs", () => {
  it("초.마이크로초 → ms", () => {
    expect(slackTsToMs("1791476048.261769")).toBe(1791476048261);
    expect(slackTsToMs("bad")).toBeNull();
  });
});

describe("fetchSlackSourceMessage", () => {
  const base = { token: "xoxb-test", channelId: "C0TESTCHAN1" };

  it("최상위 글은 conversations.history(latest=ts, inclusive, limit=1)로 그 ts 를 고른다", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ ok: true, messages: [museMessage()] }));
    const result = await fetchSlackSourceMessage({ ...base, fetchImpl, threadTs: TS, messageTs: TS });
    expect(result.kind).toBe("found");
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.pathname).toBe("/api/conversations.history");
    expect(url.searchParams.get("latest")).toBe(TS);
    expect(url.searchParams.get("inclusive")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("channel")).toBe(base.channelId);
    // 토큰은 헤더로만 — URL 에 싣지 않는다.
    expect(fetchImpl.mock.calls[0][0]).not.toContain("xoxb");
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-test");
  });

  it("최상위 조회에 더 이른 메시지만 오면(그 ts 가 없음) not_found", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ ok: true, messages: [museMessage({ ts: "1791476000.000001" })] }),
    );
    expect((await fetchSlackSourceMessage({ ...base, fetchImpl, threadTs: TS, messageTs: TS })).kind).toBe(
      "not_found",
    );
  });

  it("답글은 conversations.replies(ts=threadTs)에서 정확히 messageTs 를 고르고, 다음 쪽도 본다", async () => {
    const thread = "1791470000.000001";
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [museMessage({ ts: thread })],
          response_metadata: { next_cursor: "c2" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, messages: [museMessage({ thread_ts: thread })] }));
    const result = await fetchSlackSourceMessage({ ...base, fetchImpl, threadTs: thread, messageTs: TS });
    expect(result.kind).toBe("found");
    const second = new URL(fetchImpl.mock.calls[1][0]);
    expect(second.pathname).toBe("/api/conversations.replies");
    expect(second.searchParams.get("ts")).toBe(thread);
    expect(second.searchParams.get("cursor")).toBe("c2");
  });

  it("답글 쪽 상한(3쪽) 안에서 못 찾으면 not_found(확정) — 긴 스레드가 후보 자리를 계속 차지하지 않게", async () => {
    const thread = "1791470000.000001";
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ ok: true, messages: [museMessage({ ts: thread })], response_metadata: { next_cursor: "more" } }),
    );
    const result = await fetchSlackSourceMessage({ ...base, fetchImpl, threadTs: thread, messageTs: TS });
    expect(result.kind).toBe("not_found");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("HTTP 오류·ok:false·네트워크 예외는 error(재시도), thread_not_found 는 not_found", async () => {
    const http = vi.fn<FetchLike>(async () => new Response("", { status: 429 }));
    expect(await fetchSlackSourceMessage({ ...base, fetchImpl: http, threadTs: TS, messageTs: TS })).toEqual({
      kind: "error",
      code: "http_429",
    });
    const notOk = vi.fn<FetchLike>(async () => jsonResponse({ ok: false, error: "invalid_auth" }));
    expect(await fetchSlackSourceMessage({ ...base, fetchImpl: notOk, threadTs: TS, messageTs: TS })).toEqual({
      kind: "error",
      code: "invalid_auth",
    });
    const boom = vi.fn<FetchLike>(async () => {
      throw new TypeError("network down https://slack.com/api/... token");
    });
    const res = await fetchSlackSourceMessage({ ...base, fetchImpl: boom, threadTs: TS, messageTs: TS });
    expect(res).toEqual({ kind: "error", code: "fetch_TypeError" });
    const gone = vi.fn<FetchLike>(async () => jsonResponse({ ok: false, error: "thread_not_found" }));
    expect(
      (await fetchSlackSourceMessage({ ...base, fetchImpl: gone, threadTs: "1791470000.000001", messageTs: TS })).kind,
    ).toBe("not_found");
  });
});
