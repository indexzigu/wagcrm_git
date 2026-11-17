import { beforeEach, describe, expect, it, vi } from "vitest";

// PATCH 의 상태 전이 거절(422) 본문 계약. `error` 문구는 그대로 두고, 화면이 사유를 말하는 데 쓸
// 현재 상태·요청 상태 코드를 **따로** 싣는다(코드를 문장에 넣지 않는다 — 화면이 라벨 표로 바꾼다).

const updateDealMock = vi.fn();

vi.mock("@/services/dealService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/dealService")>();
  return {
    ...actual,
    dealService: { updateDeal: (...args: unknown[]) => updateDealMock(...args) },
  };
});

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: vi.fn().mockResolvedValue({ email: "tester@example.com" }),
}));

vi.mock("@/lib/cache-tags", () => ({
  revalidateMasterDataCaches: vi.fn(),
}));

import { PATCH } from "./route";
import { InvalidStatusTransitionError } from "@/services/dealService";

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/deals/deal-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "deal-1" }) },
  );
}

describe("PATCH /api/deals/[id] — 상태 전이 거절", () => {
  beforeEach(() => {
    updateDealMock.mockReset();
  });

  it("422 본문에 기존 문구와 함께 현재 상태·요청 상태를 싣는다", async () => {
    updateDealMock.mockRejectedValue(
      new InvalidStatusTransitionError(undefined, {
        currentStatus: "DROPPED",
        requestedStatus: "NEGOTIATING",
      }),
    );

    const res = await patch({ status: "NEGOTIATING" });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "허용되지 않는 상태 변경입니다",
      currentStatus: "DROPPED",
      requestedStatus: "NEGOTIATING",
    });
  });
});
