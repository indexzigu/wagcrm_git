import { describe, expect, it, vi } from "vitest";
import {
  resolveScheduledCampaignStatus,
  syncCampaignStatusesBySchedule,
  type CampaignStatusSyncCandidate,
} from "../campaign-status-sync";

describe("resolveScheduledCampaignStatus (순수 판정 SSOT)", () => {
  const baseCampaign: CampaignStatusSyncCandidate = {
    id: "camp-1",
    status: "ACTIVE",
    startDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-08T00:00:00.000Z"),
  };

  it("종료일 당일에는 여전히 ACTIVE를 유지한다", () => {
    // 2026-09-08 KST
    const now = new Date("2026-09-08T12:00:00+09:00");
    const verdict = resolveScheduledCampaignStatus(baseCampaign, now);

    expect(verdict.targetStatus).toBeNull();
    expect(verdict.reason).toBe("NONE");
  });

  it("종료일 다음 날(+1일 도달)에는 CLOSED로 전이한다", () => {
    // 2026-09-09 00:01 KST (종료일 + 1일 도달)
    const now = new Date("2026-09-09T00:01:00+09:00");
    const verdict = resolveScheduledCampaignStatus(baseCampaign, now);

    expect(verdict.targetStatus).toBe("CLOSED");
    expect(verdict.reason).toBe("EXPIRED_TO_CLOSED");
  });

  it("종료일이 며칠 지난 경우에도 CLOSED로 전이한다", () => {
    // 2026-09-15 KST
    const now = new Date("2026-09-15T09:00:00+09:00");
    const verdict = resolveScheduledCampaignStatus(baseCampaign, now);

    expect(verdict.targetStatus).toBe("CLOSED");
    expect(verdict.reason).toBe("EXPIRED_TO_CLOSED");
  });

  it("기한이 지난 PREPARATION 캠페인도 CLOSED로 전이한다", () => {
    const expiredPrep: CampaignStatusSyncCandidate = {
      id: "camp-prep-expired",
      status: "PREPARATION",
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-10T00:00:00.000Z"),
    };
    const now = new Date("2026-09-09T09:00:00+09:00");
    const verdict = resolveScheduledCampaignStatus(expiredPrep, now);

    expect(verdict.targetStatus).toBe("CLOSED");
    expect(verdict.reason).toBe("EXPIRED_TO_CLOSED");
  });

  it("시작일 이전의 PREPARATION 캠페인은 상태를 유지한다", () => {
    const upcomingPrep: CampaignStatusSyncCandidate = {
      id: "camp-upcoming",
      status: "PREPARATION",
      startDate: new Date("2026-09-15T00:00:00.000Z"),
      endDate: new Date("2026-09-20T00:00:00.000Z"),
    };
    const now = new Date("2026-09-09T09:00:00+09:00");
    const verdict = resolveScheduledCampaignStatus(upcomingPrep, now);

    expect(verdict.targetStatus).toBeNull();
    expect(verdict.reason).toBe("NONE");
  });

  it("시작일에 도달한 PREPARATION 캠페인은 ACTIVE로 전이한다", () => {
    const startedPrep: CampaignStatusSyncCandidate = {
      id: "camp-started",
      status: "PREPARATION",
      startDate: new Date("2026-09-09T00:00:00.000Z"),
      endDate: new Date("2026-09-15T00:00:00.000Z"),
    };
    const now = new Date("2026-09-09T09:00:00+09:00");
    const verdict = resolveScheduledCampaignStatus(startedPrep, now);

    expect(verdict.targetStatus).toBe("ACTIVE");
    expect(verdict.reason).toBe("STARTED_TO_ACTIVE");
  });

  it("이미 정산/완료/드랍/마감 단계인 캠페인은 기간이 지나도 건드리지 않는다", () => {
    const closedCampaigns: CampaignStatusSyncCandidate[] = [
      { id: "c-closed", status: "CLOSED", startDate: "2026-08-01", endDate: "2026-08-05" },
      { id: "c-wait", status: "SETTLEMENT_WAIT", startDate: "2026-08-01", endDate: "2026-08-05" },
      { id: "c-prog", status: "SETTLEMENT_IN_PROGRESS", startDate: "2026-08-01", endDate: "2026-08-05" },
      { id: "c-done", status: "COMPLETED", startDate: "2026-08-01", endDate: "2026-08-05" },
      { id: "c-drop", status: "DROPPED", startDate: "2026-08-01", endDate: "2026-08-05" },
    ];
    const now = new Date("2026-09-09T09:00:00+09:00");

    for (const c of closedCampaigns) {
      const verdict = resolveScheduledCampaignStatus(c, now);
      expect(verdict.targetStatus).toBeNull();
      expect(verdict.reason).toBe("NONE");
    }
  });
});

