// CSP 가 홈택스 로컬 헬퍼 연결을 막지 않는지 고정하는 계약 (실사고 2026-08-05).
//
// ⛔ 이 레포의 CSP 는 `connect-src 'self' https:` 였다 — 그 상태에서는 헬퍼가 켜져
// 있어도 브라우저가 http://127.0.0.1 로의 fetch 를 **차단**해, 화면에는 "헬퍼에
// 연결할 수 없습니다"만 뜬다. 코드·단위 테스트는 전부 초록이고(모듈 경계에서 fetch 를
// 모킹하므로) 실렌더 QA 의 콘솔에서만 드러났다. 즉 이 결함은 **런타임 정책과 클라이언트
// 코드가 서로 다른 파일에 있어서** 생긴 것이라, 둘의 짝을 소스 스캔으로 묶어 둔다.
//
// 🪤 CSP 는 빌드 타임 정적 문자열이라 `NEXT_PUBLIC_HOMETAX_HELPER_URL` 같은 런타임
// env 를 읽지 못한다 — 포트를 바꾸면 next.config.ts 도 함께 바꿔야 하고, 이 테스트가
// 그 짝을 확인한다(기본 주소가 CSP 허용 목록 안에 있는가).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOMETAX_HELPER_BASE_URL } from "../hometax-helper-client";

const nextConfig = readFileSync(resolve(process.cwd(), "next.config.ts"), "utf8");

/** `connect-src ...;` 한 줄을 뽑는다 — 다른 지시어의 값에 섞여 통과하지 않도록. */
function readConnectSrc(source: string): string {
  const match = source.match(/connect-src([^;]*);/);
  if (!match) throw new Error("next.config.ts 에서 connect-src 지시어를 찾지 못했습니다.");
  return match[1];
}

describe("홈택스 로컬 헬퍼 — CSP 계약", () => {
  it("connect-src 가 헬퍼 기본 주소(loopback)를 허용한다", () => {
    const connectSrc = readConnectSrc(nextConfig);
    // 상수에 값이 직접 있지 않고 next.config.ts 안의 다른 변수로 조립될 수 있으므로,
    // 조립된 최종 문자열까지 포함해 확인한다.
    const origins = nextConfig.match(/HOMETAX_HELPER_ORIGINS\s*=\s*"([^"]*)"/)?.[1] ?? "";
    const allowed = `${connectSrc} ${origins}`;
    expect(allowed).toContain(HOMETAX_HELPER_BASE_URL);
  });

  it("음성 대조군 — 허용 목록에 없는 외부 오리진은 통과하지 않는다", () => {
    // 정규식이 깨져 항상 통과하는 하네스 고장을 잡는 대조군(P8 §6 의 양성/음성 대조
    // 규율과 같은 취지). 이 단언이 실패하면 위 테스트의 초록도 믿을 수 없다.
    const connectSrc = readConnectSrc(nextConfig);
    const origins = nextConfig.match(/HOMETAX_HELPER_ORIGINS\s*=\s*"([^"]*)"/)?.[1] ?? "";
    expect(`${connectSrc} ${origins}`).not.toContain("http://example.invalid:9410");
  });

  it("허용은 loopback 뿐이다 — 외부 http 오리진을 CSP 에 열지 않는다", () => {
    const origins = nextConfig.match(/HOMETAX_HELPER_ORIGINS\s*=\s*"([^"]*)"/)?.[1] ?? "";
    expect(origins.trim()).not.toBe("");
    for (const origin of origins.trim().split(/\s+/)) {
      expect(origin).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
    }
  });
});
