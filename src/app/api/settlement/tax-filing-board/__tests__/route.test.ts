// 이 라우트는 한 응답에 **서로 다른 시간 축** 두 개를 싣는다.
// 세금계산서 = 캠페인 상태 축(월 무관) · 원천징수 = 지급월 축.
// 두 축이 다시 한 필터를 공유하면 2026-08-09 에 고친 버그가 그대로 재발한다.
import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findMany, count: vi.fn().mockResolvedValue(0) },
    campaignChecklistItem: { findMany: vi.fn().mockResolvedValue([]) },
    taxFilingLog: { findMany: vi.fn().mockResolvedValue([]) },
    activityLog: { findMany: vi.fn().mockResolvedValue([]) },
  }),
}));
vi.mock("@/lib/api-auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({ authenticated: true }),
}));

describe("tax-filing-board 라우트 — 두 축이 분리돼 있다", () => {
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  it("세금계산서 쿼리는 status 로 거르고 payoutCompletedAt 을 쓰지 않는다", async () => {
    const { GET } = await import("../route");
    await GET(new Request("http://x/api/settlement/tax-filing-board?month=2026-08"));

    const invoiceQuery = findMany.mock.calls
      .map(([arg]) => arg)
      .find((arg) => JSON.stringify(arg?.where ?? {}).includes("status"));

    expect(invoiceQuery).toBeDefined();
    expect(JSON.stringify(invoiceQuery.where)).not.toContain("payoutCompletedAt");
  });

  it("원천징수 쿼리는 payoutCompletedAt 축을 그대로 쓴다", async () => {
    const { GET } = await import("../route");
    await GET(new Request("http://x/api/settlement/tax-filing-board?month=2026-08"));

    const withholdingQuery = findMany.mock.calls
      .map(([arg]) => arg)
      .find((arg) => JSON.stringify(arg?.where ?? {}).includes("payoutCompletedAt"));

    expect(withholdingQuery).toBeDefined();
  });
});
