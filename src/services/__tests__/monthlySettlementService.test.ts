import { beforeEach, describe, expect, it, vi } from "vitest";

// 월별 정산 서비스(T-240) — 쓰기 규칙(월정산 거래처만 · 소유 확인 · 공급가액/세액 서버 분해 ·
// 물품대금 롤업)과 완료 게이트·월정산 켜기 이전을 가짜 DB 로 고정한다. 금액은 전부 가공이다(P0).

const campaignFindUnique = vi.fn();
const campaignFindMany = vi.fn();
const campaignUpdate = vi.fn();
const lineCreate = vi.fn();
const lineUpdateMany = vi.fn();
const lineDeleteMany = vi.fn();
const lineFindMany = vi.fn();
const lineFindUniqueOrThrow = vi.fn();
const lineCreateMany = vi.fn();
const partnerFindUnique = vi.fn();
const partnerUpdate = vi.fn();

const db = {
  salesCampaign: {
    findUnique: (...a: unknown[]) => campaignFindUnique(...a),
    findMany: (...a: unknown[]) => campaignFindMany(...a),
    update: (...a: unknown[]) => campaignUpdate(...a),
    count: vi.fn().mockResolvedValue(3),
  },
  campaignMonthlySettlement: {
    create: (...a: unknown[]) => lineCreate(...a),
    updateMany: (...a: unknown[]) => lineUpdateMany(...a),
    deleteMany: (...a: unknown[]) => lineDeleteMany(...a),
    findMany: (...a: unknown[]) => lineFindMany(...a),
    findUniqueOrThrow: (...a: unknown[]) => lineFindUniqueOrThrow(...a),
    createMany: (...a: unknown[]) => lineCreateMany(...a),
  },
  partner: {
    findUnique: (...a: unknown[]) => partnerFindUnique(...a),
    update: (...a: unknown[]) => partnerUpdate(...a),
  },
  $transaction: async (cb: (tx: unknown) => unknown) => cb(db),
};

// 다른 모듈이 import 시점에 getPrisma 를 부를 수 있어 지연 참조로 둔다.
vi.mock("@/lib/prisma", () => ({ getPrisma: () => dbRef.current }));
const dbRef = vi.hoisted(() => ({ current: null as unknown }));
dbRef.current = db;

import { MonthlySettlementError, monthlySettlementService } from "../monthlySettlementService";

function campaignRow(monthly: boolean) {
  return {
    id: "c1",
    startDate: new Date("2026-09-27T15:00:00.000Z"),
    endDate: new Date("2026-10-03T15:00:00.000Z"),
    actualSales: 400_000,
    deal: { partner: { monthlySettlement: monthly } },
    orderCampaign: null,
  };
}

function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "l1",
    campaignId: "c1",
    yearMonth: "2026-09",
    periodStart: null,
    periodEnd: null,
    quantity: null,
    transactionAmount: null,
    commissionRate: null,
    commissionAmount: null,
    supplyAmount: null,
    vat: null,
    salesInvoiceIssuedAt: null,
    salesInvoiceNo: null,
    salesInvoiceItemName: null,
    purchaseInvoiceReceivedAt: null,
    goodsAmount: null,
    paymentAmount: null,
    paymentDueDate: null,
    paymentPaidAt: null,
    salesInvoiceCheckedAt: null,
    purchaseInvoiceCheckedAt: null,
    paymentScheduleCheckedAt: null,
    paymentCompletedCheckedAt: null,
    memo: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  campaignFindUnique.mockResolvedValue(campaignRow(true));
  lineFindMany.mockResolvedValue([]);
});

