import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SNAPSHOT_DAILY_AGGREGATE_VERSION } from "@/lib/order-converter/daily-aggregate";

// serializeOrders는 isSqliteDatabaseUrl()의 결과(DATABASE_URL)에 따라 분기하므로
// 두 provider 케이스를 모두 검증하기 위해 매 테스트마다 모듈을 재로딩한다.
async function loadRepository() {
  vi.resetModules();
  return await import("../naverOrderSnapshotRepository");
}

/**
 * dailyAggregate 쓰기 경로용 prisma 목.
 *
 * 주의: `salesCampaign.findMany`를 빼면 buildDailyAggregateValue 내부에서
 * `undefined.findMany` TypeError가 나고, 그 예외는 try/catch에 삼켜져 조용히
 * {v:0} 마커로 대체된다 — 테스트는 통과하지만 집계 happy path는 한 번도 실행되지
 * 않는다. 아래 upsertDaily 테스트는 반드시 이 목(또는 동등물)을 써야 한다.
 */
function mockPrismaWithCampaigns(salesCampaignRows: unknown[]) {
  const upsert = vi.fn().mockResolvedValue({});
  const findMany = vi.fn().mockResolvedValue(salesCampaignRows);
  vi.doMock("@/lib/order-converter/prisma", () => ({
    prisma: { naverOrderSnapshot: { upsert }, salesCampaign: { findMany } },
  }));
  return { upsert, findMany };
}

/** loadAggregationCampaignSources가 select하는 행 모양 그대로. */
function campaignRow() {
  return {
    id: "camp-1",
    startDate: "2026-07-01T00:00:00+09:00",
    endDate: "2026-07-31T00:00:00+09:00",
    campaignDeals: [{ id: "cd-1" }],
    orderCampaign: {
      id: "oc-1",
      name: "콜라겐",
      productId: "P1",
      mappings: [
        { productName: "콜라겐", optionName: null, price: 30000, campaignDealId: "cd-1" },
      ],
    },
  };
}

function paidOrder() {
  return {
    orderId: "O1",
    productOrderId: "PO1",
    productOrderStatus: "PAYED",
    productId: "P1",
    productName: "콜라겐",
    quantity: 1,
    totalPaymentAmount: 30000,
    orderDate: "2026-07-08T10:00:00+09:00",
  };
}

describe("naverOrderSnapshotRepository serialization round-trip", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  const sampleOrders = [
    { productOrderId: "1", productOrderStatus: "PAYED", quantity: 2 },
    { productOrderId: "2", productOrderStatus: "DISPATCHED", quantity: 1 },
  ];

  it("SQLite(file: DATABASE_URL)에서는 JSON 문자열로 직렬화하고 parseOrders로 원복된다", async () => {
    process.env.DATABASE_URL = "file:./dev.db";
    const { serializeOrders, naverOrderSnapshotRepository } = await loadRepository();

    const serialized = serializeOrders(sampleOrders);
    expect(typeof serialized).toBe("string");

    const roundTripped = naverOrderSnapshotRepository.parseOrders({ orders: serialized });
    expect(roundTripped).toEqual(sampleOrders);
  });

  it("Postgres(DATABASE_URL)에서는 객체를 그대로 유지하고 parseOrders로도 그대로 반환된다", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    const { serializeOrders, naverOrderSnapshotRepository } = await loadRepository();

    const serialized = serializeOrders(sampleOrders);
    expect(serialized).toBe(sampleOrders);

    const roundTripped = naverOrderSnapshotRepository.parseOrders({ orders: serialized });
    expect(roundTripped).toEqual(sampleOrders);
  });

  it("빈 배열도 왕복 시 빈 배열로 유지된다 (SQLite)", async () => {
    process.env.DATABASE_URL = "file:./dev.db";
    const { serializeOrders, naverOrderSnapshotRepository } = await loadRepository();

    const serialized = serializeOrders([]);
    const roundTripped = naverOrderSnapshotRepository.parseOrders({ orders: serialized });
    expect(roundTripped).toEqual([]);
  });
});

