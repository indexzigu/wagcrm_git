import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listUsers = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { admin: { listUsers } } }),
}));

const { getCrmAccounts } = await import("@/lib/user-registry");
const { resetUserCache } = await import("@/lib/user-registry");
const { DEFAULT_ADMIN_EMAILS } = await import("@/lib/auth-allowlist");

const OWNER_EMAIL = DEFAULT_ADMIN_EMAILS[0];

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  resetUserCache();
  listUsers.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetUserCache();
});

describe("getCrmAccounts", () => {
  it("상태·역할·부여자를 함께 돌려준다", async () => {
    listUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: "1",
            email: "staff@example.com",
            app_metadata: {
              status: "approved",
              role: "operator",
              grantedBy: "owner@example.com",
              grantedAt: "2026-08-08T00:00:00.000Z",
            },
            user_metadata: { display_name: "직원" },
            last_sign_in_at: "2026-08-08T01:00:00.000Z",
          },
        ],
      },
      error: null,
    });

    const accounts = await getCrmAccounts();
    expect(accounts[0]).toMatchObject({
      email: "staff@example.com",
      displayName: "직원",
      status: "approved",
      role: "operator",
      isOwnerFloor: false,
      grantedBy: "owner@example.com",
      lastSignInAt: "2026-08-08T01:00:00.000Z",
    });
  });

  it("status 가 없는 계정은 대기로 나온다", async () => {
    listUsers.mockResolvedValue({
      data: { users: [{ id: "2", email: "new@example.com", app_metadata: {}, user_metadata: {} }] },
      error: null,
    });
    const accounts = await getCrmAccounts();
    expect(accounts[0].status).toBe("pending");
  });

  it("오너 바닥 계정은 isOwnerFloor 로 표시된다", async () => {
    listUsers.mockResolvedValue({
      data: { users: [{ id: "3", email: OWNER_EMAIL, app_metadata: {}, user_metadata: {} }] },
      error: null,
    });
    const accounts = await getCrmAccounts();
    expect(accounts[0]).toMatchObject({ isOwnerFloor: true, status: "approved", role: "admin" });
  });

  it("조회 실패는 삼키지 않고 던진다", async () => {
    listUsers.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getCrmAccounts()).rejects.toThrow(/boom/);
  });

  it("페이지를 끝까지 돌아 모든 계정을 가져온다 (한 페이지만 읽으면 뒷부분이 조용히 사라진다)", async () => {
    // 첫 호출이 "가득 찬" 페이지를 돌려주면 다음 페이지를 더 읽어야 한다.
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      id: `p1-${i}`,
      email: `user${i}@example.com`,
      app_metadata: { status: "approved" },
      user_metadata: {},
    }));
    listUsers
      .mockResolvedValueOnce({ data: { users: fullPage }, error: null })
      .mockResolvedValueOnce({
        data: {
          users: [
            {
              id: "p2-0",
              email: "tail@example.com",
              app_metadata: { status: "approved" },
              user_metadata: {},
            },
          ],
        },
        error: null,
      });

    const accounts = await getCrmAccounts();
    expect(accounts).toHaveLength(201);
    expect(accounts.at(-1)?.email).toBe("tail@example.com");
    expect(listUsers).toHaveBeenCalledTimes(2);
    expect(listUsers.mock.calls[0][0]).toMatchObject({ page: 1 });
    expect(listUsers.mock.calls[1][0]).toMatchObject({ page: 2 });
  });
});
