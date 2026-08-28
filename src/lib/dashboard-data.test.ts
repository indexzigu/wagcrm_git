import { beforeEach, describe, expect, it, vi } from "vitest";

const captureExceptionMock = vi.hoisted(() => vi.fn());
const getPrismaMock = vi.hoisted(() => vi.fn());

vi.mock("@sentry/nextjs", () => ({
  captureException: captureExceptionMock,
}));

vi.mock("./prisma", () => ({
  getPrisma: getPrismaMock,
}));

import { getDashboardData } from "./dashboard-data";
import { getPrisma } from "./prisma";

const originalEnv = {
  CRM_DATA_SOURCE: process.env.CRM_DATA_SOURCE,
  NODE_ENV: process.env.NODE_ENV,
};
const mutableEnv = process.env as Record<string, string | undefined>;

function restoreEnv() {
  if (originalEnv.CRM_DATA_SOURCE === undefined) {
    delete mutableEnv.CRM_DATA_SOURCE;
  } else {
    mutableEnv.CRM_DATA_SOURCE = originalEnv.CRM_DATA_SOURCE;
  }

  if (originalEnv.NODE_ENV === undefined) {
    delete mutableEnv.NODE_ENV;
  } else {
    mutableEnv.NODE_ENV = originalEnv.NODE_ENV;
  }
}

function createDatabasePrismaMock() {
  return {
    deal: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "deal-1",
          dealName: "실데이터 딜",
          costPrice: 1000,
          sellingPrice: 2000,
          status: "CONFIRMED",
          partner: {
            id: "partner-1",
            name: "파트너",
            type: "BRAND",
          },
          baseMarginPolicy: null,
        },
      ]),
    },
    seller: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "seller-1",
          name: "셀러",
          alias: null,
          snsType: "INSTAGRAM",
          snsHandle: "@seller",
          currentFollowers: 1234,
          category: "라이프스타일",
          histories: [
            {
              snapshotDate: new Date("2026-05-01T00:00:00.000Z"),
              followersCount: 1200,
            },
          ],
        },
      ]),
    },
    salesCampaign: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "campaign-1",
          dealId: "deal-1",
          sellerId: "seller-1",
          campaignName: "실데이터 캠페인",
          salesCode: "SC-1",
          updatedAt: new Date("2026-05-20T00:00:00.000Z"),
          startDate: new Date("2026-05-01T00:00:00.000Z"),
          endDate: new Date("2026-05-31T00:00:00.000Z"),
          salesChannel: "INSTAGRAM",
          baseNaverLink: "https://example.com",
          generatedTrackingLink: "https://example.com?ref=1",
          actualSales: 2000,
          totalMarginRate: 20,
          sellerMarginRate: 10,
          netMarginRate: 5,
          status: "ACTIVE",
          isManualMargin: false,
          seller: {
            name: "셀러",
            alias: null,
            snsType: "INSTAGRAM",
            snsHandle: "@seller",
            histories: [
              {
                snapshotDate: new Date("2026-05-01T00:00:00.000Z"),
                followersCount: 1200,
              },
            ],
          },
          deal: {
            dealName: "실데이터 딜",
            costPrice: 1000,
            sellingPrice: 2000,
            partner: {
              name: "파트너",
            },
          },
          activities: [],
          notes: [],
          checklistItems: [],
        },
      ]),
      count: vi.fn().mockResolvedValue(0),
    },
    apiCallLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    asset: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "asset-1",
          provider: "SUPABASE",
          section: "campaign",
          entityType: "CAMPAIGN",
          entityId: "campaign-1",
          campaignId: "campaign-1",
          fileName: "file.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
          storagePath: null,
          externalFileId: null,
          externalUrl: null,
          thumbnailUrl: null,
          notes: null,
          archivedAt: null,
          createdAt: new Date("2026-05-20T00:00:00.000Z"),
        },
      ]),
      aggregate: vi.fn().mockResolvedValue({
        _sum: { sizeBytes: 100 },
      }),
    },
    storageIntegration: {
      findUnique: vi.fn().mockResolvedValue({
        status: "CONNECTED",
        accountEmail: "drive@example.com",
        rootFolderId: "folder-1",
      }),
    },
    salesTask: {
      count: vi.fn().mockResolvedValue(2),
      findMany: vi.fn().mockResolvedValue([]),
    },
    partner: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "partner-1",
          name: "파트너",
          type: "BRAND",
        },
      ]),
    },
    priceMonitorSnapshot: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

