// 헬퍼 HTTP 계층의 브리지 보안 계약.
//
// 헬퍼는 오너 Mac 의 loopback 서버라, 오너가 방문한 **아무 사이트나** 이 주소로
// fetch 를 시도할 수 있다(CSRF 부류). 브라우저는 응답 읽기를 막을 뿐 요청 자체는
// 나가므로, 서버가 오리진을 보고 거부해야 한다. 이 파일이 그 규칙을 고정한다.
import { describe, it, expect } from "vitest";
import { ALLOWED_ORIGINS, BIND_HOST, corsHeaders, isAllowedOrigin } from "../http";

describe("오리진 화이트리스트", () => {
  it("CRM 프로덕션·로컬 dev 오리진만 허용한다", () => {
    expect(isAllowedOrigin("https://crm.ygrd.kr")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
  });

  it("임의 사이트는 거부한다", () => {
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
    // 서브도메인·접두 일치로 뚫리지 않는다(부분 문자열 비교였다면 통과했을 형태).
    expect(isAllowedOrigin("https://crm.ygrd.kr.evil.example.com")).toBe(false);
    expect(isAllowedOrigin("https://evil.example.com/crm.ygrd.kr")).toBe(false);
  });

  it("오리진 없음은 허용으로 보지 않는다", () => {
    // 오리진 헤더가 없는 요청은 브라우저발이 아니므로 서버가 CORS 헤더를 붙이지
    // 않는다 — 그 판단은 라우터가 하고, 이 함수는 "허용됨"이라고 말하지 않는다.
    expect(isAllowedOrigin(undefined)).toBe(false);
    expect(isAllowedOrigin("")).toBe(false);
  });

  it("허용 목록은 https CRM 과 로컬 주소뿐이다", () => {
    for (const origin of ALLOWED_ORIGINS) {
      expect(origin).toMatch(/^https:\/\/crm\.ygrd\.kr$|^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
    }
  });
});

describe("CORS 헤더", () => {
  it("Private Network Access 프리플라이트에 응답한다", () => {
    // 이 헤더가 없으면 https 페이지에서 loopback 으로 가는 요청을 Chrome 이 막는다.
    const headers = corsHeaders("https://crm.ygrd.kr");
    expect(headers["Access-Control-Allow-Private-Network"]).toBe("true");
  });

  it("요청 오리진을 그대로 반사하되 Vary 를 붙인다", () => {
    const headers = corsHeaders("http://localhost:3000");
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
    // 오리진별로 응답이 갈리므로 캐시가 섞이지 않게 한다.
    expect(headers.Vary).toBe("Origin");
  });

  it("와일드카드를 쓰지 않는다", () => {
    expect(corsHeaders("https://crm.ygrd.kr")["Access-Control-Allow-Origin"]).not.toBe("*");
  });
});

describe("바인딩", () => {
  it("loopback 고정", () => {
    expect(BIND_HOST).toBe("127.0.0.1");
  });
});
