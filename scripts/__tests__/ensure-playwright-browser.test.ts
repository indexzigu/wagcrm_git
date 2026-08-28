import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { INSTALL_ARGS, hasPlaywrightCore, main, skipReason } from "../ensure-playwright-browser.mjs";

/**
 * ensure-playwright-browser — 스토리 수집 브라우저의 **캐시 등록** 계약.
 *
 * 실사고(2026-08-20~24): 이 레포와 셀프호스트 트리가 Playwright 캐시 등록부
 * (`~/Library/Caches/ms-playwright/.links/`)에 없어, playwright-core 1.60.0 이 요구하는
 * `chromium_headless_shell-1223` 이 다른 프로젝트의 `playwright install` 에 고아로 판정돼
 * 삭제됐다. `capture-stories` 크론이 나흘간 500 으로 죽었고 스토리는 24h 수명이라 소급이
 * 불가능했다. 여기서 고정하는 건 그 재발을 막는 두 가지다:
 *
 *   (A) **확보는 조건 없이 돌아야 한다** — 등록이 목적이므로 "파일이 이미 있으니 건너뛴다"는
 *       최적화가 들어오면 등록이 안 되고 사고가 그대로 재발한다. 그래서 "생략 사유가 없으면
 *       install 이 실제로 실행된다"를 행위로 단언한다(주석·구현 서술이 아니라 호출로).
 *   (B) **postinstall 에 배선돼 있어야 한다** — 셀프호스트 배포(`infra/selfhost/deploy.sh`)가
 *       `npm install` 을 타므로 이 배선이 곧 프로덕션 확보 경로다. 끊기면 조용히 무방비가 된다.
 *   (C) **확보 실패는 fail-closed 다**(오너 확정 2026-08-25) — 삼키고 배포를 완주시키면
 *       브라우저 없는 프로덕션이 서고, 그 사실은 다음 자정 수집이 죽어야 드러난다.
 */
describe("ensure-playwright-browser", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("skipReason — 어느 환경에서 확보를 도는가", () => {
    it("로컬·셀프호스트(플래그 없음 + playwright-core 있음)에서는 진행한다", () => {
      expect(skipReason({}, true)).toBeNull();
    });

    it("Vercel 빌드는 건너뛴다 — 서버리스는 @sparticuz/chromium 을 쓴다", () => {
      expect(skipReason({ VERCEL: "1" }, true)).toContain("Vercel");
    });

    it("CI 는 건너뛴다 — 브라우저를 쓰는 워크플로가 없다", () => {
      expect(skipReason({ CI: "true" }, true)).toContain("CI");
    });

    it("playwright-core 가 없으면 확보 대상 자체가 없다", () => {
      expect(skipReason({}, false)).toContain("playwright-core");
    });

    it("이 트리에는 playwright-core 가 실제로 있다(위 분기가 늘 참이 되는 것을 막는 양성 프로브)", () => {
      expect(hasPlaywrightCore()).toBe(true);
    });
  });

  describe("main — 확보 실행", () => {
    it("생략 사유가 없으면 install 을 조건 없이 실행한다(등록이 목적이다)", () => {
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("CI", "");

      const run = vi.fn();
      expect(main(run)).toBe(0);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toEqual(INSTALL_ARGS);
    });

    it("생략 환경에서는 실행하지 않는다", () => {
      vi.stubEnv("CI", "true");

      const run = vi.fn();
      expect(main(run)).toBe(0);
      expect(run).not.toHaveBeenCalled();
    });

    it("확보 실패는 삼키지 않고 실패로 종료한다(fail-closed — 배포를 멈춘다)", () => {
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("CI", "");
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

      const rc = main(() => {
        throw new Error("getaddrinfo ENOTFOUND playwright.download.prss.microsoft.com");
      });

      expect(rc).toBe(1);
      // 원인을 실어야 한다(P0 No Silent Failure) — 종료 코드만으로는 무엇이 막았는지 모른다.
      expect(stderr.mock.calls.flat().join("\n")).toContain("ENOTFOUND");
      stderr.mockRestore();
    });
  });

  describe("확보 명령 — 프로덕션 수집 경로가 실제로 쓰는 바이너리", () => {
    it("chromium headless shell 을 받는다", () => {
      // launchStoryContext 는 비서버리스에서 headless: true 로 띄우고, playwright 는 그
      // 조합에서 headless shell 을 쓴다 — 사고 당시 오류가 가리킨 바이너리도 그것이다.
      expect(INSTALL_ARGS).toEqual(["playwright", "install", "chromium", "--only-shell"]);
    });
  });

  describe("배선 — postinstall", () => {
    it("package.json postinstall 이 이 스크립트를 태운다", () => {
      const pkg = JSON.parse(
        readFileSync(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
      ) as { scripts?: Record<string, string> };

      expect(pkg.scripts?.postinstall).toContain("scripts/ensure-playwright-browser.mjs");
    });
  });
});
