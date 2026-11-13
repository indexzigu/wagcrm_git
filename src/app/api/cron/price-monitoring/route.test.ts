import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({ campaignDeal: { findMany: vi.fn() } }));
const fetchAllMarketPricesMock = vi.hoisted(() => vi.fn());
const evaluateMarketPriceMock = vi.hoisted(() => vi.fn());
const upsertDailyMock = vi.hoisted(() => vi.fn());
const findLabelsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaMock }));
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => true }));
vi.mock("@/lib/system-task-status", () => ({
  withSystemTaskStatus: (_key: string, handler: (request: Request) => Promise<Response>) => handler,
}));
vi.mock("@/lib/cron-error-text", () => ({ describeErrorChain: (error: unknown) => String(error) }));
vi.mock("@/lib/price-monitor/query-builder", () => ({
  buildMonitorWindowWhere: () => ({}),
  buildSearchQuery: () => "테스트 상품",
  inferQuantityFromName: () => null,
  resolveMonitorFields: () => ({
    dealName: "테스트 딜",
    coreDealName: "테스트 딜",
    brandName: "테스트 브랜드",
    searchKeyword: "테스트 상품",
    modelName: null,
    unit: null,
    unitQuantity: null,
    childDealName: null,
    parentDealName: null,
  }),
}));
vi.mock("@/lib/price-monitor/pipeline", () => ({
  evaluateMarketPrice: (...args: unknown[]) => evaluateMarketPriceMock(...args),
}));
vi.mock("@/lib/price-monitor/market-fetch", () => ({
  fetchAllMarketPrices: (...args: unknown[]) => fetchAllMarketPricesMock(...args),
}));
vi.mock("@/repositories/priceMonitorSnapshotRepository", () => ({
  priceMonitorSnapshotRepository: { upsertDaily: (...args: unknown[]) => upsertDailyMock(...args) },
}));

vi.mock("@/repositories/priceMatchLabelRepository", () => ({
  priceMatchLabelRepository: { findByRootDealIds: (...args: unknown[]) => findLabelsMock(...args) },
}));

import { GET } from "./route";

