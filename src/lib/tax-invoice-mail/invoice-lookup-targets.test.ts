// 매일 자동 확인 작업의 조회 대상 읽기(오너 확정 2026-10-21). 이름·id 는 가공이다(P0).
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { loadInvoiceLookupTargets } from "./campaign-facts";

type Row = {
  id: string;
  groupId: string | null;
  status: string;
  startDate: Date;
  endDate: Date;
  deal: { partner: { monthlySettlement: boolean } };
};
type Member = { id: string; groupId: string; startDate: Date; endDate: Date; monthly?: boolean };

/** 일반 캠페인 행 — 판매 시작일은 일반 판정에 쓰이지 않는다. */
function row(id: string, groupId: string | null, status: string, endYmd: string, opts: { startYmd?: string; monthly?: boolean } = {}): Row {
  return {
    id,
    groupId,
    status,
    startDate: kst(opts.startYmd ?? "2026-01-01"),
    endDate: kst(endYmd),
    deal: { partner: { monthlySettlement: opts.monthly ?? false } },
  };
}

/** KST 자정 = 전날 15:00Z — 운영 저장값과 같은 꼴로 만든다. */
function kst(ymd: string): Date {
  return new Date(Date.parse(`${ymd}T00:00:00+09:00`));
}

function fakePrisma(rows: Row[], groupMembers: Member[]) {
  const findMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
    if ("groupId" in args.where) {
      const ids = (args.where.groupId as { in: string[] }).in;
      return groupMembers
        .filter((member) => ids.includes(member.groupId))
        .map(({ id, groupId, startDate, endDate, monthly }) => ({
          id,
          groupId,
          startDate,
          endDate,
          deal: { partner: { monthlySettlement: monthly ?? false } },
        }));
    }
    return rows;
  });
  return { prisma: { salesCampaign: { findMany } } as unknown as PrismaClient, findMany };
}

const NOW = new Date("2026-10-21T03:00:00.000Z"); // KST 10/21 12:00

describe("loadInvoiceLookupTargets", () => {
  it("DB 는 정산 단계로만 거르고, 종료 +10일 ~ +60일은 KST 날짜로 다시 판정한다", async () => {
    const { prisma, findMany } = fakePrisma(
      [
        row("in", null, "SETTLEMENT_WAIT", "2026-09-30"),
        // 종료 8/22 → 마지막 날 10/21 = 오늘(당일 포함이라 대상)
        row("edge", null, "SETTLEMENT_IN_PROGRESS", "2026-08-22"),
        // 종료 8/21 → 마지막 날 10/20 — 어제로 끝났다
        row("late", null, "SETTLEMENT_IN_PROGRESS", "2026-08-21"),
        // 종료 10/15 → 자동 조회 시작 10/25 — 아직 이르다
        row("early", null, "SETTLEMENT_WAIT", "2026-10-15"),
      ],
      [],
    );
    const targets = await loadInvoiceLookupTargets(prisma, NOW);
    const where = findMany.mock.calls[0][0].where as { status: { in: string[] } };
    // 월정산 캠페인이 판매 중에도 대상이라 DB 는 넓게 읽고, 일반 캠페인은 아래 판정이 다시 정산 단계로 거른다.
    expect(where.status.in).toEqual(["ACTIVE", "CLOSED", "SETTLEMENT_WAIT", "SETTLEMENT_IN_PROGRESS"]);
    expect([...targets.campaignIds].sort()).toEqual(["edge", "in"]);
    // 메일은 대상 중 가장 이른 종료일(8/22)의 +10일 = 9/1 부터 — 10/21 까지 51일.
    expect(targets.sinceDays).toBe(51);
  });

  it("그룹이 대상이면 멤버 전원을 대상에 넣고, 먼저 끝난 멤버의 종료 +10일부터 메일을 본다", async () => {
    const { prisma } = fakePrisma(
      [row("m1", "g1", "SETTLEMENT_WAIT", "2026-10-07")],
      [
        { id: "m1", groupId: "g1", startDate: kst("2026-01-01"), endDate: kst("2026-10-07") },
        // 날짜 판정에서는 빠졌을 멤버 — 9/1 종료 → 9/11 부터
        { id: "m2", groupId: "g1", startDate: kst("2026-01-01"), endDate: kst("2026-09-01") },
      ],
    );
    const targets = await loadInvoiceLookupTargets(prisma, NOW);
    expect([...targets.campaignIds].sort()).toEqual(["m1", "m2"]);
    expect([...targets.groupIds]).toEqual(["g1"]);
    expect(targets.includesUnit("g1")).toBe(true);
    expect(targets.sinceDays).toBe(41); // 9/11 ~ 10/21
  });

  it("대상이 없으면 조회 창도 없다(메일함을 열지 않는다)", async () => {
    const { prisma } = fakePrisma([], []);
    const targets = await loadInvoiceLookupTargets(prisma, NOW);
    expect(targets.campaignIds.size).toBe(0);
    expect(targets.sinceDays).toBeNull();
  });

  it("일반 캠페인은 판매중·판매마감이면 DB 에서 읽혀도 대상이 아니다", async () => {
    const { prisma } = fakePrisma(
      [row("selling", null, "ACTIVE", "2026-09-30"), row("closed", null, "CLOSED", "2026-09-30")],
      [],
    );
    const targets = await loadInvoiceLookupTargets(prisma, NOW);
    expect(targets.campaignIds.size).toBe(0);
    expect(targets.includesUnit("selling")).toBe(false);
    expect(targets.sinceDays).toBeNull();
  });
});

