// 매일 자동 확인 작업의 조회 대상 읽기(오너 확정 2026-10-21). 이름·id 는 가공이다(P0).
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { loadInvoiceLookupTargets } from "./campaign-facts";

type Row = { id: string; groupId: string | null; status: string; startDate: Date; endDate: Date };

/** KST 자정 = 전날 15:00Z — 운영 저장값과 같은 꼴로 만든다. */
function kst(ymd: string): Date {
  return new Date(Date.parse(`${ymd}T00:00:00+09:00`));
}

function fakePrisma(rows: Row[], groupMembers: Array<{ id: string; groupId: string; startDate: Date }>) {
  const findMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
    if ("groupId" in args.where) {
      const ids = (args.where.groupId as { in: string[] }).in;
      return groupMembers.filter((member) => ids.includes(member.groupId)).map(({ id, startDate }) => ({ id, startDate }));
    }
    return rows;
  });
  return { prisma: { salesCampaign: { findMany } } as unknown as PrismaClient, findMany };
}

const NOW = new Date("2026-10-21T03:00:00.000Z"); // KST 10/21 12:00

describe("loadInvoiceLookupTargets", () => {
  it("DB 는 정산 단계로만 거르고, 종료 후 60일은 KST 날짜로 다시 판정한다", async () => {
    const { prisma, findMany } = fakePrisma(
      [
        { id: "in", groupId: null, status: "SETTLEMENT_WAIT", startDate: kst("2026-09-01"), endDate: kst("2026-09-10") },
        // 종료 8/22 → 마지막 날 10/21 = 오늘(당일 포함이라 대상)
        { id: "edge", groupId: null, status: "SETTLEMENT_IN_PROGRESS", startDate: kst("2026-08-20"), endDate: kst("2026-08-22") },
        // 종료 8/21 → 마지막 날 10/20 — 어제로 끝났다
        { id: "out", groupId: null, status: "SETTLEMENT_IN_PROGRESS", startDate: kst("2026-08-10"), endDate: kst("2026-08-21") },
      ],
      [],
    );
    const targets = await loadInvoiceLookupTargets(prisma, NOW);
    const where = findMany.mock.calls[0][0].where as { status: { in: string[] } };
    expect(where.status.in).toEqual(["SETTLEMENT_WAIT", "SETTLEMENT_IN_PROGRESS"]);
    expect([...targets.campaignIds].sort()).toEqual(["edge", "in"]);
    // 메일은 대상 중 가장 이른 판매 시작일(8/20)부터 — 끝난 「out」 의 8/10 이 아니다.
    expect(targets.sinceDays).toBe(63);
  });

  it("그룹이 대상이면 멤버 전원을 대상에 넣고, 먼저 시작한 멤버의 시작일부터 메일을 본다", async () => {
    const { prisma } = fakePrisma(
      [{ id: "m1", groupId: "g1", status: "SETTLEMENT_WAIT", startDate: kst("2026-10-01"), endDate: kst("2026-10-07") }],
      [
        { id: "m1", groupId: "g1", startDate: kst("2026-10-01") },
        // 날짜 판정에서는 빠졌을 멤버 — 9/1 시작
        { id: "m2", groupId: "g1", startDate: kst("2026-09-01") },
      ],
    );
    const targets = await loadInvoiceLookupTargets(prisma, NOW);
    expect([...targets.campaignIds].sort()).toEqual(["m1", "m2"]);
    expect([...targets.groupIds]).toEqual(["g1"]);
    expect(targets.sinceDays).toBe(51); // 9/1 ~ 10/21
  });

  it("대상이 없으면 조회 창도 없다(메일함을 열지 않는다)", async () => {
    const { prisma } = fakePrisma([], []);
    const targets = await loadInvoiceLookupTargets(prisma, NOW);
    expect(targets.campaignIds.size).toBe(0);
    expect(targets.sinceDays).toBeNull();
  });
});
