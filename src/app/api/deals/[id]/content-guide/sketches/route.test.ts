import { beforeEach, describe, expect, it, vi } from "vitest";

// 시안 라우트 계약 — 이미지 호출이 돌려준 usage 가 시안 JSON 옆에 저장되는지(있으면 저장,
// 없으면 필드 없음·오류 없음), 그리고 성공 경로가 ApiCallLog 에 행을 만들지 않는지 고정한다.
// (성공 행 금지 규율: 대시보드 상위 20 이 성공 행으로 점거된 사고 방지)

const generateSketchImageMock = vi.fn();
const draftUpdateMock = vi.fn();
const apiCallLogCreateMock = vi.fn();
const uploadBytesMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({ authenticated: true }),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    dealGuideDraft: {
      findUnique: vi.fn().mockResolvedValue({
        body: "## 촬영\n- C1 · 첫 장 | 제품을 정면에서 담은 컷",
        sketches: null,
      }),
      update: (...args: unknown[]) => draftUpdateMock(...args),
    },
    deal: {
      findUnique: vi.fn().mockResolvedValue({ dealName: "테스트 상품", category: "생활" }),
    },
    apiCallLog: {
      create: (...args: unknown[]) => apiCallLogCreateMock(...args),
      createMany: (...args: unknown[]) => apiCallLogCreateMock(...args),
    },
  }),
}));

vi.mock("@/lib/agent/gemini-image", () => ({
  generateSketchImage: (...args: unknown[]) => generateSketchImageMock(...args),
}));

vi.mock("@/lib/seller-analysis/seller-media-storage", () => ({
  isSellerMediaStorageConfigured: () => true,
  publicMediaUrl: (path: string) => `https://media.test/${path}`,
  uploadBytes: (...args: unknown[]) => uploadBytesMock(...args),
}));

import { POST } from "./route";

function post() {
  return POST(
    new Request("http://localhost/api/deals/deal-1/content-guide/sketches", { method: "POST" }),
    { params: Promise.resolve({ id: "deal-1" }) },
  );
}

function savedSketches(): Array<Record<string, unknown>> {
  expect(draftUpdateMock).toHaveBeenCalledTimes(1);
  const arg = draftUpdateMock.mock.calls[0]?.[0] as { data: { sketches: string } };
  return JSON.parse(arg.data.sketches);
}

describe("POST /api/deals/[id]/content-guide/sketches — usage 기록", () => {
  beforeEach(() => {
    generateSketchImageMock.mockReset();
    draftUpdateMock.mockReset();
    apiCallLogCreateMock.mockReset();
    uploadBytesMock.mockReset().mockResolvedValue(undefined);
  });

  it("이미지 호출이 usage 를 주면 시안 옆에 토큰 수와 생성 시각이 저장된다", async () => {
    generateSketchImageMock.mockResolvedValue({
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      usage: { inputTokens: 120, outputTokens: 1290 },
    });

    const res = await post();

    expect(res.status).toBe(200);
    const [sketch] = savedSketches();
    const usage = sketch?.usage as Record<string, unknown>;
    expect(usage.inputTokens).toBe(120);
    expect(usage.outputTokens).toBe(1290);
    expect(Number.isNaN(Date.parse(String(usage.generatedAt)))).toBe(false);
  });

  it("usage 가 없으면 필드 없이 저장되고 오류도 없다", async () => {
    generateSketchImageMock.mockResolvedValue({
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
    });

    const res = await post();

    expect(res.status).toBe(200);
    const [sketch] = savedSketches();
    expect(sketch).toBeDefined();
    expect("usage" in (sketch ?? {})).toBe(false);
  });

  it("성공 경로는 usage 가 있든 없든 ApiCallLog 에 행을 만들지 않는다", async () => {
    generateSketchImageMock
      .mockResolvedValueOnce({
        bytes: new Uint8Array([1]),
        mimeType: "image/png",
        usage: { inputTokens: 1, outputTokens: 2 },
      });
    await post();

    draftUpdateMock.mockReset();
    generateSketchImageMock.mockResolvedValueOnce({
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
    });
    await post();

    expect(apiCallLogCreateMock).not.toHaveBeenCalled();
  });
});
