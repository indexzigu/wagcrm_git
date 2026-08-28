import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// 미인증 요청에 대한 미들웨어의 **실제 동작**을 검증한다.
//
// 왜 소스 계약 테스트만으로 부족한가(code-reviewer 가 재현해 지적한 공백):
// `!isSentryTunnelPath(...)` 에서 `!` 하나만 빠져도 소스 grep 계약은 토큰이 그대로라
// 전부 통과하는데, 런타임 의미는 정반대가 된다 — AND 체인 전체가 "터널일 때만 참"이 되어
// **터널 외 모든 경로의 로그인 게이트가 무력화**된다. 그 클래스를 잡으려면 조건을 읽는 게
// 아니라 실행해야 한다. 아래 "보호 경로는 여전히 막힌다"가 그 감시자다.
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

// 이 파일의 경로는 전부 예약어·다중 세그먼트라 실제로는 호출되지 않지만(portal-slug.ts
// extractPortalSlug 가 null), 앞으로 예약어 아닌 단일 세그먼트 경로가 mock 없이 추가되면
// 실 Prisma(프로덕션 DB, AGENTS.md P0)로 새는 것을 이 mock 이 원천 차단한다.
vi.mock("@/lib/portal-slug-existence", () => ({
  portalSlugExists: async () => null,
}));

const { updateSession } = await import("@/lib/supabase/middleware");

/** 세션 쿠키 없는 요청(= 익명 방문자·크롤러·Sentry 터널 POST) */
function anonymousRequest(pathname: string): NextRequest {
  return new NextRequest(new URL(`https://crm.example.test${pathname}`));
}

async function redirectTargetOf(pathname: string): Promise<string | null> {
  const response = await updateSession(anonymousRequest(pathname));
  const location = response.headers.get("location");
  return location ? new URL(location).pathname : null;
}

describe("미인증 요청 게이트 — Sentry 터널·robots.txt 통과 / 보호 경로 차단", () => {
  it("Sentry 터널은 리다이렉트되지 않는다 (에러 보고가 로그인 화면에서도 살아야 함)", async () => {
    expect(await redirectTargetOf("/monitoring")).toBeNull();
  });

  it("터널 하위 경로도 통과한다", async () => {
    // 포털 슬러그 정규식은 두 번째 세그먼트를 허용하지 않아(`/card/...` 제외) 이 경로는
    // 오직 터널 제외로만 통과한다 — 제외가 실제로 일하는지 보여주는 가장 강한 케이스다.
    expect(await redirectTargetOf("/monitoring/envelope")).toBeNull();
  });

  it("robots.txt 는 리다이렉트되지 않는다 (크롤러가 Disallow 를 읽어야 함)", async () => {
    // 'robots.txt' 는 예약 슬러그(portal-slug.ts)라 포털 공개 경로로 통과하지 못한다.
    // 즉 이 통과는 전적으로 이번 제외 덕분이다.
    expect(await redirectTargetOf("/robots.txt")).toBeNull();
  });

  it("보호 경로는 여전히 /login 으로 막힌다 (게이트 무력화 감시자)", async () => {
    // ⚠️ 이 단언이 이 파일의 존재 이유다. 제외 조건의 부정 연산자가 빠지는 등으로 조건이
    // 뒤집히면 여기서 즉시 깨진다(터널만 막고 나머지는 다 열리는 상태를 잡아낸다).
    expect(await redirectTargetOf("/pipeline")).toBe("/login");
    expect(await redirectTargetOf("/settlement")).toBe("/login");
  });

  it("터널과 접두사만 같은 경로는 터널 제외를 타지 않는다", async () => {
    // 주의: `/monitoring-admin` 은 **포털 슬러그로서 공개**라 미들웨어 레벨에선 어차피
    // 통과한다 — 그래서 여기선 대조군으로 못 쓴다. 접두사 판정 자체의 정밀도는
    // isSentryTunnelPath 단위 테스트(sentry-tunnel.contract.test.ts)가 담당한다.
    // 여기서는 예약어라 포털 경로가 아닌 다중 세그먼트로 확인한다.
    expect(await redirectTargetOf("/monitoringx/envelope")).toBe("/login");
  });
});
