/**
 * updateSession 인가(허가목록) 게이트 검증.
 * Supabase getUser 만 목킹하고 실제 허가목록(auth-allowlist)을 그대로 사용해,
 * 미허가 계정이 대기 화면(`/pending`)으로 튕기고 세션 쿠키는 유지되는지 엔드투엔드로 확인한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUserMock = vi.fn();
const portalSlugExistsMock = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
  }),
}));

vi.mock("@/lib/portal-slug-existence", () => ({
  portalSlugExists: (...args: unknown[]) => portalSlugExistsMock(...args),
}));

import { NextRequest } from "next/server";
import { TRUSTED_USER_HEADER, updateSession } from "./middleware";

function makeRequest(path: string, cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest(`https://crm.ygrd.kr${path}`);
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

describe("updateSession 허가목록 게이트", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    portalSlugExistsMock.mockReset();
    portalSlugExistsMock.mockResolvedValue(true);
  });

  it("허가 안 된 계정 → /pending 리다이렉트, 세션 쿠키는 유지", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { email: "stranger@example.com" } },
    });

    const res = await updateSession(
      makeRequest("/", { "sb-cefnwaasfepmbjokzzvz-auth-token": "fake-token" })
    );

    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/pending");

    // 🪤 종전에는 여기서 sb- 쿠키를 지웠다. 지금은 세션을 유지한 채 대기 화면으로 보낸다 —
    // 지우면 오너가 나중에 승인해도 그 사용자가 승인 사실을 확인할 방법이 없다
    // (대기 화면이 자기 이메일도 못 띄운다). 이 요청 자체엔 세션 쿠키를 지우는
    // Set-Cookie 가 없어야 한다.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toContain("sb-cefnwaasfepmbjokzzvz-auth-token");
  });

  it("허가된 계정(운영자) → 통과, 리다이렉트 없음", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { email: "zigoo1218@gmail.com" } },
    });

    const res = await updateSession(makeRequest("/"));

    expect(res.headers.get("location")).toBeNull();
  });

  it("허가 이메일 대소문자/공백 무관하게 통과", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { email: "  ZiGoo1218@Gmail.com " } },
    });

    const res = await updateSession(makeRequest("/"));

    expect(res.headers.get("location")).toBeNull();
  });

  it("비로그인 → /login 리다이렉트(denied 아님)", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await updateSession(makeRequest("/"));

    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).not.toContain("denied=1");
  });

  it("카카오 셀러 링크 미리보기는 인증 조회 없이 안전한 공개 문서로만 리라이트", async () => {
    const req = new NextRequest("https://crm.ygrd.kr/sellers/seller_123", {
      headers: { "user-agent": "kakaotalk-scrap/1.0" },
    });

    const res = await updateSession(req);

    expect(res.headers.get("x-middleware-rewrite")).toBe(
      "https://crm.ygrd.kr/share/sellers/seller_123",
    );
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("미허가 계정이라도 공개/인증교환 경로(/coupang-partners)는 게이트 제외", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { email: "stranger@example.com" } },
    });

    const res = await updateSession(makeRequest("/coupang-partners"));

    // denied 리다이렉트가 아니어야 한다.
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("denied=1");
  });

  it("셀러 전용 주소(/<slug>)는 비로그인도 통과 — 인증은 페이지의 비밀번호 게이트가 담당", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    for (const path of ["/gaon", "/gaon/card/cmr1abc"]) {
      const res = await updateSession(makeRequest(path));
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("예약 세그먼트(내부 라우트)는 슬러그로 오판하지 않는다 — 비로그인은 여전히 /login", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    for (const path of ["/sellers", "/settlement", "/calendar", "/outreach"]) {
      const res = await updateSession(makeRequest(path));
      expect(res.headers.get("location") ?? "", path).toContain("/login");
    }
  });
});

describe("updateSession 포털 슬러그 존재 확인 — 형식은 유효하나 미등록인 슬러그의 조기 404", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    portalSlugExistsMock.mockReset();
  });

  it("미등록 슬러그 → 404, Supabase 세션 조회는 아예 안 한다", async () => {
    portalSlugExistsMock.mockResolvedValue(false);

    const res = await updateSession(makeRequest("/wp-admin-lookalike"));

    expect(res.status).toBe(404);
    expect(portalSlugExistsMock).toHaveBeenCalledWith("wp-admin-lookalike");
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("카드 경로도 기본 슬러그로 존재 확인하고, 미등록이면 404", async () => {
    portalSlugExistsMock.mockResolvedValue(false);

    const res = await updateSession(makeRequest("/gaon/card/cmr1abc"));

    expect(res.status).toBe(404);
    expect(portalSlugExistsMock).toHaveBeenCalledWith("gaon");
  });

  it("등록된 슬러그 → 기존과 동일하게 통과(비로그인도 리다이렉트 없음)", async () => {
    portalSlugExistsMock.mockResolvedValue(true);
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await updateSession(makeRequest("/gaon"));

    expect(res.status).not.toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("DB 조회 실패(null) → fail-open, 기존 동작대로 통과시킨다(404로 막지 않는다)", async () => {
    portalSlugExistsMock.mockResolvedValue(null);
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await updateSession(makeRequest("/gaon"));

    expect(res.status).not.toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("슬러그 형식이 아닌 경로(예약 세그먼트 등)는 존재 확인 자체를 안 한다", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    await updateSession(makeRequest("/sellers"));

    expect(portalSlugExistsMock).not.toHaveBeenCalled();
  });

  it("데모 레인에서는 존재 확인을 하지 않는다(데모 DB는 별개 — 기존 데모 동작 유지)", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    try {
      await updateSession(makeRequest("/gaon"));
      expect(portalSlugExistsMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("updateSession 신뢰 헤더 전달(auth 중복호출 제거)", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    portalSlugExistsMock.mockReset();
    portalSlugExistsMock.mockResolvedValue(true);
  });

  it("허가된 사용자 → 다음 단계로 신뢰 헤더가 전달된다(getAuthContext가 재검증 없이 씀)", async () => {
    getUserMock.mockResolvedValue({
      data: {
        user: { id: "user-1", email: "zigoo1218@gmail.com", user_metadata: { role: "admin" } },
      },
    });

    const res = await updateSession(makeRequest("/"));

    const forwarded = res.headers.get(`x-middleware-request-${TRUSTED_USER_HEADER}`);
    expect(forwarded).not.toBeNull();
    const decoded = JSON.parse(decodeURIComponent(forwarded!));
    expect(decoded).toEqual({ id: "user-1", email: "zigoo1218@gmail.com", role: "admin" });
  });

  it("비로그인 통과 경로(공개 페이지)는 신뢰 헤더가 없다", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await updateSession(makeRequest("/coupang-partners"));

    expect(res.headers.get(`x-middleware-request-${TRUSTED_USER_HEADER}`)).toBeNull();
  });

  it("클라이언트가 위조한 신뢰 헤더는 비로그인 상태에서 제거된다(전달되지 않음)", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const req = new NextRequest("https://crm.ygrd.kr/coupang-partners", {
      headers: {
        [TRUSTED_USER_HEADER]: encodeURIComponent(
          JSON.stringify({ id: "attacker", email: "evil@example.com", role: "admin" }),
        ),
      },
    });

    const res = await updateSession(req);

    expect(res.headers.get(`x-middleware-request-${TRUSTED_USER_HEADER}`)).toBeNull();
  });

  it("클라이언트가 위조한 신뢰 헤더가 있어도 실제 로그인 사용자의 검증된 값으로 덮어써진다", async () => {
    getUserMock.mockResolvedValue({
      data: {
        user: { id: "real-user", email: "zigoo1218@gmail.com", user_metadata: { role: "admin" } },
      },
    });

    const req = new NextRequest("https://crm.ygrd.kr/", {
      headers: {
        [TRUSTED_USER_HEADER]: encodeURIComponent(
          JSON.stringify({ id: "attacker", email: "evil@example.com", role: "admin" }),
        ),
      },
    });

    const res = await updateSession(req);

    const forwarded = res.headers.get(`x-middleware-request-${TRUSTED_USER_HEADER}`);
    const decoded = JSON.parse(decodeURIComponent(forwarded!));
    expect(decoded.id).toBe("real-user");
    expect(decoded.id).not.toBe("attacker");
  });
});

describe("updateSession 데모 레인(DEMO_MODE=1)", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    portalSlugExistsMock.mockReset();
    vi.stubEnv("DEMO_MODE", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("GET 페이지 → Supabase 접촉 없이 통과 + 데모 유저 신뢰 헤더 주입", async () => {
    const res = await updateSession(makeRequest("/"));

    expect(res.headers.get("location")).toBeNull();
    expect(getUserMock).not.toHaveBeenCalled();

    const forwarded = res.headers.get(`x-middleware-request-${TRUSTED_USER_HEADER}`);
    const decoded = JSON.parse(decodeURIComponent(forwarded!));
    expect(decoded).toEqual({ id: "demo-user", email: "demo@wagcrm.demo", role: "admin" });
  });

  it("클라이언트가 위조한 신뢰 헤더는 데모 유저로 대체된다", async () => {
    const req = new NextRequest("https://demo.example.com/", {
      headers: {
        [TRUSTED_USER_HEADER]: encodeURIComponent(
          JSON.stringify({ id: "attacker", email: "evil@example.com", role: "admin" }),
        ),
      },
    });

    const res = await updateSession(req);

    const forwarded = res.headers.get(`x-middleware-request-${TRUSTED_USER_HEADER}`);
    const decoded = JSON.parse(decodeURIComponent(forwarded!));
    expect(decoded.id).toBe("demo-user");
  });

  it("비-GET(쓰기)은 전부 403 — 읽기 전용 계약", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const res = await updateSession(
        new NextRequest("https://demo.example.com/api/campaigns", { method }),
      );
      expect(res.status, method).toBe(403);
      const body = await res.json();
      expect(body.demo, method).toBe(true);
    }
  });

  it("크론·인증 교환 경로는 GET이어도 403", async () => {
    for (const path of ["/api/cron/naver-order-sync", "/api/auth/callback", "/auth/callback"]) {
      const res = await updateSession(makeRequest(path));
      expect(res.status, path).toBe(403);
    }
  });

  it("구글 연동 OAuth 콜백은 GET-write라 403, 연동 상태 조회 GET은 통과", async () => {
    for (const path of [
      "/api/integrations/google-calendar/callback",
      "/api/integrations/google-drive/callback",
    ]) {
      const res = await updateSession(makeRequest(path));
      expect(res.status, path).toBe(403);
    }

    // 콜백이 아닌 연동 경로(상태 조회 등)는 읽기라 통과해야 설정 화면이 성립한다.
    const statusRes = await updateSession(makeRequest("/api/integrations/google-drive/status"));
    expect(statusRes.status).not.toBe(403);
  });

  it("DEMO_MODE 미설정이면 데모 레인은 발동하지 않는다(기존 로그인 게이트 유지)", async () => {
    vi.unstubAllEnvs();
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await updateSession(makeRequest("/"));

    expect(res.headers.get("location") ?? "").toContain("/login");
  });
});