describe("loadInvoiceLookupTargets — 월정산 거래처 캠페인 (오너 확정 2026-10-27, T-270)", () => {
  it("판매 중인 월정산 캠페인은 월정산 단위로만 대상이고, 메일은 판매 시작일부터 본다", async () => {
    const { prisma } = fakePrisma([row("mon", null, "ACTIVE", "2026-11-30", { startYmd: "2026-09-28", monthly: true })], []);
    const targets = await loadInvoiceLookupTargets(prisma, NOW);
    expect(targets.includesUnit("mon")).toBe(true);
    // 단일 날짜 자동 확정 대상은 넓히지 않는다 — 판매 중 캠페인에 다른 날짜 칸이 자동으로 찍히지 않게.
    expect(targets.campaignIds.has("mon")).toBe(false);
    expect(targets.sinceDays).toBe(24); // 9/28 ~ 10/21
  });

  it("종료 +10일 전인 판매마감 월정산 캠페인도 대상이다(9월분 계산서가 종료 직후 온다)", async () => {
    const { prisma } = fakePrisma([row("mon", null, "CLOSED", "2026-10-15", { startYmd: "2026-10-07", monthly: true })], []);
    const targets = await loadInvoiceLookupTargets(prisma, NOW);
    expect(targets.includesUnit("mon")).toBe(true);
    expect(targets.sinceDays).toBe(15); // 10/7 ~ 10/21
  });

  it("월정산 그룹은 그룹 키로 대상이 되고 가장 먼저 시작한 멤버부터 메일을 본다", async () => {
    const { prisma } = fakePrisma(
      [row("m1", "g1", "ACTIVE", "2026-10-31", { startYmd: "2026-10-15", monthly: true })],
      [
        { id: "m1", groupId: "g1", startDate: kst("2026-10-15"), endDate: kst("2026-10-31"), monthly: true },
        { id: "m2", groupId: "g1", startDate: kst("2026-10-10"), endDate: kst("2026-10-31"), monthly: true },
      ],
    );
    const targets = await loadInvoiceLookupTargets(prisma, NOW);
    expect(targets.includesUnit("g1")).toBe(true);
    expect(targets.groupIds.has("g1")).toBe(false);
    expect(targets.campaignIds.size).toBe(0);
    expect(targets.sinceDays).toBe(12); // 10/10 ~ 10/21
  });

  it("세팅대기 월정산 캠페인은 DB 에서 읽지 않는다", async () => {
    const { prisma, findMany } = fakePrisma([], []);
    await loadInvoiceLookupTargets(prisma, NOW);
    const where = findMany.mock.calls[0][0].where as { status: { in: string[] } };
    expect(where.status.in).not.toContain("PREPARATION");
  });
});
