// 이미지 응답 파싱 — **모양이 어긋나면 조용히 넘어가지 않는다**(P0 No Silent Failure).
//
// 빈 이미지를 저장하면 프레임에 깨진 그림이 박히고, 그때는 "모델이 이상한 걸 그렸다"와
// "응답 모양이 바뀌었다"를 구분할 수 없다. 그래서 파싱은 던지고, 호출부가 컷 단위로 잡는다.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { recordFailure, rotation } = vi.hoisted(() => ({
  recordFailure: vi.fn(),
  rotation: vi.fn(),
}));
vi.mock("@/lib/agent/gemini-usage", () => ({
  recordGeminiFailure: recordFailure,
  truncateGeminiReason: (e: unknown) => String(e),
}));
vi.mock("@/lib/agent/gemini-client", async (orig) => ({
  ...(await orig<typeof import("../gemini-client")>()),
  withGeminiKeyRotation: rotation,
}));

import { extractInlineImage, generateSketchImage } from "../gemini-image";
import { GeminiClientError } from "../gemini-client";

/** 최소 100바이트를 넘기는 더미 base64(파싱 하한 검사를 통과시키기 위한 것). */
const okBase64 = Buffer.from("x".repeat(256)).toString("base64");

describe("extractInlineImage", () => {
  it("output_image.data(base64)를 바이트로 돌려준다", () => {
    const out = extractInlineImage({
      output_image: { type: "image", data: okBase64, mime_type: "image/jpeg" },
    });
    expect(out.bytes.byteLength).toBe(256);
    expect(out.mimeType).toBe("image/jpeg");
  });

  it("mime_type 이 없거나 이미지가 아니면 기본값으로 떨어진다", () => {
    for (const mime of [undefined, "application/json", 42]) {
      const out = extractInlineImage({
        output_image: { type: "image", data: okBase64, mime_type: mime },
      });
      expect(out.mimeType).toBe("image/jpeg");
    }
  });

  it("data 가 없으면 던진다 — 빈 이미지를 저장하지 않는다", () => {
    for (const bad of [{}, { output_image: {} }, { output_image: { data: "" } }, null]) {
      expect(() => extractInlineImage(bad)).toThrow(GeminiClientError);
    }
  });

  it("바이트가 비정상적으로 작으면 던진다 — 실패 응답을 그림으로 저장하지 않는다", () => {
    const tiny = Buffer.from("nope").toString("base64");
    expect(() => extractInlineImage({ output_image: { data: tiny } })).toThrow(
      /비정상/,
    );
  });

  it("uri 만 오고 data 가 없으면 던진다 — inline 을 요청했는데 안 온 것이다", () => {
    expect(() =>
      extractInlineImage({ output_image: { type: "image", uri: "https://x/a.jpg" } }),
    ).toThrow(GeminiClientError);
  });
});

describe("extractInlineImage — usage 는 방어적으로 읽는다", () => {
  const img = { type: "image", data: okBase64, mime_type: "image/jpeg" };

  it("usage 토큰 수를 함께 돌려준다", () => {
    const out = extractInlineImage({
      output_image: img,
      usage: { total_input_tokens: 123, total_output_tokens: 456 },
    });
    expect(out.usage).toEqual({ inputTokens: 123, outputTokens: 456 });
  });

  it("한쪽만 있으면 그쪽만 담는다", () => {
    const out = extractInlineImage({ output_image: img, usage: { total_output_tokens: 456 } });
    expect(out.usage).toEqual({ outputTokens: 456 });
  });

  it("usage 가 없거나 깨졌으면 필드를 생략하고 던지지 않는다", () => {
    for (const usage of [
      undefined,
      null,
      "x",
      {},
      { total_input_tokens: -1, total_output_tokens: Number.NaN },
      { total_input_tokens: "123", total_output_tokens: Infinity },
    ]) {
      const out = extractInlineImage({ output_image: img, usage });
      expect(out).not.toHaveProperty("usage");
      expect(out.bytes.byteLength).toBe(256);
    }
  });
});

describe("generateSketchImage — 성공 경로는 ApiCallLog 행을 만들지 않는다", () => {
  beforeEach(() => {
    recordFailure.mockReset();
    rotation.mockReset();
  });

  it("성공하면 usage 를 돌려주고 recordGeminiFailure 를 부르지 않는다", async () => {
    rotation.mockResolvedValue({
      output_image: { data: okBase64, mime_type: "image/jpeg" },
      usage: { total_input_tokens: 123, total_output_tokens: 456 },
    });
    const out = await generateSketchImage("p");
    expect(out.usage).toEqual({ inputTokens: 123, outputTokens: 456 });
    expect(recordFailure).not.toHaveBeenCalled();
  });
});
