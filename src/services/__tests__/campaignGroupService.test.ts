/**
 * CG-1 campaignGroupService 불변식 테스트 (블루프린트 §3).
 *
 * 이종 셀러 409 · 멤버 ≤1 자동해체 · 이미 그룹 소속 거부(병합 미지원)를 고정한다.
 * 실제 DB를 쓰지 않고, $transaction이 콜백에 넘기는 인메모리 가짜 tx로 검증한다
 * (campaignService.recalcRounds.test.ts의 가짜-tx 패턴 계열).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type FakeCampaign = {
  id: string;
  dealId: string;
  sellerId: string;
  groupId: string | null;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
  expectedDepositDate: Date | null;
  depositReceivedAt: Date | null;
  isDepositReceived: boolean;
  expectedPayoutDate: Date | null;
  payoutCompletedAt: Date | null;
  isPayoutCompleted: boolean;
  deal: { dealName: string };
  seller: { name: string; alias: string | null };
};

type FakeGroup = {
  id: string;
  sellerId: string;
  name: string | null;
  startDate: Date | null;
  endDate: Date | null;
  expectedDepositDate: Date | null;
  depositReceivedAt: Date | null;
  isDepositReceived: boolean;
  expectedPayoutDate: Date | null;
  payoutCompletedAt: Date | null;
  isPayoutCompleted: boolean;
};

const hoisted = vi.hoisted(() => {
  const state = {
    campaigns: new Map<string, FakeCampaign>(),
    groups: new Map<string, FakeGroup>(),
    groupSeq: 0,
    lockCalls: [] as string[],
  };

  const matchWhere = (c: FakeCampaign, where: Record<string, unknown>): boolean => {
    if ("groupId" in where && c.groupId !== where.groupId) return false;
    const idClause = where.id as { in?: string[] } | undefined;
    if (idClause?.in && !idClause.in.includes(c.id)) return false;
    if ("sellerId" in where && c.sellerId !== where.sellerId) return false;
    return true;
  };

  const tx = {
    async $executeRaw(_strings: TemplateStringsArray, ...values: unknown[]) {
      state.lockCalls.push(String(values[0]));
      return 0;
    },
    campaignGroup: {
      async create({ data }: { data: { id?: string; sellerId: string; name?: string | null } }) {
        const id = data.id ?? `group-${++state.groupSeq}`;
        const g: FakeGroup = {
          id,
          sellerId: data.sellerId,
          name: data.name ?? null,
          startDate: null,
          endDate: null,
          expectedDepositDate: null,
          depositReceivedAt: null,
          isDepositReceived: false,
          expectedPayoutDate: null,
          payoutCompletedAt: null,
          isPayoutCompleted: false,
        };
        state.groups.set(id, g);
        return { ...g, createdAt: new Date(), updatedAt: new Date() };
      },
      async update({ where, data }: { where: { id: string }; data: Partial<FakeGroup> }) {
        const g = state.groups.get(where.id);
        if (!g) throw new Error(`group not found: ${where.id}`);
        Object.assign(g, data);
        return { ...g, updatedAt: new Date() };
      },
      async delete({ where }: { where: { id: string } }) {
        const g = state.groups.get(where.id);
        state.groups.delete(where.id);
        return g;
      },
      async findUnique({ where }: { where: { id: string } }) {
        const g = state.groups.get(where.id);
        // select 절은 무시하고 전체를 돌려준다 — 서비스는 필요한 필드만 읽는다.
        return g ? { ...g } : null;
      },
    },
    salesCampaign: {
      async findMany({ where }: { where?: Record<string, unknown> }) {
        const rows = [...state.campaigns.values()].filter((c) => matchWhere(c, where ?? {}));
        rows.sort(
          (a, b) =>
            a.startDate.getTime() - b.startDate.getTime() ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return rows.map((c) => ({ ...c }));
      },
      async update({ where, data }: { where: { id: string }; data: { groupId?: string | null } }) {
        const c = state.campaigns.get(where.id);
        if (!c) throw new Error(`campaign not found: ${where.id}`);
        if (data.groupId !== undefined) c.groupId = data.groupId;
        return { id: c.id, groupId: c.groupId };
      },
    },
  };

  const prisma = {
    $transaction: async <T>(cb: (client: typeof tx) => Promise<T>) => cb(tx),
  };

  return { state, prisma };
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => hoisted.prisma,
}));

import { campaignGroupService, CampaignGroupError } from "../campaignGroupService";

let seq = 0;
function seedCampaign(over: Partial<FakeCampaign> & { id: string; sellerId: string; dealId: string }) {
  const c: FakeCampaign = {
    groupId: null,
    startDate: new Date("2026-07-01T00:00:00Z"),
    endDate: new Date("2026-07-05T00:00:00Z"),
    createdAt: new Date(`2026-07-01T00:00:0${seq++ % 10}Z`),
    expectedDepositDate: null,
    depositReceivedAt: null,
    isDepositReceived: false,
    expectedPayoutDate: null,
    payoutCompletedAt: null,
    isPayoutCompleted: false,
    deal: { dealName: "비타민" },
    seller: { name: "김본명", alias: "가온" },
    ...over,
  };
  hoisted.state.campaigns.set(c.id, c);
  return c;
}

beforeEach(() => {
  hoisted.state.campaigns.clear();
  hoisted.state.groups.clear();
  hoisted.state.groupSeq = 0;
  hoisted.state.lockCalls = [];
  seq = 0;
});

describe("campaignGroupService.createGroup", () => {
  it("2건을 묶어 롤업/이름/멤버십을 설정한다", async () => {
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA", startDate: new Date("2026-07-01Z"), endDate: new Date("2026-07-05Z"), deal: { dealName: "비타민" } });
    seedCampaign({ id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z"), endDate: new Date("2026-07-08Z"), deal: { dealName: "글로우" } });

    const group = await campaignGroupService.createGroup(["c1", "c2"]);

    // 대표딜 = 시작일 이른 c1("비타민"), 별칭 우선(가온), 멤버 2 → 외 1건
    expect(group.name).toBe("[가온] 비타민 외 1건");
    expect(group.sellerId).toBe("s1");
    expect(new Date(group.startDate!).getTime()).toBe(new Date("2026-07-01Z").getTime());
    expect(new Date(group.endDate!).getTime()).toBe(new Date("2026-07-08Z").getTime());
    expect(hoisted.state.campaigns.get("c1")!.groupId).toBe(group.id);
    expect(hoisted.state.campaigns.get("c2")!.groupId).toBe(group.id);
    // advisory lock이 셀러 키로 획득됨
    expect(hoisted.state.lockCalls).toContain("s1");
  });

  it("이종 셀러는 409 HETERO_SELLER로 거부한다", async () => {
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA" });
    seedCampaign({ id: "c2", sellerId: "s2", dealId: "dB" });

    await expect(campaignGroupService.createGroup(["c1", "c2"])).rejects.toMatchObject({
      code: "HETERO_SELLER",
      status: 409,
    });
    expect(hoisted.state.groups.size).toBe(0);
  });

  it("멤버 2개 미만은 TOO_FEW_MEMBERS(400)", async () => {
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA" });
    await expect(campaignGroupService.createGroup(["c1"])).rejects.toBeInstanceOf(CampaignGroupError);
    await expect(campaignGroupService.createGroup(["c1", "c1"])).rejects.toMatchObject({
      code: "TOO_FEW_MEMBERS",
      status: 400,
    });
  });

  it("이미 그룹에 속한 캠페인은 ALREADY_GROUPED(409) — 병합 미지원", async () => {
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA" });
    seedCampaign({ id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z") });
    seedCampaign({ id: "c3", sellerId: "s1", dealId: "dC", startDate: new Date("2026-07-04Z") });

    await campaignGroupService.createGroup(["c1", "c2"]);

    await expect(campaignGroupService.createGroup(["c2", "c3"])).rejects.toMatchObject({
      code: "ALREADY_GROUPED",
      status: 409,
    });
  });
});

describe("campaignGroupService.removeMembers", () => {
  it("남은 멤버가 1개면 그룹을 자동 해체한다", async () => {
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA" });
    seedCampaign({ id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z") });
    const group = await campaignGroupService.createGroup(["c1", "c2"]);

    const result = await campaignGroupService.removeMembers(group.id, ["c1"]);

    expect(result.dissolved).toBe(true);
    expect(result.group).toBeNull();
    expect(hoisted.state.groups.size).toBe(0);
    expect(hoisted.state.campaigns.get("c1")!.groupId).toBeNull();
    expect(hoisted.state.campaigns.get("c2")!.groupId).toBeNull();
  });

  it("2개 이상 남으면 그룹 유지 + 롤업/이름 재계산", async () => {
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA", deal: { dealName: "비타민" } });
    seedCampaign({ id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z"), deal: { dealName: "글로우" } });
    seedCampaign({ id: "c3", sellerId: "s1", dealId: "dC", startDate: new Date("2026-07-04Z"), deal: { dealName: "콜라겐" } });
    const group = await campaignGroupService.createGroup(["c1", "c2", "c3"]);

    const result = await campaignGroupService.removeMembers(group.id, ["c3"]);

    expect(result.dissolved).toBe(false);
    expect(result.group!.name).toBe("[가온] 비타민 외 1건");
    expect(hoisted.state.campaigns.get("c3")!.groupId).toBeNull();
  });
});

describe("campaignGroupService.addMembers", () => {
  it("같은 셀러 캠페인을 추가하고 이름을 재생성한다", async () => {
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA", deal: { dealName: "비타민" } });
    seedCampaign({ id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z") });
    seedCampaign({ id: "c3", sellerId: "s1", dealId: "dC", startDate: new Date("2026-07-04Z") });
    const group = await campaignGroupService.createGroup(["c1", "c2"]);

    const updated = await campaignGroupService.addMembers(group.id, ["c3"]);

    expect(updated.name).toBe("[가온] 비타민 외 2건");
    expect(hoisted.state.campaigns.get("c3")!.groupId).toBe(group.id);
  });

  it("다른 그룹에 속한 캠페인 추가는 ALREADY_GROUPED(409)", async () => {
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA" });
    seedCampaign({ id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z") });
    seedCampaign({ id: "c3", sellerId: "s1", dealId: "dC", startDate: new Date("2026-07-04Z") });
    seedCampaign({ id: "c4", sellerId: "s1", dealId: "dD", startDate: new Date("2026-07-05Z") });
    const g1 = await campaignGroupService.createGroup(["c1", "c2"]);
    await campaignGroupService.createGroup(["c3", "c4"]);

    await expect(campaignGroupService.addMembers(g1.id, ["c3"])).rejects.toMatchObject({
      code: "ALREADY_GROUPED",
      status: 409,
    });
  });

  it("이종 셀러 추가는 409 HETERO_SELLER", async () => {
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA" });
    seedCampaign({ id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z") });
    seedCampaign({ id: "x1", sellerId: "s2", dealId: "dX" });
    const group = await campaignGroupService.createGroup(["c1", "c2"]);

    await expect(campaignGroupService.addMembers(group.id, ["x1"])).rejects.toMatchObject({
      code: "HETERO_SELLER",
    });
  });
});

describe("정산 블록 승계 (그룹 형성 시 멤버 예정일 → 그룹)", () => {
  it("createGroup은 멤버 예정일을 그룹으로 승계한다 — 예정일은 멤버 max", async () => {
    seedCampaign({
      id: "c1", sellerId: "s1", dealId: "dA",
      expectedDepositDate: new Date("2026-07-10Z"),
      expectedPayoutDate: new Date("2026-07-20Z"),
    });
    seedCampaign({
      id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z"),
      expectedDepositDate: new Date("2026-07-14Z"),
      expectedPayoutDate: null,
    });

    const group = await campaignGroupService.createGroup(["c1", "c2"]);

    // 그룹당 1회 합산 정산(D1) — 마지막 캠페인 이후 정산되므로 가장 늦은 예정일이 대표.
    expect(group.expectedDepositDate?.getTime()).toBe(new Date("2026-07-14Z").getTime());
    // 한 멤버만 값이 있어도 non-null 중에서 승계된다.
    expect(group.expectedPayoutDate?.getTime()).toBe(new Date("2026-07-20Z").getTime());
    // 미완료 멤버가 있으므로 완료 플래그는 승계되지 않는다.
    expect(group.isDepositReceived).toBe(false);
    expect(group.depositReceivedAt).toBeNull();
  });

  it("전 멤버 완료일 때만 완료 플래그+완료시각(max)을 페어로 승계한다", async () => {
    seedCampaign({
      id: "c1", sellerId: "s1", dealId: "dA",
      isDepositReceived: true, depositReceivedAt: new Date("2026-07-11Z"),
      isPayoutCompleted: true, payoutCompletedAt: new Date("2026-07-21Z"),
    });
    seedCampaign({
      id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z"),
      isDepositReceived: true, depositReceivedAt: new Date("2026-07-13Z"),
      isPayoutCompleted: false, payoutCompletedAt: null,
    });

    const group = await campaignGroupService.createGroup(["c1", "c2"]);

    expect(group.isDepositReceived).toBe(true);
    expect(group.depositReceivedAt?.getTime()).toBe(new Date("2026-07-13Z").getTime());
    // 지급은 혼합(부분 완료) — 합산 정산이 부분 완료일 수 없으므로 false 유지.
    expect(group.isPayoutCompleted).toBe(false);
    expect(group.payoutCompletedAt).toBeNull();
  });

  it("addMembers는 정산 블록을 재승계하지 않는다(형성 1회 한정 — 오너 삭제 되살림 방지)", async () => {
    // 형성 시 예정일 없던 그룹. 이후 오너가 지운 블록을 새 멤버 값으로 되살리지 않아야 한다.
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA" });
    seedCampaign({ id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z") });
    seedCampaign({
      id: "c3", sellerId: "s1", dealId: "dC", startDate: new Date("2026-07-04Z"),
      expectedDepositDate: new Date("2026-07-30Z"),
      expectedPayoutDate: new Date("2026-08-05Z"),
    });
    const group = await campaignGroupService.createGroup(["c1", "c2"]);
    expect(group.expectedDepositDate).toBeNull(); // 형성 시 멤버 예정일 없음 → virgin 유지

    const updated = await campaignGroupService.addMembers(group.id, ["c3"]);

    // 새 멤버 c3의 예정일이 그룹으로 흘러들지 않는다 — 승계는 형성 시 1회뿐.
    expect(updated.expectedDepositDate).toBeNull();
    expect(updated.expectedPayoutDate).toBeNull();
  });

  it("멤버 전원이 예정일 없음이면 그룹 블록은 null/false 그대로다(no-op)", async () => {
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA" });
    seedCampaign({ id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z") });

    const group = await campaignGroupService.createGroup(["c1", "c2"]);

    expect(group.expectedDepositDate).toBeNull();
    expect(group.expectedPayoutDate).toBeNull();
    expect(group.isDepositReceived).toBe(false);
    expect(group.isPayoutCompleted).toBe(false);
  });
});

describe("campaignGroupService.dissolveGroup", () => {
  it("모든 멤버를 언그룹하고 그룹을 삭제한다", async () => {
    seedCampaign({ id: "c1", sellerId: "s1", dealId: "dA" });
    seedCampaign({ id: "c2", sellerId: "s1", dealId: "dB", startDate: new Date("2026-07-03Z") });
    const group = await campaignGroupService.createGroup(["c1", "c2"]);

    const result = await campaignGroupService.dissolveGroup(group.id);

    expect(result).toEqual({ dissolved: true });
    expect(hoisted.state.groups.size).toBe(0);
    expect(hoisted.state.campaigns.get("c1")!.groupId).toBeNull();
    expect(hoisted.state.campaigns.get("c2")!.groupId).toBeNull();
  });

  it("없는 그룹은 GROUP_NOT_FOUND(404)", async () => {
    await expect(campaignGroupService.dissolveGroup("nope")).rejects.toMatchObject({
      code: "GROUP_NOT_FOUND",
      status: 404,
    });
  });
});
