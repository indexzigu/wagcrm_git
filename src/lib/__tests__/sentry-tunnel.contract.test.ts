import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SENTRY_TUNNEL_ROUTE, isSentryTunnelPath } from "@/lib/sentry-tunnel";

// 계약: Sentry 터널 경로와 크롤러 지시문은 **인증 게이트 밖**에 있어야 한다.
//
// 이 테스트가 존재하는 이유(2026-07 실사고): `tunnelRoute:"/monitoring"`이 인증 미들웨어에
// 걸려 터널 POST가 /login으로 307 → 405가 났고, 그 결과 **프로덕션 에러가 Sentry에 하나도
// 안 올라갔다**. 앱은 멀쩡히 도는데 관측만 죽는 형태라 빌드·타입·테스트 어디에도 안 잡혔고,
// 앱 전역 화이트스크린을 오너 실기기 제보로만 발견했다. 누가 제외 줄을 지우면 같은 침묵이
// 재발하므로 소스 계약으로 못박는다.
//
// `/robots.txt`도 같은 게이트에 막혀 있었다 — 크롤러가 "긁지 마라"를 읽을 수조차 없어
// 공개 도메인이 전면 스캔 대상이 됐다(관측상 미인증 요청이 전체 호출의 대부분).

const REPO_ROOT = join(__dirname, "..", "..", "..");

/**
 * 주석을 걷어낸 코드만 남긴다. 주석에 경로 문자열이 등장하므로(이 PR의 설명 주석이 실제로
 * `/robots.txt`·`/login`을 언급한다) 원문 그대로 grep하면 **주석만 있고 코드는 지워져도
 * 통과**하는 공허한 테스트가 된다.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("Sentry 터널 · robots.txt 인증 제외 계약", () => {
  it("next.config.ts의 tunnelRoute 리터럴이 SENTRY_TUNNEL_ROUTE와 같다 (드리프트 차단)", () => {
    const code = codeOnly(read("next.config.ts"));
    const match = /tunnelRoute:\s*"([^"]+)"/.exec(code);
    expect(match, "next.config.ts에서 tunnelRoute 리터럴을 찾지 못했습니다").not.toBeNull();
    expect(match![1]).toBe(SENTRY_TUNNEL_ROUTE);
  });

  it("미인증 리다이렉트 조건이 터널과 robots.txt를 제외한다", () => {
    const code = codeOnly(read("src/lib/supabase/middleware.ts"));

    // 조건 블록만 잘라낸다. 앵커가 빗나가 빈 슬라이스가 되면 아래 단언이 전부 공허 통과하므로
    // 슬라이스 자체의 존재·크기를 먼저 단언한다(보드 기록: 앵커 함정으로 실제 겪은 실수).
    const start = code.indexOf("!user &&");
    const end = code.indexOf('url.pathname = "/login"', start);
    expect(start, "미인증 리다이렉트 조건의 시작 앵커를 찾지 못했습니다").toBeGreaterThan(-1);
    expect(end, "리다이렉트 본문 끝 앵커를 찾지 못했습니다").toBeGreaterThan(start);

    const condition = code.slice(start, end);
    expect(condition.length).toBeGreaterThan(200);

    // 토큰 존재만 보면 부정 연산자가 빠진 논리 반전(`!` 탈락)을 놓친다 — 조건이 정반대가 돼도
    // grep 은 침묵한다. 그래서 부정형까지 포함해 대조한다(공백 변형 허용).
    // 런타임 의미까지 지키는 감시자는 middleware-auth-gate.test.ts 쪽이다.
    expect(condition).toMatch(/!\s*isSentryTunnelPath\(/);
    expect(condition).toMatch(/pathname\s*!==\s*"\/robots\.txt"/);
  });

  it("robots.ts가 전 크롤러에 전면 Disallow를 준다", () => {
    const code = codeOnly(read("src/app/robots.ts"));
    expect(code).toContain('userAgent: "*"');
    expect(code).toContain('disallow: "/"');
  });

  it("isSentryTunnelPath는 터널과 하위 경로만 통과시킨다 (음성 대조군 포함)", () => {
    expect(isSentryTunnelPath("/monitoring")).toBe(true);
    expect(isSentryTunnelPath("/monitoring/envelope")).toBe(true);

    // 접두사만 같은 무관한 라우트가 인증에서 열리면 안 된다 — startsWith만 썼을 때의 사고.
    expect(isSentryTunnelPath("/monitoring-admin")).toBe(false);
    expect(isSentryTunnelPath("/pipeline")).toBe(false);
    expect(isSentryTunnelPath("/")).toBe(false);
  });

  it("codeOnly가 주석을 실제로 제거한다 (테스트 자신의 음성 대조군)", () => {
    expect(codeOnly('const a = 1; // "/robots.txt"')).not.toContain("/robots.txt");
    expect(codeOnly('/* "/robots.txt" */ const a = 1;')).not.toContain("/robots.txt");
    // URL의 `//`는 주석이 아니므로 살아남아야 한다(과잉 제거 방지).
    expect(codeOnly('const u = "https://example.com/x";')).toContain("https://example.com/x");
  });
});
