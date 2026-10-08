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

// 월별 정산 완료 게이트(T-240) — 이 파일은 상태 전이·그룹 전파만 본다(월정산 거래처 아님 = 통과).
// 게이트 자체의 판정은 campaign-invoices.test.ts · route.monthly-gate.test.ts 가 고정한다.
vi.mock("@/services/campaignInvoiceService", () => ({
  campaignInvoiceService: {
    gateAutoCompletion: vi.fn(async (_db: unknown, _id: string, _prev: string, auto: string | null | undefined) => ({
      status: auto ?? undefined,
      blockedReason: null,
    })),
    findCompletionBlocker: vi.fn().mockResolvedValue(null),
    findCompletionBlockers: vi.fn().mockResolvedValue(new Map()),
  },
}));

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
      actor: "tester",
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
      actor: "tester",
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
      actor: "tester",
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
      actor: "tester",
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
      actor: "tester",
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
      actor: "tester",
    });

    expect(groupUpdateMany).not.toHaveBeenCalled();
    expect(campaignUpdateMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      campaign: CAMPAIGN,
      group: GROUP,
      propagatedStatusSiblingIds: [],
    });
  });
});

describe("writeSettlementFlags × 그룹 상태 연동(오너 확정 2026-10-05)", () => {
  const membersFindMany = vi.fn();
  const activityCreateMany = vi.fn();
  const executeRaw = vi.fn();
  const groupTx = {
    $executeRaw: executeRaw,
    campaignGroup: {
      updateMany: groupUpdateMany,
      findUnique: groupFindUnique,
    },
    salesCampaign: {
      updateMany: campaignUpdateMany,
      findUnique: campaignFindUnique,
      findMany: membersFindMany,
    },
    activityLog: { createMany: activityCreateMany },
  } as never;

  beforeEach(() => {
    membersFindMany.mockReset();
    activityCreateMany.mockReset();
    executeRaw.mockReset();
    executeRaw.mockResolvedValue(0);
    groupFindUnique.mockResolvedValue({
      id: "g1",
      sellerId: "s1",
      isDepositReceived: true,
      isPayoutCompleted: true,
      isSupplierPayoutCompleted: false,
    });
  });

  it("자동전이 COMPLETED 를 같은 tx 에서 형제에 전파하고 이전 상태를 이력에 남긴다", async () => {
    membersFindMany.mockResolvedValue([
      { id: "c1", status: "COMPLETED", salesChannel: "BRAND_MALL" },
      { id: "c2", status: "SETTLEMENT_WAIT", salesChannel: "BRAND_MALL" },
      { id: "c3", status: "DROPPED", salesChannel: "BRAND_MALL" },
      { id: "c4", status: "PROPOSAL", salesChannel: "BRAND_MALL" },
    ]);
    const result = await writeSettlementFlags(groupTx, {
      campaign: { id: "c1", status: "SETTLEMENT_WAIT", groupId: "g1" } as never,
      group: GROUP,
      settlementUpdates: { isPayoutCompleted: true },
      campaignUpdates: { status: "COMPLETED" },
      actor: "ops@example.com",
    });

    expect(result).toMatchObject({ ok: true, propagatedStatusSiblingIds: ["c2"] });
    const siblingWrite = campaignUpdateMany.mock.calls[1][0];
    expect(siblingWrite.where.id).toEqual({ in: ["c2"] });
    expect(siblingWrite.data).toEqual({ status: "COMPLETED" });
    expect(activityCreateMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({
        entityId: "c2",
        fieldName: "status",
        previousValue: "SETTLEMENT_WAIT",
        newValue: "COMPLETED",
        actor: "ops@example.com",
      }),
    ]);
  });

  it("🪤 락 순서 — 그룹 락이 그룹·멤버 행 쓰기보다 먼저다(팬아웃과의 교착 방지)", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://user@localhost:5432/db";
    try {
      membersFindMany.mockResolvedValue([{ id: "c1", status: "COMPLETED", salesChannel: "BRAND_MALL" }]);
      await writeSettlementFlags(groupTx, {
        campaign: { id: "c1", status: "SETTLEMENT_WAIT", groupId: "g1" } as never,
        group: GROUP,
        settlementUpdates: { isPayoutCompleted: true },
        campaignUpdates: { status: "COMPLETED" },
        actor: "ops@example.com",
      });

      const lockAt = executeRaw.mock.invocationCallOrder[0];
      expect(lockAt).toBeLessThan(groupUpdateMany.mock.invocationCallOrder[0]);
      expect(lockAt).toBeLessThan(campaignUpdateMany.mock.invocationCallOrder[0]);
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });

  it("형제 본인 행에서 같은 토글을 했을 때 답이 다른 형제(채널이 요구하는 플래그가 다름)는 건드리지 않는다", async () => {
    // 자사몰은 [공급사 지급, 셀러 지급] 이 완료 조건 — 그룹 플래그상 공급사 지급이 아직이라
    // 그 형제는 손으로 토글했어도 COMPLETED 가 되지 않았을 것이다.
    membersFindMany.mockResolvedValue([
      { id: "c1", status: "COMPLETED", salesChannel: "BRAND_MALL" },
      { id: "c2", status: "SETTLEMENT_WAIT", salesChannel: "OWN_MALL" },
    ]);
    const result = await writeSettlementFlags(groupTx, {
      campaign: { id: "c1", status: "SETTLEMENT_WAIT", groupId: "g1" } as never,
      group: GROUP,
      settlementUpdates: { isPayoutCompleted: true },
      campaignUpdates: { status: "COMPLETED" },
      actor: "ops@example.com",
    });

    expect(result).toMatchObject({ ok: true, propagatedStatusSiblingIds: [] });
    expect(campaignUpdateMany).toHaveBeenCalledTimes(1);
  });
});
