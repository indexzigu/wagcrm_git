import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 홈 「오늘 처리할 주문」 로더(`loadOrderWorkSummary`) 계약.
 *
 * ① **네이버 호출 0** — 이 기능의 존재 이유가 프록시 하루 요청 수 절약이다(오너 승인 2026-10-06).
 *    네이버로 가는 층(토큰·apiRequest·proxyFetch·스토어 조회·동기화)을 전부 스파이로 바꾸고
 *    로더가 하나도 부르지 않는지 본다.
 * ② **주문 관리 카드와 같은 숫자** — 같은 픽스처를 주문 관리 핸들러(`fetchAndSyncCampaigns`)와
 *    로더에 넣어 캠페인별 발주 대기·지연 수가 일치하는지 본다(화면이 판정을 다시 쓰다 갈라지는
 *    반복 결함을 막는 대조). 픽스처는 추가구성상품·창 밖 주문·미귀속 주문을 포함한다.
 * ③ 클레임은 주문 관리 「반품/교환」과 같은 판정 — `*_REJECT`·`*_DONE` 은 끝난 클레임이다.
 *
 * ⏰ 날짜는 전부 now 기준 상대값(P9 시한폭탄 규칙).
 */

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const naverSpies = vi.hoisted(() => ({
  searchNaverProducts: vi.fn(),
  getNaverToken: vi.fn(),
  apiRequest: vi.fn(),
  getAccessToken: vi.fn(),
  proxyFetch: vi.fn(),
  runSync: vi.fn(),
  sweepDeliveringOrders: vi.fn(),
  syncOrdersByIds: vi.fn(),
}));

const state = vi.hoisted(() => ({
  campaigns: [] as any[],
  snapshotRows: [] as Array<{ snapshotDate: string; lastCallTime: Date; orders: any[] }>,
  claimRows: [] as Array<{ snapshotDate: string; claimSource: unknown }>,
  poRequested: new Map<string, Date>(),
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => {
    state.afterCallbacks.push(callback);
  },
}));

vi.mock("@/lib/order-converter/naver-commerce-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/order-converter/naver-commerce-api")>()),
  searchNaverProducts: (...args: unknown[]) => naverSpies.searchNaverProducts(...args),
  getNaverToken: (...args: unknown[]) => naverSpies.getNaverToken(...args),
}));
vi.mock("@/lib/order-converter/naver-commerce-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/order-converter/naver-commerce-client")>()),
  apiRequest: (...args: unknown[]) => naverSpies.apiRequest(...args),
  getAccessToken: (...args: unknown[]) => naverSpies.getAccessToken(...args),
}));
vi.mock("@/lib/order-converter/fetch-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/order-converter/fetch-client")>()),
  proxyFetch: (...args: unknown[]) => naverSpies.proxyFetch(...args),
}));
vi.mock("@/lib/order-converter/naver-order-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/order-converter/naver-order-sync")>()),
  runSync: (...args: unknown[]) => naverSpies.runSync(...args),
  sweepDeliveringOrders: (...args: unknown[]) => naverSpies.sweepDeliveringOrders(...args),
  syncOrdersByIds: (...args: unknown[]) => naverSpies.syncOrdersByIds(...args),
}));

