import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const findManyMock = vi.fn();
const requireAuthMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    deal: {
      findMany: findManyMock,
    },
  }),
}));

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

function createRequest(url: string) {
  return new NextRequest(url);
}

describe("GET /api/deals", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    requireAuthMock.mockReset();
    requireAuthMock.mockResolvedValue({ authenticated: true });
    findManyMock.mockResolvedValue([
      {
        id: "deal-1",
        dealName: "테스트 딜",
        brandName: "테스트 브랜드",
        partnerId: "partner-1",
        partner: { name: "테스트 파트너", type: "BRAND" },
        costPrice: 1000,
        sellingPrice: 2000,
        baseMarginPolicy: "{}",
        status: "SOURCING",
        dealType: "MAIN",
        parentDealId: null,
        _count: { campaigns: 0 },
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-02T00:00:00.000Z"),
      },
    ]);
  });

  it("returns deals including brandName for linked-deal detail consumers", async () => {
    const request = createRequest(
      "http://localhost:3000/api/deals?partnerId=partner-1&sortBy=createdAt&sortDir=desc",
    );
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(body.deals[0].brandName).toBe("테스트 브랜드");

    const callArg = findManyMock.mock.calls[0][0] as {
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      select?: Record<string, unknown>;
    };

    expect(callArg.where).toMatchObject({
      partnerId: "partner-1",
      dealType: "MAIN",
    });
    expect(callArg.orderBy).toEqual({ createdAt: "desc" });
    expect(callArg.select?.brandName).toBe(true);
  });

  it("falls back to brand partner name when brandName is missing", async () => {
    findManyMock.mockResolvedValueOnce([
      {
        id: "deal-2",
        dealName: "fallback 딜",
        brandName: null,
        partnerId: "partner-2",
        partner: { name: "브랜드 fallback", type: "BRAND" },
        costPrice: 1000,
        sellingPrice: 2000,
        baseMarginPolicy: "{}",
        status: "NEGOTIATING",
        dealType: "MAIN",
        parentDealId: null,
        _count: { campaigns: 0 },
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-02T00:00:00.000Z"),
      },
    ]);

    const request = createRequest("http://localhost:3000/api/deals?partnerId=partner-2");
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deals[0].brandName).toBe("브랜드 fallback");
  });

  it("does not infer a brand name from a vendor partner", async () => {
    findManyMock.mockResolvedValueOnce([
      {
        id: "deal-3",
        dealName: "벤더 연결 딜",
        brandName: null,
        partnerId: "partner-3",
        partner: { name: "벤더 회사", type: "VENDOR" },
        costPrice: 1000,
        sellingPrice: 2000,
        baseMarginPolicy: "{}",
        status: "NEGOTIATING",
        dealType: "MAIN",
        parentDealId: null,
        _count: { campaigns: 0 },
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-02T00:00:00.000Z"),
      },
    ]);

    const request = createRequest("http://localhost:3000/api/deals?partnerId=partner-3");
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deals[0].brandName).toBeNull();
  });

  it("short-circuits when auth fails", async () => {
    requireAuthMock.mockResolvedValueOnce({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    });

    const request = createRequest("http://localhost:3000/api/deals");
    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
