import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const requireAuthMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

// getPrisma만 목업 — 실제 campaignGroupRepository.findSuggestions가 돌며 포락선 where를 만든다.
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    campaignGroup: { findMany: (...args: unknown[]) => findManyMock(...args) },
  }),
}));

function groupFixture(over: Record<string, unknown> = {}) {
  return {
    id: "g1",
    sellerId: "s1",
    name: "[가온] 비타민 외 1건",
    startDate: new Date("2026-07-01T00:00:00Z"),
    endDate: new Date("2026-07-08T00:00:00Z"),
    expectedDepositDate: null,
    depositReceivedAt: null,
    isDepositReceived: false,
    expectedPayoutDate: null,
    payoutCompletedAt: null,
    isPayoutCompleted: false,
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    accountingCompletedAt: null,
    returnPeriodEndDate: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    seller: { name: "김본명", alias: "가온" },
    members: [
      { id: "c1", campaignName: "비타민 - 가온", status: "PROPOSAL", startDate: new Date("2026-07-01T00:00:00Z"), endDate: new Date("2026-07-05T00:00:00Z"), roundNumber: null, deal: { dealName: "비타민" } },
      { id: "c2", campaignName: "글로우 - 가온", status: "PROPOSAL", startDate: new Date("2026-07-03T00:00:00Z"), endDate: new Date("2026-07-08T00:00:00Z"), roundNumber: null, deal: { dealName: "글로우" } },
    ],
    ...over,
  };
}

function req(qs: string) {
  return new NextRequest(`http://localhost:3000/api/campaign-groups/suggest?${qs}`);
}

beforeEach(() => {
  requireAuthMock.mockReset();
  findManyMock.mockReset();
  requireAuthMock.mockResolvedValue({ authenticated: true, context: { userId: "u1" } });
});

describe("GET /api/campaign-groups/suggest", () => {
  it("후보 없으면 빈 배열", async () => {
    findManyMock.mockResolvedValue([]);
    const response = await GET(req("sellerId=s1&startDate=2026-07-01&endDate=2026-07-10"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.groups).toEqual([]);
  });

  it("포락선 겹침 where — startDate<=rangeEnd AND endDate>=rangeStart", async () => {
    findManyMock.mockResolvedValue([groupFixture()]);

    const response = await GET(req("sellerId=s1&startDate=2026-07-01&endDate=2026-07-10"));
    const body = await response.json();

    expect(response.status).toBe(200);
    const where = findManyMock.mock.calls[0][0].where;
    expect(where.sellerId).toBe("s1");
    // rangeStart = startDate 파라미터, rangeEnd = endDate 파라미터
    expect(where.startDate).toEqual({ lte: new Date("2026-07-10") });
    expect(where.endDate).toEqual({ gte: new Date("2026-07-01") });
    expect(where.NOT).toBeUndefined();

    // 요약 행으로 매핑(멤버 수·기간·이름 포함)
    expect(body.groups[0]).toMatchObject({ id: "g1", name: "[가온] 비타민 외 1건", memberCount: 2 });
  });

  it("excludeCampaignId가 있으면 그 캠페인이 속한 그룹을 제외한다", async () => {
    findManyMock.mockResolvedValue([]);
    await GET(req("sellerId=s1&startDate=2026-07-01&endDate=2026-07-10&excludeCampaignId=c9"));
    const where = findManyMock.mock.calls[0][0].where;
    expect(where.NOT).toEqual({ members: { some: { id: "c9" } } });
  });

  it("필수 파라미터 누락은 400", async () => {
    const response = await GET(req("startDate=2026-07-01&endDate=2026-07-10"));
    expect(response.status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
