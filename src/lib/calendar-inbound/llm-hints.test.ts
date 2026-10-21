import { beforeEach, describe, expect, it, vi } from "vitest";

const recordGeminiFailure = vi.fn(async (_f: unknown) => undefined);
vi.mock("@/lib/agent/gemini-usage", async (orig) => ({
  ...(await orig<typeof import("@/lib/agent/gemini-usage")>()),
  recordGeminiFailure: (f: unknown) => recordGeminiFailure(f),
}));

import { extractTitleHints } from "./llm-hints";

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
    expect(r).toEqual({
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
    expect(r).toEqual({
      sellerHint: null,
      brandHint: "테스트브랜드",
      round: 2,
      kind: "payout",
    });
  });

  it("키가 없으면 fetch 없이 null", async () => {
    const fetchImpl = vi.fn();
    const prev = {
      a: process.env.GEMINI_API_KEY,
      b: process.env.BACKUP_GEMINI_API_KEY,
    };
    delete process.env.GEMINI_API_KEY;
    delete process.env.BACKUP_GEMINI_API_KEY;
    try {
      expect(await extractTitleHints(TITLE, { fetchImpl })).toBeNull();
    } finally {
      if (prev.a !== undefined) process.env.GEMINI_API_KEY = prev.a;
      if (prev.b !== undefined) process.env.BACKUP_GEMINI_API_KEY = prev.b;
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recordGeminiFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "NO_KEYS" }),
    );
  });

  it("비JSON 응답은 null", async () => {
    const fetchImpl = vi.fn(async () => geminiReply("이건 JSON 이 아님"));
    expect(
      await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" }),
    ).toBeNull();
  });

  it("스키마가 어긋나면 null", async () => {
    const fetchImpl = vi.fn(async () =>
      geminiReply({ round: "둘째", kind: "weird" }),
    );
    expect(
      await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" }),
    ).toBeNull();
  });

  it("HTTP 오류는 null 이고 실패가 계측된다", async () => {
    const fetchImpl = vi.fn(async () => geminiReply(null, 500));
    expect(
      await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" }),
    ).toBeNull();
    expect(recordGeminiFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "HTTP", statusCode: 500 }),
    );
  });

  it("네트워크 예외도 throw 하지 않는다", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });
    expect(
      await extractTitleHints(TITLE, { fetchImpl, apiKey: "k" }),
    ).toBeNull();
    expect(recordGeminiFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "NETWORK" }),
    );
  });
});