// 모델·메서드를 가리지 않는 prisma 대역 — 주문캠페인 조회만 픽스처를 돌려준다.
const prismaMock = vi.hoisted(() => {
  const orderCampaign = {
    findMany: async () => state.campaigns.map((c) => structuredClone(c)),
    update: async ({ where }: { where: { id: string } }) => state.campaigns.find((c) => c.id === where.id),
  };
  return new Proxy(
    {},
    {
      get: (_target, model: string) =>
        model === "orderCampaign"
          ? orderCampaign
          : new Proxy({}, { get: (_m, method: string) => async () => (method === "findMany" ? [] : method === "count" ? 0 : null) }),
    },
  );
});
vi.mock("@/lib/order-converter/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaMock }));
vi.mock("@/lib/demo-mode", () => ({ isDemoMode: () => false }));

const repoMock = vi.hoisted(() => ({
  findRangeMeta: vi.fn(async (start: string, end: string) =>
    state.snapshotRows
      .filter((r) => r.snapshotDate >= start && r.snapshotDate <= end)
      .map((r) => ({ snapshotDate: r.snapshotDate, lastCallTime: r.lastCallTime })),
  ),
  findByDates: vi.fn(async (keys: string[]) =>
    state.snapshotRows
      .filter((r) => keys.includes(r.snapshotDate))
      .map((r) => ({ ...r, newOrdersCount: 0, preparingCount: 0, deliveringCount: 0, isDirty: false })),
  ),
  findRange: vi.fn(async () => []),
  findRangeClaimSources: vi.fn(async () => state.claimRows),
  latestSyncMeta: vi.fn(async () => ({ lastCallTime: new Date(NOW - 30 * 60 * 1000), syncType: "CHANGED" })),
  latestChangeCursor: vi.fn(async () => ({ lastChangeStatusCursor: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() })),
  parseOrders: (row: { orders: unknown }) => row.orders,
}));
vi.mock("@/repositories/naverOrderSnapshotRepository", () => ({ naverOrderSnapshotRepository: repoMock }));
vi.mock("@/repositories/orderFulfillmentRepository", () => ({
  orderFulfillmentRepository: {
    getPoRequestedMap: vi.fn(async (ids: string[]) => new Map([...state.poRequested].filter(([id]) => ids.includes(id)))),
  },
}));

const { loadOrderWorkSummary } = await import("../order-work-summary");
const { fetchAndSyncCampaigns } = await import("@/app/order-converter/api/campaigns/campaigns-handler");
const { toDateKeyKst } = await import("@/lib/order-converter/naver-order-sync");
const { SUPPLEMENT_PRODUCT_CLASS } = await import("../product-class");

function campaign(id: string, name: string, productId: string, startAgoDays: number) {
  const startDate = new Date(NOW - startAgoDays * DAY);
  const endDate = new Date(NOW + 10 * DAY);
  return {
    id,
    name,
    productId,
    isActive: true,
    template: null,
    category: "생활",
    salePeriod: "기간",
    productStatus: "SALE",
    // 간격 구간 + 방금 확인 → 주문 관리 핸들러도 스토어 조회를 하지 않는다(대조 조건을 같게).
    periodCheckedAt: new Date(NOW),
    startDate,
    endDate,
    tasks: [],
    mappings: [{ id: `${id}-m`, productName: name, optionName: "기본", campaignDealId: null, price: 0 }],
    salesCampaigns: [
      {
        id: `${id}-sc`,
        sellerId: "seller",
        status: "ACTIVE",
        startDate,
        endDate,
        actualSales: 0,
        sellerFeeBasisOverride: null,
        sellerMarginRate: null,
        campaignDeals: [],
      },
    ],
  };
}

function order(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    productOrderId: id,
    orderId: `o-${id}`,
    productOrderStatus: "PAYED",
    placeOrderStatus: "NOT_YET",
    quantity: 1,
    totalPaymentAmount: 10000,
    ...overrides,
  };
}

