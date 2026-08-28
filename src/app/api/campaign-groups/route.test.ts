import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((callback: () => unknown) => callback()),
  };
});

const requireAuthMock = vi.fn();
const createGroupMock = vi.fn();
const findByIdOrThrowMock = vi.fn();
const syncGroupToCalendarMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

vi.mock("@/lib/cache-tags", () => ({
  revalidateCampaignCaches: vi.fn(),
}));

vi.mock("@/lib/google-calendar-sync", () => ({
  syncGroupToCalendar: (...args: unknown[]) => syncGroupToCalendarMock(...args),
}));

vi.mock("@/services/campaignGroupService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/campaignGroupService")>();
  return {
    ...actual,
    campaignGroupService: {
      createGroup: (...args: unknown[]) => createGroupMock(...args),
    },
  };
});

vi.mock("@/repositories/campaignGroupRepository", () => ({
  campaignGroupRepository: {
    findByIdOrThrow: (...args: unknown[]) => findByIdOrThrowMock(...args),
  },
}));

import { CampaignGroupError } from "@/services/campaignGroupService";

function groupFixture(over: Record<string, unknown> = {}) {
  return {
    id: "g1",
    sellerId: "s1",
    name: "[가온] 비타민 외 1건",
    startDate: new Date("2026-07-01T00:00:00Z"),
    endDate: new Date("2026-07-08T00:00:00Z"),
    expectedDepositDate: null,
    depositReceivedAt: null,
    isDepositReceived: false,
    expectedPayoutDate: null,
    payoutCompletedAt: null,
    isPayoutCompleted: false,
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    accountingCompletedAt: null,
    returnPeriodEndDate: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    seller: { name: "김본명", alias: "가온" },
    members: [
      { id: "c1", campaignName: "비타민 - 가온", status: "PROPOSAL", startDate: new Date("2026-07-01T00:00:00Z"), endDate: new Date("2026-07-05T00:00:00Z"), roundNumber: null, deal: { dealName: "비타민" } },
      { id: "c2", campaignName: "글로우 - 가온", status: "PROPOSAL", startDate: new Date("2026-07-03T00:00:00Z"), endDate: new Date("2026-07-08T00:00:00Z"), roundNumber: null, deal: { dealName: "글로우" } },
    ],
    ...over,
  };
}

function postRequest(body: unknown) {
  return new Request("http://localhost:3000/api/campaign-groups", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/campaign-groups", () => {
  beforeEach(() => {
    requireAuthMock.mockReset();
    createGroupMock.mockReset();
    findByIdOrThrowMock.mockReset();
    syncGroupToCalendarMock.mockReset();
    requireAuthMock.mockResolvedValue({ authenticated: true, context: { userId: "u1", email: "u@x.com" } });
    syncGroupToCalendarMock.mockResolvedValue({ ok: true });
  });

  it("2건을 묶어 201 + 그룹 상세(멤버 포함)를 반환한다", async () => {
    createGroupMock.mockResolvedValue({ id: "g1" });
    findByIdOrThrowMock.mockResolvedValue(groupFixture());

    const response = await POST(postRequest({ campaignIds: ["c1", "c2"] }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(createGroupMock).toHaveBeenCalledWith(["c1", "c2"]);
    // CG-3: 그룹 형성 훅 — 멤버 개별 이벤트 정리 + 그룹 이벤트 생성
    expect(syncGroupToCalendarMock).toHaveBeenCalledWith("g1");
    expect(body.id).toBe("g1");
    expect(body.name).toBe("[가온] 비타민 외 1건");
    expect(body.memberCount).toBe(2);
    expect(body.members).toHaveLength(2);
    expect(body.members[0]).toMatchObject({ campaignId: "c1", dealName: "비타민", status: "PROPOSAL" });
  });

  it("campaignIds가 2개 미만이면 400(zod)", async () => {
    const response = await POST(postRequest({ campaignIds: ["c1"] }));
    expect(response.status).toBe(400);
    expect(createGroupMock).not.toHaveBeenCalled();
  });

  it("이종 셀러는 서비스 에러를 409로 매핑한다", async () => {
    createGroupMock.mockRejectedValue(new CampaignGroupError("HETERO_SELLER", "그룹 멤버는 모두 같은 셀러여야 합니다."));

    const response = await POST(postRequest({ campaignIds: ["c1", "c2"] }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("HETERO_SELLER");
  });

  it("이미 그룹 소속이면 409 ALREADY_GROUPED", async () => {
    createGroupMock.mockRejectedValue(new CampaignGroupError("ALREADY_GROUPED", "이미 다른 그룹에 속해 있습니다."));

    const response = await POST(postRequest({ campaignIds: ["c1", "c2"] }));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("ALREADY_GROUPED");
  });

  it("인증 실패 시 단락한다", async () => {
    requireAuthMock.mockResolvedValueOnce({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });

    const response = await POST(postRequest({ campaignIds: ["c1", "c2"] }));
    expect(response.status).toBe(401);
    expect(createGroupMock).not.toHaveBeenCalled();
  });
});
