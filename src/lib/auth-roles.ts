/**
 * 역할(role) 어휘와 operator 접근 경계 — **순수 모듈**(env·Prisma·next 무의존).
 *
 * edge(미들웨어) · node(라우트) · 브라우저(사이드바) 세 런타임이 같은 판정을 공유해야
 * 하므로 여기엔 부수효과가 있는 것을 두지 않는다. 이메일→역할 해석처럼 env를 읽는 부분은
 * `auth-allowlist.ts`(인가 신원 SSOT)가 소유한다.
 *
 * ## operator 가 무엇인가
 * 카톡 대화 txt 를 CRM 에 올리기만 하는 직원 계정이다. 셀러·캠페인·정산·매출·세무는
 * 보지 못한다(오너 확정 2026-08-06 "계정 + 업로드 탭만 열기").
 *
 * ## 화이트리스트인 이유 (되돌리지 말 것)
 * 차단 목록(블랙리스트)으로 뒤집으면 **새로 생기는 라우트·페이지가 기본 공개**가 된다 —
 * 이 레포는 라우트가 계속 늘어나므로 누락이 곧 침묵형 유출이다. 여기 없는 경로는 전부
 * 막히고, operator 에게 새 표면을 열 때만 이 목록에 한 줄 추가한다.
 */

export type UserRole = "admin" | "operator";

const ROLE_VALUES: readonly UserRole[] = ["admin", "operator"];

/**
 * operator 로그인 시 착지하는 화면. 막힌 경로로 들어오면 여기로 되돌린다.
 * `OPERATOR_ALLOWED_EXACT` 에 반드시 포함돼 있어야 한다(리다이렉트 루프 방지).
 */
export const OPERATOR_HOME = "/assets/katalk";

/**
 * 승인되지 않은 사용자(대기·거절)가 착지하는 화면. 아래 `isPendingAllowedPath` 에
 * 반드시 포함돼 있어야 한다(리다이렉트 루프 방지).
 *
 * ⚠️ 같은 이유로 **역할 게이트도** 이 경로를 통과시켜야 한다 — 미승인 사용자의 역할은
 * 거의 항상 operator 라, 역할 게이트가 여기를 가로채면 `/pending` ↔ `OPERATOR_HOME`
 * 무한 리다이렉트가 된다. 집행은 `supabase/middleware.ts` 의 역할 게이트에서
 * `!isPendingAllowedPath(pathname)` 로 한다.
 */
export const PENDING_HOME = "/pending";

/**
 * 미승인 사용자가 열 수 있는 유일한 경로들. operator 화이트리스트와 같은 이유로
 * 화이트리스트다 — 새 라우트가 기본 공개가 되면 안 된다.
 * 로그아웃(`/auth/`)을 막으면 대기 상태에서 계정을 바꿀 수 없다.
 */
export function isPendingAllowedPath(pathname: string): boolean {
  if (pathname === PENDING_HOME || pathname === "/login") return true;
  return pathname.startsWith("/auth/") || pathname.startsWith("/api/auth/");
}

/**
 * 미들웨어가 심는 **표시용** 역할 쿠키. httpOnly 가 아니다 — 사이드바가 첫 렌더에서
 * 동기적으로 읽어 내비게이션을 그리기 위한 것이다.
 *
 * ⚠️ **권한 경계가 아니다.** 위조해도 얻는 것은 자기 화면의 메뉴 표시뿐이고, 실제 접근은
 * 미들웨어가 Supabase 세션에서 다시 판정한다. 이 쿠키로 서버 판정을 하지 말 것.
 * 매 요청마다 미들웨어가 덮어쓰므로 역할 변경 시 자동으로 따라온다.
 */
export const ROLE_COOKIE = "wag_crm_role";

/** 알 수 없는 값은 null — 호출부가 폴백 규칙을 적용한다(임의 문자열을 역할로 승격 금지). */
export function parseRole(value: unknown): UserRole | null {
  return typeof value === "string" && (ROLE_VALUES as readonly string[]).includes(value)
    ? (value as UserRole)
    : null;
}

/**
 * operator 가 열 수 있는 정확 경로.
 * - `/assets/katalk` — 업로드 화면(방 관리 탭은 화면단에서 숨긴다)
 * - `/api/kakao-uploads` — 업로드 API(preview·commit 2단계 모두 이 한 경로다)
 *
 * ⛔ `/api/partners`·`/api/sellers`·`/api/campaigns` 는 **의도적으로 빠져 있다** —
 * 업로드 화면의 "귀속 대상 지정" 드롭다운이 쓰는 목록이라 열면 전 셀러·거래처·캠페인
 * 이름이 직원에게 노출된다(이 작업이 막으려는 바로 그것). 귀속 지정은 오너가 방 관리
 * 탭에서 처리하고, 미매핑 업로드는 정상 경로다(`지정 안 함(미매핑 유지)`).
 */
const OPERATOR_ALLOWED_EXACT: ReadonlySet<string> = new Set([
  OPERATOR_HOME,
  "/api/kakao-uploads",
  "/login",
]);

/** 로그인·로그아웃 흐름. 막으면 operator 가 세션을 끝낼 수 없다. */
const OPERATOR_ALLOWED_PREFIXES: readonly string[] = ["/auth/", "/api/auth/"];

export function isOperatorAllowedPath(pathname: string): boolean {
  if (OPERATOR_ALLOWED_EXACT.has(pathname)) return true;
  return OPERATOR_ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
