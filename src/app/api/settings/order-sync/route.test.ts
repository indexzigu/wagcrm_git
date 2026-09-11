import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthMock = vi.fn();
const requireRoleMock = vi.fn();
const getIntervalMock = vi.fn();
const setIntervalMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireRole: (...args: unknown[]) => requireRoleMock(...args),
}));

// 허용값 판정(isOrderAutoSyncInterval)은 실물을 쓴다 — DB 읽기·쓰기만 대체한다.
vi.mock("@/lib/order-converter/order-auto-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/order-converter/order-auto-sync")>()),
  getOrderAutoSyncIntervalHours: (...args: unknown[]) => getIntervalMock(...args),
  setOrderAutoSyncIntervalHours: (...args: unknown[]) => setIntervalMock(...args),
}));

const { GET, PATCH } = await import("./route");

const admin = { authenticated: true, context: { userId: "owner@example.com", role: "admin" } };

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/settings/order-sync", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/settings/order-sync", () => {
  beforeEach(() => {
    requireAuthMock.mockReset().mockResolvedValue(admin);
    requireRoleMock.mockReset().mockResolvedValue(admin);
    getIntervalMock.mockReset().mockResolvedValue(6);
    setIntervalMock.mockReset().mockImplementation(async (hours: number) => hours);
  });

  it("GET은 현재 간격·선택지·편집 권한을 돌려준다", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ intervalHours: 6, options: [1, 3, 6], canEdit: true });
  });

  it("PATCH는 1·3·6 밖의 값을 400으로 거절하고 저장하지 않는다", async () => {
    for (const intervalHours of [2, 0, "3", null]) {
      const response = await PATCH(patchRequest({ intervalHours }));
      expect(response.status).toBe(400);
    }
    expect(setIntervalMock).not.toHaveBeenCalled();
  });

  it("PATCH는 허용값을 저장한다", async () => {
    const response = await PATCH(patchRequest({ intervalHours: 3 }));
    expect(response.status).toBe(200);
    expect(setIntervalMock).toHaveBeenCalledWith(3);
    expect(await response.json()).toEqual({ intervalHours: 3 });
  });

  it("PATCH는 관리자만 할 수 있다", async () => {
    requireRoleMock.mockResolvedValueOnce({
      authenticated: false,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    });
    const response = await PATCH(patchRequest({ intervalHours: 1 }));
    expect(response.status).toBe(403);
    expect(requireRoleMock).toHaveBeenCalledWith("admin");
    expect(setIntervalMock).not.toHaveBeenCalled();
  });
});
