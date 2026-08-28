/**
 * 역할 게이트의 **실제 런타임 동작**을 검증한다 — 이 레포에서 operator 경계를 집행하는
 * 유일한 지점이 `updateSession` 이므로, 여기가 뚫리면 다른 방어선이 없다.
 *
 * 왜 `isOperatorAllowedPath` 단위 테스트만으로 부족한가: 화이트리스트가 옳아도 미들웨어의
 * AND 체인에서 `!` 하나가 빠지거나 게이트가 조건문 **뒤**로 밀리면 판정이 통째로 뒤집힌다.
 * 그 클래스는 조건을 읽는 게 아니라 실행해야 잡힌다(같은 이유로 만들어진 자매 파일:
 * `middleware-auth-gate.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type TestUser = {
  id: string;
  email: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
};

let currentUser: TestUser | null = null;

// 이 파일의 경로는 전부 예약어·다중 세그먼트라 실제로는 호출되지 않지만(portal-slug.ts
// extractPortalSlug 가 null), 앞으로 예약어 아닌 단일 세그먼트 경로가 mock 없이 추가되면
// 실 Prisma(프로덕션 DB, AGENTS.md P0)로 새는 것을 이 mock 이 원천 차단한다.
vi.mock("@/lib/portal-slug-existence", () => ({
  portalSlugExists: async () => null,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
  }),
}));

const { updateSession } = await import("@/lib/supabase/middleware");
const { OPERATOR_HOME, ROLE_COOKIE } = await import("@/lib/auth-roles");

const OWNER_EMAIL = (await import("@/lib/auth-allowlist")).DEFAULT_ADMIN_EMAILS[0];
const STAFF_EMAIL = "staff@example.com";

/** admin 이 실제로 쓰는 표면 표본 — operator 차단이 여기까지 번지면 오너가 잠긴다. */
const ADMIN_SURFACES = [
  "/",
  "/calendar",
  "/pipeline",
  "/deals",
  "/outreach",
  "/claim-check",
  "/order-converter",
  "/settlement",
  "/partners",
  "/sellers",
  "/assets",
  "/assets/katalk",
  "/reports/pnl",
  "/reports/inflow",
  "/assistant",
  "/settings/operations",
  "/admin",
  "/schedule",
  "/share",
  "/api/sellers",
  "/api/campaigns",
  "/api/chat-room-mappings/manage",
  "/api/kakao-uploads",
  "/order-converter/api/action-log",
];

beforeEach(() => {
  currentUser = null;
});

function requestFor(pathname: string): NextRequest {
  return new NextRequest(new URL(`https://crm.example.test${pathname}`));
}

/**
 * `appMetadata` = 서버(service_role)만 쓸 수 있는 필드 · `userMetadata` = 사용자 본인이 쓸 수 있는 필드
 *
 * 승인 여부(`status`)는 기본으로 approved 를 넣는다 — 이 파일이 검증하는 것은 **역할**
 * 게이트이고, 미승인 계정은 그보다 앞의 인가 게이트에서 `/pending` 으로 끊겨 역할 게이트에
 * 도달하지 못한다(그 경로는 `middleware-access-gate.test.ts` 가 맡는다).
 * 호출부가 `status` 를 직접 주면 그것이 이긴다.
 */
function signInAs(
  email: string,
  appMetadata: Record<string, unknown> = {},
  userMetadata: Record<string, unknown> = {},
) {
  currentUser = {
    id: `user-${email}`,
    email,
    app_metadata: { status: "approved", ...appMetadata },
    user_metadata: userMetadata,
  };
}

/** 게이트 판정 요약: 통과=null · 페이지 차단=리다이렉트 경로 · API 차단=403 */
async function gateResultFor(pathname: string): Promise<string | null> {
  const response = await updateSession(requestFor(pathname));
  if (response.status === 403) return "403";
  const location = response.headers.get("location");
  return location ? new URL(location).pathname : null;
}