describe("줄 쓰기", () => {
  it("월정산이 아닌 거래처 캠페인에는 줄을 만들지 않는다(409)", async () => {
    campaignFindUnique.mockResolvedValue(campaignRow(false));
    await expect(monthlySettlementService.createLine("c1", { yearMonth: "2026-09" })).rejects.toMatchObject({
      status: 409,
    });
    expect(lineCreate).not.toHaveBeenCalled();
  });

  it("공급가액·세액은 수수료액에서 서버가 나누고, 캠페인 물품대금을 줄 합계로 맞춘다", async () => {
    lineCreate.mockResolvedValue(lineRow({ yearMonth: "2026-10", commissionAmount: 110_000 }));
    lineFindMany.mockResolvedValue([{ goodsAmount: 30_000 }, { goodsAmount: 20_000 }]);

    await monthlySettlementService.createLine("c1", {
      yearMonth: "2026-10",
      commissionAmount: 110_000,
      goodsAmount: 20_000,
      paymentDueDate: "2026-11-10",
    });

    const data = lineCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ campaignId: "c1", supplyAmount: 100_000, vat: 10_000, goodsAmount: 20_000 });
    expect(data.paymentDueDate).toEqual(new Date("2026-11-10"));
    expect(campaignUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { settlementGoodsCost: 50_000 },
    });
  });

  it("캠페인 기간 밖의 달은 만들지 않는다(409)", async () => {
    await expect(monthlySettlementService.createLine("c1", { yearMonth: "2026-11" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(monthlySettlementService.createLine("c1", { yearMonth: "2026-08" })).rejects.toMatchObject({
      status: 409,
    });
    expect(lineCreate).not.toHaveBeenCalled();
  });

  it("체크 칸만 바꾼 저장은 캠페인 물품대금을 다시 맞추지 않는다(수기 값 보호)", async () => {
    lineUpdateMany.mockResolvedValue({ count: 1 });
    lineFindUniqueOrThrow.mockResolvedValue(lineRow({ salesInvoiceCheckedAt: new Date("2026-10-08") }));
    await monthlySettlementService.updateLine("c1", "l1", { salesInvoiceCheckedAt: "2026-10-08" });
    expect(campaignUpdate).not.toHaveBeenCalled();
  });

  it("물품대금을 고친 저장은 롤업한다", async () => {
    lineUpdateMany.mockResolvedValue({ count: 1 });
    lineFindUniqueOrThrow.mockResolvedValue(lineRow({ goodsAmount: 70_000 }));
    lineFindMany.mockResolvedValue([{ goodsAmount: 70_000 }]);
    await monthlySettlementService.updateLine("c1", "l1", { goodsAmount: 70_000 });
    expect(campaignUpdate).toHaveBeenCalledWith({ where: { id: "c1" }, data: { settlementGoodsCost: 70_000 } });
  });

  it("빈 줄 추가는 롤업하지 않는다 — 기존 수기 물품대금을 null 로 덮지 않는다", async () => {
    lineCreate.mockResolvedValue(lineRow({ yearMonth: "2026-09" }));
    await monthlySettlementService.createLine("c1", { yearMonth: "2026-09" });
    expect(campaignUpdate).not.toHaveBeenCalled();
  });

  it("귀속 월을 기간 밖으로 바꾸는 수정도 거절한다(409)", async () => {
    await expect(monthlySettlementService.updateLine("c1", "l1", { yearMonth: "2026-12" })).rejects.toMatchObject({
      status: 409,
    });
    expect(lineUpdateMany).not.toHaveBeenCalled();
  });

  it("같은 달이 이미 있으면 409 문구로 돌려준다", async () => {
    lineCreate.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const error = await monthlySettlementService
      .createLine("c1", { yearMonth: "2026-09" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MonthlySettlementError);
    expect((error as MonthlySettlementError).status).toBe(409);
  });

  it("남의 캠페인 줄 id 로는 수정되지 않는다 — 소유 조건이 where 에 있고 0건이면 404", async () => {
    lineUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      monthlySettlementService.updateLine("c1", "other-line", { memo: "x" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(lineUpdateMany.mock.calls[0][0].where).toEqual({ id: "other-line", campaignId: "c1" });
    expect(campaignUpdate).not.toHaveBeenCalled();
  });

  it("줄을 지우면 남은 줄 합계로 물품대금을 다시 맞추고, 모두 비면 null(추정 상태)로 돌린다", async () => {
    lineDeleteMany.mockResolvedValue({ count: 1 });
    lineFindMany.mockResolvedValue([]);
    await monthlySettlementService.deleteLine("c1", "l1");
    expect(campaignUpdate).toHaveBeenCalledWith({ where: { id: "c1" }, data: { settlementGoodsCost: null } });
  });
});

describe("완료 게이트", () => {
  it("월정산 캠페인 중 4/4 가 아닌 달이 있는 캠페인만 사유와 함께 돌려준다", async () => {
    const done = {
      salesInvoiceCheckedAt: new Date(),
      purchaseInvoiceCheckedAt: new Date(),
      paymentScheduleCheckedAt: new Date(),
      paymentCompletedCheckedAt: new Date(),
    };
    campaignFindMany.mockResolvedValue([
      { id: "a", monthlySettlements: [lineRow({ yearMonth: "2026-09", ...done })] },
      { id: "b", monthlySettlements: [lineRow({ yearMonth: "2026-10" })] },
      { id: "c", monthlySettlements: [] },
    ]);
    const blocked = await monthlySettlementService.findCompletionBlockers(db as never, ["a", "b", "c", "d"]);
    expect([...blocked.keys()]).toEqual(["b", "c"]);
    expect(blocked.get("b")).toContain("10월분(0/4)");
    // 월정산 거래처만 조회한다 — 「d」(월정산 아님)는 조회 결과에 없어 통과다.
    expect(campaignFindMany.mock.calls[0][0].where.deal).toEqual({ partner: { monthlySettlement: true } });
  });

  it("빈 목록이면 DB 를 부르지 않는다", async () => {
    const blocked = await monthlySettlementService.findCompletionBlockers(db as never, []);
    expect(blocked.size).toBe(0);
    expect(campaignFindMany).not.toHaveBeenCalled();
  });
});

describe("거래처 월정산 켜기 = 기존 캠페인 이전", () => {
  const groupedCampaign = {
    id: "g-member",
    groupId: "g1",
    startDate: new Date("2026-09-13T15:00:00.000Z"),
    endDate: new Date("2026-09-19T15:00:00.000Z"),
    salesChannel: "OWN_MALL_NAVER",
    quantity: 5,
    actualSales: 100_000,
    totalMarginRate: 45,
    settlementSales: 45_000,
    settlementGoodsCost: 50_000,
    // 멤버 행의 날짜는 낡았다 — 그룹 값이 정본이다(CG-1).
    supplierInvoiceIssuedAt: null,
    expectedDepositDate: null,
    depositReceivedAt: null,
    isDepositReceived: false,
    expectedPayoutDate: null,
    payoutCompletedAt: null,
    isPayoutCompleted: false,
    expectedSupplierPayoutDate: null,
    supplierPayoutCompletedAt: null,
    isSupplierPayoutCompleted: false,
    group: {
      supplierInvoiceIssuedAt: new Date("2026-09-30T00:00:00.000Z"),
      expectedDepositDate: null,
      depositReceivedAt: null,
      isDepositReceived: false,
      expectedPayoutDate: null,
      payoutCompletedAt: null,
      isPayoutCompleted: false,
      expectedSupplierPayoutDate: new Date("2026-10-10T00:00:00.000Z"),
      supplierPayoutCompletedAt: null,
      isSupplierPayoutCompleted: false,
    },
  };

  it("켜면 드랍·기존 줄을 뺀 캠페인에 1줄씩 만들고, 그룹 소속이면 그룹 날짜를 옮긴다", async () => {
    partnerFindUnique.mockResolvedValue({ id: "p1" });
    campaignFindMany.mockResolvedValue([groupedCampaign]);

    const result = await monthlySettlementService.setPartnerMonthlySettlement("p1", true, new Date("2026-10-08T00:00:00Z"));

    expect(result).toEqual({ enabled: true, createdLines: 1 });
    expect(partnerUpdate).toHaveBeenCalledWith({ where: { id: "p1" }, data: { monthlySettlement: true } });
    expect(campaignFindMany.mock.calls[0][0].where).toEqual({
      deal: { partnerId: "p1" },
      status: { not: "DROPPED" },
      monthlySettlements: { none: {} },
    });
    const [row] = lineCreateMany.mock.calls[0][0].data;
    expect(row).toMatchObject({
      campaignId: "g-member",
      yearMonth: "2026-09",
      goodsAmount: 50_000,
      transactionAmount: 100_000,
      commissionRate: 45,
    });
    expect(row.purchaseInvoiceReceivedAt).toEqual(new Date("2026-09-30T00:00:00.000Z"));
    expect(row.paymentDueDate).toEqual(new Date("2026-10-10T00:00:00.000Z"));
    // 이전은 캠페인 값을 건드리지 않는다(주문수량·거래액 수정 금지 · 물품대금은 이미 같은 값).
    expect(campaignUpdate).not.toHaveBeenCalled();
  });

  it("끄면 플래그만 내리고 줄은 보관한다(비파괴)", async () => {
    partnerFindUnique.mockResolvedValue({ id: "p1" });
    const result = await monthlySettlementService.setPartnerMonthlySettlement("p1", false);
    expect(result).toEqual({ enabled: false, createdLines: 0 });
    expect(lineDeleteMany).not.toHaveBeenCalled();
    expect(lineCreateMany).not.toHaveBeenCalled();
  });

  it("없는 거래처는 404", async () => {
    partnerFindUnique.mockResolvedValue(null);
    await expect(monthlySettlementService.setPartnerMonthlySettlement("nope", true)).rejects.toMatchObject({
      status: 404,
    });
  });
});
