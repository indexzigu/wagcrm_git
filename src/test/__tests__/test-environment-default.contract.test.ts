// 테스트 환경 기본값 계약 (2026-08-28).
//
// 배경: 종전에는 `environment: "jsdom"` 이 전역이라 **DOM 을 전혀 안 쓰는 파일도**
// 브라우저 환경을 매번 지었다. 기본을 `node` 로 내리고 DOM 이 필요한 파일만
// `// @vitest-environment jsdom` 을 선언하도록 바꿨다.
// 실측: 전체 실행 170~194초 → 89~91초(부하가 더 높은 조건에서), 테스트 개수 동일.
//
// 🪤 **이 최적화는 조용히 되돌아갈 수 있다.** 누가 `environment` 를 다시 `"jsdom"` 으로
// 올리면 테스트는 **전부 통과한 채** 두 배 느려진다 — 실패가 없으니 알아차릴 계기가
// 없다. 그래서 기본값 자체를 계약으로 고정한다.
//
// 반대 방향(파일이 DOM 을 쓰는데 선언을 빠뜨림)은 `document is not defined` 로
// **시끄럽게** 실패하므로 계약이 필요 없다 — 그쪽은 이미 자기고발한다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONFIG = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");
const SETUP = readFileSync(join(process.cwd(), "src", "test", "setup.ts"), "utf8");

/** 주석을 걷어낸 설정 본문 — 주석이 옛 값을 설명하므로 그대로 검사하면 오탐이다. */
const configCode = CONFIG.split("\n")
  .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
  .join("\n");

describe("테스트 환경 기본값", () => {
  it("기본 environment 는 `node` 다 — jsdom 으로 되돌리면 조용히 2배 느려진다", () => {
    expect(configCode).toMatch(/environment:\s*"node"/);
    expect(configCode, "전역 jsdom 으로 되돌아갔다").not.toMatch(/environment:\s*"jsdom"/);
  });

  it("DOM 이 필요한 파일은 파일 단위로 선언한다 — 중앙 목록을 만들지 않는다", () => {
    // 중앙 목록은 파일이 늘 때마다 어긋나고, 어긋나도 조용하다.
    expect(configCode).not.toMatch(/environmentMatchGlobs/);
    expect(configCode).not.toMatch(/environmentOptions[\s\S]*jsdom/);
  });
});

describe("공통 setup 은 두 환경에서 다 살아야 한다", () => {
  it("DOM 손질이 `hasDom` 가드 안에 있다", () => {
    // 가드 없이 `Element.prototype` 을 만지면 node 환경 테스트가 **전부** 죽는다
    // (2026-08-28 실측: 644파일 중 521개가 그 한 줄로 넘어졌다).
    expect(SETUP).toMatch(/const hasDom\s*=/);
    expect(SETUP).toMatch(/if \(hasDom\)/);
  });

  it("@testing-library 를 정적 import 하지 않는다 — node 환경에서 평가되면 죽는다", () => {
    const setupCode = SETUP.split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(setupCode).not.toMatch(/^import .*@testing-library/m);
    // 대신 가드 안에서 동적으로 가져온다.
    expect(setupCode).toMatch(/import\("@testing-library\/react"\)/);
  });

  it("vi.mock 은 최상위에 남는다 — 호이스팅되므로 조건 안에서는 동작하지 않는다", () => {
    const guardAt = SETUP.indexOf("if (hasDom)");
    expect(guardAt).toBeGreaterThan(-1);
    const beforeGuard = SETUP.slice(0, guardAt);
    expect(beforeGuard, "vi.mock 이 가드 뒤로 밀렸다").toContain('vi.mock("next/cache"');
    expect(beforeGuard).toContain('vi.mock("@/hooks/use-mobile"');
  });
});
