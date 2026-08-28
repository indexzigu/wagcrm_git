// 봇 스캔 경로 판정 — proxy(미들웨어)에서 인증·DB 접근 **전에** 끊기 위한 순수 문자열 로직.
// edge 에서 import 하므로 Node 전용 API(crypto·prisma) 금지.
//
// 왜 필요한가 (2026-08-02 prod 실측):
//   `/wp-admin` · `/xmlrpc.php` 가 **HTTP 200 + 49KB** 를 받고 있었다. 셀러 포털 `[slug]` 는
//   한 세그먼트짜리 경로를 전부 받는 catch-all 이고, `isValidPortalSlug` 는 "소문자 영숫자
//   3~31자"라는 **형식**만 보므로 스캐너 경로가 그 형식을 그대로 통과한다. 그 뒤:
//     ① 미들웨어가 공개 경로로 판정 → `supabase.auth.getUser()` 왕복
//     ② 페이지가 `resolvePortalSeller` 로 DB 조회
//     ③ `notFound()` 를 부르지만 **PPR 정적 셸이 이미 200 으로 나간 뒤**라 상태코드를 못 바꾼다
//   결과가 "200 + 49KB" 다 — 봇 입장에선 **찾은 것처럼 보이므로** 스캔을 멈출 이유가 없고,
//   매 요청이 auth 왕복 + DB 조회 + 프리로드 링크 49KB 를 태운다.
//
// ⚠️ 이 판정은 "존재하지 않는 슬러그"를 가리지 못한다 — 그건 DB 를 봐야 알 수 있고 edge 에서는
//    할 수 없다. 여기서 잡는 것은 **셀러 슬러그일 수 없는 모양**뿐이다(확장자·CMS 관용 경로).
//    형식상 슬러그인 미등록 경로는 여전히 페이지까지 가서 200 셸을 받는다 — 알려진 잔여다.

/**
 * 셀러 슬러그일 수 없는 파일 확장자 — 스캐너가 때리는 스크립트·설정·백업·아카이브류.
 *
 * ⚠️ 앱이 실제로 서빙하는 확장자를 넣지 말 것 — 넣는 순간 그 경로가 죽는다.
 * 그래서 `txt`(robots.txt) · `xml`(sitemap.xml) · `json`/`webmanifest`(manifest·
 * `.well-known/*`) · `ico` 는 **의도적으로 제외**한다.
 *
 * 셀러 슬러그는 점을 포함할 수 있으므로(인스타 핸들 호환, 예: `user.name`) "점이 있으면
 * 봇"으로 판정하지 않는다 — 반드시 이 목록의 확장자로 **끝날 때만** 잡는다.
 */
const BOT_SCAN_EXTENSIONS: ReadonlySet<string> = new Set([
  // 서버 스크립트
  'php', 'php5', 'php7', 'phtml', 'asp', 'aspx', 'jsp', 'jspx', 'cgi', 'pl', 'py', 'rb', 'sh', 'bash',
  // 설정·시크릿·VCS
  'env', 'ini', 'cfg', 'conf', 'yml', 'yaml', 'pem', 'key', 'crt', 'git',
  // 데이터·백업·로그
  'sql', 'db', 'sqlite', 'sqlite3', 'bak', 'old', 'swp', 'log',
  // 아카이브·바이너리
  'zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'war', 'jar', 'dll', 'exe',
]);

/**
 * 셀러 슬러그로 쓰일 리 없는 CMS·관리도구 관용 경로의 **첫 세그먼트**.
 *
 * 확장자가 없어서 위 규칙으로는 못 잡히는 것들이다(`/wp-admin` 이 대표 — 실측 최다 표적).
 * `RESERVED_PORTAL_SLUGS` 와 **역할이 다르다**: 저쪽은 "실재하는 앱 라우트라서 셀러가 못
 * 가져가는 이름"이고(→ 로그인 게이트로 흘러야 한다), 이쪽은 "앱에 존재하지도 않고 셀러도
 * 아닌 이름"이다(→ 즉시 404). 두 집합이 겹치면 실재 라우트가 404 가 되므로
 * `bot-scan-paths.contract.test.ts` 가 교집합 0 을 강제한다.
 */
const BOT_SCAN_SEGMENTS: ReadonlySet<string> = new Set([
  'wp-admin', 'wp-login', 'wp-content', 'wp-includes', 'wp-json', 'wordpress', 'wp',
  'phpmyadmin', 'pma', 'myadmin', 'phpinfo',
  'cgi-bin', 'vendor', 'administrator', 'typo3', 'joomla', 'drupal', 'magento',
  'owa', 'autodiscover', 'boaform', 'solr', 'jenkins', 'actuator',
]);

/** 경로 세그먼트가 봇 스캔 확장자로 끝나는가 */
function hasBotScanExtension(segment: string): boolean {
  const dot = segment.lastIndexOf('.');
  if (dot < 0 || dot === segment.length - 1) return false;
  return BOT_SCAN_EXTENSIONS.has(segment.slice(dot + 1).toLowerCase());
}

/**
 * 이 요청이 봇 스캔인가 — 참이면 미들웨어가 인증·렌더 없이 즉시 404 로 끊는다.
 *
 * 어느 **세그먼트라도** 걸리면 참이다(`/.git/config` 처럼 표적이 첫 세그먼트에만 있는 경우가
 * 흔하다). 판정은 대소문자 무시 — 스캐너는 `/WP-Admin` 같은 변형도 섞어 보낸다.
 */
export function isBotScanPath(pathname: string): boolean {
  for (const segment of pathname.split('/')) {
    if (!segment) continue;
    const lower = segment.toLowerCase();
    if (BOT_SCAN_SEGMENTS.has(lower)) return true;
    if (hasBotScanExtension(lower)) return true;
  }
  return false;
}

export const __testing = { BOT_SCAN_EXTENSIONS, BOT_SCAN_SEGMENTS };
