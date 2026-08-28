// 셀러 전용 주소(crm.ygrd.kr/<slug>)의 슬러그 규칙 — edge(proxy)와 서버 양쪽에서 import
// 하므로 Node 전용 API(crypto·prisma) 금지. 순수 문자열 로직만 둔다.
//
// 보안 모델: slug는 셀러 계정명 기반이라 **공개 정보로 취급**한다(열거 가능해도 안전해야 함).
// 접근 비밀은 오직 비밀번호(portal-auth.ts) — slug 자체에 비밀성을 기대하지 말 것.

/**
 * 예약 슬러그 — src/app 최상위 라우트 세그먼트 + 정적/메타 경로 + 향후 충돌 위험 단어.
 * ⚠ src/app 에 최상위 라우트를 새로 만들면 반드시 여기에도 추가할 것 —
 * __tests__/portal-slug.test.ts 의 계약 테스트가 디렉터리를 스캔해 누락을 잡는다.
 * (예약어 누락 = 그 경로가 셀러 슬러그로 선점당하거나, proxy가 공개 경로로 오판할 수 있다.)
 */
export const RESERVED_PORTAL_SLUGS: ReadonlySet<string> = new Set([
  // src/app 최상위 라우트 (계약 테스트 대상)
  'admin',
  'api',
  'assets',
  'assistant',
  'auth',
  'calendar',
  'claim-check',
  'coupang-partners',
  'deals',
  'login',
  'order-converter',
  'outreach',
  'p',
  'partners',
  'pending', // 미승인 계정 대기 화면 — 빠져 있으면 포털 공개 경로로 오판돼 인가·역할 게이트를 둘 다 건너뛴다
  'pipeline',
  'privacy',
  'reports',
  'sellers',
  'settings',
  'settlement',
  'schedule',
  'share', // PR #32 소셜 미리보기 리라이트 경로(/share/sellers/...)
  // 정적/메타 경로
  'favicon.ico',
  'manifest.webmanifest',
  'robots.txt',
  'sitemap.xml',
  '_next',
  'monitoring', // Sentry tunnel 등 인프라 예약
  // 향후 라우트로 쓸 법한 일반 단어 선점 방지
  'app',
  'dashboard',
  'portal',
  'report',
  'seller',
  'mobile',
  'www',
]);

// 3~31자, 소문자 영숫자로 시작, 이후 소문자 영숫자/._- 허용(인스타 핸들 규칙과 호환)
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{2,30}$/;

/** 유효한 셀러 슬러그인지 — 형식 + 예약어 + 연속 점 금지 */
export function isValidPortalSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes('..') && !RESERVED_PORTAL_SLUGS.has(slug);
}

/** SNS 핸들 → 슬러그 제안. 정규화 불가(한글 핸들 등)면 null — 소유자가 직접 입력한다. */
export function suggestPortalSlug(snsHandle: string | null | undefined): string | null {
  if (!snsHandle) return null;
  const normalized = snsHandle
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+/, '')
    .slice(0, 31);
  return isValidPortalSlug(normalized) ? normalized : null;
}

const PORTAL_PATH_RE = /^\/([^/]+)(\/card\/[A-Za-z0-9_-]+)?\/?$/;

/**
 * proxy(미들웨어)의 공개 경로 판정 — /<slug> 와 /<slug>/card/<id> 만 공개로 연다.
 * 예약 세그먼트는 절대 공개로 열지 않는다(내부 라우트 보호). 실제 인증(비밀번호 게이트)은
 * 페이지가 수행하고, 여기서는 "로그인 리다이렉트를 하지 않을 경로"만 판정한다.
 * 존재하지 않는 슬러그는 페이지에서 404 — 공개로 열려도 노출되는 것이 없다.
 */
export function isPortalPublicPath(pathname: string): boolean {
  return extractPortalSlug(pathname) !== null;
}

/**
 * 위와 같은 판정에서 **기본 슬러그 값**을 꺼낸다(카드 경로의 접미사는 버린다).
 * proxy 가 DB 존재 확인(별도 모듈, Node 전용)에 넘길 슬러그를 얻는 용도 — 판정 자체는
 * 이 함수도 `isPortalPublicPath` 와 완전히 같은 정규식을 공유하므로 두 결과가 어긋나지
 * 않는다(어긋나면 형식은 맞는데 존재 확인을 안 하는 구멍이 생긴다).
 */
export function extractPortalSlug(pathname: string): string | null {
  const m = pathname.match(PORTAL_PATH_RE);
  if (!m) return null;
  return isValidPortalSlug(m[1]) ? m[1] : null;
}
