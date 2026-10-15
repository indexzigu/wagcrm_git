/**
 * `upsert_product_mappings` WRITE 액션 — 가드 계약(가짜 tx).
 *
 * 고정하는 것:
 *  ⓪ 사람 승인만 — 시스템 실행자·봇 실행자는 DB 를 읽기 전에 거부.
 *  ⓪' 승인 시점 캠페인 이름이 기안 때와 다르면 쓰지 않는다.
 *  ⓐ 캠페인이 없으면 실패. ⓑ 계획이 거절되면(줄 하나라도) 아무것도 쓰지 않는다.
 *  ⓒ 새 줄은 create, 고칠 줄은 update — `campaignDealId` 는 건드리지 않고 deleteMany 는 부르지 않는다.
 *  ⓓ 결과 요약 문구 + 새로 만든 줄 수(`createdCount` — 후속 자동 연결을 돌릴지 정한다).
 *  ⓔ 고칠 줄은 조건부 쓰기(id + 기안 때 코드·가격) — 승인 중에 값이 바뀌면 count 0 으로 실패.
 *  ⓕ 주문캠페인 행 잠금(FOR UPDATE)을 매핑을 읽기 전에 건다(sqlite 에서는 구문이 없어 건너뛴다).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

let sqliteMode = false;
vi.mock("@/lib/prisma-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma-client")>();
  return { ...actual, isSqliteDatabaseUrl: () => sqliteMode };
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => {
    throw new Error("이 테스트는 주입한 tx 만 써야 한다");
  },
}));

const { executeWriteAction, resolveWriteActionEffects, WRITE_ACTIONS } = await import("../write-executor");

const campaignFindUniqueMock = vi.fn();
const mappingFindManyMock = vi.fn();
const mappingCreateMock = vi.fn();
const mappingUpdateMock = vi.fn();
const mappingUpdateManyMock = vi.fn();
const mappingDeleteManyMock = vi.fn();
const queryRawMock = vi.fn();

const tx = {
  $queryRaw: queryRawMock,
  orderCampaign: { findUnique: campaignFindUniqueMock },
  productMapping: {
    findMany: mappingFindManyMock,
    create: mappingCreateMock,
    update: mappingUpdateMock,
    updateMany: mappingUpdateManyMock,
    deleteMany: mappingDeleteManyMock,
  },
} as unknown as Prisma.TransactionClient;

const CAMPAIGN_ID = "cmtestordercampaign000000001";
const CAMPAIGN_NAME = "[샘플 공구] 테스트 기획전";

const newRow = {
  optionName: "샘플 상품 B 1개",
  brandCode: "TC000103",
  price: 12000,
  expectedBrandCode: null,
  expectedPrice: null,
};
const updateRow = {
  optionName: "샘플 상품 A 3개",
  productName: "샘플 상품 A",
  brandCode: "TC000102",
  price: 20000,
  expectedBrandCode: "TC000101",
  expectedPrice: 15000,
};
const sameRow = {
  optionName: "샘플 상품 C 2개",
  brandCode: "TC0099",
  price: 8000,
  expectedBrandCode: "TC0099",
  expectedPrice: 8000,
};
const args = {
  orderCampaignId: CAMPAIGN_ID,
  orderCampaignName: CAMPAIGN_NAME,
  mappings: [newRow, updateRow, sameRow],
};

const existingRows = [
  { id: "pm-1", optionName: "샘플 상품 A  3개", productName: "샘플 상품 A 기본", brandCode: "TC000101", price: 15000 },
  { id: "pm-2", optionName: "샘플 상품 C 2개", productName: "", brandCode: "TC0099", price: 8000 },
];

beforeEach(() => {
  for (const mock of [
    campaignFindUniqueMock,
    mappingFindManyMock,
    mappingCreateMock,
    mappingUpdateMock,
    mappingUpdateManyMock,
    mappingDeleteManyMock,
    queryRawMock,
  ]) {
    mock.mockReset();
  }
  sqliteMode = false;
  queryRawMock.mockResolvedValue([{ "?column?": 1 }]);
  campaignFindUniqueMock.mockResolvedValue({ id: CAMPAIGN_ID, name: CAMPAIGN_NAME });
  mappingFindManyMock.mockResolvedValue(existingRows);
  mappingCreateMock.mockResolvedValue({ id: "pm-new" });
  mappingUpdateMock.mockResolvedValue({ id: "pm-1" });
  mappingUpdateManyMock.mockResolvedValue({ count: 1 });
});

function expectNoWrites() {
  expect(mappingCreateMock).not.toHaveBeenCalled();
  expect(mappingUpdateMock).not.toHaveBeenCalled();
  expect(mappingUpdateManyMock).not.toHaveBeenCalled();
  expect(mappingDeleteManyMock).not.toHaveBeenCalled();
}

describe("upsert_product_mappings 실행기", () => {
  it("is registered in WRITE_ACTIONS", () => {
    expect(Object.hasOwn(WRITE_ACTIONS, "upsert_product_mappings")).toBe(true);
  });

  it.each(["AGENT_WORKER", "SYSTEM_AUTO", "SYSTEM_SETTLEMENT_AUTO"])(
    "refuses an automated actor (%s) before touching the database",
    async (actor) => {
      await expect(executeWriteAction("upsert_product_mappings", args, actor, tx)).rejects.toThrow(
        /사람이 결재함에서 승인해야/,
      );
      expect(campaignFindUniqueMock).not.toHaveBeenCalled();
      expect(mappingFindManyMock).not.toHaveBeenCalled();
      expect(queryRawMock).not.toHaveBeenCalled();
      expectNoWrites();
    },
  );

  it("refuses when the campaign name differs from the proposal (no writes)", async () => {
    campaignFindUniqueMock.mockResolvedValue({ id: CAMPAIGN_ID, name: "[샘플 공구] 다른 기획전" });
    await expect(executeWriteAction("upsert_product_mappings", args, "owner", tx)).rejects.toThrow(
      "주문캠페인 이름이 기안 때와 다릅니다(지금 「[샘플 공구] 다른 기획전」)",
    );
    expectNoWrites();
  });

  it("does not refuse when the stored campaign name is NFD and the proposed name is NFC", async () => {
    campaignFindUniqueMock.mockResolvedValue({ id: CAMPAIGN_ID, name: CAMPAIGN_NAME.normalize("NFD") });
    await expect(executeWriteAction("upsert_product_mappings", args, "owner", tx)).resolves.toBeDefined();
  });

  it("still refuses a genuinely different name even when it is NFD", async () => {
    campaignFindUniqueMock.mockResolvedValue({ id: CAMPAIGN_ID, name: "[샘플 공구] 다른 기획전".normalize("NFD") });
    await expect(executeWriteAction("upsert_product_mappings", args, "owner", tx)).rejects.toThrow(
      /주문캠페인 이름이 기안 때와 다릅니다/,
    );
    expectNoWrites();
  });

  it("fails cleanly when the order campaign is gone", async () => {
    campaignFindUniqueMock.mockResolvedValue(null);
    await expect(executeWriteAction("upsert_product_mappings", args, "owner", tx)).rejects.toThrow(
      `주문캠페인(${CAMPAIGN_ID})을 찾을 수 없습니다`,
    );
    expect(campaignFindUniqueMock).toHaveBeenCalledWith({ where: { id: CAMPAIGN_ID }, select: { id: true, name: true } });
    expectNoWrites();
  });

  it("throws the plan's reason and writes nothing when any row is refused", async () => {
    mappingFindManyMock.mockResolvedValue([{ ...existingRows[0], price: 14000 }, existingRows[1]]);
    await expect(executeWriteAction("upsert_product_mappings", args, "owner", tx)).rejects.toThrow(
      "「샘플 상품 A 3개」 지금 값(TC000101/14,000원)이 기안 때(TC000101/15,000원)와 다릅니다.",
    );
    expectNoWrites();
  });

  it("creates new rows and updates changed rows without touching campaignDealId or deleting anything", async () => {
    const result = await executeWriteAction("upsert_product_mappings", args, "owner", tx);

    expect(mappingFindManyMock).toHaveBeenCalledWith({
      where: { campaignId: CAMPAIGN_ID },
      select: { id: true, optionName: true, productName: true, brandCode: true, price: true },
    });
    expect(mappingCreateMock).toHaveBeenCalledTimes(1);
    expect(mappingCreateMock).toHaveBeenCalledWith({
      data: { campaignId: CAMPAIGN_ID, optionName: "샘플 상품 B 1개", productName: "", brandCode: "TC000103", price: 12000 },
    });
    expect(mappingUpdateMock).not.toHaveBeenCalled();
    expect(mappingUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(mappingUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "pm-1", brandCode: "TC000101", price: 15000 },
      data: { brandCode: "TC000102", price: 20000, productName: "샘플 상품 A" },
    });
    for (const [call] of [...mappingCreateMock.mock.calls, ...mappingUpdateManyMock.mock.calls]) {
      expect(call.data).not.toHaveProperty("campaignDealId");
    }
    expect(mappingDeleteManyMock).not.toHaveBeenCalled();

    expect(result).toEqual({
      refType: "ORDER_CAMPAIGN",
      refId: CAMPAIGN_ID,
      summary: `주문캠페인 "${CAMPAIGN_NAME}" 상품 매핑: 새로 1줄 · 바꿈 1줄 · 그대로 1줄`,
      createdCount: 1,
    });
  });

  it("reports createdCount 0 when the proposal only updates existing rows", async () => {
    const result = await executeWriteAction("upsert_product_mappings", { ...args, mappings: [updateRow] }, "owner", tx);
    expect(result.createdCount).toBe(0);
    expect(mappingCreateMock).not.toHaveBeenCalled();
  });

  it("fails without further writes when a conditional update matches no row (value changed during approval)", async () => {
    mappingUpdateManyMock.mockResolvedValue({ count: 0 });
    await expect(executeWriteAction("upsert_product_mappings", args, "owner", tx)).rejects.toThrow(
      "「샘플 상품 A 3개」 지금 값이 승인 중에 바뀌었습니다. 다시 올려 주세요.",
    );
    expect(mappingUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(mappingCreateMock).not.toHaveBeenCalled();
    expect(mappingUpdateMock).not.toHaveBeenCalled();
    expect(mappingDeleteManyMock).not.toHaveBeenCalled();
  });

  it("locks the order campaign row (parameterized FOR UPDATE) before reading the mappings", async () => {
    await executeWriteAction("upsert_product_mappings", args, "owner", tx);
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRawMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("$")).toBe('SELECT 1 FROM "OrderCampaign" WHERE id = $ FOR UPDATE');
    expect(values).toEqual([CAMPAIGN_ID]);
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(mappingFindManyMock.mock.invocationCallOrder[0]);
  });

  it("skips the row lock on sqlite (no FOR UPDATE syntax) and still writes", async () => {
    sqliteMode = true;
    await executeWriteAction("upsert_product_mappings", args, "owner", tx);
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(mappingUpdateManyMock).toHaveBeenCalledTimes(1);
  });

  it("leaves productName out of the update when the proposal did not set it", async () => {
    const { productName: _omit, ...withoutProductName } = updateRow;
    await executeWriteAction("upsert_product_mappings", { ...args, mappings: [withoutProductName] }, "owner", tx);
    expect(mappingUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "pm-1", brandCode: "TC000101", price: 15000 },
      data: { brandCode: "TC000102", price: 20000 },
    });
  });

  it("effects: no cache tags (the screen-save route invalidates none), no calendar resync, auto-link target = the order campaign when rows were created", () => {
    expect(
      resolveWriteActionEffects("upsert_product_mappings", {
        refType: "ORDER_CAMPAIGN",
        refId: CAMPAIGN_ID,
        summary: "",
        createdCount: 2,
      }),
    ).toEqual({ revalidate: [], calendarCampaignId: null, autoMapOrderCampaignId: CAMPAIGN_ID });
  });

  it("effects: no auto-link when the proposal created no rows (updates keep campaignDealId)", () => {
    const spec = resolveWriteActionEffects("upsert_product_mappings", {
      refType: "ORDER_CAMPAIGN",
      refId: CAMPAIGN_ID,
      summary: "",
      createdCount: 0,
    });
    expect(spec).toEqual({ revalidate: [], calendarCampaignId: null });
    expect(spec).not.toHaveProperty("autoMapOrderCampaignId");
  });
});
