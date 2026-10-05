/**
 * `propagateGroupStatus` 행위 계약 — 조합 캠페인의 상태 변경은 그룹 전체에 적용된다
 * (오너 확정 2026-10-05). 규칙은 전부 이 함수가 소유하고, 호출부(캠페인 PATCH · 정산 토글 ·
 * 에이전트 정산 확정 · 일정 자동전이 · 정산 체크리스트)는 이 함수를 통과한다 — 통과 여부는
 * `campaign-status-group-propagation.contract.test.ts` 가 소스 스캔으로 강제한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeGroupStatusPropagation,
  propagateGroupStatus,
} from "@/services/campaignGroupService";

type Member = { id: string; status: string; salesChannel: string };

const lockCalls: unknown[] = [];
const groupFindUnique = vi.fn();
const membersFindMany = vi.fn();
const campaignUpdateMany = vi.fn();
const activityCreateMany = vi.fn();
const activityLogCreateMany = vi.fn();

const tx = {
  async $executeRaw(_s: TemplateStringsArray, ...values: unknown[]) {
    lockCalls.push(values[0]);
    return 0;
  },
  campaignGroup: { findUnique: groupFindUnique },
  salesCampaign: { findMany: membersFindMany, updateMany: campaignUpdateMany },
  campaignActivity: { createMany: activityCreateMany },
  activityLog: { createMany: activityLogCreateMany },
} as never;

function members(...rows: Array<[string, string]>): Member[] {
  return rows.map(([id, status]) => ({ id, status, salesChannel: "BRAND_MALL" }));
}

const BASE = {
  originCampaignId: "c1",
  groupId: "g1",
  originPreviousStatus: "ACTIVE",
  status: "CLOSED",
  actor: "user-1",
  log: { kind: "campaign-activity", action: "UPDATED", label: "Campaign updated" },
} as const;

beforeEach(() => {
  lockCalls.length = 0;
  [groupFindUnique, membersFindMany, campaignUpdateMany, activityCreateMany, activityLogCreateMany].forEach(
    (m) => m.mockReset(),
  );
  groupFindUnique.mockResolvedValue({ id: "g1", sellerId: "s1" });
  campaignUpdateMany.mockResolvedValue({ count: 1 });
  activityCreateMany.mockResolvedValue({ count: 1 });
  activityLogCreateMany.mockResolvedValue({ count: 1 });
});

describe("propagateGroupStatus", () => {
  it("형제 멤버에 같은 상태를 한 번의 updateMany 로 쓰고, 원본과 같은 actor 로 이력을 남긴다", async () => {
    membersFindMany.mockResolvedValue(members(["c1", "CLOSED"], ["c2", "ACTIVE"], ["c3", "PREPARATION"]));

    const result = await propagateGroupStatus(tx, BASE);

    expect(result).toEqual([
      { id: "c2", previousStatus: "ACTIVE" },
      { id: "c3", previousStatus: "PREPARATION" },
    ]);
    expect(campaignUpdateMany).toHaveBeenCalledTimes(1);
    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["c2", "c3"] },
        groupId: "g1",
        status: { notIn: ["DROPPED", "PROPOSAL", "CLOSED"] },
      },
      data: { status: "CLOSED" },
    });
    expect(activityCreateMany).toHaveBeenCalledWith({
      data: [
        {
          campaignId: "c2",
          action: "UPDATED",
          label: "Campaign updated",
          details: describeGroupStatusPropagation("c1", "ACTIVE", "CLOSED"),
          actor: "user-1",
        },
        {
          campaignId: "c3",
          action: "UPDATED",
          label: "Campaign updated",
          details: describeGroupStatusPropagation("c1", "PREPARATION", "CLOSED"),
          actor: "user-1",
        },
      ],
    });
  });

  // 락 단언은 env 에 따라 갈린다(`acquireGroupLock` 은 sqlite 면 건너뛴다) — `test:ci` 는
  // `DATABASE_URL=file:./dev.db` 를 강제하므로 두 갈래를 각각 명시 env 로 고정한다(P9).
  it.each([
    ["postgresql://user@localhost:5432/db", ["s1"]],
    ["file:./dev.db", []],
  ])("셀러 단위 락: DATABASE_URL=%s → %j", async (url, expected) => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    try {
      membersFindMany.mockResolvedValue(members(["c1", "CLOSED"], ["c2", "ACTIVE"]));
      await propagateGroupStatus(tx, BASE);
      expect(lockCalls).toEqual(expected);
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });

  it("DROPPED 형제는 되살리지도 전진시키지도 않는다", async () => {
    membersFindMany.mockResolvedValue(members(["c1", "CLOSED"], ["c2", "DROPPED"], ["c3", "ACTIVE"]));

    const result = await propagateGroupStatus(tx, BASE);

    expect(result.map((r) => r.id)).toEqual(["c3"]);
    expect(campaignUpdateMany.mock.calls[0][0].where.id).toEqual({ in: ["c3"] });
  });

  it("PROPOSAL 형제는 그룹 상태 변경을 따라가지 않는다(오너 확정 2026-10-05)", async () => {
    membersFindMany.mockResolvedValue(members(["c1", "CLOSED"], ["c2", "PROPOSAL"], ["c3", "COMPLETED"]));

    const result = await propagateGroupStatus(tx, BASE);

    // COMPLETED 형제도 따라간다(수동 경로는 DROPPED·PROPOSAL 외 전원) — PROPOSAL 만 남는다.
    expect(result.map((r) => r.id)).toEqual(["c3"]);
    expect(campaignUpdateMany.mock.calls[0][0].where.id).toEqual({ in: ["c3"] });
  });

  it("원본이 PROPOSAL → PREPARATION 이면 PREPARATION/ACTIVE 형제에는 전파하고 다른 PROPOSAL 형제는 그대로 둔다", async () => {
    membersFindMany.mockResolvedValue(
      members(["c1", "PREPARATION"], ["c2", "ACTIVE"], ["c3", "PREPARATION"], ["c4", "PROPOSAL"]),
    );

    const result = await propagateGroupStatus(tx, {
      ...BASE,
      originPreviousStatus: "PROPOSAL",
      status: "PREPARATION",
    });

    // c3 는 이미 PREPARATION(멱등 — 쓰기 없음), c4 는 PROPOSAL(따라가지 않음).
    expect(result).toEqual([{ id: "c2", previousStatus: "ACTIVE" }]);
    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["c2"] },
        groupId: "g1",
        status: { notIn: ["DROPPED", "PROPOSAL", "PREPARATION"] },
      },
      data: { status: "PREPARATION" },
    });
  });

  it("DROPPED 로의 변경은 전파하지 않는다(드랍은 멤버 단위) — 그룹 조회조차 하지 않는다", async () => {
    const result = await propagateGroupStatus(tx, { ...BASE, status: "DROPPED" });

    expect(result).toEqual([]);
    expect(groupFindUnique).not.toHaveBeenCalled();
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });

  it("DROPPED 에서 복귀하는 변경도 전파하지 않는다(복귀도 멤버 단위)", async () => {
    const result = await propagateGroupStatus(tx, { ...BASE, originPreviousStatus: "DROPPED" });

    expect(result).toEqual([]);
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });

  it("무그룹이면 no-op 이다", async () => {
    expect(await propagateGroupStatus(tx, { ...BASE, groupId: null })).toEqual([]);
    expect(await propagateGroupStatus(tx, { ...BASE, groupId: undefined })).toEqual([]);
    expect(groupFindUnique).not.toHaveBeenCalled();
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });

  it("멱등 — 형제가 이미 목표 상태면 쓰지도 기록하지도 않는다", async () => {
    membersFindMany.mockResolvedValue(members(["c1", "CLOSED"], ["c2", "CLOSED"]));

    expect(await propagateGroupStatus(tx, BASE)).toEqual([]);
    expect(campaignUpdateMany).not.toHaveBeenCalled();
    expect(activityCreateMany).not.toHaveBeenCalled();
  });

  it("원본이 이미 그룹을 떠났으면(멤버 목록에 없음) 남의 그룹을 바꾸지 않는다", async () => {
    membersFindMany.mockResolvedValue(members(["c2", "ACTIVE"], ["c3", "ACTIVE"]));

    expect(await propagateGroupStatus(tx, BASE)).toEqual([]);
    expect(campaignUpdateMany).not.toHaveBeenCalled();
  });

  it("그룹이 사라졌으면 no-op 이다", async () => {
    groupFindUnique.mockResolvedValue(null);

    expect(await propagateGroupStatus(tx, BASE)).toEqual([]);
    expect(membersFindMany).not.toHaveBeenCalled();
  });

  it("경로별 형제 선별(isSiblingEligible)을 따른다", async () => {
    membersFindMany.mockResolvedValue(members(["c1", "CLOSED"], ["c2", "ACTIVE"], ["c3", "SETTLEMENT_WAIT"]));

    const result = await propagateGroupStatus(tx, {
      ...BASE,
      isSiblingEligible: (s) => s.status === "ACTIVE" || s.status === "PREPARATION",
    });

    expect(result.map((r) => r.id)).toEqual(["c2"]);
  });

  it("정산 토글 경로는 ActivityLog CHANGE(status) 로 같은 표식을 남긴다", async () => {
    membersFindMany.mockResolvedValue(members(["c1", "COMPLETED"], ["c2", "SETTLEMENT_WAIT"]));

    await propagateGroupStatus(tx, {
      ...BASE,
      originPreviousStatus: "SETTLEMENT_WAIT",
      status: "COMPLETED",
      actor: "ops@example.com",
      log: { kind: "activity-change" },
    });

    expect(activityCreateMany).not.toHaveBeenCalled();
    expect(activityLogCreateMany).toHaveBeenCalledWith({
      data: [
        {
          entityType: "CAMPAIGN",
          entityId: "c2",
          type: "CHANGE",
          fieldName: "status",
          previousValue: "SETTLEMENT_WAIT",
          newValue: "COMPLETED",
          content: describeGroupStatusPropagation("c1", "SETTLEMENT_WAIT", "COMPLETED"),
          actor: "ops@example.com",
        },
      ],
    });
  });

  it("재귀하지 않는다 — 형제 쓰기는 updateMany 1회이고 형제마다 그룹을 다시 조회하지 않는다", async () => {
    membersFindMany.mockResolvedValue(
      members(["c1", "CLOSED"], ["c2", "ACTIVE"], ["c3", "ACTIVE"], ["c4", "ACTIVE"]),
    );

    await propagateGroupStatus(tx, BASE);

    expect(groupFindUnique).toHaveBeenCalledTimes(1);
    expect(membersFindMany).toHaveBeenCalledTimes(1);
    expect(campaignUpdateMany).toHaveBeenCalledTimes(1);
  });
});
