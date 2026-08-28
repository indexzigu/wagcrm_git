/**
 * `settlement-flag-write` 단위 계약 — 「어느 행이 정본인가」(CG-1)를 한 곳에서 고정한다.
 * 계약의 재발 방지 축(호출부가 손으로 다시 만드는 것)은
 * `settlement-flag-write.contract.test.ts` 가 소스 스캔으로 담당한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSettlementFlagSnapshot,
  writeSettlementFlags,
} from "@/lib/settlement-flag-write";

const groupUpdateMany = vi.fn();
const groupFindUnique = vi.fn();
const campaignUpdateMany = vi.fn();
const campaignFindUnique = vi.fn();

const tx = {
  campaignGroup: { updateMany: groupUpdateMany, findUnique: groupFindUnique },
  salesCampaign: { updateMany: campaignUpdateMany, findUnique: campaignFindUnique },
} as never;

const CAMPAIGN = { id: "c1", status: "SETTLEMENT_WAIT" } as never;
const GROUP = { id: "g1" } as never;

beforeEach(() => {
  [groupUpdateMany, groupFindUnique, campaignUpdateMany, campaignFindUnique].forEach((m) =>
    m.mockReset(),
  );
  groupUpdateMany.mockResolvedValue({ count: 1 });
  campaignUpdateMany.mockResolvedValue({ count: 1 });
  groupFindUnique.mockResolvedValue({ id: "g1", isDepositReceived: true });
  campaignFindUnique.mockResolvedValue({ id: "c1", status: "COMPLETED" });
});

describe("resolveSettlementFlagSnapshot", () => {
  const stale = {
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
  };
  const fresh = {
    isDepositReceived: true,
    isPayoutCompleted: true,
    isSupplierPayoutCompleted: true,
  };

  it("그룹이 있으면 그룹 스칼라가 정본이다(멤버 행 값은 낡을 수 있다)", () => {
    expect(resolveSettlementFlagSnapshot(stale, fresh)).toEqual(fresh);
  });

  it("미그룹이면 멤버 행이 정본이다", () => {
    expect(resolveSettlementFlagSnapshot(fresh, null)).toEqual(fresh);
  });
});

describe("writeSettlementFlags", () => {
  it("미그룹: 플래그와 status 를 멤버 행 한 statement 로 쓴다", async () => {
    const result = await writeSettlementFlags(tx, {
      campaign: CAMPAIGN,
      group: null,
      settlementUpdates: { isDepositReceived: true },
      campaignUpdates: { status: "COMPLETED" },
    });

    expect(groupUpdateMany).not.toHaveBeenCalled();
    expect(campaignUpdateMany).toHaveBeenCalledTimes(1);
    expect(campaignUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: "c1" },
      data: { isDepositReceived: true, status: "COMPLETED" },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("그룹: 플래그는 그룹 스칼라로, status 는 멤버 행으로 갈린다", async () => {
    await writeSettlementFlags(tx, {
      campaign: CAMPAIGN,
      group: GROUP,
      settlementUpdates: { isDepositReceived: true },
      campaignUpdates: { status: "COMPLETED" },
    });

    expect(groupUpdateMany.mock.calls[0][0]).toEqual({
      // 멤버십 조건은 방어가 아니라 계약 — 조회 이후 그룹을 떠났으면 남의 그룹을 쓰게 된다.
      where: { id: "g1", members: { some: { id: "c1" } } },
      data: { isDepositReceived: true },
    });
    // ⛔ 핵심: 멤버 행에는 플래그가 가지 않는다.
    expect(campaignUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: "c1" },
      data: { status: "COMPLETED" },
    });
  });

  it("선행조건(expect)은 플래그가 사는 행에만 실린다", async () => {
    await writeSettlementFlags(tx, {
      campaign: CAMPAIGN,
      group: GROUP,
      settlementUpdates: { isPayoutCompleted: true },
      campaignUpdates: { status: "COMPLETED" },
      expect: { isPayoutCompleted: false },
    });

    expect(groupUpdateMany.mock.calls[0][0].where).toEqual({
      id: "g1",
      members: { some: { id: "c1" } },
      isPayoutCompleted: false,
    });
    // 그룹 소속 멤버 행의 플래그는 이미 낡았을 수 있어, 여기 걸면 정상 확정이 조용히 거부된다.
    expect(campaignUpdateMany.mock.calls[0][0].where).toEqual({ id: "c1" });
  });

  it("미그룹이면 선행조건이 멤버 행 where 에 실린다", async () => {
    await writeSettlementFlags(tx, {
      campaign: CAMPAIGN,
      group: null,
      settlementUpdates: { isDepositReceived: true },
      campaignUpdates: {},
      expect: { isDepositReceived: false },
    });

    expect(campaignUpdateMany.mock.calls[0][0].where).toEqual({
      id: "c1",
      isDepositReceived: false,
    });
  });

  it("그룹 쓰기가 거절되면 멤버 행은 건드리지 않고 실패로 돌려준다", async () => {
    groupUpdateMany.mockResolvedValue({ count: 0 });

    const result = await writeSettlementFlags(tx, {
      campaign: CAMPAIGN,
      group: GROUP,
      settlementUpdates: { isDepositReceived: true },
      campaignUpdates: { status: "COMPLETED" },
    });

    expect(result).toEqual({ ok: false });
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });

  it("쓸 것이 없으면 아무 쓰기도 하지 않고 사전 조회분을 그대로 돌려준다", async () => {
    const result = await writeSettlementFlags(tx, {
      campaign: CAMPAIGN,
      group: GROUP,
      settlementUpdates: {},
      campaignUpdates: {},
    });

    expect(groupUpdateMany).not.toHaveBeenCalled();
    expect(campaignUpdateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, campaign: CAMPAIGN, group: GROUP });
  });
});
