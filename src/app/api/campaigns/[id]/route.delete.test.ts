import { beforeEach, describe, expect, it, vi } from "vitest";

// DELETE /api/campaigns/[id] 회귀 테스트:
// 같은 (dealId, sellerId) 코호트의 차수·캠페인명이 삭제 후 재계산되지 않아
// 남은 단독 캠페인이 "N차" 이름·번호로 영구 잔존하던 공백을 막는다.
// 핵심은 "삭제 트랜잭션 안에서 recalculateCampaignRounds가 호출되는가"이므로
// recalc는 spy로 두고, 삭제 대상 조회 → 삭제 → 같은 tx 재계산 배선을 검증한다.

const findUniqueMock = vi.fn();
const deleteMock = vi.fn();
const trackingUpdateManyMock = vi.fn();
const assetUpdateManyMock = vi.fn();
const recalcMock = vi.fn();
const revalidateMock = vi.fn();

// $transaction(callback) — 콜백에 넘길 tx 핸들. 삭제·재계산이 이 핸들 위에서
// 순서대로 일어나는지 확인하기 위해 실제 프리즈마 클라이언트 형태를 흉내낸다.
const tx = {
  trackingAttribution: { updateMany: trackingUpdateManyMock },
  asset: { updateMany: assetUpdateManyMock },
  salesCampaign: { delete: deleteMock },
};

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findUnique: findUniqueMock },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  }),
}));

vi.mock("@/lib/cache-tags", () => ({
  revalidateCampaignCaches: () => revalidateMock(),
}));

vi.mock("@/services/campaignRounds", () => ({
  recalculateCampaignRounds: (...args: unknown[]) => recalcMock(...args),
}));

// 삭제 훅의 구글 캘린더 정리는 이 테스트 관심사가 아니므로 무력화한다.
vi.mock("@/lib/google-calendar-sync", () => ({
  deleteCampaignCalendarEvents: vi.fn(async () => ({ ok: true })),
  syncCampaignToCalendar: vi.fn(),
}));

import { DELETE } from "./route";

function createContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("DELETE /api/campaigns/[id]", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    deleteMock.mockReset();
    trackingUpdateManyMock.mockReset();
    assetUpdateManyMock.mockReset();
    recalcMock.mockReset();
    revalidateMock.mockReset();
  });

  it("삭제 후 같은 코호트의 차수·이름을 재계산한다(N차 잔존 방지)", async () => {
    findUniqueMock.mockResolvedValue({
      calendarEventIds: null,
      dealId: "deal-1",
      sellerId: "seller-1",
    });

    const response = await DELETE(new Request("http://localhost/api/campaigns/c1"), createContext("c1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });

    // 삭제 대상의 코호트 키(+캘린더 id)를 삭제 전에 확보한다.
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "c1" },
      select: { calendarEventIds: true, dealId: true, sellerId: true },
    });

    // 삭제와 재계산이 같은 tx 핸들 위에서 일어난다.
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: "c1" } });
    expect(recalcMock).toHaveBeenCalledWith("deal-1", "seller-1", tx);

    // 재계산은 삭제 이후에 호출되어야 남은 구성이 반영된다.
    expect(deleteMock.mock.invocationCallOrder[0]).toBeLessThan(
      recalcMock.mock.invocationCallOrder[0],
    );
  });

  it("대상 캠페인이 이미 없으면 재계산을 시도하지 않는다", async () => {
    findUniqueMock.mockResolvedValue(null);

    const response = await DELETE(new Request("http://localhost/api/campaigns/ghost"), createContext("ghost"));

    expect(response.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: "ghost" } });
    expect(recalcMock).not.toHaveBeenCalled();
  });
});
