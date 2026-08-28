// 이미지 응답 파싱 — **모양이 어긋나면 조용히 넘어가지 않는다**(P0 No Silent Failure).
//
// 빈 이미지를 저장하면 프레임에 깨진 그림이 박히고, 그때는 "모델이 이상한 걸 그렸다"와
// "응답 모양이 바뀌었다"를 구분할 수 없다. 그래서 파싱은 던지고, 호출부가 컷 단위로 잡는다.

import { describe, it, expect } from "vitest";
import { extractInlineImage } from "../gemini-image";
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