describe("GET /api/cron/price-monitoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.campaignDeal.findMany.mockResolvedValue([
      {
        campaign: { id: "campaign-1", shippingFee: null, freeShippingThreshold: null },
        deal: {
          id: "deal-1",
          dealName: "테스트 딜",
          brandName: "테스트 브랜드",
          unit: null,
          unitQuantity: null,
          sellingPrice: 10000,
          supplementaryInfo: null,
          monitorEnabled: true,
          parentDealId: null,
          parentDeal: null,
        },
      },
    ]);
    fetchAllMarketPricesMock.mockResolvedValue({
      allItems: [],
      minItem: null,
      errors: { naver: "NAVER_SEARCH_CLIENT_ID/SECRET 미설정", coupang: null, kakao: null },
      sources: {
        naver: { status: "error", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
        coupang: { status: "disabled", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
        kakao: { status: "empty", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
      },
    });
    evaluateMarketPriceMock.mockReturnValue({
      verdict: "NO_DATA",
      minValidItem: null,
      minConfidentItem: null,
      ourUnitPrice: null,
      validCount: 0,
      allScored: [],
    });
    upsertDailyMock.mockResolvedValue(undefined);
    findLabelsMock.mockResolvedValue(new Map());
  });

  it("루트 딜의 오너 표시와 브랜드·회사 이름을 판정에 넘긴다(3축 판정 2026-11-13)", async () => {
    prismaMock.campaignDeal.findMany.mockResolvedValue([
      {
        campaign: { id: "campaign-1", shippingFee: null, freeShippingThreshold: null },
        deal: {
          id: "option-1",
          dealName: "테스트 딜 - 2박스",
          brandName: null,
          unit: "박스",
          unitQuantity: 2,
          sellingPrice: 10000,
          supplementaryInfo: null,
          monitorEnabled: true,
          parentDealId: "root-1",
          monitorBrandAliases: null,
          parentDeal: {
            dealName: "테스트 딜",
            brandName: "테스트 브랜드",
            supplementaryInfo: null,
            unit: "박스",
            monitorBrandAliases: "제조사A\n제조사B",
          },
        },
      },
    ]);
    const labels = [{ nameKey: "몰|상품", urlKey: null, label: "DIFFERENT" }];
    findLabelsMock.mockResolvedValue(new Map([["root-1", labels]]));

    await GET(new Request("http://localhost/api/cron/price-monitoring"));

    expect(findLabelsMock).toHaveBeenCalledWith(["root-1"]);
    expect(evaluateMarketPriceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        brandIdentities: ["테스트 브랜드", "제조사A", "제조사B"],
        ownerLabels: labels,
      }),
    );
  });

  it("소스 상태를 evidence.sourceStates에 저장하고 부분 수집을 summary에 집계한다", async () => {
    const response = await GET(new Request("http://localhost/api/cron/price-monitoring"));
    const body = await response.json();

    expect(fetchAllMarketPricesMock).toHaveBeenCalledWith(
      "테스트 상품",
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    expect(upsertDailyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: expect.objectContaining({
          sourceErrors: { naver: "NAVER_SEARCH_CLIENT_ID/SECRET 미설정", coupang: null, kakao: null },
          sourceStates: expect.objectContaining({
            naver: expect.objectContaining({ status: "error" }),
            coupang: expect.objectContaining({ status: "disabled" }),
          }),
        }),
      }),
    );
    expect(body.summary).toMatchObject({ sourceFailures: 1, partial: 1, failed: 0 });
    expect(body).toMatchObject({ success: true, failed: false });
  });

  it("사용 가능한 모든 소스가 실패하면 실행 상태도 실패로 선언한다", async () => {
    fetchAllMarketPricesMock.mockResolvedValue({
      allItems: [],
      minItem: null,
      errors: { naver: "수집 시간 제한", coupang: null, kakao: "HTTP 503" },
      sources: {
        naver: { status: "error", checkedAt: new Date().toISOString(), itemCount: 0 },
        coupang: { status: "disabled", checkedAt: new Date().toISOString(), itemCount: 0 },
        kakao: { status: "error", checkedAt: new Date().toISOString(), itemCount: 0 },
      },
    });

    const body = await (await GET(new Request("http://localhost/api/cron/price-monitoring"))).json();

    expect(body).toMatchObject({ success: false, failed: true });
    expect(body.summary).toMatchObject({ failed: 0, unprocessed: 0, collectionFailures: 1 });
    expect(body.failureReason).toContain("전체 소스 조회 실패");
    expect(upsertDailyMock).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ sourceErrors: expect.objectContaining({ naver: "수집 시간 제한", kakao: "HTTP 503" }) }),
    }));
  });

  it("전체 budget은 대상 조회 전부터 시작하고 만료된 대상도 네트워크 없이 실패 증거를 저장한다", async () => {
    const target = {
      campaign: { id: "campaign-1", shippingFee: null, freeShippingThreshold: null },
      deal: {
        id: "deal-1",
        dealName: "테스트 딜",
        brandName: "테스트 브랜드",
        unit: null,
        unitQuantity: null,
        sellingPrice: 10000,
        supplementaryInfo: null,
        monitorEnabled: true,
        parentDealId: null,
        parentDeal: null,
      },
    };
    const realNow = Date.now();
    let currentNow = realNow;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    prismaMock.campaignDeal.findMany.mockImplementation(async () => {
      currentNow = realNow + 240_001;
      return [target, { ...target, campaign: { ...target.campaign, id: "campaign-2" } }];
    });

    try {
      const response = await GET(new Request("http://localhost/api/cron/price-monitoring"));
      const body = await response.json();

      expect(fetchAllMarketPricesMock).not.toHaveBeenCalled();
      expect(upsertDailyMock).toHaveBeenCalledTimes(2);
      expect(upsertDailyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          evidence: expect.objectContaining({
            sourceErrors: {
              naver: expect.stringContaining("예산"),
              coupang: expect.stringContaining("예산"),
              kakao: expect.stringContaining("예산"),
            },
            sourceStates: expect.objectContaining({
              naver: expect.objectContaining({ status: "error", itemCount: 0 }),
              coupang: expect.objectContaining({ status: "error", itemCount: 0 }),
              kakao: expect.objectContaining({ status: "error", itemCount: 0 }),
            }),
          }),
        }),
      );
      expect(body).toMatchObject({ success: false, failed: true });
      expect(body.summary).toMatchObject({ total: 2, unprocessed: 2, sourceFailures: 6, partial: 2, failed: 0 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("대상 사이에 고정 300ms 지연을 넣지 않는다", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      await GET(new Request("http://localhost/api/cron/price-monitoring"));
      expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 300)).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("수집 중 예산이 만료되면 저장하더라도 실행을 미완료로 보고한다", async () => {
    const realNow = Date.now();
    let currentNow = realNow;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    fetchAllMarketPricesMock.mockImplementation(async () => {
      currentNow = realNow + 240_001;
      return {
        allItems: [],
        minItem: null,
        errors: { naver: null, coupang: null, kakao: null },
        sources: {
          naver: { status: "empty", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
          coupang: { status: "empty", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
          kakao: { status: "empty", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
        },
      };
    });

    try {
      const response = await GET(new Request("http://localhost/api/cron/price-monitoring"));
      const body = await response.json();

      expect(upsertDailyMock).toHaveBeenCalledTimes(1);
      expect(body).toMatchObject({ success: false, failed: true });
      expect(body.summary).toMatchObject({ total: 1, failed: 0, unprocessed: 1 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("일부 대상 저장 실패는 summary와 실행 실패 선언에 함께 반영한다", async () => {
    const target = {
      campaign: { id: "campaign-1", shippingFee: null, freeShippingThreshold: null },
      deal: {
        id: "deal-1",
        dealName: "테스트 딜",
        brandName: "테스트 브랜드",
        unit: null,
        unitQuantity: null,
        sellingPrice: 10000,
        supplementaryInfo: null,
        monitorEnabled: true,
        parentDealId: null,
        parentDeal: null,
      },
    };
    prismaMock.campaignDeal.findMany.mockResolvedValue([
      target,
      { ...target, campaign: { ...target.campaign, id: "campaign-2" } },
    ]);
    upsertDailyMock.mockRejectedValueOnce(new Error("snapshot write failed"));

    const response = await GET(new Request("http://localhost/api/cron/price-monitoring"));
    const body = await response.json();

    expect(body).toMatchObject({ success: false, failed: true });
    expect(body.summary).toMatchObject({ total: 2, failed: 1, unprocessed: 0 });
    expect(body.summary.OK + body.summary.NO_DATA).toBe(1);
  });
});