describe("syncCampaignStatusesBySchedule (DB 전이 실행)", () => {
  it("기간이 지난 ACTIVE 캠페인은 CLOSED로 업데이트하고 시작일 도달 캠페인은 ACTIVE로 업데이트한다", async () => {
    const campaigns = [
      {
        id: "c1",
        status: "ACTIVE",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-08T00:00:00.000Z"),
        groupId: null,
      },
      {
        id: "c2",
        status: "PREPARATION",
        startDate: new Date("2026-09-09T00:00:00.000Z"),
        endDate: new Date("2026-09-15T00:00:00.000Z"),
        groupId: null,
      },
      {
        id: "c3",
        status: "ACTIVE",
        startDate: new Date("2026-09-05T00:00:00.000Z"),
        endDate: new Date("2026-09-12T00:00:00.000Z"),
        groupId: null,
      },
    ];

    const updatedMap = new Map<string, string>();
    const salesCampaign = {
      findMany: vi.fn().mockResolvedValue(campaigns),
      update: vi.fn().mockImplementation(({ where, data }: { where: { id: string }; data: { status: string } }) => {
        updatedMap.set(where.id, data.status);
        return Promise.resolve({ id: where.id, ...data });
      }),
    };
    // 원본 쓰기와 그룹 상태 연동이 한 트랜잭션이다 — 무그룹 후보는 tx 안에서 update 1회뿐.
    const fakePrisma = {
      salesCampaign,
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ salesCampaign })),
    };

    const now = new Date("2026-09-09T09:00:00+09:00");
    const result = await syncCampaignStatusesBySchedule(fakePrisma as any, now);

    expect(result.totalChecked).toBe(3);
    expect(result.expiredToClosedCount).toBe(1);
    expect(result.startedToActiveCount).toBe(1);
    expect(result.updatedCampaignIds).toEqual(["c1", "c2"]);

    expect(updatedMap.get("c1")).toBe("CLOSED");
    expect(updatedMap.get("c2")).toBe("ACTIVE");
    expect(updatedMap.has("c3")).toBe(false); // c3는 9월 12일까지 판매 중이므로 변경 없음
  });

  it("dryRun=true인 경우 DB 업데이트를 실행하지 않는다", async () => {
    const campaigns = [
      {
        id: "c1",
        status: "ACTIVE",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-08T00:00:00.000Z"),
        groupId: null,
      },
    ];

    const fakePrisma = {
      salesCampaign: {
        findMany: vi.fn().mockResolvedValue(campaigns),
        update: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    const now = new Date("2026-09-09T09:00:00+09:00");
    const result = await syncCampaignStatusesBySchedule(fakePrisma as any, now, { dryRun: true });

    expect(result.expiredToClosedCount).toBe(1);
    expect(fakePrisma.salesCampaign.update).not.toHaveBeenCalled();
    expect(fakePrisma.$transaction).not.toHaveBeenCalled();
  });

  it("그룹 멤버의 자동 판매마감은 같은 tx 에서 형제에 전파되고, 형제는 다시 쓰이지 않는다 — DROPPED·정산 단계 형제 제외", async () => {
    const window = {
      startDate: new Date("2026-09-01T00:00:00.000Z"),
      endDate: new Date("2026-09-08T00:00:00.000Z"),
      groupId: "g1",
    };
    const candidates = [
      { id: "c1", status: "ACTIVE", ...window },
      { id: "c2", status: "ACTIVE", ...window },
    ];
    const members = [
      { id: "c1", status: "CLOSED", salesChannel: "BRAND_MALL", ...window },
      { id: "c2", status: "ACTIVE", salesChannel: "BRAND_MALL", ...window },
      { id: "c3", status: "DROPPED", salesChannel: "BRAND_MALL", ...window },
      { id: "c4", status: "SETTLEMENT_WAIT", salesChannel: "BRAND_MALL", ...window },
    ];
    const txUpdate = vi.fn().mockResolvedValue({});
    const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const activityCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const executeRaw = vi.fn().mockResolvedValue(0);
    const tx = {
      $executeRaw: executeRaw,
      campaignGroup: { findUnique: vi.fn().mockResolvedValue({ id: "g1", sellerId: "s1" }) },
      salesCampaign: {
        update: txUpdate,
        findMany: vi.fn().mockResolvedValue(members),
        updateMany: txUpdateMany,
      },
      campaignActivity: { createMany: activityCreateMany },
    };
    const fakePrisma = {
      salesCampaign: { findMany: vi.fn().mockResolvedValue(candidates) },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };

    const now = new Date("2026-09-09T09:00:00+09:00");
    const result = await withPostgresUrl(() => syncCampaignStatusesBySchedule(fakePrisma as any, now));

    // 🪤 락 순서 — 그룹 락(pg_advisory_xact_lock)이 원본 행 쓰기보다 먼저다(교착 방지).
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(txUpdate.mock.invocationCallOrder[0]);
    // c1 이 직접 전이 · c2 는 연동으로 따라감 → c2 차례가 와도 트랜잭션을 다시 열지 않는다.
    expect(fakePrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledWith({ where: { id: "c1" }, data: { status: "CLOSED" } });
    expect(txUpdateMany).toHaveBeenCalledTimes(1);
    expect(txUpdateMany.mock.calls[0][0].where.id).toEqual({ in: ["c2"] });
    expect(txUpdateMany.mock.calls[0][0].data).toEqual({ status: "CLOSED" });
    expect(activityCreateMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({
        campaignId: "c2",
        action: "STATUS_AUTO_TRANSITION",
        label: "자동 판매마감",
        actor: "SYSTEM",
      }),
    ]);
    expect(result.expiredToClosedCount).toBe(1);
    expect(result.updatedCampaignIds).toEqual(["c1", "c2"]);
    expect(result.propagatedSiblingIds).toEqual(["c2"]);
  });

  it("기간이 다른 그룹 형제는 원본 기준으로 미리 옮기지 않는다 — 형제 자신의 기간으로 같은 답일 때만", async () => {
    const candidates = [
      // A: 9/8 종료 → 9/9 에 마감 대상.
      { id: "a", status: "ACTIVE", startDate: new Date("2026-09-01T00:00:00.000Z"), endDate: new Date("2026-09-08T00:00:00.000Z"), groupId: "g1" },
      // B: 9/11 종료 → 아직 판매 중.
      { id: "b", status: "ACTIVE", startDate: new Date("2026-09-01T00:00:00.000Z"), endDate: new Date("2026-09-11T00:00:00.000Z"), groupId: "g1" },
      // C: 9/12 시작 → 아직 준비 중(원본이 ACTIVE 로 가는 경우에도 미리 진행시키면 안 된다).
      { id: "c", status: "PREPARATION", startDate: new Date("2026-09-12T00:00:00.000Z"), endDate: new Date("2026-09-20T00:00:00.000Z"), groupId: "g1" },
    ];
    const members = [
      { ...candidates[0], status: "CLOSED", salesChannel: "BRAND_MALL" },
      { ...candidates[1], salesChannel: "BRAND_MALL" },
      { ...candidates[2], salesChannel: "BRAND_MALL" },
    ];
    const txUpdate = vi.fn().mockResolvedValue({});
    const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      campaignGroup: { findUnique: vi.fn().mockResolvedValue({ id: "g1", sellerId: "s1" }) },
      salesCampaign: { update: txUpdate, findMany: vi.fn().mockResolvedValue(members), updateMany: txUpdateMany },
      campaignActivity: { createMany: vi.fn() },
    };
    const fakePrisma = {
      salesCampaign: { findMany: vi.fn().mockResolvedValue(candidates) },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };

    const result = await syncCampaignStatusesBySchedule(fakePrisma as any, new Date("2026-09-09T09:00:00+09:00"));

    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledWith({ where: { id: "a" }, data: { status: "CLOSED" } });
    expect(txUpdateMany).not.toHaveBeenCalled();
    expect(result.updatedCampaignIds).toEqual(["a"]);
    expect(result.propagatedSiblingIds).toEqual([]);
  });
});

/** 락 단언은 env 에 따라 갈린다(sqlite 면 락 생략) — postgres 갈래를 명시 env 로 고정한다(P9). */
async function withPostgresUrl<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://user@localhost:5432/db";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
}
