/**
 * 허가 게이트의 런타임 동작을 검증한다. 미승인 사용자가 실제로 무엇을 볼 수 있는지는
 * 조건문을 읽어서가 아니라 `updateSession` 을 실행해야 확인된다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const { PENDING_HOME, OPERATOR_HOME } = await import("@/lib/auth-roles");
const { DEFAULT_ADMIN_EMAILS } = await import("@/lib/auth-allowlist");

const OWNER_EMAIL = DEFAULT_ADMIN_EMAILS[0];
const STRANGER_EMAIL = "stranger@example.com";

beforeEach(() => {
  currentUser = null;
});

afterEach(() => {
  currentUser = null;
});

function signInAs(email: string, appMetadata: Record<string, unknown> = {}) {
  currentUser = { id: `user-${email}`, email, app_metadata: appMetadata, user_metadata: {} };
}

async function gateResultFor(pathname: string): Promise<string | null> {
  const response = await updateSession(
    new NextRequest(new URL(`https://crm.example.test${pathname}`)),
  );
  if (response.status === 403) return "403";
  const location = response.headers.get("location");
  return location ? new URL(location).pathname : null;
}

describe("허가 게이트", () => {
  it("승인되지 않은 사용자는 페이지 요청 시 대기 화면으로 간다", async () => {
    signInAs(STRANGER_EMAIL);
    expect(await gateResultFor("/")).toBe(PENDING_HOME);
    expect(await gateResultFor("/sellers")).toBe(PENDING_HOME);
  });

  it("승인되지 않은 사용자의 API 요청은 403 이다", async () => {
    signInAs(STRANGER_EMAIL);
    expect(await gateResultFor("/api/sellers")).toBe("403");
  });

  it("거절된 사용자도 같은 취급이다", async () => {
    signInAs(STRANGER_EMAIL, { status: "rejected", role: "admin" });
    expect(await gateResultFor("/")).toBe(PENDING_HOME);
  });

  it("대기 화면 자체와 로그아웃 경로는 열려 있다", async () => {
    signInAs(STRANGER_EMAIL);
    expect(await gateResultFor(PENDING_HOME)).toBeNull();
    expect(await gateResultFor("/auth/signout")).toBeNull();
  });

  // 🪤 위 테스트는 한동안 **잘못된 이유로** 통과했다. `/pending` 이 `RESERVED_PORTAL_SLUGS`
  // 에 없어 `isPortalPublicPath` 가 true 를 돌려줬고, 그래서 인가·역할 게이트를 **둘 다**
  // 건너뛰었을 뿐이다(부수효과로 비로그인에게도 공개였다). 예약어를 채우면 이번엔 역할
  // 게이트가 `/pending` 을 가로채 무한 리다이렉트가 난다 — 아래 두 테스트가 그 두 가지를
  // 각각 고정한다.
  it("미승인 사용자가 대기 화면을 열어도 리다이렉트 루프가 생기지 않는다", async () => {
    // STRANGER_EMAIL 은 admin 목록 밖이라 역할이 operator 로 판정된다(실제 운영 형태).
    signInAs(STRANGER_EMAIL);
    const visited: string[] = [];
    let path = "/sellers";
    for (let hop = 0; hop < 5; hop += 1) {
      const next = await gateResultFor(path);
      if (next === null) break; // 게이트 통과 = 착지
      expect(next, `${path} 에서 403 이 아니라 리다이렉트여야 한다`).not.toBe("403");
      expect(visited, `리다이렉트 루프: ${[...visited, next].join(" -> ")}`).not.toContain(next);
      visited.push(next);
      path = next;
    }
    // 마지막으로 도달한 곳이 대기 화면이고, 거기서 더는 튕기지 않는다.
    expect(visited).toEqual([PENDING_HOME]);
    expect(await gateResultFor(PENDING_HOME)).toBeNull();
  });

  it("대기 화면은 비로그인에게 공개가 아니다", async () => {
    currentUser = null;
    expect(await gateResultFor(PENDING_HOME)).toBe("/login");
  });

  it("승인된 사용자는 통과한다", async () => {
    signInAs(STRANGER_EMAIL, { status: "approved", role: "admin" });
    expect(await gateResultFor("/sellers")).toBeNull();
  });

  it("오너는 metadata 가 비어 있어도 통과한다(바닥)", async () => {
    signInAs(OWNER_EMAIL);
    expect(await gateResultFor("/sellers")).toBeNull();
  });

});
