import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const requireAuthMock = vi.fn();
const sellerFindUniqueMock = vi.fn();
const dealFindManyMock = vi.fn();
const createCampaignMock = vi.fn();
const createGroupMock = vi.fn();
const groupFindByIdOrThrowMock = vi.fn();
const campaignDeleteMock = vi.fn();
const revalidateMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    seller: { findUnique: (...a: unknown[]) => sellerFindUniqueMock(...a) },
    deal: { findMany: (...a: unknown[]) => dealFindManyMock(...a) },
  }),
}));

vi.mock("@/lib/cache-tags", () => ({
  revalidateCampaignCaches: () => revalidateMock(),
}));

vi.mock("@/lib/google-calendar-sync", () => ({
  syncCampaignToCalendar: vi.fn().mockResolvedValue(undefined),
}));

// toCampaignRow만 경량 목업 — 그룹 필드 세팅 검증이 목적. toKstDateStr 등 나머지는 실물 유지.
vi.mock("@/lib/campaign-row", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/campaign-row")>();
  return { ...actual, toCampaignRow: (c: { id: string }) => ({ id: c.id }) };
});

vi.mock("@/services/campaignService", () => ({
  campaignService: {
    createCampaign: (...a: unknown[]) => createCampaignMock(...a),
  },
}));

vi.mock("@/repositories/campaignRepository", () => ({
  campaignRepository: {
    delete: (...a: unknown[]) => campaignDeleteMock(...a),
  },
}));

vi.mock("@/services/campaignGroupService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/campaignGroupService")>();
  return {
    ...actual,
    campaignGroupService: {
      createGroup: (...a: unknown[]) => createGroupMock(...a),
    },
  };
});

vi.mock("@/repositories/campaignGroupRepository", () => ({
  campaignGroupRepository: {
    findByIdOrThrow: (...a: unknown[]) => groupFindByIdOrThrowMock(...a),
  },
}));

function groupFixture() {
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
      { id: "camp-dA", campaignName: null, status: "PROPOSAL", startDate: new Date("2026-07-01T00:00:00Z"), endDate: new Date("2026-07-05T00:00:00Z"), roundNumber: null, deal: { dealName: "비타민" } },
      { id: "camp-dB", campaignName: null, status: "PROPOSAL", startDate: new Date("2026-07-03T00:00:00Z"), endDate: new Date("2026-07-08T00:00:00Z"), roundNumber: null, deal: { dealName: "글로우" } },
    ],
  };
}

function postRequest(body: unknown) {
  return new Request("http://localhost:3000/api/campaigns/bulk-combo", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const validBody = {
  sellerId: "s1",
  dealIds: ["dA", "dB"],
  startDate: "2026-07-01",
  endDate: "2026-07-08",
};

beforeEach(() => {
  [requireAuthMock, sellerFindUniqueMock, dealFindManyMock, createCampaignMock, createGroupMock, groupFindByIdOrThrowMock, campaignDeleteMock, revalidateMock].forEach((m) => m.mockReset());
  requireAuthMock.mockResolvedValue({ authenticated: true, context: { userId: "u1", email: "u@x.com" } });
  sellerFindUniqueMock.mockResolvedValue({ id: "s1" });
  dealFindManyMock.mockResolvedValue([{ id: "dA" }, { id: "dB" }]);
  createCampaignMock.mockImplementation(async (input: { dealId: string }) => ({ id: `camp-${input.dealId}` }));
  createGroupMock.mockResolvedValue({ id: "g1" });
  groupFindByIdOrThrowMock.mockResolvedValue(groupFixture());
  campaignDeleteMock.mockResolvedValue(undefined);
});

describe("POST /api/campaigns/bulk-combo", () => {
  it("딜별 실제 생성 + 그룹 동시 생성 → 201 { created, group }", async () => {
    const response = await POST(postRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(createCampaignMock).toHaveBeenCalledTimes(2);
    // 실제 생성 경로 인자: 링크 빈값·PROPOSAL·salesChannel 기본 UNSPECIFIED
    expect(createCampaignMock.mock.calls[0][0]).toMatchObject({
      dealId: "dA",
      sellerId: "s1",
      startDate: "2026-07-01",
      endDate: "2026-07-08",
      salesChannel: "UNSPECIFIED",
      baseNaverLink: "",
      status: "PROPOSAL",
      isManualMargin: false,
    });
    expect(createCampaignMock.mock.calls[0][1]).toEqual({ userId: "u1", email: "u@x.com" });

    expect(createGroupMock).toHaveBeenCalledWith(["camp-dA", "camp-dB"]);
    expect(body.created).toHaveLength(2);
    expect(body.created[0]).toMatchObject({ id: "camp-dA", groupId: "g1", groupMemberCount: 2 });
    expect(body.group).toMatchObject({ id: "g1", memberCount: 2, name: "[가온] 비타민 외 1건" });
    expect(revalidateMock).toHaveBeenCalled();
  });

  it("salesChannel을 넘기면 그대로 사용", async () => {
    await POST(postRequest({ ...validBody, salesChannel: "OWN_MALL" }));
    expect(createCampaignMock.mock.calls[0][0].salesChannel).toBe("OWN_MALL");
  });

  it("사전 검증: 일부 딜 없음 → 400, 0건 생성", async () => {
    dealFindManyMock.mockResolvedValue([{ id: "dA" }]); // dB 없음
    const response = await POST(postRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.missingDealIds).toEqual(["dB"]);
    expect(createCampaignMock).not.toHaveBeenCalled();
    expect(createGroupMock).not.toHaveBeenCalled();
  });

  it("사전 검증: 셀러 없음 → 400, 0건 생성", async () => {
    sellerFindUniqueMock.mockResolvedValue(null);
    const response = await POST(postRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.sellerFound).toBe(false);
    expect(createCampaignMock).not.toHaveBeenCalled();
  });

  it("dealIds 2개 미만은 400(zod)", async () => {
    const response = await POST(postRequest({ ...validBody, dealIds: ["dA"] }));
    expect(response.status).toBe(400);
    expect(createCampaignMock).not.toHaveBeenCalled();
  });

  it("중복 제거 후 2개 미만이면 400", async () => {
    const response = await POST(postRequest({ ...validBody, dealIds: ["dA", "dA"] }));
    expect(response.status).toBe(400);
    expect(createCampaignMock).not.toHaveBeenCalled();
  });

  it("all-or-nothing: 그룹 생성 실패 시 생성된 캠페인을 보상 삭제", async () => {
    createGroupMock.mockRejectedValue(new Error("db fail"));

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(500);
    expect(createCampaignMock).toHaveBeenCalledTimes(2);
    // 두 캠페인 모두 보상 삭제
    const deletedIds = campaignDeleteMock.mock.calls.map((c) => c[0]).sort();
    expect(deletedIds).toEqual(["camp-dA", "camp-dB"]);
  });

  it("all-or-nothing: 중간 캠페인 생성 실패 시 앞서 만든 것만 보상 삭제", async () => {
    createCampaignMock.mockReset();
    createCampaignMock
      .mockResolvedValueOnce({ id: "camp-dA" })
      .mockRejectedValueOnce(new Error("create fail"));

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(500);
    expect(createGroupMock).not.toHaveBeenCalled();
    expect(campaignDeleteMock.mock.calls.map((c) => c[0])).toEqual(["camp-dA"]);
  });

  it("인증 실패 시 단락", async () => {
    requireAuthMock.mockResolvedValueOnce({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(401);
    expect(createCampaignMock).not.toHaveBeenCalled();
  });
});
