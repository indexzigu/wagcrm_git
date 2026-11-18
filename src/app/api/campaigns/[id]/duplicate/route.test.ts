import { beforeEach, describe, expect, it, vi } from "vitest";

// T-313 Part A: duplicating a campaign whose period is not set yet ("기간 미정") copies its
// placeholder dates — the copy must carry the marker too, or the placeholder reads as a real period.

const findUniqueMock = vi.fn();
const createMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      update: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
    },
  }),
}));
vi.mock("@/lib/campaign-activity", () => ({ recordCampaignActivity: vi.fn() }));
vi.mock("@/lib/campaign-row", () => ({ toCampaignRow: (row: { id: string }) => ({ id: row.id }) }));

import { POST } from "./route";

const PLACEHOLDER = new Date("2026-11-17T03:00:00.000Z");

function source(overrides: Record<string, unknown> = {}) {
  return {
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
    deal: {},
    ...overrides,
  };
}

function duplicate() {
  return POST(new Request("http://localhost/api/campaigns/c1/duplicate", { method: "POST" }), {
    params: Promise.resolve({ id: "c1" }),
  });
}

describe("POST /api/campaigns/[id]/duplicate — 기간 미정 유지(T-313)", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    createMock.mockReset().mockResolvedValue({ id: "c2" });
  });

  it("기간 미정 원본의 복제본도 기간 미정이다", async () => {
    findUniqueMock.mockResolvedValue(source());

    const res = await duplicate();

    expect(res.status).toBe(201);
    const data = createMock.mock.calls[0][0].data;
    expect(data.periodPlaceholderAt).toEqual(PLACEHOLDER);
    expect(data.startDate).toEqual(PLACEHOLDER);
    expect(data.endDate).toEqual(PLACEHOLDER);
  });

  it("기간이 정해진 원본은 표식을 옮기지 않는다", async () => {
    findUniqueMock.mockResolvedValue(source({ startDate: new Date("2026-11-20T00:00:00.000Z"), endDate: new Date("2026-11-30T00:00:00.000Z") }));

    await duplicate();

    expect(createMock.mock.calls[0][0].data.periodPlaceholderAt).toBeNull();
  });
});
