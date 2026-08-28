import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const getUserMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
  }),
}));

// 실제 판정 함수(`resolveAccess`)를 모의한다 — 이 파일이 검증하는 것은 크론 재실행
// 라우트의 인가 처리이지 판정 로직 자체가 아니다(그쪽은 auth-access-resolution.test.ts).
// ⚠️ 모의 대상 이름이 실제 export 와 어긋나면 vi.mock 이 조용히 무력화되고 라우트가
// 진짜 판정을 쓰게 된다 — 종전 `isEmailAllowed` 모의가 그 위험을 안고 있었다.
vi.mock("@/lib/auth-allowlist", () => ({
  resolveAccess: (appMetadata: unknown, email: string | null | undefined) => {
    // ⛔ 첫 인자가 `app_metadata` 인지 여기서 못박는다. 이 단언이 없으면 라우트를
    // `resolveAccess(user.user_metadata, …)` 로 바꿔도 전 케이스가 통과한다 —
    // `user_metadata` 는 사용자 본인이 쓸 수 있어 그 순간 자기 승격이 열린다(P0).
    if ((appMetadata as { source?: string } | null)?.source !== "app_metadata") {
      throw new Error("resolveAccess 는 app_metadata 를 받아야 한다");
    }
    return email === "owner@example.com"
      ? { approved: true, status: "approved", role: "admin" }
      : { approved: false, status: "pending", role: "operator" };
  },
}));

function createRequest(body: unknown): Request {
  return new Request("https://crm.example.com/api/system/cron-run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 두 metadata 에 서로 다른 표식을 넣어, 라우트가 어느 쪽을 넘기는지 위 모의가 가려내게 한다. */
function loginAs(email: string | null) {
  getUserMock.mockResolvedValue({
    data: {
      user: email
        ? {
            email,
            app_metadata: { source: "app_metadata" },
            user_metadata: { source: "user_metadata" },
          }
        : null,
    },
  });
}

describe("POST /api/system/cron-run", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    loginAs("owner@example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("비로그인 요청은 401", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const res = await POST(createRequest({ jobKey: "price-monitoring" }));
    expect(res.status).toBe(401);
  });

  it("허가목록 밖 계정은 401", async () => {
    loginAs("stranger@example.com");
    const res = await POST(createRequest({ jobKey: "price-monitoring" }));
    expect(res.status).toBe(401);
  });

  it("화이트리스트에 없는 jobKey는 400 (경로 주입 차단)", async () => {
    const res = await POST(createRequest({ jobKey: "../auth/callback" }));
    expect(res.status).toBe(400);
  });

  it("CRON_SECRET 미설정이면 503", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await POST(createRequest({ jobKey: "price-monitoring" }));
    expect(res.status).toBe(503);
  });

  it("정상 실행: 같은 호스트의 크론 엔드포인트를 Bearer 시크릿으로 호출하고 결과를 전달", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ generated: 2, skipped: 1 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(createRequest({ jobKey: "price-monitoring" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; result: { generated: number } };
    expect(json.ok).toBe(true);
    expect(json.result.generated).toBe(2);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://crm.example.com/api/cron/price-monitoring");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-secret");
  });

  it("크론이 비2xx를 반환하면 502로 감싸 실패를 드러낸다 (무음 실패 금지)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })),
    );
    const res = await POST(createRequest({ jobKey: "price-monitoring" }));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { ok: boolean; status: number };
    expect(json.ok).toBe(false);
    expect(json.status).toBe(401);
  });
});
