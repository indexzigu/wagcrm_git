import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 계약: playwright-core 가 기대하는 Chromium 메이저와 @sparticuz/chromium(서버리스 바이너리)
// 메이저가 일치해야 한다. 불일치하면 Vercel Lambda 에서 launch 직후 브라우저가 즉사한다
// ("Target page, context or browser has been closed" — 2026-07-13 프로덕션 실사고: 141 vs 148,
// capture-stories 크론이 매일 500). launchStoryContext 는 executablePath 주입이라 playwright 의
// 자체 버전 검증이 조용히 우회되므로, 이 테스트가 유일한 기계 강제 장치다.
//
// node_modules 에 의존하지 않고 package-lock.json 만 읽는다 — 공유 워크트리는 두 패키지가
// 로컬에 설치돼 있지 않을 수 있다(prune 함정). lockfile 이 배포(fresh install)의 정본이다.

// playwright-core 마이너 → 그 릴리스가 번들하는 Chromium 메이저(playwright-core/browsers.json 실측).
// 어느 한쪽만 bump 하면 이 테스트가 깨진다 — 의도된 마찰. 갱신법: 새 playwright-core 의
// browsers.json 에서 chromium browserVersion 메이저를 확인해 이 테이블과 @sparticuz/chromium
// 버전(package.json)을 함께 올린다.
const PLAYWRIGHT_CHROMIUM_PAIRS: Record<string, number> = {
  "1.60": 148,
};

type LockPackage = { version?: string };

function lockVersion(lock: { packages?: Record<string, LockPackage> }, name: string): string {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`package-lock.json 에서 ${name} 버전을 찾지 못했습니다`);
  return version;
}

describe("스토리 브라우저 버전 계약 (playwright-core ↔ @sparticuz/chromium)", () => {
  // vitest 루트 = 레포 루트(vitest 환경에선 import.meta.url 이 file 스킴이 아닐 수 있어 cwd 사용)
  const lockPath = join(process.cwd(), "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    packages?: Record<string, LockPackage>;
  };

  it("@sparticuz/chromium 메이저가 playwright-core 기대 Chromium 메이저와 일치한다", () => {
    const playwrightVersion = lockVersion(lock, "playwright-core"); // 예: "1.60.0"
    const sparticuzVersion = lockVersion(lock, "@sparticuz/chromium"); // 예: "148.0.0"

    const playwrightMinor = playwrightVersion.split(".").slice(0, 2).join(".");
    const expectedChromiumMajor = PLAYWRIGHT_CHROMIUM_PAIRS[playwrightMinor];
    expect(
      expectedChromiumMajor,
      `playwright-core ${playwrightVersion} 는 페어 테이블에 없습니다. 해당 릴리스의 ` +
        `browsers.json(chromium browserVersion)을 확인해 PLAYWRIGHT_CHROMIUM_PAIRS 와 ` +
        `@sparticuz/chromium 버전을 함께 갱신하세요.`,
    ).toBeDefined();

    const sparticuzMajor = Number(sparticuzVersion.split(".")[0]);
    expect(
      sparticuzMajor,
      `@sparticuz/chromium ${sparticuzVersion} ↔ playwright-core ${playwrightVersion}(기대 Chromium ` +
        `${expectedChromiumMajor}) 메이저 불일치 — Vercel 스토리 수집이 launch 직후 죽습니다. ` +
        `두 패키지를 같은 Chromium 메이저로 맞추세요.`,
    ).toBe(expectedChromiumMajor);
  });
});
