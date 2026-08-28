import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  getPrisma: vi.fn(),
}));

vi.mock("@/repositories/orderFulfillmentRepository", () => ({
  orderFulfillmentRepository: { getPoRequestedSet: vi.fn().mockResolvedValue(new Set<string>()) },
}));

import { getPrisma } from "@/lib/prisma";
import { getMobilePulse } from "../mobile-pulse-loader";
import { computeSnapshotDailyAggregate } from "@/lib/order-converter/daily-aggregate";
import type { PulseOrderLike, PulseSalesCampaignSource } from "../mobile-pulse-data";

/**
 * 모바일 펄스 로더 — dailyAggregate 읽기 경로 검증 (2026-07-15 egress 절감).
 * 홈 표면이 스냅샷 orders 블롭(최대 30일 × 행당 수 MB)을 읽지 않고, #163과 동일한
 * 사전 집계 컬럼만 select 하는지가 계약이다. 집계 규칙 자체(computePulse 동치)는
 * mobile-pulse-data.test.ts 와 daily-aggregate 경로 테스트가 담당한다.
 */

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function makeCampaignSource(overrides: Partial<PulseSalesCampaignSource> = {}): PulseSalesCampaignSource {
  return {
    id: "camp-1",
    dealName: "",
    sellerName: "",
    startMs: ms("2026-07-01T00:00:00+09:00"),
    endMs: ms("2026-07-31T23:59:59+09:00"),
    campaignDealIds: ["cd-1"],
    orderCampaign: {
      id: "oc-1",
      name: "콜라겐",
      productId: "P1",
      mappings: [{ productName: "콜라겐", optionName: null, price: 30000, campaignDealId: "cd-1" }],
    },
    ...overrides,
  };
}

function order(overrides: Partial<PulseOrderLike>): PulseOrderLike {
  return {
    orderId: "O1",
    productOrderId: "PO1",
    productOrderStatus: "PAYED",
    productName: "콜라겐",
    productId: "P1",
    quantity: 1,
    totalPaymentAmount: 30000,
    paymentDate: "2026-07-08T10:00:00+09:00",
    ...overrides,
  };
}

const NOW = new Date("2026-07-08T12:00:00+09:00");

