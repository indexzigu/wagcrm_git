/**
 * getAuthContext 신뢰 헤더 경로 검증.
 * 미들웨어가 심어둔 x-wag-verified-user 헤더가 있으면 supabase.auth.getUser()를
 * 다시 호출하지 않고 그 값을 그대로 쓰는지, 헤더가 없거나 손상됐을 때 기존 경로
 * (getUser 재검증)로 안전하게 폴백하는지 확인한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUserMock = vi.fn();
const headersGetMock = vi.fn();
const cookiesGetMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
  }),
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (...args: unknown[]) => headersGetMock(...args) }),
  cookies: async () => ({ get: (...args: unknown[]) => cookiesGetMock(...args) }),
}));

import { TRUSTED_USER_HEADER } from "@/lib/supabase/middleware";
import { getAuthContext } from "./auth-context";

describe("getAuthContext", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    headersGetMock.mockReset();
    cookiesGetMock.mockReset();
    headersGetMock.mockReturnValue(null);
    cookiesGetMock.mockReturnValue(undefined);
  });

  it("미들웨어 신뢰 헤더가 있으면 getUser()를 재호출하지 않고 그 값을 그대로 쓴다", async () => {
    headersGetMock.mockImplementation((name: string) =>
      name === TRUSTED_USER_HEADER
        ? encodeURIComponent(JSON.stringify({ id: "u1", email: "a@b.com", role: "admin" }))
        : null,
    );

    const ctx = await getAuthContext();

    expect(ctx).toEqual({ userId: "u1", email: "a@b.com", role: "admin" });
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("헤더가 없으면 기존 경로(getUser 재검증)로 동작한다", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u2", email: "user@example.com", app_metadata: { role: "admin" } } },
    });

    const ctx = await getAuthContext();

    expect(ctx).toEqual({ userId: "u2", email: "user@example.com", role: "admin" });
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("헤더가 손상돼도(디코딩 실패) 안전하게 getUser() 경로로 폴백한다", async () => {
    headersGetMock.mockImplementation((name: string) =>
      name === TRUSTED_USER_HEADER ? "%zz-broken-encoding" : null,
    );
    getUserMock.mockResolvedValue({ data: { user: null } });

    const ctx = await getAuthContext();

    expect(ctx).toBeNull();
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("헤더 값이 JSON이지만 id가 없으면(불완전) getUser() 경로로 폴백한다", async () => {
    headersGetMock.mockImplementation((name: string) =>
      name === TRUSTED_USER_HEADER ? encodeURIComponent(JSON.stringify({ email: "no-id@example.com" })) : null,
    );
    getUserMock.mockResolvedValue({
      data: { user: { id: "u3", email: "real@example.com", app_metadata: { role: "admin" } } },
    });

    const ctx = await getAuthContext();

    expect(ctx).toEqual({ userId: "u3", email: "real@example.com", role: "admin" });
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("헤더의 role 이 알 수 없는 값이면 admin 으로 승격하지 않는다", async () => {
    // 구버전·손상 헤더를 그대로 믿어 admin 을 주던 경로를 막는다(fail-closed) —
    // 허가목록에 admin 이 아닌 이메일이므로 operator 로 떨어져야 한다.
    headersGetMock.mockImplementation((name: string) =>
      name === TRUSTED_USER_HEADER
        ? encodeURIComponent(JSON.stringify({ id: "u4", email: "staff@example.com", role: "superuser" }))
        : null,
    );

    const ctx = await getAuthContext();

    expect(ctx).toEqual({ userId: "u4", email: "staff@example.com", role: "operator" });
    expect(getUserMock).not.toHaveBeenCalled();
  });
});
