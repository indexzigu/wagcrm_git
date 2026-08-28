/**
 * 헬퍼 HTTP 계층의 **순수 규칙** — 오리진 검사와 CORS 헤더. 브라우저·Playwright 의존이
 * 없어 그대로 단위 테스트한다(서버를 띄우지 않고 규칙만 검증할 수 있어야 한다).
 *
 * ## 왜 오리진 화이트리스트가 필요한가
 *
 * 헬퍼는 오너 Mac 의 loopback 에서 도는 서버라, 오너가 방문한 **아무 웹사이트나**
 * `fetch("http://127.0.0.1:9410/issue")` 를 시도할 수 있다(CSRF 부류). 브라우저는
 * cross-origin 응답을 읽지 못하게 막을 뿐 **요청 자체는 나간다** — 그래서 서버가
 * 오리진을 보고 거부해야 한다. 우리 CRM 오리진만 허용한다.
 */

/** CRM 이 서비스되는 오리진. 프로덕션 + 로컬 dev 두 갈래뿐이다. */
export const ALLOWED_ORIGINS: readonly string[] = [
  "https://crm.ygrd.kr",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
];

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

/**
 * 허용 오리진에 대한 CORS 헤더.
 * `Access-Control-Allow-Private-Network` 는 Chrome 의 Private Network Access
 * 프리플라이트 응답이다 — public 사이트(https CRM)에서 private 주소(loopback)로 가는
 * 요청은 이 헤더가 없으면 브라우저가 막는다.
 */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Private-Network": "true",
    Vary: "Origin",
  };
}

/** 헬퍼가 바인딩하는 주소 — **loopback 고정**. 0.0.0.0 으로 열면 같은 네트워크의 다른
 *  기기가 발행 데이터를 밀어 넣을 수 있다(P0). 이 상수를 바꾸지 말 것. */
export const BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 9410;
