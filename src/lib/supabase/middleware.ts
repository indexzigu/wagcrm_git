import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { resolveAccess } from "@/lib/auth-allowlist";
import {
  isOperatorAllowedPath,
  isPendingAllowedPath,
  OPERATOR_HOME,
  PENDING_HOME,
  ROLE_COOKIE,
  type UserRole,
} from "@/lib/auth-roles";
import { isBotScanPath } from "@/lib/bot-scan-paths";
import { DEMO_READONLY_MESSAGE, DEMO_USER, isDemoMode } from "@/lib/demo-mode";
import { extractPortalSlug, isPortalPublicPath } from "@/lib/portal-slug";
import { portalSlugExists } from "@/lib/portal-slug-existence";
import { isSentryTunnelPath } from "@/lib/sentry-tunnel";
import { getSocialPreviewRewritePath } from "@/lib/social-preview";

const DEV_AUTH_COOKIE = "wag_crm_dev_auth";

// 미들웨어가 이미 검증한 사용자를 라우트 핸들러(getAuthContext)에 전달하는 신뢰 헤더.
// 매 요청마다 미들웨어 1회 + 라우트 핸들러 1회, 총 2번 /auth/v1/user를 때리던 중복을 없앤다
// (auth API 호출량 실측 원인). 클라이언트가 이 헤더를 직접 위조해 보내도, 아래에서 항상
// 먼저 지우고 검증된 값일 때만 다시 채우므로 신뢰 경계는 미들웨어 통과 시점으로 고정된다.
export const TRUSTED_USER_HEADER = "x-wag-verified-user";

function encodeTrustedUser(user: { id: string; email: string; role: string }) {
  return encodeURIComponent(JSON.stringify(user));
}

/** 🪤 API 라우트가 `/api/*` 한 군데가 아니다 — `/order-converter/api/*` 도 라우트 핸들러다.
 *  접두사로만 판정하면 그쪽이 페이지 취급을 받아 fetch 가 307 을 따라간다. */
function isApiPath(pathname: string): boolean {
  return pathname.split("/").includes("api");
}

/** fetch() 로 오는 API 요청에는 리다이렉트가 아니라 403 을 준다 — 307 을 따라가면 클라이언트가
 *  로그인 HTML 을 JSON 으로 파싱하려다 정체불명의 파싱 오류를 뱉는다(원인이 안 보인다). */
function denyOperator(request: NextRequest): NextResponse {
  if (isApiPath(request.nextUrl.pathname)) {
    return NextResponse.json(
      { error: "Forbidden", reason: "operator-scope" },
      { status: 403 },
    );
  }
  const url = request.nextUrl.clone();
  url.pathname = OPERATOR_HOME;
  url.search = "";
  return NextResponse.redirect(url);
}

