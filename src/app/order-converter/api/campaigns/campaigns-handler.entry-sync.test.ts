import { beforeEach, describe, expect, it, vi } from "vitest";

// 진입 동기화 배선 회귀 가드(order-auto-sync.ts): 변경피드 동기화만 간격을 타고, 배송중 sweep 은
// 간격 밖에서 매번 호출된다(자체 3h 쿨다운). sweep 을 간격 안에 두면 배송완료 반영이 멈춘다 —
// 이 보정의 호출자는 이 핸들러뿐이다.

const afterCallbacks: Array<() => Promise<void>> = [];
const runSyncMock = vi.fn();
const sweepMock = vi.fn();
const lastChangeSyncMsMock = vi.fn();

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => Promise<void>) => {
    afterCallbacks.push(callback);
  },
}));

// 모델·메서드를 가리지 않고 빈 결과를 돌려주는 prisma 대역 — 캠페인 0건이면 핸들러는 스냅샷 경로만 탄다.
const emptyPrisma: unknown = new Proxy(
  {},
  {
    get: () =>
      new Proxy(
        {},
        {
          get: (_model, method: string) =>
            vi.fn(async () => (method === "findMany" ? [] : method === "count" ? 0 : null)),
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
    latestSyncMeta: vi.fn(async () => ({ lastCallTime: new Date(Date.now() - 10 * 60 * 1000), syncType: "CHANGED" })),
    parseOrders: vi.fn(() => []),
  },
}));

vi.mock("@/lib/order-converter/naver-order-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/order-converter/naver-order-sync")>()),
  runSync: (...args: unknown[]) => runSyncMock(...args),
  sweepDeliveringOrders: (...args: unknown[]) => sweepMock(...args),
}));

vi.mock("@/lib/order-converter/order-auto-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/order-converter/order-auto-sync")>()),
  getOrderAutoSyncIntervalHoursOrDefault: async () => 6,
  getLastChangeSyncMs: () => lastChangeSyncMsMock(),
}));

const { fetchAndSyncCampaigns } = await import("./campaigns-handler");
const { toDateKeyKst } = await import("@/lib/order-converter/naver-order-sync");

const HOUR = 60 * 60 * 1000;

async function enterDashboard() {
  const response = await fetchAndSyncCampaigns(false);
  for (const callback of afterCallbacks.splice(0)) await callback();
  return response;
}

describe("campaigns-handler 진입 동기화 배선", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    runSyncMock.mockReset().mockResolvedValue({ skipped: false });
    sweepMock.mockReset().mockResolvedValue({ swept: 1, skipped: false });
    // 오늘자 스냅샷이 10분 전 기록(당일 TTL 1분 초과 → stale)이고 배송중 1건을 담고 있다.
    (globalThis as any).__naverDailyCache = {
      [toDateKeyKst(new Date())]: {
        lastCallTime: Date.now() - 10 * 60 * 1000,
        orders: [{ productOrderId: "po-delivering", productOrderStatus: "DELIVERING" }],
        newOrdersCount: 0,
        preparingCount: 0,
        deliveringCount: 1,
        isDirty: false,
      },
    };
  });

  it("마지막 변경피드 동기화가 간격보다 최근이면 변경피드는 건너뛰고 배송중 sweep 은 건다", async () => {
    const lastChangeSyncMs = Date.now() - 1 * HOUR;
    lastChangeSyncMsMock.mockResolvedValue(lastChangeSyncMs);
    const response = await enterDashboard();
    expect(runSyncMock).not.toHaveBeenCalled();
    expect(sweepMock).toHaveBeenCalledWith(["po-delivering"]);
    expect(response.headers.get("X-Naver-Syncing")).toBe("0");
    // 「마지막 동기화」는 lastCallTime(10분 전 — sweep·액션도 밀어 올림)이 아니라 변경피드 커서 시각이다.
    expect(response.headers.get("X-Naver-Last-Sync")).toBe(new Date(lastChangeSyncMs).toISOString());
  });

  it("간격이 지났으면 변경피드 동기화와 배송중 sweep 을 함께 건다", async () => {
    lastChangeSyncMsMock.mockResolvedValue(Date.now() - 7 * HOUR);
    const response = await enterDashboard();
    expect(runSyncMock).toHaveBeenCalledWith("CHANGED");
    expect(sweepMock).toHaveBeenCalledWith(["po-delivering"]);
    expect(response.headers.get("X-Naver-Syncing")).toBe("1");
  });
});