// M2 회귀 테스트: lastChangeStatusCursor 미전달 시 기존 커서를 소거하지 않아야 한다.
// prisma.naverOrderSnapshot.upsert 호출 인자를 가로채 create/update 데이터에 필드가
// 아예 생략되는지(undefined가 아니라 key 자체가 없는지) 검증한다.
describe("naverOrderSnapshotRepository.upsertDaily 커서 처리", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("lastChangeStatusCursor를 넘기지 않으면 upsert의 create/update 데이터에 해당 필드가 생략된다 (기존값 보존)", async () => {
    vi.doMock("@/lib/order-converter/prisma", () => ({
      prisma: {
        naverOrderSnapshot: {
          upsert: vi.fn().mockResolvedValue({}),
        },
      },
    }));

    const { naverOrderSnapshotRepository } = await loadRepository();
    const { prisma } = await import("@/lib/order-converter/prisma");

    await naverOrderSnapshotRepository.upsertDaily({
      snapshotDate: "2026-07-04",
      orders: [],
      ordersCount: 0,
      newOrdersCount: 0,
      preparingCount: 0,
      deliveringCount: 0,
      isDirty: false,
      lastCallTime: new Date(),
      syncType: "CHANGED",
      // lastChangeStatusCursor 생략
    });

    const call = (prisma.naverOrderSnapshot.upsert as any).mock.calls[0][0];
    expect(call.create).not.toHaveProperty("lastChangeStatusCursor");
    expect(call.update).not.toHaveProperty("lastChangeStatusCursor");

    vi.doUnmock("@/lib/order-converter/prisma");
  });

  it("lastChangeStatusCursor를 명시적으로 null로 넘기면 update 데이터에서 커서가 소거된다", async () => {
    vi.doMock("@/lib/order-converter/prisma", () => ({
      prisma: {
        naverOrderSnapshot: {
          upsert: vi.fn().mockResolvedValue({}),
        },
      },
    }));

    const { naverOrderSnapshotRepository } = await loadRepository();
    const { prisma } = await import("@/lib/order-converter/prisma");

    await naverOrderSnapshotRepository.upsertDaily({
      snapshotDate: "2026-07-04",
      orders: [],
      ordersCount: 0,
      newOrdersCount: 0,
      preparingCount: 0,
      deliveringCount: 0,
      isDirty: false,
      lastCallTime: new Date(),
      syncType: "CHANGED",
      lastChangeStatusCursor: null,
    });

    const call = (prisma.naverOrderSnapshot.upsert as any).mock.calls[0][0];
    expect(call.update.lastChangeStatusCursor).toBeNull();
    expect(call.create.lastChangeStatusCursor).toBeNull();

    vi.doUnmock("@/lib/order-converter/prisma");
  });

  it("lastChangeStatusCursor를 문자열로 넘기면 그 값이 그대로 update/create 데이터에 반영된다", async () => {
    vi.doMock("@/lib/order-converter/prisma", () => ({
      prisma: {
        naverOrderSnapshot: {
          upsert: vi.fn().mockResolvedValue({}),
        },
      },
    }));

    const { naverOrderSnapshotRepository } = await loadRepository();
    const { prisma } = await import("@/lib/order-converter/prisma");

    await naverOrderSnapshotRepository.upsertDaily({
      snapshotDate: "2026-07-04",
      orders: [],
      ordersCount: 0,
      newOrdersCount: 0,
      preparingCount: 0,
      deliveringCount: 0,
      isDirty: false,
      lastCallTime: new Date(),
      syncType: "CHANGED",
      lastChangeStatusCursor: "2026-07-04T00:00:00.000Z",
    });

    const call = (prisma.naverOrderSnapshot.upsert as any).mock.calls[0][0];
    expect(call.update.lastChangeStatusCursor).toBe("2026-07-04T00:00:00.000Z");
    expect(call.create.lastChangeStatusCursor).toBe("2026-07-04T00:00:00.000Z");

    vi.doUnmock("@/lib/order-converter/prisma");
  });
});

