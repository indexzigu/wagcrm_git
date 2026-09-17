import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * 계약: **접기는 HTTP 응답(`GET`)에서만 일어난다 — `fetchAndSyncCampaigns` 는 온전한 목록을 준다.**
 *
 * 이 경계가 이 기능의 유일한 진짜 위험이다. `fetchAndSyncCampaigns` 는 주문관리 전용이 아니라
 * **셀러 포털 리포트(`seller-portal-report.tsx`)와 성과 카드(`seller-performance-card.tsx`)가
 * 직접 호출**한다(`await fetchAndSyncCampaigns(false)` → `res.json()`). 접기를 그 함수 안으로
 * 옮기면 셀러 화면에서 끝난 캠페인이 **조용히 사라진다** — 응답이 any-typed JSON 이라 타입체커가
 * 못 잡고, 포털은 "공유 중인 캠페인 없음" 빈 화면이 될 뿐 오류를 내지 않는다(select 축소가
 * 포털을 비웠던 #137 과 같은 형태).
 *
 * 그래서 소스 스캔이 아니라 **두 경로의 실제 응답을 나란히** 본다.
 */

const afterCallbacks: Array<() => Promise<void>> = [];

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => Promise<void>) => {
    afterCallbacks.push(callback);
  },
}));

const SETTLED = {
  id: "settled-1",
  name: "정산까지 끝난 캠페인",
  template: null,
  isActive: false,
  category: "건강식품",
  productStatus: "CLOSE",
  salePeriod: "2026.06.12 ~ 2026.06.18",
  startDate: new Date("2026-06-12T00:00:00.000Z"),
  endDate: new Date("2026-06-18T00:00:00.000Z"),
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  cachedTotalOrders: 40,
  cachedDistinctOrderCount: 38,
  cachedTotalQuantity: 44,
  cachedTotalRevenue: 1_234_000,
  cachedDailyStats: [{ date: "2026-06-12", quantity: 3 }],
  cachedInsights: { inflow: [], hourly: [] },
  mappings: [{ id: "m1", productName: "가", optionName: "나", price: 1000 }],
  tasks: [{ id: "t1", date: "2026-06-12", status: "EMAILED" }],
  salesCampaigns: [{ id: "sc1", sellerId: "seller-1", status: "COMPLETED", startDate: new Date("2026-06-12T00:00:00.000Z"), endDate: new Date("2026-06-18T00:00:00.000Z") }],
};

const IN_SETTLEMENT = {
  ...SETTLED,
  id: "in-settlement-1",
  name: "마감됐지만 정산 진행중",
  salesCampaigns: [{ ...SETTLED.salesCampaigns[0], id: "sc2", status: "SETTLEMENT_IN_PROGRESS" }],
};

const emptyPrisma: unknown = new Proxy(
  {},
  {
    get: (_t, model: string) =>
      new Proxy(
        {},
        {
          get: (_m, method: string) =>
            vi.fn(async () => {
              if (model === "orderCampaign" && method === "findMany") return [SETTLED, IN_SETTLEMENT];
              if (method === "findMany") return [];
              if (method === "count") return 0;
              return null;
            }),
        },
      ),
  },
);
vi.mock("@/lib/order-converter/prisma", () => ({ prisma: emptyPrisma }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => emptyPrisma }));
vi.mock("@/lib/demo-mode", () => ({ isDemoMode: () => false }));

vi.mock("@/repositories/naverOrderSnapshotRepository", () => ({
  naverOrderSnapshotRepository: {
    findRangeMeta: vi.fn(async () => []),
    findByDates: vi.fn(async () => []),
    findRange: vi.fn(async () => []),
    findRangeCounts: vi.fn(async () => []),
    latestSyncMeta: vi.fn(async () => ({ lastCallTime: new Date(), syncType: "CHANGED" })),
    parseOrders: vi.fn(() => []),
  },
}));

vi.mock("@/lib/order-converter/naver-order-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/order-converter/naver-order-sync")>()),
  runSync: vi.fn(async () => undefined),
  sweepDeliveringOrders: vi.fn(async () => undefined),
}));

const { fetchAndSyncCampaigns, GET } = await import("./campaigns-handler");

async function readJson(response: Response): Promise<any[]> {
  const body = await response.json();
  for (const callback of afterCallbacks.splice(0)) await callback();
  return body;
}

const byId = (list: any[], id: string) => list.find((c) => c.id === id);

beforeEach(() => {
  afterCallbacks.splice(0);
});

describe("정산종료 캠페인 접기 — 경로별 경계", () => {
  it("포털 경로(fetchAndSyncCampaigns)는 접지 않는다 — 끝난 캠페인도 온전히 준다", async () => {
    const list = await readJson(await fetchAndSyncCampaigns(false));
    const settled = byId(list, "settled-1");

    expect(settled).toBeDefined();
    expect(settled.isCollapsed).toBeUndefined();
    // 포털이 "내 캠페인"을 고르는 근거가 이 필드다 — 여기서 사라지면 셀러 화면이 빈다(#137).
    expect(settled.salesCampaigns?.[0]?.sellerId).toBe("seller-1");
    expect(settled.dailyStats).toEqual([{ date: "2026-06-12", quantity: 3 }]);
  });

  it("주문관리 경로(GET)는 정산종료 캠페인만 요약으로 접는다", async () => {
    const list = await readJson(await GET(new NextRequest("https://x.test/order-converter/api/dashboard-stats")));
    const settled = byId(list, "settled-1");

    expect(settled.isCollapsed).toBe(true);
    expect(settled.name).toBe("정산까지 끝난 캠페인");
    expect(settled.totalRevenue).toBe(1_234_000);
    expect(settled).not.toHaveProperty("dailyStats");
    expect(settled).not.toHaveProperty("insights");
    expect(settled).not.toHaveProperty("salesCampaigns");
  });

  it("주문관리 경로에서도 정산 진행중인 캠페인은 접지 않는다(오너 확정 2026-09-16)", async () => {
    const list = await readJson(await GET(new NextRequest("https://x.test/order-converter/api/dashboard-stats")));
    const inSettlement = byId(list, "in-settlement-1");

    expect(inSettlement.isCollapsed).toBeUndefined();
    expect(inSettlement.dailyStats).toBeDefined();
  });

  it("접어도 동기화 메타 헤더는 그대로 실려 나간다(클라이언트 폴링이 이 헤더로 멈춘다)", async () => {
    const response = await GET(new NextRequest("https://x.test/order-converter/api/dashboard-stats"));
    expect(response.headers.has("X-Naver-Syncing")).toBe(true);
    await readJson(response);
  });
});
