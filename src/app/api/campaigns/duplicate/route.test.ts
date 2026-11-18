import { beforeEach, describe, expect, it, vi } from "vitest";

// T-313 Part A: "다른 셀러로 복제" copies the source dates; a 기간 미정 source must stay 기간 미정.

const campaignFindUniqueMock = vi.fn();
const createMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: {
      findUnique: (...args: unknown[]) => campaignFindUniqueMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      update: async ({ where }: { where: { id: string } }) => ({ id: where.id, deal: {}, seller: {} }),
    },
    seller: { findUnique: async () => ({ id: "seller-2", snsType: "INSTAGRAM" }) },
  }),
}));

import { POST } from "./route";

const PLACEHOLDER = new Date("2026-11-17T03:00:00.000Z");

function duplicate() {
  return POST(
    new Request("http://localhost/api/campaigns/duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceCampaignId: "c1", sellerId: "seller-2" }),
    }),
  );
}

describe("POST /api/campaigns/duplicate — 기간 미정 유지(T-313)", () => {
  beforeEach(() => {
    createMock.mockReset().mockResolvedValue({ id: "c2" });
    campaignFindUniqueMock.mockReset().mockResolvedValue({
      id: "c1",
      dealId: "deal-1",
      sellerId: "seller-1",
      startDate: PLACEHOLDER,
      endDate: PLACEHOLDER,
      periodPlaceholderAt: PLACEHOLDER,
      salesChannel: "OWN_MALL",
      baseNaverLink: "",
      totalMarginRate: 0,
      sellerMarginRate: 0,
      netMarginRate: 0,
      isManualMargin: false,
      seller: { snsType: "INSTAGRAM" },
    });
  });

  it("기간 미정 원본의 복제본도 기간 미정이다", async () => {
    await duplicate();
    expect(createMock.mock.calls[0][0].data.periodPlaceholderAt).toEqual(PLACEHOLDER);
  });
});
