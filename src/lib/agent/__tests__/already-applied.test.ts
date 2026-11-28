/**
 * 실패한 기안의 「이미 반영됨」 판정 — 결재함 실패 탭이 종결 버튼과 함께 띄우는 배지의 근거.
 *
 * 고정하는 것:
 *  - 세 액션(confirm_settlement · update_record · update_settlement_amount)만 판정하고, 판정은
 *    **실행기와 같은 읽기·비교**를 쓴다(묶음이면 묶음 스칼라, 날짜는 KST 달력 날짜, 금액은 Decimal).
 *  - 바꿀 값이 **전부** 지금 값과 같을 때만 true. 하나라도 다르거나, 대상이 없거나, 모르는 액션이면 false.
 *  - 판정이 던지면 목록을 깨지 않고 false(로그는 남긴다).
 */
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => {
    throw new Error("이 테스트는 주입한 db 만 써야 한다");
  },
}));

const { detectAlreadyApplied } = await import("../already-applied");

const dec = (value: string | number) => new Prisma.Decimal(value);

type CampaignRow = Record<string, unknown>;

function fakeDb(campaign: CampaignRow | null) {
  return {
    salesCampaign: { findUnique: vi.fn(async () => campaign) },
    deal: { findUnique: vi.fn(async () => null) },
    partner: { findUnique: vi.fn(async () => null) },
    seller: { findUnique: vi.fn(async () => null) },
  } as unknown as Parameters<typeof detectAlreadyApplied>[1];
}

function campaign(overrides: CampaignRow = {}): CampaignRow {
  return {
    id: "camp-1",
    salesChannel: "BRAND_MALL",
    groupId: null,
    group: null,
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    notesFromImport: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    depositReceivedAt: null,
    payoutCompletedAt: null,
    sellerInvoiceIssuedAt: null,
    supplierInvoiceIssuedAt: null,
    settlementSales: dec("775710"),
    ...overrides,
  };
}

