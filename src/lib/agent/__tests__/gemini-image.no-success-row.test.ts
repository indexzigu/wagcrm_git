// 성공 호출은 ApiCallLog 행을 만들지 않는다 — 실제 키 로테이션·gemini-usage 를 그대로
// 통과시키고 DB 쓰기(`apiCallLog.create`)만 감시한다. 키 로테이션이나 기록 모듈에 성공
// 계측이 끼어들면 대시보드 상위 20 이 성공 행으로 점거되는 사고가 되살아난다.
// (usage 는 ApiCallLog 가 아니라 시안 JSON 옆에 남긴다 — T-317)

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, sdkCreateMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  sdkCreateMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ apiCallLog: { create: createMock, createMany: createMock } }),
}));

vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    interactions = { create: sdkCreateMock };
  },
}));

import { generateSketchImage } from "../gemini-image";

const okBase64 = Buffer.from("x".repeat(256)).toString("base64");

describe("generateSketchImage — 성공 경로의 DB 쓰기", () => {
  beforeEach(() => {
    createMock.mockReset();
    sdkCreateMock.mockReset();
    vi.stubEnv("GEMINI_API_KEY", "test-key-not-real");
  });

  it("usage 가 있어도 없어도 apiCallLog 에 아무것도 쓰지 않는다", async () => {
    sdkCreateMock.mockResolvedValueOnce({
      output_image: { data: okBase64, mime_type: "image/jpeg" },
      usage: { total_input_tokens: 10, total_output_tokens: 20 },
    });
    const withUsage = await generateSketchImage("p");
    expect(withUsage.usage).toEqual({ inputTokens: 10, outputTokens: 20 });

    sdkCreateMock.mockResolvedValueOnce({
      output_image: { data: okBase64, mime_type: "image/jpeg" },
    });
    const withoutUsage = await generateSketchImage("p");
    expect(withoutUsage.usage).toBeUndefined();

    expect(sdkCreateMock).toHaveBeenCalledTimes(2);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("(양성 대조) 실패하면 같은 경로로 실패 행은 쓴다", async () => {
    sdkCreateMock.mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 400 }));
    await expect(generateSketchImage("p")).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