// dailyAggregate 쓰기 경로(egress 절감, 2026-07-15) — 계산 결과가 실제로 upsert
// 데이터에 실리는 happy path와, 실패 시 무음화 금지 계약을 리포지토리 레벨에서 고정한다.
describe("naverOrderSnapshotRepository.upsertDaily dailyAggregate 쓰기", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    vi.doUnmock("@/lib/order-converter/prisma");
    vi.restoreAllMocks();
  });

  async function upsertOnce(orders: unknown[]) {
    const { naverOrderSnapshotRepository, resetAggregationSourcesMemo } = await loadRepository();
    // 캠페인 우주 메모(60s TTL)는 모듈 전역이라 테스트 간 누수를 막는다.
    resetAggregationSourcesMemo();
    await naverOrderSnapshotRepository.upsertDaily({
      snapshotDate: "2026-07-08",
      orders,
      ordersCount: orders.length,
      newOrdersCount: 0,
      preparingCount: 0,
      deliveringCount: 0,
      isDirty: false,
      lastCallTime: new Date(),
      syncType: "CHANGED",
    });
  }

  it("Postgres: 계산된 집계가 객체 그대로 create/update 데이터에 실린다", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    const { upsert, findMany } = mockPrismaWithCampaigns([campaignRow()]);

    await upsertOnce([paidOrder()]);

    // 귀속 우주는 데스크톱과 동일한 isActive 게이트를 써야 한다(수치 정합 조건).
    expect(findMany.mock.calls[0][0].where).toEqual({ orderCampaign: { isActive: true } });

    const call = upsert.mock.calls[0][0];
    for (const data of [call.create, call.update]) {
      expect(data.dailyAggregate.v).toBe(SNAPSHOT_DAILY_AGGREGATE_VERSION);
      expect(data.dailyAggregate.campaignIds).toEqual(["camp-1"]);
      // 주문이 그 날짜·캠페인 리프로 집계됐다(= {v:0} 마커로 강등되지 않았다).
      expect(data.dailyAggregate.days["2026-07-08"]["camp-1"]).toBeTruthy();
    }
  });

  it("SQLite: 집계도 orders와 동일하게 JSON 문자열로 직렬화된다", async () => {
    process.env.DATABASE_URL = "file:./dev.db";
    const { upsert } = mockPrismaWithCampaigns([campaignRow()]);

    await upsertOnce([paidOrder()]);

    const call = upsert.mock.calls[0][0];
    expect(typeof call.create.dailyAggregate).toBe("string");
    const parsed = JSON.parse(call.create.dailyAggregate);
    expect(parsed.v).toBe(SNAPSHOT_DAILY_AGGREGATE_VERSION);
    expect(parsed.campaignIds).toEqual(["camp-1"]);
  });

  it("집계 계산 실패는 삼키지 않는다 — 경고 로그 + UNAVAILABLE 마커, 스냅샷 쓰기는 성공", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const upsert = vi.fn().mockResolvedValue({});
    vi.doMock("@/lib/order-converter/prisma", () => ({
      prisma: {
        naverOrderSnapshot: { upsert },
        salesCampaign: { findMany: vi.fn().mockRejectedValue(new Error("db down")) },
      },
    }));

    // 스냅샷 쓰기 자체는 계속 성공해야 한다(집계 실패가 동기화를 죽이지 않는다).
    await expect(upsertOnce([paidOrder()])).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    const call = upsert.mock.calls[0][0];
    // {v:0} 마커 → 읽기가 그 행만 블롭 폴백으로 안전 강등된다.
    expect(call.create.dailyAggregate).toEqual({ v: 0 });
    expect(call.update.dailyAggregate).toEqual({ v: 0 });
  });
});

