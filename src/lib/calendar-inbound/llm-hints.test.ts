import { beforeEach, describe, expect, it, vi } from "vitest";

const recordGeminiFailure = vi.fn(async (_f: unknown) => undefined);
vi.mock("@/lib/agent/gemini-usage", async (orig) => ({
  ...(await orig<typeof import("@/lib/agent/gemini-usage")>()),
  recordGeminiFailure: (f: unknown) => recordGeminiFailure(f),
}));

import { extractTitleHints, type TitleHintsResult } from "./llm-hints";

/** hints 결과면 그 힌트, 아니면 null — 근거 검증 테스트용. */
function hintsOf(r: TitleHintsResult) {
  return r.kind === "hints" ? r.hints : null;
}

function geminiReply(obj: unknown, status = 200): Response {
  const body =
    status === 200
      ? {
          candidates: [
            {
              content: {
                parts: [
                  { text: typeof obj === "string" ? obj : JSON.stringify(obj) },
                ],
              },
            },
          ],
        }
      : { error: "boom" };
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  recordGeminiFailure.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const TITLE = "샘플셀러님 테스트브랜드 2차 공구";

describe("extractTitleHints", () => {
  it("모델 JSON 을 힌트로 돌려준다", async () => {
    const fetchImpl = vi.fn(async () =>
      geminiReply({
        sellerHint: "샘플셀러",
        brandHint: "테스트브랜드",
        round: 2,
        kind: "campaign",
      }),
    );
    const r = await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" });
    expect(hintsOf(r)).toEqual({
      sellerHint: "샘플셀러",
      brandHint: "테스트브랜드",
      round: 2,
      kind: "campaign",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("gemini-2.5-flash-lite:generateContent");
    expect(
      JSON.parse(init.body as string).generationConfig.responseMimeType,
    ).toBe("application/json");
  });

  it("제목에 없는 이름은 버린다 — 모델이 이름을 주입할 수 없다", async () => {
    const fetchImpl = vi.fn(async () =>
      geminiReply({
        sellerHint: "없는사람",
        brandHint: "테스트브랜드",
        round: 2,
        kind: "payout",
      }),
    );
    const r = await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" });
    expect(hintsOf(r)).toEqual({
      sellerHint: null,
      brandHint: "테스트브랜드",
      round: 2,
      kind: null,
    });
  });

  it("제목에 차가 없으면 모델이 준 회차는 버린다", async () => {
    const fetchImpl = vi.fn(async () =>
      geminiReply({
        sellerHint: "샘플셀러",
        brandHint: null,
        round: 3,
        kind: null,
      }),
    );
    const r = await extractTitleHints("샘플셀러님 테스트브랜드 공구", {
      fetchImpl,
      apiKey: "k",
    });
    expect(hintsOf(r)?.round ?? null).toBeNull();
  });

  it("제목의 회차와 다른 숫자도 버린다", async () => {
    const fetchImpl = vi.fn(async () => geminiReply({ round: 3, kind: null }));
    const r = await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" });
    expect(hintsOf(r)?.round ?? null).toBeNull();
  });

  it("제목에 입금/지급 키워드가 없으면 deposit/payout 종류를 버린다", async () => {
    for (const kind of ["deposit", "payout"]) {
      const fetchImpl = vi.fn(async () => geminiReply({ round: 2, kind }));
      const r = await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" });
      expect(hintsOf(r)?.kind ?? null).toBeNull();
    }
  });

  it("근거 있는 입금·정산금 종류는 통과한다", async () => {
    const dep = vi.fn(async () => geminiReply({ kind: "deposit" }));
    expect(
      (
        hintsOf(await extractTitleHints("샘플셀러 입금", {
          fetchImpl: dep,
          apiKey: "k",
        }))
      )?.kind,
    ).toBe("deposit");
    const pay = vi.fn(async () => geminiReply({ kind: "payout" }));
    expect(
      (
        hintsOf(await extractTitleHints("샘플셀러 정산금", {
          fetchImpl: pay,
          apiKey: "k",
        }))
      )?.kind,
    ).toBe("payout");
  });

  it("키가 없으면 fetch 없이 none(설정 문제라 다시 물어도 같다)", async () => {
    const fetchImpl = vi.fn();
    const prev = {
      a: process.env.GEMINI_API_KEY,
      b: process.env.BACKUP_GEMINI_API_KEY,
    };
    delete process.env.GEMINI_API_KEY;
    delete process.env.BACKUP_GEMINI_API_KEY;
    try {
      expect(await extractTitleHints(TITLE, { fetchImpl })).toEqual({ kind: "none" });
    } finally {
      if (prev.a !== undefined) process.env.GEMINI_API_KEY = prev.a;
      if (prev.b !== undefined) process.env.BACKUP_GEMINI_API_KEY = prev.b;
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recordGeminiFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "NO_KEYS" }),
    );
  });

  it("비JSON 응답은 none", async () => {
    const fetchImpl = vi.fn(async () => geminiReply("이건 JSON 이 아님"));
    expect(
      await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" }),
    ).toEqual({ kind: "none" });
  });

  it("스키마가 어긋나면 none", async () => {
    const fetchImpl = vi.fn(async () =>
      geminiReply({ round: "둘째", kind: "weird" }),
    );
    expect(
      await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" }),
    ).toEqual({ kind: "none" });
  });

  it("5xx 는 unavailable(일시 장애) 이고 실패가 계측된다", async () => {
    const fetchImpl = vi.fn(async () => geminiReply(null, 500));
    expect(
      await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" }),
    ).toEqual({ kind: "unavailable" });
    expect(recordGeminiFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "HTTP", statusCode: 500 }),
    );
  });

  it("네트워크 예외는 throw 하지 않고 unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });
    expect(
      await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" }),
    ).toEqual({ kind: "unavailable" });
    expect(recordGeminiFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "NETWORK" }),
    );
  });

  it("429 도 unavailable", async () => {
    const fetchImpl = vi.fn(async () => geminiReply(null, 429));
    expect(await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" })).toEqual({ kind: "unavailable" });
  });

  it("재시도해도 안 될 HTTP 오류(400)는 none 이고 계측된다", async () => {
    const fetchImpl = vi.fn(async () => geminiReply(null, 400));
    expect(await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" })).toEqual({ kind: "none" });
    expect(recordGeminiFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: "HTTP", statusCode: 400 }));
  });

  it("키 여럿이 전부 429/5xx 면 KEYS_EXHAUSTED 로 계측하고 unavailable", async () => {
    const prev = { a: process.env.GEMINI_API_KEY, b: process.env.BACKUP_GEMINI_API_KEY };
    process.env.GEMINI_API_KEY = "k1";
    process.env.BACKUP_GEMINI_API_KEY = "k2";
    const fetchImpl = vi.fn(async () => geminiReply(null, 503));
    try {
      expect(await extractTitleHints(TITLE, { fetchImpl })).toEqual({ kind: "unavailable" });
    } finally {
      if (prev.a === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev.a;
      if (prev.b === undefined) delete process.env.BACKUP_GEMINI_API_KEY;
      else process.env.BACKUP_GEMINI_API_KEY = prev.b;
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(recordGeminiFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: "KEYS_EXHAUSTED" }));
  });

  it("근거 있는 힌트가 하나도 없으면 none", async () => {
    const fetchImpl = vi.fn(async () =>
      geminiReply({ sellerHint: "없는사람", brandHint: null, round: 9, kind: "payout" }),
    );
    expect(await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" })).toEqual({ kind: "none" });
  });
});
