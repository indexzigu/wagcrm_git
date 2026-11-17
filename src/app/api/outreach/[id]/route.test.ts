import { beforeEach, describe, expect, it, vi } from "vitest";

// PATCH 의 상태 전이 거절(422) 본문 계약. `error` 문구에는 영문 코드가 들어 있어 화면에 그대로
// 내면 안 된다 — 화면은 함께 실린 현재 상태·요청 상태 코드를 라벨 표로 바꿔 사유를 말한다.

const findUniqueMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesTask: { findUnique: (...args: unknown[]) => findUniqueMock(...args) },
  }),
}));

vi.mock("@/lib/cache-tags", () => ({
  OUTREACH_INVALIDATION_TAGS: [],
  revalidateCrmTags: vi.fn(),
}));

vi.mock("@/lib/asset-storage", () => ({
  moveDriveShortcut: vi.fn(),
  googleDriveProvider: {},
  GOOGLE_DRIVE_PROVIDER: "GOOGLE_DRIVE",
}));

import { PATCH } from "./route";

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/outreach/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "task-1" }) },
  );
}

describe("PATCH /api/outreach/[id] — 상태 전이 거절", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
  });

  it("422 본문에 기존 문구와 함께 현재 상태·요청 상태를 싣는다", async () => {
    findUniqueMock.mockResolvedValue({
      id: "task-1",
      status: "CONVERTED",
      deal: null,
      seller: null,
    });

    const res = await patch({ status: "TESTING" });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "허용되지 않는 상태 변경입니다: CONVERTED → TESTING",
      currentStatus: "CONVERTED",
      requestedStatus: "TESTING",
    });
  });
});