// claimSource 쓰기 경로(egress 절감, 2026-07-21 · P7) — 클레임 보유 주문 프로젝션이
// 실제로 upsert 데이터에 실리는지와 직렬화 규칙(SQLite=문자열)을 고정한다.
describe("naverOrderSnapshotRepository.upsertDaily claimSource 쓰기", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    vi.doUnmock("@/lib/order-converter/prisma");
    vi.restoreAllMocks();
  });

  function claimOrder() {
    return {
      ...paidOrder(),
      productOrderId: "PO-CLAIM",
      __claim: {
        return: { claimStatus: "RETURNING", collectDeliveryCompany: "CJGLS" },
        currentClaim: { claimType: "RETURN", claimStatus: "RETURNING" },
      },
    };
  }

  async function upsertOnce(orders: unknown[]) {
    const { naverOrderSnapshotRepository, resetAggregationSourcesMemo } = await loadRepository();
    resetAggregationSourcesMemo();
    await naverOrderSnapshotRepository.upsertDaily({
      snapshotDate: "2026-07-08",
      orders,
      ordersCount: orders.length,
      newOrdersCount: 0,
      preparingCount: 0,
      deliveringCount: 0,
      isDirty: false,
      lastCallTime: new Date(),
      syncType: "CHANGED",
    });
  }

  it("Postgres: 클레임 보유 주문만 담긴 v1 프로젝션이 create/update 데이터에 실린다", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    const { upsert } = mockPrismaWithCampaigns([campaignRow()]);

    await upsertOnce([paidOrder(), claimOrder()]);

    const call = upsert.mock.calls[0][0];
    for (const data of [call.create, call.update]) {
      expect(data.claimSource.v).toBe(1);
      // 무클레임 주문(paidOrder)은 탈락하고 클레임 주문만 프로젝션된다.
      expect(data.claimSource.orders).toHaveLength(1);
      expect(data.claimSource.orders[0].productOrderId).toBe("PO-CLAIM");
      expect(data.claimSource.orders[0].__claim.return.claimStatus).toBe("RETURNING");
    }
  });

  it("SQLite: claimSource도 orders와 동일하게 JSON 문자열로 직렬화된다", async () => {
    process.env.DATABASE_URL = "file:./dev.db";
    const { upsert } = mockPrismaWithCampaigns([campaignRow()]);

    await upsertOnce([paidOrder(), claimOrder()]);

    const call = upsert.mock.calls[0][0];
    expect(typeof call.create.claimSource).toBe("string");
    const parsed = JSON.parse(call.create.claimSource);
    expect(parsed.v).toBe(1);
    expect(parsed.orders.map((o: any) => o.productOrderId)).toEqual(["PO-CLAIM"]);
  });

  it("클레임 0건이어도 null이 아닌 빈 프로젝션(v1)을 저장한다 — 읽기가 블롭 폴백을 타지 않게", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    const { upsert } = mockPrismaWithCampaigns([campaignRow()]);

    await upsertOnce([paidOrder()]);

    const call = upsert.mock.calls[0][0];
    expect(call.create.claimSource).toEqual({ v: 1, orders: [] });
  });
});

// ============================================================================
// egress 절감 계약 (2026-07-24): 쓰기 RETURNING 최소화 · 커서 전용 좁은 update ·
// 카운트 전용 경량 조회. 이 select들이 넓어지면 스냅샷 블롭이 다시 왕복한다.
// ============================================================================

