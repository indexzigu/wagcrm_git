/**
 * 정산 확정 계획 — 실행기와 슬랙 카드가 함께 읽는 판정(`settlement-confirm-preview.ts`).
 * 이름·금액은 모두 지어낸 값이다. ⏰ 날짜는 「오늘」에서 상대로 만든다(고정 날짜 픽스처 금지, P9).
 */
import { describe, expect, it, vi } from "vitest";
import {
  checkSettlementCompletedOn,
  isConfirmableAmount,
  resolveSettlementConfirmPlan,
  toSettlementConfirmPreview,
  toSettlementCompletedAt,
  type SettlementConfirmPlanClient,
} from "@/lib/settlement-confirm-preview";

function member(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    groupId: "g1",
    status: "SETTLEMENT_WAIT",
    salesChannel: "OWN_MALL_NAVER",
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    actualSales: 1_000_000,
    sellerExpense: 100_000,
    settlementSales: 300_000,
    actualPayoutAmount: null,
    settlementGoodsCost: 400_000,
    ...over,
  };
}

function clientFor(campaign: Record<string, unknown> | null, members: Record<string, unknown>[] = []) {
  const findUnique = vi.fn(async () => campaign);
  const findMany = vi.fn(async () => members);
  return {
    client: { salesCampaign: { findUnique, findMany } } as unknown as SettlementConfirmPlanClient,
    findUnique,
    findMany,
  };
}

const group = { id: "g1", isDepositReceived: false, isPayoutCompleted: false, isSupplierPayoutCompleted: false };

describe("resolveSettlementConfirmPlan", () => {
  it("자사몰 묶음 4개 · 공급사 지급: 그룹 정본 플래그 · 멤버 합산 금액 · 멤버 수", async () => {
    const rep = { ...member(), group };
    const members = [rep, member({ id: "m2" }), member({ id: "m3", settlementGoodsCost: 0 }), member({ id: "m4", settlementGoodsCost: 200_000 })];
    const { client, findUnique, findMany } = clientFor(rep, members);

    const plan = await resolveSettlementConfirmPlan(client, "m1", "supplierPayout");

    expect(findUnique).toHaveBeenCalledWith({ where: { id: "m1" }, include: { group: true } });
    expect(findMany).toHaveBeenCalledWith({ where: { groupId: "g1" } });
    expect(plan?.slot?.key).toBe("supplierPayout");
    expect(plan?.validity).toEqual({ ok: true });
    expect(plan?.amountKrw).toBe(1_000_000);
    expect(toSettlementConfirmPreview(plan!)).toEqual({
      slot: { counterpartLabel: "공급사", verb: "지급" },
      ready: true,
      amountKrw: 1_000_000,
      memberCount: 4,
    });
  });

  it("묶음 소속이면 플래그는 멤버 행이 아니라 그룹 스칼라를 본다(CG-1)", async () => {
    // 멤버 행은 false 인데 그룹은 이미 공급사 지급 완료 — 다시 확정하면 안 된다.
    const rep = { ...member(), group: { ...group, isSupplierPayoutCompleted: true } };
    const { client } = clientFor(rep, [rep]);
    const plan = await resolveSettlementConfirmPlan(client, "m1", "supplierPayout");
    expect(plan?.validity.ok).toBe(false);
    expect(toSettlementConfirmPreview(plan!).ready).toBe(false);
  });

  it("단일 캠페인은 멤버를 따로 읽지 않는다 · 칸이 없는 채널이면 slot·금액이 null", async () => {
    const solo = { ...member({ groupId: null, salesChannel: "SELLER_MALL" }), group: null };
    const { client, findMany } = clientFor(solo);
    const plan = await resolveSettlementConfirmPlan(client, "m1", "supplierPayout");
    expect(findMany).not.toHaveBeenCalled();
    expect(plan?.memberCount).toBe(1);
    expect(plan?.slot).toBeNull();
    expect(plan?.amountKrw).toBeNull();
  });

  it("캠페인이 없으면 null", async () => {
    const { client } = clientFor(null);
    await expect(resolveSettlementConfirmPlan(client, "missing", "payout")).resolves.toBeNull();
  });
});

describe("isConfirmableAmount", () => {
  it("미정·0·음수는 확정하지 않는다", () => {
    expect([null, 0, -1, Number.NaN].map(isConfirmableAmount)).toEqual([false, false, false, false]);
    expect(isConfirmableAmount(1)).toBe(true);
  });
});

describe("checkSettlementCompletedOn · toSettlementCompletedAt", () => {
  const kst = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
  const shift = (ymd: string, days: number) => {
    const d = new Date(`${ymd}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  it("오늘·과거는 받고 미래는 거부한다(오늘 = KST)", () => {
    const now = new Date();
    const today = kst(now);
    expect(checkSettlementCompletedOn(today, now)).toEqual({ ok: true });
    expect(checkSettlementCompletedOn(shift(today, -400), now)).toEqual({ ok: true });
    const future = checkSettlementCompletedOn(shift(today, 1), now);
    expect(future.ok === false && future.reason).toMatch(/미래 날짜는 지급 완료일로 기록하지 않습니다/);
  });

  it("KST 와 UTC 날짜가 갈리는 시각에도 KST 「오늘」을 쓴다", () => {
    // UTC 15:30 = KST 다음날 00:30 — KST 로는 그 다음날이 「오늘」이다.
    const today = shift(kst(new Date()), -10);
    const now = new Date(`${today}T15:30:00.000Z`);
    expect(checkSettlementCompletedOn(shift(today, 1), now)).toEqual({ ok: true });
    expect(checkSettlementCompletedOn(shift(today, 2), now).ok).toBe(false);
  });

  it("달력에 없는 날짜·다른 모양은 거부한다", () => {
    for (const bad of ["2026-02-30", "2026-1-05", "2026/01/05", "어제"]) {
      expect([bad, checkSettlementCompletedOn(bad).ok]).toEqual([bad, false]);
    }
  });

  it("날짜가 있으면 UTC 자정(캠페인 편집 저장과 같은 규약)으로, 없으면 승인 시각으로 저장한다", () => {
    const now = new Date();
    const day = shift(kst(now), -3);
    const stored = toSettlementCompletedAt(day, now);
    expect(stored.toISOString()).toBe(`${day}T00:00:00.000Z`);
    expect(kst(stored)).toBe(day);
    expect(toSettlementCompletedAt(undefined, now)).toBe(now);
  });
});
