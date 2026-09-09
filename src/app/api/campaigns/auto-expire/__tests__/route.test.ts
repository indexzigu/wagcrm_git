import { describe, expect, it, vi, beforeEach } from "vitest";
import { POST } from "../route";

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/campaign-status-sync", () => ({
  syncCampaignStatusesBySchedule: vi.fn().mockResolvedValue({
    totalChecked: 5,
    expiredToClosedCount: 2,
    startedToActiveCount: 1,
    updatedCampaignIds: ["c1", "c2", "c3"],
  }),
}));

import { getAuthContext } from "@/lib/auth-context";
import { syncCampaignStatusesBySchedule } from "@/lib/campaign-status-sync";

describe("POST /api/campaigns/auto-expire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("인증되지 않은 요청은 401을 반환한다", async () => {
    vi.mocked(getAuthContext).mockResolvedValue(null);

    const request = new Request("https://crm.ygrd.kr/api/campaigns/auto-expire", {
      method: "POST",
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("인증된 요청은 syncCampaignStatusesBySchedule을 호출하고 결과를 반환한다", async () => {
    vi.mocked(getAuthContext).mockResolvedValue({
      userId: "user-1",
      email: "owner@ygrd.kr",
      role: "admin",
    } as any);

    const request = new Request("https://crm.ygrd.kr/api/campaigns/auto-expire", {
      method: "POST",
      body: JSON.stringify({ dryRun: false }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.result.expiredToClosedCount).toBe(2);
    expect(syncCampaignStatusesBySchedule).toHaveBeenCalledWith(expect.anything(), expect.any(Date), {
      dryRun: false,
      activateStarted: true,
    });
  });
});
