import { beforeEach, describe, expect, it, vi } from "vitest";

const recordGeminiFailure = vi.fn(async (_f: unknown) => undefined);
vi.mock("@/lib/agent/gemini-usage", async (orig) => ({
  ...(await orig<typeof import("@/lib/agent/gemini-usage")>()),
  recordGeminiFailure: (f: unknown) => recordGeminiFailure(f),
}));

import {
  LOCAL_HINT_TIMEOUT_MS,
  resetLocalHintWarnings,
  extractTitleHintsLocal,
} from "./local-hints";

function ollamaReply(content: unknown, status = 200): Response {
  const body =
    status === 200
      ? {
          choices: [
            {
              message: {
                content:
                  typeof content === "string" ? content : JSON.stringify(content),
              },
            },
          ],
        }
      : { error: "boom" };
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  recordGeminiFailure.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const TITLE = "샘플셀러님 테스트브랜드 2차 공구";
const BASE = { baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:4b" };

describe("extractTitleHintsLocal", () => {
  it("로컬 모델 JSON 을 근거 있는 힌트로 돌려준다", async () => {
    const fetchImpl = vi.fn(async () =>
      ollamaReply({
        sellerHint: "샘플셀러",
        brandHint: "테스트브랜드",
        round: 2,
        kind: "campaign",
      }),
    );
    const r = await extractTitleHintsLocal(TITLE, { ...BASE, fetchImpl });
    expect(r).toEqual({
      kind: "hints",
      hints: {
        sellerHint: "샘플셀러",
        brandHint: "테스트브랜드",
        round: 2,
        kind: "campaign",
      },
    });
    expect(recordGeminiFailure).not.toHaveBeenCalled();
  });

  it("요청은 OpenAI 호환 경로이고 사고 끄기·결정적 설정을 싣는다", async () => {
    const fetchImpl = vi.fn(async () => ollamaReply({ sellerHint: "샘플셀러" }));
    await extractTitleHintsLocal(TITLE, { ...BASE, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    // qwen3.5 의 사고를 끄는 유일한 방법 — think:false 는 조용히 무시된다.
    expect(body.reasoning_effort).toBe("none");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(120);
    expect(body.model).toBe("qwen3.5:4b");
    expect(JSON.stringify(body.messages)).toContain(TITLE);
  });

  it("env 로 주소·모델을 바꿀 수 있고 기본값이 있다", async () => {
    const prev = {
      b: process.env.LOCAL_LLM_BASE_URL,
      m: process.env.CALENDAR_INBOUND_LOCAL_MODEL,
    };
    try {
      delete process.env.LOCAL_LLM_BASE_URL;
      delete process.env.CALENDAR_INBOUND_LOCAL_MODEL;
      const f1 = vi.fn(async () => ollamaReply({ sellerHint: "샘플셀러" }));
      await extractTitleHintsLocal(TITLE, { fetchImpl: f1 });
      const [u1, i1] = f1.mock.calls[0] as unknown as [string, RequestInit];
      expect(u1).toBe("http://127.0.0.1:11434/v1/chat/completions");
      expect(JSON.parse(i1.body as string).model).toBe("qwen3.5:4b");

      process.env.LOCAL_LLM_BASE_URL = "http://localhost:9999/";
      process.env.CALENDAR_INBOUND_LOCAL_MODEL = "other:1b";
      const f2 = vi.fn(async () => ollamaReply({ sellerHint: "샘플셀러" }));
      await extractTitleHintsLocal(TITLE, { fetchImpl: f2 });
      const [u2, i2] = f2.mock.calls[0] as unknown as [string, RequestInit];
      expect(u2).toBe("http://localhost:9999/v1/chat/completions");
      expect(JSON.parse(i2.body as string).model).toBe("other:1b");
    } finally {
      if (prev.b === undefined) delete process.env.LOCAL_LLM_BASE_URL;
      else process.env.LOCAL_LLM_BASE_URL = prev.b;
      if (prev.m === undefined) delete process.env.CALENDAR_INBOUND_LOCAL_MODEL;
      else process.env.CALENDAR_INBOUND_LOCAL_MODEL = prev.m;
    }
  });

  it("content 가 비면(사고가 reasoning 으로 샌 경우) none", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "", reasoning: "생각 중..." } }],
          }),
          { status: 200 },
        ),
    );
    expect(await extractTitleHintsLocal(TITLE, { ...BASE, fetchImpl })).toEqual({
      kind: "none",
    });
  });

  it("같은 실패는 한 회차에 한 번만 경고하고, 회차가 바뀌면(초기화) 다시 경고한다", async () => {
    const warn = vi.mocked(console.warn);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    resetLocalHintWarnings();
    warn.mockClear();
    await extractTitleHintsLocal(TITLE, { ...BASE, fetchImpl });
    await extractTitleHintsLocal(TITLE, { ...BASE, fetchImpl });
    expect(warn).toHaveBeenCalledTimes(1);
    resetLocalHintWarnings();
    await extractTitleHintsLocal(TITLE, { ...BASE, fetchImpl });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("연결 거부는 unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      });
    });
    expect(await extractTitleHintsLocal(TITLE, { ...BASE, fetchImpl })).toEqual({
      kind: "unavailable",
    });
    expect(recordGeminiFailure).not.toHaveBeenCalled();
  });

  it("시간 초과는 요청을 끊고 unavailable", async () => {
    let aborted = false;
    const fetchImpl = vi.fn(
      (_u: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            rej(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    expect(
      await extractTitleHintsLocal(TITLE, { ...BASE, fetchImpl, timeoutMs: 20 }),
    ).toEqual({ kind: "unavailable" });
    expect(aborted).toBe(true);
  });

  it("호출당 시간 제한 기본값은 30초", () => {
    expect(LOCAL_HINT_TIMEOUT_MS).toBe(30_000);
  });

  it("5xx·429 는 unavailable, 그 밖의 4xx 는 none", async () => {
    for (const [status, kind] of [
      [500, "unavailable"],
      [503, "unavailable"],
      [429, "unavailable"],
      [404, "none"],
      [400, "none"],
    ] as const) {
      const fetchImpl = vi.fn(async () => ollamaReply(null, status));
      expect(
        await extractTitleHintsLocal(TITLE, { ...BASE, fetchImpl }),
      ).toEqual({ kind });
    }
  });

  it("제목에 없는 이름·회차는 버린다", async () => {
    const fetchImpl = vi.fn(async () =>
      ollamaReply({
        sellerHint: "없는사람",
        brandHint: "테스트브랜드",
        round: 1,
        kind: "payout",
      }),
    );
    expect(
      await extractTitleHintsLocal("샘플셀러님 테스트브랜드 공구", {
        ...BASE,
        fetchImpl,
      }),
    ).toEqual({
      kind: "hints",
      hints: { sellerHint: null, brandHint: "테스트브랜드", round: null, kind: null },
    });
  });

  it("근거 있는 힌트가 하나도 없으면 none", async () => {
    const fetchImpl = vi.fn(async () =>
      ollamaReply({ sellerHint: "없는사람", brandHint: null, round: 9, kind: "payout" }),
    );
    expect(await extractTitleHintsLocal(TITLE, { ...BASE, fetchImpl })).toEqual({
      kind: "none",
    });
  });

  it("content 가 비JSON·스키마 불일치·응답 자체가 비JSON 이면 none", async () => {
    const replies = [
      ollamaReply("JSON 아님"),
      ollamaReply({ round: "둘째", kind: "weird" }),
      new Response("<html>oops</html>", { status: 200 }),
    ];
    for (const reply of replies) {
      const fetchImpl = vi.fn(async () => reply);
      expect(
        await extractTitleHintsLocal(TITLE, { ...BASE, fetchImpl }),
      ).toEqual({ kind: "none" });
    }
  });
});