describe("detectAlreadyApplied", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("confirm_settlement", () => {
    const payload = { action: "confirm_settlement", args: { campaignId: "camp-1", target: "payout" } };

    it("지급 표시가 이미 켜져 있으면 반영됨", async () => {
      expect(await detectAlreadyApplied(payload, fakeDb(campaign({ isPayoutCompleted: true })))).toBe(true);
    });

    it("지급 표시가 꺼져 있으면 반영 안 됨", async () => {
      expect(await detectAlreadyApplied(payload, fakeDb(campaign()))).toBe(false);
    });

    it("묶음 캠페인은 묶음 스칼라가 정본이다 — 멤버 행 값이 낡아 있어도 묶음 값으로 판정", async () => {
      const grouped = campaign({
        groupId: "grp-1",
        isPayoutCompleted: false,
        group: { id: "grp-1", isDepositReceived: true, isPayoutCompleted: true, isSupplierPayoutCompleted: true },
      });
      expect(await detectAlreadyApplied(payload, fakeDb(grouped))).toBe(true);

      const staleMember = campaign({
        groupId: "grp-1",
        isPayoutCompleted: true,
        group: { id: "grp-1", isDepositReceived: true, isPayoutCompleted: false, isSupplierPayoutCompleted: false },
      });
      expect(await detectAlreadyApplied(payload, fakeDb(staleMember))).toBe(false);
    });

    it("입금 확정 기안은 입금 표시로 판정", async () => {
      const deposit = { action: "confirm_settlement", args: { campaignId: "camp-1", target: "deposit" } };
      expect(await detectAlreadyApplied(deposit, fakeDb(campaign({ isDepositReceived: true })))).toBe(true);
      expect(await detectAlreadyApplied(deposit, fakeDb(campaign({ isPayoutCompleted: true })))).toBe(false);
    });

    it("대상 캠페인이 없으면 반영 안 됨", async () => {
      expect(await detectAlreadyApplied(payload, fakeDb(null))).toBe(false);
    });

    it("그 판매채널에 없는 절차면 낡은 플래그가 켜져 있어도 반영 안 됨", async () => {
      const deposit = { action: "confirm_settlement", args: { campaignId: "camp-1", target: "deposit" } };
      const { resolveSettlementCompletionFlags } = await import("@/lib/tax-filing-board");
      const noDeposit = ["OWN_MALL", "SELLER_MALL", "BRAND_MALL"].find(
        (ch) => !resolveSettlementCompletionFlags(ch).includes("isDepositReceived"),
      );
      expect(noDeposit).toBeDefined();
      const row = campaign({ salesChannel: noDeposit, isDepositReceived: true });
      expect(await detectAlreadyApplied(deposit, fakeDb(row))).toBe(false);
    });

    it("자사몰 공급사 지급 기안(지급일 포함)은 공급사 지급 표시로 판정", async () => {
      const supplier = {
        action: "confirm_settlement",
        args: { campaignId: "camp-1", target: "supplierPayout", completedOn: "2026-01-15" },
      };
      const ownMall = { salesChannel: "OWN_MALL_NAVER" };
      expect(await detectAlreadyApplied(supplier, fakeDb(campaign({ ...ownMall, isSupplierPayoutCompleted: true })))).toBe(true);
      expect(await detectAlreadyApplied(supplier, fakeDb(campaign({ ...ownMall, isPayoutCompleted: true })))).toBe(false);
    });
  });

  describe("update_record", () => {
    const payload = {
      action: "update_record",
      args: {
        entityType: "CAMPAIGN",
        entityId: "camp-1",
        changes: { depositReceivedAt: "2026-04-28", payoutCompletedAt: "2026-05-26" },
        expected: { depositReceivedAt: null, payoutCompletedAt: null },
      },
    };

    it("바꿀 칸이 전부 지금 값과 같으면 반영됨(날짜는 KST 달력 날짜로 비교)", async () => {
      const row = campaign({
        // KST 2026-04-28 00:00 = UTC 04-27 15:00 — UTC 날짜로 비교하면 틀린다.
        depositReceivedAt: new Date("2026-04-27T15:00:00.000Z"),
        payoutCompletedAt: new Date("2026-05-26T03:00:00.000Z"),
      });
      expect(await detectAlreadyApplied(payload, fakeDb(row))).toBe(true);
    });

    it("한 칸이라도 다르면 반영 안 됨", async () => {
      const row = campaign({ depositReceivedAt: new Date("2026-04-27T15:00:00.000Z"), payoutCompletedAt: null });
      expect(await detectAlreadyApplied(payload, fakeDb(row))).toBe(false);
    });

    it("묶음 캠페인은 묶음 행의 날짜로 판정", async () => {
      const row = campaign({
        groupId: "grp-1",
        depositReceivedAt: null,
        payoutCompletedAt: null,
        group: {
          id: "grp-1",
          updatedAt: new Date("2026-10-01T00:00:00.000Z"),
          invoiceInfo: null,
          depositReceivedAt: new Date("2026-04-27T15:00:00.000Z"),
          payoutCompletedAt: new Date("2026-05-25T15:00:00.000Z"),
        },
      });
      expect(await detectAlreadyApplied(payload, fakeDb(row))).toBe(true);
    });

    it("행동 칸(드랍 사유)은 저장값이 없어 반영 여부를 알 수 없다 — 반영 안 됨", async () => {
      const drop = {
        action: "update_record",
        args: { entityType: "CAMPAIGN", entityId: "camp-1", changes: { dropReason: null }, expected: { dropReason: null } },
      };
      expect(await detectAlreadyApplied(drop, fakeDb(campaign()))).toBe(false);
    });

    it("대상이 없으면 반영 안 됨", async () => {
      expect(await detectAlreadyApplied(payload, fakeDb(null))).toBe(false);
    });
  });

  describe("update_settlement_amount", () => {
    const payload = {
      action: "update_settlement_amount",
      args: { campaignId: "camp-1", field: "settlementSales", expectedCurrentKrw: 775710, newAmountKrw: 768510 },
    };

    it("칸 값이 이미 바꿀 금액이면 반영됨(Decimal 비교)", async () => {
      expect(await detectAlreadyApplied(payload, fakeDb(campaign({ settlementSales: dec("768510.00") })))).toBe(true);
    });

    it("칸 값이 아직 이전 금액이면 반영 안 됨", async () => {
      expect(await detectAlreadyApplied(payload, fakeDb(campaign()))).toBe(false);
    });

    it("빈 칸(null)은 0원과 같지 않다", async () => {
      const toZero = { ...payload, args: { ...payload.args, newAmountKrw: 0 } };
      expect(await detectAlreadyApplied(toZero, fakeDb(campaign({ settlementSales: null })))).toBe(false);
    });
  });

  it("판정하지 않는 액션은 반영 안 됨으로 둔다", async () => {
    const db = fakeDb(campaign());
    const memo = { action: "add_entity_memo", args: { entityType: "CAMPAIGN", entityId: "camp-1", content: "x" } };
    expect(await detectAlreadyApplied(memo, db)).toBe(false);
    expect(await detectAlreadyApplied(null, db)).toBe(false);
    expect(await detectAlreadyApplied({ action: "confirm_settlement", args: { campaignId: "" } }, db)).toBe(false);
  });

  it("조회가 던지면 목록을 깨지 않고 반영 안 됨 + 로그", async () => {
    const db = fakeDb(campaign());
    (db.salesCampaign.findUnique as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    const payload = { action: "confirm_settlement", args: { campaignId: "camp-1", target: "payout" } };
    expect(await detectAlreadyApplied(payload, db)).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });
});
