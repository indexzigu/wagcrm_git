import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { resolveCampaignContentScope } from "../campaign-group-scope";

// 그룹(조합) 캠페인 콘텐츠 공유 스코프 계약: 미그룹=자기 자신, 그룹=멤버 전체 id + 기간 포락선.
function mockPrisma(members: Array<{ id: string; startDate: Date; endDate: Date }>) {
  return {
    salesCampaign: { findMany: vi.fn(async () => members) },
  } as unknown as PrismaClient;
}

describe("resolveCampaignContentScope", () => {
  it("미그룹 캠페인은 자기 자신과 자기 기간만 반환한다", async () => {
    const prisma = mockPrisma([]);
    const scope = await resolveCampaignContentScope(prisma, {
      id: "c1",
      groupId: null,
      startDate: new Date("2026-07-10"),
      endDate: new Date("2026-07-19"),
    });
    expect(scope.campaignIds).toEqual(["c1"]);
    expect(scope.startDate?.toISOString().slice(0, 10)).toBe("2026-07-10");
  });

  it("그룹 캠페인은 멤버 전체 id와 기간 포락선(min~max)을 반환한다", async () => {
    const prisma = mockPrisma([
      { id: "c1", startDate: new Date("2026-07-12"), endDate: new Date("2026-07-19") },
      { id: "c2", startDate: new Date("2026-07-10"), endDate: new Date("2026-07-15") },
      { id: "c3", startDate: new Date("2026-07-14"), endDate: new Date("2026-07-22") },
    ]);
    const scope = await resolveCampaignContentScope(prisma, {
      id: "c1",
      groupId: "g1",
      startDate: new Date("2026-07-12"),
      endDate: new Date("2026-07-19"),
    });
    expect([...scope.campaignIds].sort()).toEqual(["c1", "c2", "c3"]);
    expect(scope.startDate?.toISOString().slice(0, 10)).toBe("2026-07-10");
    expect(scope.endDate?.toISOString().slice(0, 10)).toBe("2026-07-22");
  });

  it("멤버 조회가 비어도(경합 등) 자기 자신은 항상 포함된다", async () => {
    const prisma = mockPrisma([]);
    const scope = await resolveCampaignContentScope(prisma, {
      id: "c1",
      groupId: "g1",
      startDate: new Date("2026-07-12"),
      endDate: new Date("2026-07-19"),
    });
    expect(scope.campaignIds).toEqual(["c1"]);
  });
});
