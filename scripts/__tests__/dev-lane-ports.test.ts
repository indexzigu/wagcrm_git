import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * 개발 레인의 포트 계약. 2026-08-13 자체호스팅 컷오버로 이 맥이 **프로덕션 호스트**가
 * 됐다 — 포트 3000 은 프로덕션 앱(launchd `kr.ygrd.wagcrm.app`), 3001 은 프리뷰다.
 * 개발용이 그 둘을 건드리면 두 가지가 난다:
 *   (A) `kill-port 3000` 류가 **프로덕션을 죽인다**(`start-server.command` 가 실제로
 *       그랬다 — PR #387).
 *   (B) 죽이지 않더라도 "localhost:3000 을 열었는데 사실 프로덕션이었다"는 오독이 남는다.
 *
 * 🪤 그리고 이 파일이 존재하는 진짜 이유는 **playwright 결합**이다. e2e 설정은
 * `webServer.command` 로 `npm run dev` 를 띄우고 `webServer.url` 이 뜨기를 기다리는데,
 * 둘이 어긋나면 playwright 는 그 주소에서 응답하는 **프로덕션을 자기 서버로 착각하고
 * 거기에 테스트를 돌린다.** 실패가 아니라 초록불로 끝나므로 사람이 알아챌 계기가 없다.
 */
const ROOT = path.resolve(__dirname, "..", "..");
const RESERVED = { "3000": "프로덕션", "3001": "프리뷰" } as const;

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const playwright = readFileSync(path.join(ROOT, "e2e", "playwright.config.ts"), "utf8");

/** `next dev … -p <port>` 에서 포트를 뽑는다. 미지정이면 null(= Next 기본 3000). */
function devPortOf(command: string): string | null {
  const m = command.match(/-p\s+(\d+)/);
  return m ? m[1] : null;
}

describe("개발 레인 포트", () => {
  const devScripts = Object.entries(pkg.scripts).filter(([, v]) => v.includes("next dev"));

  it("모든 개발 서버 스크립트가 포트를 명시하고, 예약 레인과 겹치지 않는다", () => {
    expect(devScripts.length, "next dev 스크립트를 찾지 못했다 — 스캐너 고장").toBeGreaterThan(0);
    for (const [name, command] of devScripts) {
      const port = devPortOf(command);
      // 미지정이면 Next 기본값 3000 = 프로덕션 포트로 뜬다.
      expect(port, `${name} 이 포트를 명시하지 않는다 — 기본 3000 은 프로덕션이다`).not.toBeNull();
      expect(
        RESERVED[port as keyof typeof RESERVED],
        `${name} 의 포트 ${port} 은 ${RESERVED[port as keyof typeof RESERVED]} 레인이다`,
      ).toBeUndefined();
    }
  });

  it("개발 스크립트들이 같은 포트를 쓴다", () => {
    const ports = new Set(devScripts.map(([, v]) => devPortOf(v)));
    expect(ports.size, `개발 스크립트 포트가 갈렸다: ${[...ports].join(", ")}`).toBe(1);
  });

  it("playwright 가 기다리는 주소가 그 개발 서버와 같은 포트다", () => {
    // webServer.command 가 실제로 부르는 스크립트의 포트와 대조한다.
    const cmd = playwright.match(/command:\s*['"]([^'"]+)['"]/);
    expect(cmd, "playwright webServer.command 를 찾지 못했다 — 스캐너 고장").not.toBeNull();
    const scriptName = cmd![1].replace(/^npm run\s+/, "");
    const expected = devPortOf(pkg.scripts[scriptName] ?? "");
    expect(expected, `playwright 가 부르는 ${scriptName} 을 package.json 에서 찾지 못했다`).not.toBeNull();

    const urls = [...playwright.matchAll(/https?:\/\/localhost:(\d+)/g)].map((m) => m[1]);
    expect(urls.length, "playwright 에서 localhost 주소를 찾지 못했다 — 스캐너 고장").toBeGreaterThan(0);
    for (const port of urls) {
      expect(
        port,
        `playwright 가 :${port} 를 기다리는데 ${scriptName} 은 :${expected} 로 뜬다 — ` +
          `그 주소에 다른 것(프로덕션)이 응답하면 거기에 테스트가 돈다`,
      ).toBe(expected);
    }
  });

  it("kill-port 가 예약 레인을 겨냥하지 않는다", () => {
    const kills = Object.entries(pkg.scripts).filter(([, v]) => v.includes("kill-port"));
    expect(kills.length, "kill-port 스크립트를 찾지 못했다 — 스캐너 고장").toBeGreaterThan(0);
    for (const [name, command] of kills) {
      for (const port of Object.keys(RESERVED)) {
        expect(
          command,
          `${name} 이 ${RESERVED[port as keyof typeof RESERVED]} 포트 ${port} 을 죽인다`,
        ).not.toContain(`kill-port ${port}`);
      }
    }
  });
});