function seed() {
  state.campaigns = [campaign("oc-a", "에이상품", "P-A", 10), campaign("oc-b", "비상품", "P-B", 5)];
  const mainA = { productName: "에이상품", productOption: "기본", productId: "CH-A", originalProductId: "P-A" };
  const mainB = { productName: "비상품", productOption: "기본", productId: "CH-B", originalProductId: "P-B" };
  const orders = [
    order("a1", { ...mainA, paymentDate: iso(DAY / 2) }), // 미확인 → 발주 대기
    order("a2", { ...mainA, placeOrderStatus: "OK", paymentDate: iso(3 * DAY) }), // 발주확인 후 3일 → 발주 대기(지연)
    order("a3", { ...mainA, placeOrderStatus: "OK", paymentDate: iso(4 * DAY) }), // 발주요청 3일 전 → 송장 미회신
    order("a4", { ...mainA, productOrderStatus: "DELIVERING", paymentDate: iso(6 * DAY) }), // 배송 6일 → 배송 지연
    order("a5", { ...mainA, productOrderStatus: "DELIVERED", paymentDate: iso(8 * DAY) }), // 완료 → 일 아님
    order("a6", { ...mainA, productOrderStatus: "CANCELED", paymentDate: iso(DAY) }), // 취소 → 일 아님
    // 추가구성상품 — 이름이 캠페인과 무관해도 같은 상품번호의 메인이 귀속됐으면 따라간다.
    order("a7", { productName: "파우치", productOption: "아이보리", productId: "CH-A", productClass: SUPPLEMENT_PRODUCT_CLASS, paymentDate: iso(DAY) }),
    order("b1", { ...mainB, paymentDate: iso(DAY) }), // 발주 대기
    order("b2", { ...mainB, paymentDate: iso(20 * DAY) }), // 캠페인 B 창(5일 전 시작) 밖 → 제외
    order("x1", { productName: "Zebra Socks", productOption: "", productId: "CH-X", paymentDate: iso(DAY) }), // 미귀속
  ];
  // 결제일(KST)별로 스냅샷 행을 나눈다 — 실제 저장 모양과 같게.
  const byDate = new Map<string, any[]>();
  for (const o of orders) {
    const key = toDateKeyKst(new Date(o.paymentDate as string));
    byDate.set(key, [...(byDate.get(key) ?? []), o]);
  }
  state.snapshotRows = [...byDate].map(([snapshotDate, rows]) => ({
    snapshotDate,
    lastCallTime: new Date(NOW - 60 * 60 * 1000),
    orders: rows,
  }));
  state.poRequested = new Map([["a3", new Date(NOW - 3 * DAY)]]);

  const claimOrder = (id: string, productId: string | null, productName: string, bag: Record<string, unknown>) => ({
    productOrderId: id,
    productName,
    productId,
    originalProductId: productId === "CH-A" ? "P-A" : productId === "CH-B" ? "P-B" : null,
    paymentDate: iso(2 * DAY),
    __claim: bag,
  });
  state.claimRows = [
    {
      snapshotDate: toDateKeyKst(new Date(NOW - 2 * DAY)),
      claimSource: {
        v: 1,
        orders: [
          claimOrder("c1", "CH-A", "에이상품", { return: { claimStatus: "RETURN_REQUEST" } }), // 진행 중 · 캠페인 A
          claimOrder("c2", "CH-B", "비상품", { cancel: { claimStatus: "CANCEL_REJECT" } }), // 철회 → 끝남
          claimOrder("c3", "CH-A", "에이상품", { return: { claimStatus: "RETURN_DONE" } }), // 완료 → 끝남
          claimOrder("c4", "CH-X", "Zebra Socks", { exchange: { claimStatus: "EXCHANGE_REQUEST" } }), // 진행 중 · 미매칭
        ],
      },
    },
  ];
}

beforeEach(() => {
  for (const spy of Object.values(naverSpies)) spy.mockReset();
  repoMock.findByDates.mockClear();
  state.afterCallbacks.length = 0;
  (globalThis as any).__naverDailyCache = undefined;
  seed();
});

afterEach(() => {
  (globalThis as any).__naverDailyCache = undefined;
});

describe("loadOrderWorkSummary — 네이버 호출 0", () => {
  it("저장된 스냅샷·DB 만 읽고 네이버로 가는 어떤 층도 부르지 않는다", async () => {
    await loadOrderWorkSummary(new Date(NOW));
    for (const [name, spy] of Object.entries(naverSpies)) {
      expect(spy, `${name} 가 불렸다`).not.toHaveBeenCalled();
    }
  });

  it("스냅샷이 전무해도 FULL 부트스트랩을 걸지 않고 「동기화된 주문 없음」으로 답한다", async () => {
    state.snapshotRows = [];
    const summary = await loadOrderWorkSummary(new Date(NOW));
    expect(summary.hasSnapshot).toBe(false);
    expect(summary.awaitingPo.lines).toBe(0);
    expect(naverSpies.runSync).not.toHaveBeenCalled();
  });
});