describe("operator — 화이트리스트 밖은 전부 차단된다", () => {
  beforeEach(() => signInAs(STAFF_EMAIL));

  it("업로드 화면과 업로드 API 만 통과한다", async () => {
    expect(await gateResultFor(OPERATOR_HOME)).toBeNull();
    expect(await gateResultFor("/api/kakao-uploads")).toBeNull();
  });

  it("URL 직접 입력으로 들어온 업무 화면은 업로드 화면으로 되돌려진다", async () => {
    // 🪤 사이드바 내비게이션의 **전 경로**를 넣는 것이 의도다. 역할 게이트는
    // `isPortalPublicPath` 를 제외 조건으로 두는데, 그 판정은 예약 슬러그
    // (`RESERVED_PORTAL_SLUGS`)가 아닌 **한 세그먼트 경로를 전부 셀러 포털로 본다** —
    // 앱 라우트 하나가 예약 목록에서 빠지면 operator 가 그 페이지를 그대로 렌더한다
    // (API 가 403 이어도 서버 렌더 데이터는 이미 나간 뒤다). 목록을 줄이지 말 것.
    for (const path of [
      "/",
      "/calendar",
      "/pipeline",
      "/deals",
      "/outreach",
      "/claim-check",
      "/order-converter",
      "/settlement",
      "/partners",
      "/sellers",
      "/assets",
      "/reports/pnl",
      "/reports/inflow",
      "/assistant",
      "/settings/operations",
      "/admin",
      "/schedule",
      "/share",
    ]) {
      expect(await gateResultFor(path), path).toBe(OPERATOR_HOME);
    }
  });

  it("API 는 리다이렉트가 아니라 403 이다 (fetch 가 로그인 HTML 을 파싱하지 않도록)", async () => {
    for (const path of [
      "/api/sellers",
      "/api/partners",
      "/api/campaigns",
      "/api/chat-room-mappings/manage",
      // 🪤 API 라우트는 `/api/*` 한 군데가 아니다 — 이쪽도 라우트 핸들러다.
      "/order-converter/api/action-log",
    ]) {
      expect(await gateResultFor(path), path).toBe("403");
    }
  });

  it("로그아웃 경로는 살아 있다 (막으면 세션을 끝낼 방법이 없다)", async () => {
    expect(await gateResultFor("/api/auth/signout")).toBeNull();
    expect(await gateResultFor("/login")).toBeNull();
  });

  it("역할 쿠키가 operator 로 심긴다 (화면단 표시용)", async () => {
    const response = await updateSession(requestFor(OPERATOR_HOME));
    expect(response.cookies.get(ROLE_COOKIE)?.value).toBe("operator");
  });

  it("app_metadata.role=admin 으로 승격된 계정은 차단되지 않는다", async () => {
    // 오너가 나중에 직원을 admin 으로 올리는 경로가 살아 있는지 확인한다(service_role 필드).
    signInAs(STAFF_EMAIL, { role: "admin" });
    expect(await gateResultFor("/settlement")).toBeNull();
  });

  it("⛔ user_metadata.role=admin 으로는 승격되지 않는다 (자기 승격 차단)", async () => {
    // 이 파일에서 가장 중요한 단언이다. `user_metadata` 는 사용자 본인이
    // `supabase.auth.updateUser({ data: … })` 로 쓸 수 있는 필드라(공개 anon key + 본인
    // 세션만으로 충분), 그것을 역할 출처로 쓰면 operator 가 브라우저 콘솔 한 줄로 스스로
    // admin 이 된다 — 미들웨어 화이트리스트가 통째로 무의미해진다.
    signInAs(STAFF_EMAIL, {}, { role: "admin" });
    expect(await gateResultFor("/settlement")).toBe(OPERATOR_HOME);
    expect(await gateResultFor("/api/sellers")).toBe("403");
  });
});

describe("admin — 기존 접근이 하나도 줄지 않는다", () => {
  it("역할 미지정 오너 계정은 모든 표면을 그대로 연다", async () => {
    signInAs(OWNER_EMAIL);
    for (const path of ADMIN_SURFACES) {
      expect(await gateResultFor(path), path).toBeNull();
    }
  });

  it("역할 쿠키가 admin 으로 심긴다", async () => {
    signInAs(OWNER_EMAIL);
    const response = await updateSession(requestFor("/pipeline"));
    expect(response.cookies.get(ROLE_COOKIE)?.value).toBe("admin");
  });

  it("app_metadata.role=operator 로도 오너는 강등되지 않는다(오너 바닥은 무조건)", async () => {
    // 🪤 이 테스트는 종전엔 "명시 강등이 오너도 차단한다"를 검증했다. 허가 게이트가
    // `resolveAccess` 로 전환되면서 역할도 그 판정을 따르게 됐고(`middleware.ts` 의
    // `role = access.role`), `resolveAccess` 의 오너 바닥(`DEFAULT_ADMIN_EMAILS`)은
    // metadata 와 무관하게 무조건 admin 을 반환한다(`auth-allowlist.ts` 주석: "오너가
    // UI 조작으로 스스로 잠기는 경로를 구조적으로 없앤다"). 즉 오너는 이제 자기 계정의
    // `app_metadata.role` 을 잘못 건드려도 잠기지 않는다 — 의도된 동작이다.
    signInAs(OWNER_EMAIL, { role: "operator" });
    expect(await gateResultFor("/pipeline")).toBeNull();
  });
});

describe("비로그인 — 역할 게이트가 로그인 게이트를 가리지 않는다", () => {
  it("보호 경로는 여전히 /login 으로 간다", async () => {
    expect(await gateResultFor("/pipeline")).toBe("/login");
  });

  it("역할 쿠키를 심지 않는다", async () => {
    const response = await updateSession(requestFor("/login"));
    expect(response.cookies.get(ROLE_COOKIE)?.value).toBeFalsy();
  });
});