describe("naverOrderSnapshotRepository egress 절감 계약", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "file:./test.db";
  });

  afterEach(() => {
    vi.doUnmock("@/lib/order-converter/prisma");
    vi.resetModules();
  });

  it("upsertDaily는 RETURNING을 식별자(select id/snapshotDate)로 좁힌다 — orders 블롭을 되받지 않는다", async () => {
    const { upsert } = mockPrismaWithCampaigns([]);
    const repo = await loadRepository();

    await repo.naverOrderSnapshotRepository.upsertDaily({
      snapshotDate: "2026-07-08",
      orders: [paidOrder()],
      ordersCount: 1,
      newOrdersCount: 1,
      preparingCount: 0,
      deliveringCount: 0,
      isDirty: false,
      lastCallTime: new Date("2026-07-08T10:00:00+09:00"),
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].select).toEqual({ id: true, snapshotDate: true });
  });

  it("advanceCursor는 커서·syncType만 update하고(orders 미접촉) select도 id로 좁힌다", async () => {
    const update = vi.fn().mockResolvedValue({ id: "row-1" });
    vi.doMock("@/lib/order-converter/prisma", () => ({
      prisma: { naverOrderSnapshot: { update } },
    }));
    const repo = await loadRepository();

    await repo.naverOrderSnapshotRepository.advanceCursor("2026-07-08", "2026-07-08T01:00:00.000Z");

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.where).toEqual({ snapshotDate: "2026-07-08" });
    expect(arg.data).toEqual({
      lastChangeStatusCursor: "2026-07-08T01:00:00.000Z",
      syncType: "CHANGED",
    });
    expect(arg.select).toEqual({ id: true });
  });

  it("findLatestCursor는 커서 판독에 필요한 필드만 select한다 — orders 블롭 미포함", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    vi.doMock("@/lib/order-converter/prisma", () => ({
      prisma: { naverOrderSnapshot: { findFirst } },
    }));
    const repo = await loadRepository();

    await repo.naverOrderSnapshotRepository.findLatestCursor();

    expect(findFirst).toHaveBeenCalledTimes(1);
    const arg = findFirst.mock.calls[0][0];
    expect(arg.select).toEqual({ snapshotDate: true, lastChangeStatusCursor: true });
    expect(arg.omit).toBeUndefined();
  });

  it("findRangeCounts는 일별 카운트 컬럼만 select한다 — orders 블롭 미포함", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    vi.doMock("@/lib/order-converter/prisma", () => ({
      prisma: { naverOrderSnapshot: { findMany } },
    }));
    const repo = await loadRepository();

    await repo.naverOrderSnapshotRepository.findRangeCounts("2026-07-01", "2026-07-08");

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(Object.keys(arg.select).sort()).toEqual([
      "deliveringCount",
      "lastCallTime",
      "newOrdersCount",
      "ordersCount",
      "preparingCount",
      "snapshotDate",
    ]);
    expect(arg.select.orders).toBeUndefined();
  });

  // 무효화 폭 계약 — 수명주기 전체는 snapshot-dirty-lifecycle.contract.test.ts 가 고정한다.
  // 배경: 종전 `markAllDirty()`가 최근 30일을 뭉뚱그려 찍었고, dirty를 지우는 주체(그 날짜의
  // upsert)는 CHANGED 사이클에서 변경된 날짜에만 오므로 플래그가 단조 증가해 실측 48행 중
  // 47행이 상시 true가 됐다(관측 가치 0).
  it("markDirty는 전달한 날짜만 대상으로 하고 중복을 제거한다", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    vi.doMock("@/lib/order-converter/prisma", () => ({
      prisma: { naverOrderSnapshot: { updateMany } },
    }));
    const repo = await loadRepository();

    await repo.naverOrderSnapshotRepository.markDirty([
      "2026-07-28",
      "2026-07-29",
      "2026-07-28",
    ]);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { snapshotDate: { in: ["2026-07-28", "2026-07-29"] } },
      data: { isDirty: true },
    });
  });

  it("markDirty는 빈 입력에서 쿼리를 아예 내지 않는다 — '모르면 창 전체' 로 승격 금지", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    vi.doMock("@/lib/order-converter/prisma", () => ({
      prisma: { naverOrderSnapshot: { updateMany } },
    }));
    const repo = await loadRepository();

    await expect(repo.naverOrderSnapshotRepository.markDirty([])).resolves.toEqual({ count: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
