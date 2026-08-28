import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listUsers = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { admin: { listUsers } } }),
}));

const { getCrmUsers, resetUserCache } = await import("@/lib/user-registry");

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

describe("getCrmUsers", () => {
  it("페이지를 끝까지 돌아 모든 계정을 가져온다 (자동완성도 계정 목록과 같은 페이지네이션을 쓴다)", async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      id: `p1-${i}`,
      email: `user${i}@example.com`,
      app_metadata: {},
      user_metadata: {},
    }));
    listUsers
      .mockResolvedValueOnce({ data: { users: fullPage }, error: null })
      .mockResolvedValueOnce({
        data: { users: [{ id: "p2-0", email: "tail@example.com", app_metadata: {}, user_metadata: {} }] },
        error: null,
      });

    const users = await getCrmUsers();

    expect(users).toHaveLength(201);
    expect(users.at(-1)?.email).toBe("tail@example.com");
    expect(listUsers).toHaveBeenCalledTimes(2);
    expect(listUsers.mock.calls[0][0]).toMatchObject({ page: 1 });
    expect(listUsers.mock.calls[1][0]).toMatchObject({ page: 2 });
  });

  it("캐시 만료 후 재조회가 실패하면 최근 값을 반환한다 (자동완성이 통째로 죽지 않는다)", async () => {
    // Date 만 흉내낸다 — 이 테스트는 setTimeout 을 쓰지 않으므로 testing-library 의
    // findBy* 류와 얽힐 일이 없다(가짜 타이머가 그것들을 죽이는 것은 별개 함정).
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      listUsers.mockResolvedValueOnce({
        data: { users: [{ id: "1", email: "cached@example.com", app_metadata: {}, user_metadata: {} }] },
        error: null,
      });
      const first = await getCrmUsers();
      expect(first).toHaveLength(1);

      // 캐시 TTL(60초)을 넘겨 다음 호출이 실제로 재조회를 시도하게 만든다.
      vi.advanceTimersByTime(60_001);
      listUsers.mockReset();
      listUsers.mockResolvedValueOnce({ data: null, error: { message: "boom" } });

      const second = await getCrmUsers();
      expect(second).toEqual(first);
      // `second === first` 만으로는 캐시가 만료되지 않아 애초에 재조회를 안 한 경우와
      // 구분이 안 된다(둘 다 이 단언을 통과한다) — 재조회가 실제로 시도됐음을 여기서 못박는다.
      // (TTL advance 를 지운 채로 돌려 이 단언이 실제로 실패함을 확인했다.)
      expect(listUsers).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("캐시도 없고 조회도 실패하면 에러를 삼키지 않는다", async () => {
    listUsers.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(getCrmUsers()).rejects.toThrow(/boom/);
  });
});
