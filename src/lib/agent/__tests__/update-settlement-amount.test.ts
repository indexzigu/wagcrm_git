/**
 * `update_settlement_amount` WRITE 액션 — 가드 계약.
 *
 * 고정하는 것(가드 순서대로):
 *  ① 정산 확정 거부 — 채널의 대금 칸 중 하나라도 확정이면 거부. 묶음이면 **묶음 스칼라**가 정본.
 *  ② 현재 값 대조 — Decimal 비교, `null` 과 `0` 은 다르다.
 *  ③ 조건부 쓰기 — where 에 칸 값·확정 표시·묶음 소속·updatedAt, count 0 이면 거부.
 *  그리고 수동 고정 플래그 · 파생 재계산(정본 PATCH 와 같은 함수) · 감사 기록(메모 포함).
 *
 * 파생 계산은 **모킹하지 않는다** — 실제 `deriveCampaignFinancialsForUpdate` 를 태워 「같은 함수가
 * 같은 값을 낸다」를 본다. tx 는 그 함수가 읽는 `campaignDeal.findMany` 까지만 흉내 낸다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordActivityChangeMock = vi.fn();

vi.mock("@/lib/activity-log", () => ({
  recordActivityChange: (...args: unknown[]) => recordActivityChangeMock(...args),
  recordActivityMemo: vi.fn(),
  recordActivityCreate: vi.fn(),
}));

// 다른 액션이 끌고 오는 모듈 — 이 파일의 경로에서는 부르지 않는다.
vi.mock("@/services/campaignInvoiceService", () => ({ campaignInvoiceService: {} }));
// 파생 함수는 **실물을 그대로 통과**시킨다 — 사후 조건 테스트 한 건만 반환값을 바꿔 끼운다.
vi.mock("@/services/campaignFinancialDerivation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/campaignFinancialDerivation")>();
  return { ...actual, deriveCampaignFinancialsForUpdate: vi.fn(actual.deriveCampaignFinancialsForUpdate) };
});
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => {
    throw new Error("이 테스트는 주입한 tx 만 써야 한다");
  },
}));

const { executeWriteAction, resolveWriteActionEffects } = await import("../write-executor");
const { deriveCampaignFinancialsForUpdate } = await import("@/services/campaignFinancialDerivation");
const { resolveCampaignMoneySlots } = await import("@/lib/tax-filing-board");
const { CAMPAIGN_INVALIDATION_TAGS } = await import("@/lib/cache-tags");

const dec = (value: string | number) => new Prisma.Decimal(value);
const UPDATED_AT = new Date("2026-10-01T00:00:00.000Z");

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "camp-1",
    status: "SETTLEMENT_WAIT",
    salesChannel: "BRAND_MALL",
    groupId: null,
    group: null,
    updatedAt: UPDATED_AT,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    actualSales: dec("1000000"),
    settlementSales: dec("300000"),
    sellerExpense: dec("100000"),
    taxExpense: dec("18182"),
    operatingExpense: dec("5000"),
    miscExpense: dec("1000"),
    settlementSupplyCost: null,
    settlementGoodsCost: null,
    operatingProfit: dec("175818"),
    totalMarginRate: dec("30"),
    sellerMarginRate: dec("10"),
    netMarginRate: dec("20"),
    isManualSettlementSales: false,
    isManualSellerExpense: false,
    isManualTaxExpense: false,
    sellerTaxType: null,
    sellerFeeBasisOverride: null,
    seller: { agency: { businessNumber: "1234567890" } },
    ...overrides,
  };
}

const findUniqueMock = vi.fn();
const updateManyMock = vi.fn();
const dealFindManyMock = vi.fn();
const dealCountMock = vi.fn();
const groupFindUniqueMock = vi.fn();
const groupUpdateManyMock = vi.fn();
const executeRawMock = vi.fn();
const tx = {
  salesCampaign: { findUnique: findUniqueMock, updateMany: updateManyMock },
  campaignDeal: { findMany: dealFindManyMock, count: dealCountMock },
  campaignGroup: { findUnique: groupFindUniqueMock, updateMany: groupUpdateManyMock },
  // 그룹 락(`acquireGroupLock`)은 sqlite 면 건너뛰고 아니면 advisory 락을 건다 — 어느 쪽이든 통과한다.
  $executeRaw: executeRawMock,
} as unknown as Prisma.TransactionClient;

const GROUP = { id: "group-1", sellerId: "seller-1" };

function run(args: Record<string, unknown>) {
  return executeWriteAction("update_settlement_amount", args, "approver-1", tx);
}

function writeCall() {
  expect(updateManyMock).toHaveBeenCalledTimes(1);
  return updateManyMock.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
}

beforeEach(() => {
  findUniqueMock.mockReset();
  updateManyMock.mockReset();
  dealFindManyMock.mockReset();
  dealCountMock.mockReset();
  groupFindUniqueMock.mockReset();
  groupUpdateManyMock.mockReset();
  executeRawMock.mockReset();
  recordActivityChangeMock.mockReset();
  dealFindManyMock.mockResolvedValue([]);
  dealCountMock.mockResolvedValue(0);
  groupFindUniqueMock.mockResolvedValue(GROUP);
  groupUpdateManyMock.mockResolvedValue({ count: 1 });
  executeRawMock.mockResolvedValue(0);
  updateManyMock.mockResolvedValue({ count: 1 });
  recordActivityChangeMock.mockResolvedValue({ id: "log" });
});

describe("① 정산 확정 거부", () => {
  it("채널의 대금 칸 하나라도 확정이면 쓰지 않는다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow({ isDepositReceived: true }));

    await expect(
      run({ campaignId: "camp-1", field: "operatingExpense", expectedCurrentKrw: 5000, newAmountKrw: 7000 }),
    ).rejects.toThrow(/정산 금액 수정 불가: 이미 정산이 확정된 캠페인/);

    expect(updateManyMock).not.toHaveBeenCalled();
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("묶음 캠페인은 묶음 스칼라가 정본이다 — 멤버 행이 false 여도 묶음이 확정이면 거부한다", async () => {
    findUniqueMock.mockResolvedValue(
      campaignRow({
        groupId: "group-1",
        group: { id: "group-1", isDepositReceived: false, isPayoutCompleted: true, isSupplierPayoutCompleted: false },
      }),
    );

    await expect(
      run({ campaignId: "camp-1", field: "miscExpense", expectedCurrentKrw: 1000, newAmountKrw: 0 }),
    ).rejects.toThrow(/묶음 캠페인 기준/);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("캠페인을 묶음·셀러 사업자번호와 함께 읽는다(묶음이 빠지면 낡은 멤버 플래그로 판정하게 된다)", async () => {
    findUniqueMock.mockResolvedValue(campaignRow());

    await run({ campaignId: "camp-1", field: "miscExpense", expectedCurrentKrw: 1000, newAmountKrw: 0 });

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      include: {
        group: true,
        seller: { select: { agency: { select: { businessNumber: true } } } },
      },
    });
  });

  it("묶음이 미확정이면 멤버 행의 낡은 true 는 거부 사유가 아니고, 쓰기 조건은 묶음 쪽에 건다", async () => {
    findUniqueMock.mockResolvedValue(
      campaignRow({
        groupId: "group-1",
        isDepositReceived: true, // 낡은 멤버 값(CG-1)
        group: { id: "group-1", isDepositReceived: false, isPayoutCompleted: false, isSupplierPayoutCompleted: false },
      }),
    );

    await run({ campaignId: "camp-1", field: "miscExpense", expectedCurrentKrw: 1000, newAmountKrw: 0 });

    const { where } = writeCall();
    const slotFlags = Object.fromEntries(
      resolveCampaignMoneySlots("BRAND_MALL").map((slot) => [slot.flagField, false]),
    );
    expect(where.group).toEqual({ is: slotFlags });
    expect(where.groupId).toBe("group-1");
    expect(where).not.toHaveProperty("isDepositReceived");

    // 묶음 행 자체를 잠그며 다시 확인한다: 그룹 락(셀러 단위) → 묶음 행 조건부 갱신 → 멤버 행 쓰기.
    expect(groupFindUniqueMock).toHaveBeenCalledWith({ where: { id: "group-1" }, select: { id: true, sellerId: true } });
    expect(groupUpdateManyMock).toHaveBeenCalledTimes(1);
    const guard = groupUpdateManyMock.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(guard.where).toEqual({ id: "group-1", members: { some: { id: "camp-1" } }, ...slotFlags });
    expect(Object.keys(guard.data)).toEqual(["updatedAt"]);
    expect(groupUpdateManyMock.mock.invocationCallOrder[0]).toBeLessThan(updateManyMock.mock.invocationCallOrder[0]);
  });

  it("읽은 뒤 묶음이 먼저 확정됐거나 묶음에서 빠졌으면(묶음 행 갱신 count 0) 멤버 행을 쓰지 않는다", async () => {
    findUniqueMock.mockResolvedValue(
      campaignRow({
        groupId: "group-1",
        group: { id: "group-1", isDepositReceived: false, isPayoutCompleted: false, isSupplierPayoutCompleted: false },
      }),
    );
    groupUpdateManyMock.mockResolvedValue({ count: 0 });

    await expect(
      run({ campaignId: "camp-1", field: "miscExpense", expectedCurrentKrw: 1000, newAmountKrw: 0 }),
    ).rejects.toThrow(/묶음 캠페인의 정산이 확정되었거나 묶음 구성이 바뀌었습니다/);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("묶음이 아니면 묶음 행·그룹 락을 건드리지 않는다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow());

    await run({ campaignId: "camp-1", field: "miscExpense", expectedCurrentKrw: 1000, newAmountKrw: 0 });

    expect(groupUpdateManyMock).not.toHaveBeenCalled();
    expect(groupFindUniqueMock).not.toHaveBeenCalled();
  });

  it("그 채널에 없는 대금 칸의 플래그는 보지 않는다(판정 축은 채널 슬롯)", async () => {
    const slotFlags = resolveCampaignMoneySlots("BRAND_MALL").map((slot) => slot.flagField);
    expect(slotFlags).not.toContain("isSupplierPayoutCompleted"); // 전제 확인
    findUniqueMock.mockResolvedValue(campaignRow({ isSupplierPayoutCompleted: true }));

    await run({ campaignId: "camp-1", field: "miscExpense", expectedCurrentKrw: 1000, newAmountKrw: 2000 });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });
});

describe("② 현재 값 대조 (Decimal 비교, null ≠ 0)", () => {
  it("현재 값이 기안 값과 다르면 거부하고 두 값을 말해 준다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow({ settlementSales: dec("310000") }));

    await expect(
      run({ campaignId: "camp-1", field: "settlementSales", expectedCurrentKrw: 300000, newAmountKrw: 350000 }),
    ).rejects.toThrow(/기안: 300,000원 · 현재: 310,000원/);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("저장값이 0 인데 기안이 null(비어 있음)이면 거부한다 — 물품대금 0 은 합산 이관 표시다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow({ settlementGoodsCost: dec("0") }));

    await expect(
      run({ campaignId: "camp-1", field: "settlementGoodsCost", expectedCurrentKrw: null, newAmountKrw: 500000 }),
    ).rejects.toThrow(/기안: 비어 있음 · 현재: 0원/);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("저장값이 비어 있는데(null) 기안이 0 이면 거부한다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow({ settlementGoodsCost: null }));

    await expect(
      run({ campaignId: "camp-1", field: "settlementGoodsCost", expectedCurrentKrw: 0, newAmountKrw: 500000 }),
    ).rejects.toThrow(/기안: 0원 · 현재: 비어 있음/);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("비어 있음(null) → 값: 쓰기 조건에도 null 을 그대로 건다(0 으로 접지 않는다)", async () => {
    findUniqueMock.mockResolvedValue(campaignRow({ settlementGoodsCost: null }));

    await run({ campaignId: "camp-1", field: "settlementGoodsCost", expectedCurrentKrw: null, newAmountKrw: 0 });

    const { where, data } = writeCall();
    expect(where.settlementGoodsCost).toBeNull();
    expect(data.settlementGoodsCost).toBe(0);
  });

  it("소수 자릿수 표기가 달라도 같은 금액이면 통과한다(Decimal 비교)", async () => {
    findUniqueMock.mockResolvedValue(campaignRow({ settlementSupplyCost: dec("1200000.00") }));

    await run({ campaignId: "camp-1", field: "settlementSupplyCost", expectedCurrentKrw: 1200000, newAmountKrw: 1350000 });
    expect(writeCall().data.settlementSupplyCost).toBe(1350000);
  });
});

describe("③ 조건부 쓰기", () => {
  it("where 에 칸 값·확정 표시·묶음 소속·updatedAt 을 함께 건다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow());

    await run({ campaignId: "camp-1", field: "operatingExpense", expectedCurrentKrw: 5000, newAmountKrw: -20000 });

    const slotFlags = Object.fromEntries(
      resolveCampaignMoneySlots("BRAND_MALL").map((slot) => [slot.flagField, false]),
    );
    expect(writeCall().where).toEqual({
      id: "camp-1",
      updatedAt: UPDATED_AT,
      groupId: null,
      operatingExpense: 5000,
      ...slotFlags,
    });
  });

  it("읽은 뒤 남이 먼저 고쳤으면(count 0) 덮어쓰지 않고 실패한다 — 감사 기록도 남기지 않는다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow());
    updateManyMock.mockResolvedValue({ count: 0 });

    await expect(
      run({ campaignId: "camp-1", field: "operatingExpense", expectedCurrentKrw: 5000, newAmountKrw: 7000 }),
    ).rejects.toThrow(/다른 수정이나 정산 확정이 먼저 반영/);
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("없는 캠페인이면 쓰지 않는다", async () => {
    findUniqueMock.mockResolvedValue(null);

    await expect(
      run({ campaignId: "ghost", field: "operatingExpense", expectedCurrentKrw: 0, newAmountKrw: 1 }),
    ).rejects.toThrow(/찾을 수 없/);
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

describe("수동 고정 플래그", () => {
  it.each([
    ["settlementSales", "isManualSettlementSales", 300000, 350000],
    ["sellerExpense", "isManualSellerExpense", 100000, 90000],
    ["taxExpense", "isManualTaxExpense", 18182, 20000],
  ] as const)("%s 를 고치면 %s 를 켜고, 재계산 뒤에도 승인한 값이 그대로 저장된다", async (field, flag, before, after) => {
    findUniqueMock.mockResolvedValue(campaignRow());

    const result = await run({ campaignId: "camp-1", field, expectedCurrentKrw: before, newAmountKrw: after });

    const { data } = writeCall();
    expect(data[field]).toBe(after);
    expect(data[flag]).toBe(true);
    // 플래그 전환도 감사 기록에 남는다(자동 계산이 더는 이 칸을 덮지 않는다는 사실).
    expect(recordActivityChangeMock).toHaveBeenCalledWith("CAMPAIGN", "camp-1", flag, false, true, "approver-1", tx);
    expect(result.summary).toContain("자동 계산 → 수동 고정");
  });

  it("이미 수동인 칸은 플래그 전환 기록을 다시 남기지 않는다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow({ isManualSellerExpense: true }));

    await run({ campaignId: "camp-1", field: "sellerExpense", expectedCurrentKrw: 100000, newAmountKrw: 90000 });

    expect(recordActivityChangeMock).toHaveBeenCalledTimes(1);
  });

  it.each(["actualSales", "operatingExpense", "miscExpense", "settlementSupplyCost", "settlementGoodsCost"] as const)(
    "%s 는 자동 재계산 대상이 아니라 수동 플래그를 건드리지 않는다",
    async (field) => {
      findUniqueMock.mockResolvedValue(campaignRow({ settlementSupplyCost: dec("0"), settlementGoodsCost: dec("0") }));
      const before = { actualSales: 1000000, operatingExpense: 5000, miscExpense: 1000 }[field as string] ?? 0;

      await run({ campaignId: "camp-1", field, expectedCurrentKrw: before, newAmountKrw: 1234 });

      const { data } = writeCall();
      expect(data).not.toHaveProperty("isManualSettlementSales");
      expect(data).not.toHaveProperty("isManualSellerExpense");
      expect(data).not.toHaveProperty("isManualTaxExpense");
    },
  );
});

describe("파생 재계산 — 정본 PATCH 와 같은 함수", () => {
  it("운영 비용을 바꾸면 영업이익이 다시 계산되고, 그 값은 PATCH 가 부르는 함수의 결과와 같다", async () => {
    const row = campaignRow();
    findUniqueMock.mockResolvedValue(row);

    const result = await run({
      campaignId: "camp-1",
      field: "operatingExpense",
      expectedCurrentKrw: 5000,
      newAmountKrw: -20000,
    });

    const expected = await deriveCampaignFinancialsForUpdate(tx, {
      id: "camp-1",
      data: { operatingExpense: -20000 },
      previous: row,
    });
    const { data } = writeCall();
    expect(data).toMatchObject({ ...expected.derivedFinancials, netMarginRate: expected.nextNetMarginRate });
    expect(data.operatingProfit).not.toBe(175818);
    expect(result.summary).toMatch(/영업이익 175,818원 → /);
  });

  it("총 거래액을 바꾸면 그 값으로 파생이 다시 돈다(품목 행도 같은 tx 에서 읽는다)", async () => {
    const row = campaignRow();
    findUniqueMock.mockResolvedValue(row);

    await run({ campaignId: "camp-1", field: "actualSales", expectedCurrentKrw: 1000000, newAmountKrw: 2000000 });

    const expected = await deriveCampaignFinancialsForUpdate(tx, {
      id: "camp-1",
      data: { actualSales: 2000000 },
      previous: row,
    });
    expect(writeCall().data).toMatchObject({ actualSales: 2000000, ...expected.derivedFinancials });
    expect(dealFindManyMock).toHaveBeenCalledWith({ where: { campaignId: "camp-1" } });
  });

  it("품목이 있는 캠페인의 총 거래액은 고치지 않는다 — 품목 합계가 정본이다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow());
    dealCountMock.mockResolvedValue(2);

    await expect(
      run({ campaignId: "camp-1", field: "actualSales", expectedCurrentKrw: 1000000, newAmountKrw: 2000000 }),
    ).rejects.toThrow(/품목이 2개 있는 캠페인의 총 거래액은 품목 합계에서 정해집니다/);
    expect(dealCountMock).toHaveBeenCalledWith({ where: { campaignId: "camp-1" } });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("재계산 결과가 승인한 값과 다르면(수동 층위 규칙이 바뀐 경우) 쓰지 않는다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow());
    vi.mocked(deriveCampaignFinancialsForUpdate).mockResolvedValueOnce({
      derivedFinancials: { settlementSales: 999, sellerExpense: 100000, taxExpense: 18182, operatingProfit: 1 },
      nextNetMarginRate: 20,
    });

    await expect(
      run({ campaignId: "camp-1", field: "settlementSales", expectedCurrentKrw: 300000, newAmountKrw: 350000 }),
    ).rejects.toThrow(/재계산 결과\(999원\)가 승인할 영업 수익 350,000원와 다릅니다/);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("재계산으로 함께 바뀐 자동 칸도 결과 요약에 적는다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow());
    vi.mocked(deriveCampaignFinancialsForUpdate).mockResolvedValueOnce({
      derivedFinancials: { settlementSales: 310000, sellerExpense: 100000, taxExpense: 19091, operatingProfit: 184909 },
      nextNetMarginRate: 20,
    });

    const result = await run({ campaignId: "camp-1", field: "miscExpense", expectedCurrentKrw: 1000, newAmountKrw: 1000 });

    expect(result.summary).toBe(
      "정산 금액 수정: 기타 조정 비용 1,000원 → 1,000원 · 영업 수익 300,000원 → 310,000원 · " +
        "제세공과금 18,182원 → 19,091원 · 영업이익 175,818원 → 184,909원",
    );
  });

  it("캠페인 PATCH 본체도 같은 함수를 부른다(산식 사본이 다시 생기지 않았는지)", () => {
    const source = readFileSync(join(process.cwd(), "src/services/campaignService.ts"), "utf8");
    expect(source).toMatch(/await deriveCampaignFinancialsForUpdate\(tx,/);
    expect(source).not.toMatch(/calculateDerivedCampaignFinancials\(/);
  });
});

describe("감사 기록 · 결과 · 후속 처리", () => {
  it("CHANGE 한 건에 칸 이름·이전 값·새 값·승인자·메모를 남긴다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow());

    const result = await run({
      campaignId: "camp-1",
      field: "miscExpense",
      expectedCurrentKrw: 1000,
      newAmountKrw: -3000,
      memo: "반품 조정분 차감",
    });

    expect(recordActivityChangeMock).toHaveBeenCalledWith(
      "CAMPAIGN",
      "camp-1",
      "miscExpense",
      "1000",
      "-3000",
      "approver-1",
      tx,
      "반품 조정분 차감",
    );
    expect(result).toMatchObject({ refType: "CAMPAIGN", refId: "camp-1" });
    expect(result.summary).toMatch(/^정산 금액 수정: 기타 조정 비용 1,000원 → -3,000원/);
  });

  it("메모가 없으면 content 는 null 이다", async () => {
    findUniqueMock.mockResolvedValue(campaignRow());

    await run({ campaignId: "camp-1", field: "miscExpense", expectedCurrentKrw: 1000, newAmountKrw: 0 });

    expect(recordActivityChangeMock.mock.calls[0][7]).toBeNull();
  });

  it("후속 처리: 캠페인 캐시 태그 무효화 + 대금 일정 캘린더 재동기화", () => {
    expect(resolveWriteActionEffects("update_settlement_amount", { refType: "CAMPAIGN", refId: "camp-1", summary: "" })).toEqual({
      revalidate: CAMPAIGN_INVALIDATION_TAGS,
      calendarCampaignId: "camp-1",
    });
  });
});

describe("승인 시점 args 재검증", () => {
  it.each([
    [{ field: "operatingProfit" }, "파생 칸"],
    [{ field: "settlementSales", newAmountKrw: -1 }, "음수 불가 칸"],
    [{ field: "operatingExpense", newAmountKrw: -1_000_000_000 }, "음수 하한 밖"],
    [{ field: "settlementSales", newAmountKrw: 1_000_000_000_000 }, "상한 밖"],
    [{ field: "settlementSales", newAmountKrw: 1.5 }, "정수 아님"],
    [{ extra: "x" }, "모르는 칸"],
  ])("%j (%s) 는 쓰기 전에 거부한다", async (patch, _reason) => {
    findUniqueMock.mockResolvedValue(campaignRow());

    await expect(
      run({ campaignId: "camp-1", field: "settlementSales", expectedCurrentKrw: 300000, newAmountKrw: 1, ...patch }),
    ).rejects.toThrow(/args 검증 실패/);
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});