describe("loadOrderWorkSummary — 숫자", () => {
  it("발주 대기·배송 지연·진행 중 클레임을 주문 라인과 캠페인 수로 센다", async () => {
    const summary = await loadOrderWorkSummary(new Date(NOW));
    // A: a1·a2·a7(추가구성) + B: b1 — b2 는 창 밖, x1 은 미귀속이라 빠진다.
    expect(summary.awaitingPo).toEqual({ lines: 4, campaigns: 2, delayedLines: 1 });
    expect(summary.delayed).toEqual({ lines: 2, campaigns: 1, invoiceLines: 1, shippingLines: 1 });
    // c2(CANCEL_REJECT)·c3(RETURN_DONE)는 끝난 클레임이다.
    expect(summary.openClaims).toEqual({ lines: 2, campaigns: 1, unmatchedLines: 1 });
    expect(summary.total).toBe(8);
    expect(summary.activeCampaignCount).toBe(2);
    expect(summary.hasSnapshot).toBe(true);
    // 기준 시각 = 마지막 변경피드 동기화(커서) — 주문 관리 툴바와 같은 값.
    expect(summary.lastSyncAt).toBe((await repoMock.latestChangeCursor())?.lastChangeStatusCursor);
  });

  it("활성 캠페인이 없으면 주문 블롭을 읽지 않는다(클레임은 그대로 센다)", async () => {
    state.campaigns = [];
    const summary = await loadOrderWorkSummary(new Date(NOW));
    expect(repoMock.findByDates).not.toHaveBeenCalled();
    expect(summary.awaitingPo.lines + summary.delayed.lines).toBe(0);
    expect(summary.openClaims.lines).toBe(2);
    expect(summary.openClaims.campaigns).toBe(0);
  });

  it("웜 프로세스에서는 바뀐 날짜만 블롭을 다시 읽는다(L1 공유 — egress 규율)", async () => {
    await loadOrderWorkSummary(new Date(NOW));
    const firstFetch = repoMock.findByDates.mock.calls.flatMap(([keys]) => keys as string[]).length;
    expect(firstFetch).toBeGreaterThan(0);
    repoMock.findByDates.mockClear();
    await loadOrderWorkSummary(new Date(NOW));
    const secondFetch = repoMock.findByDates.mock.calls.flatMap(([keys]) => keys as string[]).length;
    expect(secondFetch).toBe(0);
  });
});

describe("주문 관리 카드와 같은 판정(대조)", () => {
  it("같은 픽스처에서 캠페인별 발주 대기·지연 수가 주문 관리 핸들러와 일치한다", async () => {
    const summary = await loadOrderWorkSummary(new Date(NOW));
    const response = await fetchAndSyncCampaigns(false);
    const board = (await response.json()) as any[];
    const sum = (pick: (c: any) => number) => board.reduce((acc, c) => acc + pick(c), 0);
    const count = (buckets: Record<string, number> | undefined) => Object.values(buckets ?? {}).reduce((a, b) => a + b, 0);

    expect(summary.awaitingPo.lines).toBe(sum((c) => (c.newOrderBeforeCount ?? 0) + (c.newOrderAfterCount ?? 0)));
    expect(summary.awaitingPo.delayedLines).toBe(sum((c) => count(c.confirmDelayDays)));
    expect(summary.delayed.invoiceLines).toBe(sum((c) => count(c.pendingDelayDays)));
    expect(summary.delayed.shippingLines).toBe(sum((c) => count(c.shippingDelayDays)));
    expect(summary.awaitingPo.campaigns).toBe(
      board.filter((c) => (c.newOrderBeforeCount ?? 0) + (c.newOrderAfterCount ?? 0) > 0).length,
    );
    expect(summary.delayed.campaigns).toBe(
      board.filter((c) => count(c.pendingDelayDays) + count(c.shippingDelayDays) > 0).length,
    );
  });
});