function activeCampaignRow(
  id: string,
  dealName: string,
  sellerName: string,
  link: { orderCampaignId: string | null; isActive: boolean } = {
    orderCampaignId: "oc-1",
    isActive: true,
  },
) {
  return {
    id,
    startDate: new Date("2026-07-01T00:00:00+09:00"),
    orderCampaignId: link.orderCampaignId,
    orderCampaign: link.orderCampaignId ? { isActive: link.isActive } : null,
    deal: { dealName },
    seller: { name: sellerName, alias: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getMobilePulse — dailyAggregate 읽기 경로", () => {
  it("집계가 가용하면 orders 블롭을 select하지 않고 오늘/누적/캠페인별/퍼널을 합성한다", async () => {
    const camp1 = makeCampaignSource();
    const camp2 = makeCampaignSource({
      id: "camp-2",
      campaignDealIds: ["cd-2"],
      orderCampaign: {
        id: "oc-2",
        name: "비타민",
        productId: "P2",
        mappings: [{ productName: "비타민", optionName: null, price: 40000, campaignDealId: "cd-2" }],
      },
    });

    // 07-07: camp-1 결제 1건(PAYED) + camp-2 배송중 1건 / 07-08(오늘): camp-1 결제 1건
    const day1 = computeSnapshotDailyAggregate([camp1, camp2], [
      order({
        orderId: "ORDER-1",
        productOrderId: "PO-1",
        paymentDate: "2026-07-07T10:00:00+09:00",
      }),
      order({
        orderId: "ORDER-3",
        productOrderId: "PO-3",
        productOrderStatus: "DELIVERING",
        productName: "비타민",
        productId: "P2",
        totalPaymentAmount: 40000,
        paymentDate: "2026-07-07T11:00:00+09:00",
      }),
    ]);
    const day2 = computeSnapshotDailyAggregate([camp1, camp2], [
      order({
        orderId: "ORDER-2",
        productOrderId: "PO-2",
        paymentDate: "2026-07-08T09:00:00+09:00",
      }),
    ]);

    const snapshotFindMany = vi.fn().mockResolvedValue([
      { snapshotDate: "2026-07-07", dailyAggregate: day1 },
      { snapshotDate: "2026-07-08", dailyAggregate: day2 },
    ]);
    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: {
        findMany: vi.fn().mockResolvedValue([
          activeCampaignRow("camp-1", "콜라겐", "하늘언니"),
          activeCampaignRow("camp-2", "비타민", "하늘님"),
        ]),
      },
      naverOrderSnapshot: {
        findFirst: vi.fn().mockResolvedValue({ lastCallTime: "2026-07-08T11:00:00+09:00" }),
        findMany: snapshotFindMany,
      },
    } as never);

    const pulse = await getMobilePulse(NOW);

    // 블롭 미조회 — 집계 컬럼 select 1회.
    expect(snapshotFindMany).toHaveBeenCalledTimes(1);
    expect(snapshotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { snapshotDate: true, dailyAggregate: true } }),
    );

    expect(pulse.asOf).toBe(new Date("2026-07-08T11:00:00+09:00").toISOString());
    expect(pulse.today).toEqual({ orders: 1, quantity: 1, revenue: 30000 });
    expect(pulse.cumulative).toEqual({ orders: 3, quantity: 3, revenue: 100000 });
    // 오늘 매출 있는 camp-1 이 앞, camp-2 는 0건으로도 목록에 남는다.
    expect(pulse.byCampaign).toEqual([
      { campaignId: "camp-1", dealName: "콜라겐", sellerName: "하늘언니", todayOrders: 1, todayRevenue: 30000 },
      { campaignId: "camp-2", dealName: "비타민", sellerName: "하늘님", todayOrders: 0, todayRevenue: 0 },
    ]);
    // PAYED 2건 = ordered, DELIVERING 1건 = shipping.
    expect(pulse.fulfillment).toEqual({ ordered: 2, shipping: 1, completed: 0 });
  });

  it("진행중 캠페인이 없으면 스냅샷 조회 없이 0 응답을 낸다", async () => {
    const snapshotFindMany = vi.fn();
    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: { findMany: vi.fn().mockResolvedValue([]) },
      naverOrderSnapshot: {
        findFirst: vi.fn().mockResolvedValue({ lastCallTime: "2026-07-08T11:00:00+09:00" }),
        findMany: snapshotFindMany,
      },
    } as never);

    const pulse = await getMobilePulse(NOW);

    expect(snapshotFindMany).not.toHaveBeenCalled();
    expect(pulse.today).toEqual({ orders: 0, quantity: 0, revenue: 0 });
    expect(pulse.cumulative).toEqual({ orders: 0, quantity: 0, revenue: 0 });
    expect(pulse.byCampaign).toEqual([]);
    expect(pulse.fulfillment).toEqual({ ordered: 0, shipping: 0, completed: 0 });
  });

  it("발주 미연동 ACTIVE 캠페인은 커버리지 대상에서 빼 전 창 블롭 폴백을 막는다(집계 유지)", async () => {
    const linked = makeCampaignSource();
    const day = computeSnapshotDailyAggregate([linked], [
      order({ orderId: "ORDER-1", productOrderId: "PO-1", paymentDate: "2026-07-08T09:00:00+09:00" }),
    ]);
    // 미연동 캠페인(camp-99)은 dailyAggregate.campaignIds 에 절대 없다 — 예전엔 이것 하나가
    // aggregateCoversCampaigns 를 매 요청 false 로 만들어 전 창 orders 블롭을 다시 읽게 했다.
    const snapshotFindMany = vi.fn().mockResolvedValue([
      { snapshotDate: "2026-07-08", dailyAggregate: day },
    ]);
    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: {
        findMany: vi.fn().mockResolvedValue([
          activeCampaignRow("camp-1", "콜라겐", "하늘언니"),
          activeCampaignRow("camp-99", "자사몰단독", "직영", { orderCampaignId: null, isActive: false }),
        ]),
      },
      naverOrderSnapshot: {
        findFirst: vi.fn().mockResolvedValue({ lastCallTime: "2026-07-08T11:00:00+09:00" }),
        findMany: snapshotFindMany,
      },
    } as never);

    const pulse = await getMobilePulse(NOW);

    // 블롭 폴백 없이 집계 select 1회만 — where.snapshotDate.in(블롭 2차 조회)이 없어야 한다.
    expect(snapshotFindMany).toHaveBeenCalledTimes(1);
    expect(snapshotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { snapshotDate: true, dailyAggregate: true } }),
    );
    expect(pulse.today).toEqual({ orders: 1, quantity: 1, revenue: 30000 });
    // 미연동 캠페인도 byCampaign 목록에는 0으로 남는다(표시용).
    expect(pulse.byCampaign).toEqual([
      { campaignId: "camp-1", dealName: "콜라겐", sellerName: "하늘언니", todayOrders: 1, todayRevenue: 30000 },
      { campaignId: "camp-99", dealName: "자사몰단독", sellerName: "직영", todayOrders: 0, todayRevenue: 0 },
    ]);
  });

  it("연동 OrderCampaign이 마감(isActive=false)이면 대상에서 빼 폴백을 막는다", async () => {
    const snapshotFindMany = vi.fn().mockResolvedValue([]);
    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: {
        findMany: vi.fn().mockResolvedValue([
          activeCampaignRow("camp-1", "마감연동", "하늘언니", { orderCampaignId: "oc-1", isActive: false }),
        ]),
      },
      naverOrderSnapshot: {
        findFirst: vi.fn().mockResolvedValue({ lastCallTime: "2026-07-08T11:00:00+09:00" }),
        findMany: snapshotFindMany,
      },
    } as never);

    const pulse = await getMobilePulse(NOW);

    // 연동 active 대상이 0개 → 스냅샷 조회 없이 0 응답(byCampaign 은 표시 유지).
    expect(snapshotFindMany).not.toHaveBeenCalled();
    expect(pulse.today).toEqual({ orders: 0, quantity: 0, revenue: 0 });
    expect(pulse.byCampaign).toEqual([
      { campaignId: "camp-1", dealName: "마감연동", sellerName: "하늘언니", todayOrders: 0, todayRevenue: 0 },
    ]);
  });
});
