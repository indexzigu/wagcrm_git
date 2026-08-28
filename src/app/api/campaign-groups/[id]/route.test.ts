import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH, DELETE } from "./route";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((callback: () => unknown) => callback()),
  };
});

const requireAuthMock = vi.fn();
const removeMembersMock = vi.fn();
const addMembersMock = vi.fn();
const renameGroupMock = vi.fn();
const dissolveGroupMock = vi.fn();
const findByIdMock = vi.fn();
const syncGroupToCalendarMock = vi.fn();
const syncCampaignToCalendarMock = vi.fn();
const deleteCampaignCalendarEventsMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

vi.mock("@/lib/cache-tags", () => ({
  revalidateCampaignCaches: vi.fn(),
}));

vi.mock("@/lib/google-calendar-sync", () => ({
  syncGroupToCalendar: (...args: unknown[]) => syncGroupToCalendarMock(...args),
  syncCampaignToCalendar: (...args: unknown[]) => syncCampaignToCalendarMock(...args),
  deleteCampaignCalendarEvents: (...args: unknown[]) => deleteCampaignCalendarEventsMock(...args),
}));

vi.mock("@/services/campaignGroupService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/campaignGroupService")>();
  return {
    ...actual,
    campaignGroupService: {
      removeMembers: (...args: unknown[]) => removeMembersMock(...args),
      addMembers: (...args: unknown[]) => addMembersMock(...args),
      renameGroup: (...args: unknown[]) => renameGroupMock(...args),
      dissolveGroup: (...args: unknown[]) => dissolveGroupMock(...args),
    },
  };
});

vi.mock("@/repositories/campaignGroupRepository", () => ({
  campaignGroupRepository: {
    findById: (...args: unknown[]) => findByIdMock(...args),
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

const ctx = { params: Promise.resolve({ id: "g1" }) };

function patchRequest(body: unknown) {
  return new Request("http://localhost:3000/api/campaign-groups/g1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  [requireAuthMock, removeMembersMock, addMembersMock, renameGroupMock, dissolveGroupMock, findByIdMock, syncGroupToCalendarMock, syncCampaignToCalendarMock, deleteCampaignCalendarEventsMock].forEach((m) => m.mockReset());
  requireAuthMock.mockResolvedValue({ authenticated: true, context: { userId: "u1", email: "u@x.com" } });
  syncGroupToCalendarMock.mockResolvedValue({ ok: true });
  syncCampaignToCalendarMock.mockResolvedValue({ ok: true });
  deleteCampaignCalendarEventsMock.mockResolvedValue({ ok: true });
});

describe("GET /api/campaign-groups/[id]", () => {
  it("그룹 상세를 반환한다", async () => {
    findByIdMock.mockResolvedValue(groupFixture());
    const response = await GET(new Request("http://localhost/x"), ctx);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.id).toBe("g1");
    expect(body.members).toHaveLength(2);
  });

  it("없는 그룹은 404", async () => {
    findByIdMock.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/x"), ctx);
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/campaign-groups/[id]", () => {
  it("멤버 제거로 해체되면 200 { dissolved: true } (404 아님)", async () => {
    // CG-3: 해체 전 장부 확보용 findById → 그룹 이벤트 정리 + 전 멤버 개별 복귀 동기화
    findByIdMock.mockResolvedValue(
      groupFixture({ calendarEventIds: JSON.stringify({ campaign: "g-ev" }) }),
    );
    removeMembersMock.mockResolvedValue({ dissolved: true, group: null });

    const response = await PATCH(patchRequest({ removeCampaignIds: ["c1"] }), ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ dissolved: true });
    expect(deleteCampaignCalendarEventsMock).toHaveBeenCalledWith(
      JSON.stringify({ campaign: "g-ev" }),
    );
    expect(syncCampaignToCalendarMock).toHaveBeenCalledWith("c1");
    expect(syncCampaignToCalendarMock).toHaveBeenCalledWith("c2");
  });

  it("멤버 제거 후 유지되면 갱신된 상세 반환", async () => {
    removeMembersMock.mockResolvedValue({ dissolved: false, group: { id: "g1" } });
    findByIdMock.mockResolvedValue(groupFixture());

    const response = await PATCH(patchRequest({ removeCampaignIds: ["c3"] }), ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.memberCount).toBe(2);
    expect(removeMembersMock).toHaveBeenCalledWith("g1", ["c3"]);
  });

  it("멤버 추가는 addMembers 경유 후 상세 반환", async () => {
    addMembersMock.mockResolvedValue({ id: "g1" });
    findByIdMock.mockResolvedValue(groupFixture());

    const response = await PATCH(patchRequest({ addCampaignIds: ["c3"] }), ctx);
    expect(response.status).toBe(200);
    expect(addMembersMock).toHaveBeenCalledWith("g1", ["c3"]);
  });

  it("이름 변경은 renameGroup 경유", async () => {
    renameGroupMock.mockResolvedValue({ id: "g1" });
    findByIdMock.mockResolvedValue(groupFixture({ name: "새 이름" }));

    const response = await PATCH(patchRequest({ name: "새 이름" }), ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(renameGroupMock).toHaveBeenCalledWith("g1", "새 이름");
    expect(body.name).toBe("새 이름");
  });

  it("빈 이름은 자동 이름 복귀(renameGroup에 빈 문자열 전달)", async () => {
    renameGroupMock.mockResolvedValue({ id: "g1" });
    findByIdMock.mockResolvedValue(groupFixture());

    await PATCH(patchRequest({ name: "" }), ctx);
    expect(renameGroupMock).toHaveBeenCalledWith("g1", "");
  });

  it("없는 그룹 조작은 서비스 에러를 404로 매핑", async () => {
    addMembersMock.mockRejectedValue(new CampaignGroupError("GROUP_NOT_FOUND", "그룹을 찾을 수 없습니다."));

    const response = await PATCH(patchRequest({ addCampaignIds: ["c3"] }), ctx);
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("GROUP_NOT_FOUND");
  });
});

describe("DELETE /api/campaign-groups/[id]", () => {
  it("그룹을 해체하고 { dissolved: true }", async () => {
    dissolveGroupMock.mockResolvedValue({ dissolved: true });
    const response = await DELETE(new Request("http://localhost/x"), ctx);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ dissolved: true });
  });

  it("없는 그룹 해체는 404", async () => {
    dissolveGroupMock.mockRejectedValue(new CampaignGroupError("GROUP_NOT_FOUND", "그룹을 찾을 수 없습니다."));
    const response = await DELETE(new Request("http://localhost/x"), ctx);
    expect(response.status).toBe(404);
  });
});
