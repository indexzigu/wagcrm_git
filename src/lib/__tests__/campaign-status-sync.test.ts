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
    const fakePrisma = {
      salesCampaign: {
        findMany: vi.fn().mockResolvedValue(campaigns),
        update: vi.fn().mockImplementation(({ where, data }: { where: { id: string }; data: { status: string } }) => {
          updatedMap.set(where.id, data.status);
          return Promise.resolve({ id: where.id, ...data });
        }),
      },
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
    };

    const now = new Date("2026-09-09T09:00:00+09:00");
    const result = await syncCampaignStatusesBySchedule(fakePrisma as any, now, { dryRun: true });

    expect(result.expiredToClosedCount).toBe(1);
    expect(fakePrisma.salesCampaign.update).not.toHaveBeenCalled();
  });
});