describe("getDashboardData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreEnv();
  });

  it("returns mock data directly when CRM_DATA_SOURCE=mock", async () => {
    mutableEnv.CRM_DATA_SOURCE = "mock";

    const data = await getDashboardData();

    expect(getPrismaMock).not.toHaveBeenCalled();
    expect(data.dataSource).toBe("mock");
    expect(data.dataSourceMessage).toContain("목업 데이터");
    expect(data.dataSourceMessage).not.toContain("CRM_DATA_SOURCE");
    expect(data.dataSourceMessage).not.toContain("=mock");
  });

  it("returns database-backed data when the database is available", async () => {
    mutableEnv.CRM_DATA_SOURCE = "database";
    mutableEnv.NODE_ENV = "production";

    const prismaMock = createDatabasePrismaMock();
    getPrismaMock.mockReturnValue(prismaMock as never);

    const data = await getDashboardData();

    expect(getPrisma).toHaveBeenCalled();
    expect(data.dataSource).toBe("database");
    expect(data.campaigns).toHaveLength(1);
    expect(data.deals[0]?.dealName).toBe("실데이터 딜");
    expect(prismaMock.salesCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          campaignDeals: { include: { deal: true } },
        }),
      }),
    );
  });

  describe("최저가 위반 배지 데이터 공급 (UX1-C)", () => {
    it("캠페인의 딜(메인+하위)에 최신 VIOLATED 스냅샷이 있으면 hasPriceViolation=true를 채운다", async () => {
      mutableEnv.CRM_DATA_SOURCE = "database";
      mutableEnv.NODE_ENV = "production";

      const prismaMock = createDatabasePrismaMock();
      prismaMock.priceMonitorSnapshot.findMany.mockResolvedValue([
        { dealId: "deal-1", snapshotDate: "2026-05-01", verdict: "VIOLATED" },
      ]);
      getPrismaMock.mockReturnValue(prismaMock as never);

      const data = await getDashboardData();

      expect(data.campaigns[0]?.hasPriceViolation).toBe(true);
      expect(data.campaigns[0]?.violatedDealCount).toBe(1);
    });

    it("과거에 VIOLATED였다가 최신 스냅샷이 OK로 회복되면 hasPriceViolation=false다 (배지가 지워진다)", async () => {
      mutableEnv.CRM_DATA_SOURCE = "database";
      mutableEnv.NODE_ENV = "production";

      const prismaMock = createDatabasePrismaMock();
      // distinct+orderBy(snapshotDate desc)로 딜당 최신 1건만 조회되므로, 회복된 딜은
      // 최신 OK 행이 반환된다. verdict 사전필터가 남아있으면 이 행이 유실돼 배지가 안 지워진다.
      prismaMock.priceMonitorSnapshot.findMany.mockResolvedValue([
        { dealId: "deal-1", snapshotDate: "2026-07-05", verdict: "OK" },
      ]);
      getPrismaMock.mockReturnValue(prismaMock as never);

      const data = await getDashboardData();

      expect(data.campaigns[0]?.hasPriceViolation).toBe(false);
      expect(data.campaigns[0]?.violatedDealCount).toBe(0);
    });

    it("스냅샷이 없으면 hasPriceViolation=false, violatedDealCount=0이다 (기본 상태와 동일)", async () => {
      mutableEnv.CRM_DATA_SOURCE = "database";
      mutableEnv.NODE_ENV = "production";

      const prismaMock = createDatabasePrismaMock();
      getPrismaMock.mockReturnValue(prismaMock as never);

      const data = await getDashboardData();

      expect(data.campaigns[0]?.hasPriceViolation).toBe(false);
      expect(data.campaigns[0]?.violatedDealCount).toBe(0);
    });

    it("priceMonitorSnapshot 조회는 딜 id 필터 단일 findMany이며, verdict 사전필터 없이 딜별 최신 1건만(distinct+orderBy) 가져온다 (N+1 금지 + 배지 회복 보장)", async () => {
      mutableEnv.CRM_DATA_SOURCE = "database";
      mutableEnv.NODE_ENV = "production";

      const prismaMock = createDatabasePrismaMock();
      getPrismaMock.mockReturnValue(prismaMock as never);

      await getDashboardData();

      expect(prismaMock.priceMonitorSnapshot.findMany).toHaveBeenCalledTimes(1);
      const callArg = prismaMock.priceMonitorSnapshot.findMany.mock.calls[0][0];
      expect(callArg.where.dealId).toEqual(
        expect.objectContaining({ in: expect.any(Array) }),
      );
      // verdict 사전필터가 있으면 회복된 딜의 최신 OK 스냅샷이 유실돼 배지가 안 지워진다.
      expect(callArg.where.verdict).toBeUndefined();
      expect(callArg.distinct).toEqual(["dealId"]);
      expect(callArg.orderBy).toEqual([
        { dealId: "asc" },
        { snapshotDate: "desc" },
      ]);
    });
  });

  describe("mobileLite 스코프 (모바일 캠페인 탭 경량 로드, 2026-07-23)", () => {
    it("mobileLite면 마스터데이터 7종·스토리지 추정을 건너뛰고 campaigns·카운트만 실조회한다", async () => {
      mutableEnv.CRM_DATA_SOURCE = "database";
      mutableEnv.NODE_ENV = "production";

      const prismaMock = createDatabasePrismaMock();
      getPrismaMock.mockReturnValue(prismaMock as never);

      const data = await getDashboardData({ workspace: "pipeline", scope: "mobileLite" });

      // 건너뛰는 조회 — 모바일 파이프라인 뷰(조회 전용)에 소비처가 없다.
      expect(prismaMock.deal.findMany).not.toHaveBeenCalled();
      expect(prismaMock.seller.findMany).not.toHaveBeenCalled();
      expect(prismaMock.apiCallLog.findMany).not.toHaveBeenCalled();
      expect(prismaMock.asset.findMany).not.toHaveBeenCalled();
      expect(prismaMock.asset.aggregate).not.toHaveBeenCalled();
      expect(prismaMock.storageIntegration.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.salesTask.findMany).not.toHaveBeenCalled();
      expect(prismaMock.partner.findMany).not.toHaveBeenCalled();

      // 유지되는 조회 — 모바일이 실제 소비하는 campaigns 행과 카운트.
      expect(prismaMock.salesCampaign.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.salesTask.count).toHaveBeenCalledTimes(1);
      expect(prismaMock.salesCampaign.count).toHaveBeenCalledTimes(1);
      expect(data.campaigns).toHaveLength(1);
      expect(data.actionRequiredCounts?.overdueReminders).toBe(2);

      // 반환 형태는 DashboardData 그대로(빈값 채움) — 소비측 타입·렌더 경로 불변.
      expect(data.deals).toEqual([]);
      expect(data.sellers).toEqual([]);
      expect(data.assets).toEqual([]);
      expect(data.salesTasks).toEqual([]);
      expect(data.partners).toEqual([]);
      expect(data.storage.googleDriveConnected).toBe(false);
      expect(data.storage.supabaseEstimatedBytes).toBe(0);
    });

    it("scope 미지정은 종전과 동일하게 전체 조회한다(full 기본값 회귀 안전)", async () => {
      mutableEnv.CRM_DATA_SOURCE = "database";
      mutableEnv.NODE_ENV = "production";

      const prismaMock = createDatabasePrismaMock();
      getPrismaMock.mockReturnValue(prismaMock as never);

      await getDashboardData({ workspace: "pipeline" });

      expect(prismaMock.deal.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.seller.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.asset.aggregate).toHaveBeenCalledTimes(1);
      expect(prismaMock.partner.findMany).toHaveBeenCalledTimes(1);
    });
  });

  it("throws in production when database mode fails", async () => {
    mutableEnv.CRM_DATA_SOURCE = "database";
    mutableEnv.NODE_ENV = "production";

    const prismaMock = createDatabasePrismaMock();
    prismaMock.deal.findMany.mockRejectedValueOnce(new Error("DB down"));
    getPrismaMock.mockReturnValue(prismaMock as never);

    await expect(getDashboardData()).rejects.toThrow("DB down");
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});
