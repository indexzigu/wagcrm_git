import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const findManyMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: {
      findMany: findManyMock,
    },
  }),
}));

function createRequest(url: string) {
  return new NextRequest(url);
}

describe("GET /api/reports/settlement", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    findManyMock.mockResolvedValue([
      {
        id: "camp-1",
        status: "SETTLEMENT_IN_PROGRESS",
        updatedAt: new Date("2026-05-10T00:00:00.000Z"),
        startDate: new Date("2026-05-01T00:00:00.000Z"),
        endDate: new Date("2026-05-03T00:00:00.000Z"),
        actualSales: 1000000,
        totalMarginRate: 30,
        sellerMarginRate: 10,
        deal: { dealName: "앰플 공구", brandName: "브랜드A" },
        seller: { name: "셀러A" },
      },
      {
        id: "camp-2",
        status: "COMPLETED",
        updatedAt: new Date("2026-05-12T00:00:00.000Z"),
        startDate: new Date("2026-05-04T00:00:00.000Z"),
        endDate: new Date("2026-05-08T00:00:00.000Z"),
        actualSales: 500000,
        totalMarginRate: 25,
        sellerMarginRate: 8,
        deal: { dealName: "선크림 공구", brandName: null },
        seller: { name: "셀러B" },
      },
    ]);
  });

  it("returns 400 for invalid month format", async () => {
    const request = createRequest(
      "http://localhost:3000/api/reports/settlement?month=2026-13",
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid month format");
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("queries settlement report statuses by default", async () => {
    const request = createRequest(
      "http://localhost:3000/api/reports/settlement?month=2026-05",
    );
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(findManyMock).toHaveBeenCalledTimes(1);

    const callArg = findManyMock.mock.calls[0][0] as {
      where?: { status?: { in?: string[] } };
    };

    expect(callArg.where?.status?.in).toEqual([
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
    ]);
    expect(body.summary.campaignCount).toBe(2);
    expect(body.summary.totalRevenue).toBe(1500000);
  });

  it("applies explicit status, team and search filters", async () => {
    const request = createRequest(
      "http://localhost:3000/api/reports/settlement?month=2026-05&status=COMPLETED&teamId=user-1&searchQuery=%EC%85%80%EB%9F%AC",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(findManyMock).toHaveBeenCalledTimes(1);

    const callArg = findManyMock.mock.calls[0][0] as {
      where?: {
        status?: { in?: string[] };
        assignedTo?: string;
        OR?: Array<Record<string, unknown>>;
      };
    };

    expect(callArg.where?.status?.in).toEqual(["COMPLETED"]);
    expect(callArg.where?.assignedTo).toBe("user-1");
    expect(callArg.where?.OR).toHaveLength(3);
  });

  it("queries year range when year parameter is provided", async () => {
    const request = createRequest(
      "http://localhost:3000/api/reports/settlement?year=2026",
    );
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(findManyMock).toHaveBeenCalledTimes(1);

    const callArg = findManyMock.mock.calls[0][0] as {
      where?: {
        endDate?: {
          gte: Date;
          lte: Date;
        };
      };
    };

    expect(callArg.where?.endDate?.gte.getFullYear()).toBe(2026);
    expect(callArg.where?.endDate?.gte.getMonth()).toBe(0);
    expect(callArg.where?.endDate?.lte.getFullYear()).toBe(2026);
    expect(callArg.where?.endDate?.lte.getMonth()).toBe(11);
    expect(body.month).toBe("2026");
  });
});