export async function updateSession(request: NextRequest) {
  const previewPath = getSocialPreviewRewritePath(
    request.nextUrl.pathname,
    request.headers.get("user-agent") ?? "",
  );
  if (previewPath) {
    // 다운스트림으로 요청을 전달하는 세 경로(여기 · 데모 · 최종) 중 이곳만 신뢰 헤더를
    // 지우지 않고 있었다 — 클라이언트가 위조한 `x-wag-verified-user` 가 그대로 도달한다.
    // 지금 그 rewrite 대상(`/share/*`)은 인증을 읽지 않아 악용되지 않지만, 이 헤더가
    // **역할까지 싣게 된 이상** 그 하위에 인증을 읽는 코드가 하나만 생기면 권한 상승이
    // 된다. 신뢰 경계는 "미들웨어 통과 시점"이라는 불변식을 세 경로 모두에서 지킨다.
    const previewHeaders = new Headers(request.headers);
    previewHeaders.delete(TRUSTED_USER_HEADER);
    return NextResponse.rewrite(new URL(previewPath, request.url), {
      request: { headers: previewHeaders },
    });
  }

  // 봇 스캔 경로는 여기서 끝낸다 — Supabase 세션 조회보다 **앞**이어야 의미가 있다.
  // 셀러 포털 `[slug]` 가 한 세그먼트 경로를 전부 받는 catch-all 이라, 스캐너 경로가
  // 슬러그 형식을 통과해 auth 왕복 + DB 조회 + PPR 셸 49KB 를 태우고 심지어 **200** 을
  // 돌려주고 있었다(2026-08-02 prod 실측 — 페이지의 `notFound()` 는 정적 셸이 나간 뒤라
  // 상태코드를 못 바꾼다). 본문 없는 404 는 렌더도 DB 도 타지 않는다.
  if (isBotScanPath(request.nextUrl.pathname)) {
    return new NextResponse(null, { status: 404, headers: { "x-robots-tag": "noindex" } });
  }

  // 데모 배포 레인(외부 시연용 · 비로그인 열람): Supabase 미구성 전제라 세션 검사 없이
  // 열람(GET/HEAD/OPTIONS)만 전면 공개하고, 쓰기·크론·인증 교환은 여기서 차단한다.
  // 데이터는 sqlite 목업뿐이다 — prisma-client가 데모 모드에서 postgres 연결을 거부하므로
  // 이 우회가 실DB와 결합될 수 없다.
  if (isDemoMode()) {
    const method = request.method.toUpperCase();
    const demoPath = request.nextUrl.pathname;
    const demoBlocked =
      demoPath.startsWith("/api/cron") || // vercel.json 크론이 데모 프로젝트에도 등록되므로 명시 차단
      demoPath.startsWith("/api/auth") || // OAuth 교환 경로 — 데모에는 로그인 개념이 없다
      demoPath.startsWith("/auth") ||
      // 구글 연동 OAuth 콜백은 GET인데 code/state 검증 전에 DB write(연동 상태 upsert)가 있어
      // "GET=읽기전용" 전제에서 빠진다 — 방문자가 쿼리파라미터만으로 데모 화면의 연동 상태를
      // 훼손할 수 있으므로 콜백만 정밀 차단한다(상태 조회 GET은 살려 설정 화면을 유지).
      (demoPath.startsWith("/api/integrations/") && demoPath.endsWith("/callback"));
    if (demoBlocked || (method !== "GET" && method !== "HEAD" && method !== "OPTIONS")) {
      return NextResponse.json(
        { error: DEMO_READONLY_MESSAGE, demo: true },
        { status: 403 },
      );
    }
    const demoHeaders = new Headers(request.headers);
    demoHeaders.delete(TRUSTED_USER_HEADER);
    demoHeaders.set(TRUSTED_USER_HEADER, encodeTrustedUser({ ...DEMO_USER }));
    return NextResponse.next({ request: { headers: demoHeaders } });
  }

  // 봇 스캔 목록(isBotScanPath)이 못 잡는 잔여 갭 — 형식은 슬러그로 유효한데 실재하지
  // 않는 임의 문자열은 여기 오기 전까진 페이지까지 가서 200+셸을 받았다(2026-08-02
  // 실측, bot-scan-paths.ts 도입 근거와 같은 뿌리). DB 조회가 필요해 edge 시절엔 여기서
  // 못 했지만, proxy 가 Node.js 런타임이 기본이 된 뒤로는(Next 16) 가능하다.
  // ⚠️ fail-open: DB 조회가 실패하면(`portalSlugExists` 가 null) 막지 않고 그대로
  // 통과시킨다 — 이 지점은 거의 모든 요청이 지나므로 여기서 fail-closed 로 만들면
  // DB 일시 장애 한 번이 셀러 포털 전체를 404 시킨다.
  const portalSlug = extractPortalSlug(request.nextUrl.pathname);
  if (portalSlug) {
    const exists = await portalSlugExists(portalSlug);
    if (exists === false) {
      return new NextResponse(null, { status: 404, headers: { "x-robots-tag": "noindex" } });
    }
  }

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const devBypassEnabled =
    process.env.NODE_ENV === "development" &&
    (request.cookies.get(DEV_AUTH_COOKIE)?.value === "1" ||
      process.env.DEV_AUTH_BYPASS === "1");

  // B4-1 에이전트 접근 레인: 비프로덕션(preview/dev) 배포에서만 헤더 토큰으로 통과.
  // 프로덕션에는 AGENT_BYPASS_TOKEN env를 설정하지 않는 것이 1차 방어이고,
  // VERCEL_ENV 가드가 2차 방어 — 둘 다 만족해야 열린다.
  const agentLaneEnabled =
    process.env.VERCEL_ENV !== "production" &&
    !!process.env.AGENT_BYPASS_TOKEN &&
    request.headers.get("x-agent-key") === process.env.AGENT_BYPASS_TOKEN;

  // 아래 인가 게이트와 역할 게이트가 공유하는 경로 판정.
  // - agent 레인/cron은 세션(user)이 없어 여기 걸리지 않는다.
  // - /auth·/api/auth(코드 교환)와 공개 페이지(/coupang-partners)는 제외해 로그인 흐름을 방해하지 않는다.
  const pathname = request.nextUrl.pathname;
  // 🪤 접두사는 **슬래시까지** 고정한다. 종전 `startsWith("/auth")` 는 `/authorize` ·
  // `/api/authors` 같은 미래 라우트를 함께 통과시키는데, 이 조건은 허가목록 게이트와
  // 역할 게이트를 **둘 다** 건너뛰게 하므로 그런 라우트만 비로그인·operator 에게 열린다
  // (fail-closed 성질이 이 접두사 아래에서만 뒤집힌다 — 리뷰 지적 2026-08-06).
  // `auth-roles.ts` 의 operator 화이트리스트는 이미 슬래시 고정이라 단위 테스트는
  // 통과하는데 실제 집행점에서만 뚫리는, 눈에 안 띄는 형태였다.
  const isAuthExchangePath =
    pathname === "/auth" ||
    pathname.startsWith("/auth/") ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/coupang-partners") ||
    // 셀러 포털: 로그인 없는 토큰 URL 공개 경로. "/p/"로 슬래시까지 매칭해야
    // /pipeline·/partners·/privacy를 오매칭하지 않는다.
    pathname.startsWith("/p/") ||
    // 셀러 전용 주소(/<slug>) — 예약 세그먼트 제외 후 공개. 실제 인증은 페이지의 비밀번호 게이트.
    isPortalPublicPath(pathname);

  // 인가 게이트: 인증(Google 로그인 성공)과 인가(이 앱을 쓸 자격)는 별개다.
  // 종전에는 env 허가목록을 읽었으나, 권한 관리를 CRM 화면으로 옮기면서 판정 출처가
  // `app_metadata` 로 바뀌었다(`resolveAccess`). 미승인 사용자는 세션을 유지한 채
  // 대기 화면으로 보낸다 — 세션을 지우면 오너가 승인해도 그 사실을 볼 방법이 없다.
  const access = user ? resolveAccess(user.app_metadata, user.email) : null;

  if (user && access && !access.approved && !isAuthExchangePath && !isPendingAllowedPath(pathname)) {
    if (isApiPath(pathname)) {
      return NextResponse.json(
        { error: "Forbidden", reason: "not-approved" },
        { status: 403 },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = PENDING_HOME;
    url.search = "";
    return NextResponse.redirect(url);
  }

  // 역할 게이트: operator(카톡 업로드 전담 직원)는 화이트리스트 밖의 모든 페이지·API 를
  // 여기서 잃는다. **이 레포에서 역할을 집행하는 유일한 지점이다** —
  // `src/proxy.ts` matcher 가 정적 자산을 뺀 전 경로(`/api` 포함)를 받으므로, 라우트
  // 핸들러·페이지 렌더에 도달하기 전에 끊긴다. 그래서 신규 라우트는 별도 조치 없이
  // 기본 차단이고(fail-closed), operator 에게 열 때만 `auth-roles.ts` 목록에 추가한다.
  // ⚠️ 라우트마다 `requireRole` 을 복사하는 방식으로 되돌리지 말 것 — 크론 인증이 18개
  // 라우트에 복사돼 2건이 fail-open 으로 갈라진 선례가 있다(P0, `cron-auth.ts` 참조).
  const role: UserRole = access ? access.role : "admin";

  // 🪤 대기 경로는 **역할과 무관하게** 통과시킨다. 이 예외가 없으면 두 게이트가 서로를
  // 되받아 무한 리다이렉트가 된다: 미승인 사용자의 역할은 거의 항상 operator 이므로
  // (`resolveUserRole` 의 이메일 폴백 — admin 목록 밖은 전부 operator) `/pending` 이
  // 역할 게이트에 걸려 `/assets/katalk` 로 가고, 그건 다시 인가 게이트가 `/pending` 으로
  // 되돌린다 → 미승인 사용자 전원이 ERR_TOO_MANY_REDIRECTS 이고 대기 화면을 아무도 못 본다.
  //
  // `OPERATOR_ALLOWED_EXACT` 에 `/pending` 을 넣지 않고 여기서 제외하는 이유:
  // 그 목록은 "카톡 업로드 직원에게 여는 업무 표면"이라는 **제품 결정** 목록이고
  // (auth-roles.ts 주석), 대기 화면은 업무 표면이 아니라 승인 여부라는 **다른 축**의
  // 착지 지점이다. 인가 게이트의 목적지는 역할 게이트가 가로채면 안 된다는 것이 여기서
  // 표현하려는 불변식이다. `isPendingAllowedPath` 도 화이트리스트라 fail-closed 는 유지된다
  // (신규 라우트가 기본 공개가 되지 않는다).
  if (
    user &&
    role === "operator" &&
    !isAuthExchangePath &&
    !isSentryTunnelPath(pathname) &&
    !isPendingAllowedPath(pathname) &&
    !isOperatorAllowedPath(pathname)
  ) {
    return denyOperator(request);
  }

  if (
    !user &&
    !devBypassEnabled &&
    !agentLaneEnabled &&
    !request.nextUrl.pathname.startsWith("/api/auth") &&
    !request.nextUrl.pathname.startsWith("/api/cron") &&
    // 자체 Bearer INGEST_TOKEN 인증을 쓰는 인제스트 라우트(로컬 러너용, 세션 없음) — 정확 경로로만
    // 제외한다(Phase 4-5). 신규 /api/chat-room-mappings/manage와 /api/kakao-uploads는 세션 인증이
    // 필요한 라우트이므로 startsWith로 넓게 열면 세션 게이트를 우회해버린다.
    request.nextUrl.pathname !== "/api/work-records/ingest" &&
    request.nextUrl.pathname !== "/api/chat-room-mappings" &&
    request.nextUrl.pathname !== "/api/chat-room-mappings/unmapped" &&
    request.nextUrl.pathname !== "/api/chat-room-mappings/reconcile" &&
    !request.nextUrl.pathname.startsWith("/login") &&
    !request.nextUrl.pathname.startsWith("/auth") &&
    // Sentry 터널(next.config.ts `tunnelRoute`) — 브라우저가 광고차단기를 우회해 에러를 보내는
    // 통로다. 게이트에 걸리면 POST가 307을 따라가 /login에서 405가 되고, 그 결과 **프로덕션
    // 에러가 Sentry에 하나도 안 올라간다**(실사고: 앱 전역 화이트스크린을 아무도 못 잡았고
    // 오너 실기기 제보로만 발견). 에러는 로그인 전 화면·셀러 포털처럼 세션이 없는 표면에서
    // 오히려 더 중요하므로, 이 경로는 설계상 비인증이어야 한다.
    !isSentryTunnelPath(request.nextUrl.pathname) &&
    // 크롤러 지시문 — 인증 뒤에 두면 크롤러가 "긁지 마라"를 읽을 수조차 없어 전면 스캔을
    // 유발한다(실측: /robots.txt가 307 → /login). robots.ts가 Disallow를 주려면 공개여야 한다.
    request.nextUrl.pathname !== "/robots.txt" &&
    // 쿠팡 파트너스 채널 인증용 공개 페이지 — 심사자가 비로그인으로 열람해야 하므로 게이트 제외.
    !request.nextUrl.pathname.startsWith("/coupang-partners") &&
    // 셀러 포털 토큰 URL — 셀러가 비로그인으로 열람 (토큰 자체가 접근 자격).
    !request.nextUrl.pathname.startsWith("/p/") &&
    // 셀러 전용 주소(/<slug>) — 비로그인 열람 허용, 페이지의 비밀번호 게이트가 인증 담당.
    !isPortalPublicPath(request.nextUrl.pathname)
  ) {
    // no user, potentially respond by redirecting the user to the login page
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // 검증된 user를 신뢰 헤더로 다운스트림에 전달. 클라이언트가 보낸 원본 헤더 값은 무엇이든
  // 먼저 지운 뒤(위조 방어) user가 있을 때만 방금 검증한 값으로 다시 채운다 — 미인증 요청은
  // 이 시점 이후로도 절대 헤더를 갖고 있을 수 없다.
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.delete(TRUSTED_USER_HEADER);
  if (user) {
    forwardedHeaders.set(
      TRUSTED_USER_HEADER,
      encodeTrustedUser({ id: user.id, email: user.email ?? "", role }),
    );
  }

  const finalResponse = NextResponse.next({ request: { headers: forwardedHeaders } });

  // 표시용 역할 쿠키(권한 경계 아님 — `ROLE_COOKIE` 주석 참조). 사이드바·카톡 페이지가
  // 이 값을 읽어 operator 에게 "눌러도 막히는 입구"를 그리지 않는다. 비로그인이면 지운다.
  if (user) {
    finalResponse.cookies.set(ROLE_COOKIE, role, {
      path: "/",
      sameSite: "lax",
      httpOnly: false,
    });
  } else {
    finalResponse.cookies.delete(ROLE_COOKIE);
  }
  // Supabase가 setAll에서 이미 써둔 Set-Cookie(세션 갱신)를 옵션 손실 없이 그대로 이관.
  for (const [key, value] of supabaseResponse.headers) {
    if (key.toLowerCase() === "set-cookie") finalResponse.headers.append(key, value);
  }
  return finalResponse;
}
