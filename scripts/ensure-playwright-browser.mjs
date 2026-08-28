/**
 * 스토리 수집이 쓰는 Playwright 브라우저(chromium headless shell)를 **이 트리 소유로
 * 등록**한다. postinstall 에서 돌아 `npm install`/`npm ci` 마다 확보를 재확인한다.
 *
 * ⚠️ **이 스크립트의 본질은 다운로드가 아니라 등록이다**(실사고 2026-08-20~24).
 * Playwright 브라우저 캐시(`~/Library/Caches/ms-playwright`)는 **머신 전역 공유 자원**
 * 인데, 어느 리비전을 보존할지는 `<캐시>/.links/` 에 등록된 playwright 설치들이 정한다 —
 * `playwright install` 을 한 번이라도 돌린 트리만 거기 등록되고, 등록되지 않은 리비전은
 * 다음 install 때 "아무도 안 쓰는 것"으로 판정돼 삭제된다.
 *
 * **실사고:** 이 레포도 셀프호스트 배포 트리도 `playwright install` 을 돌린 적이 없어
 * `.links` 에 없었다. 두 트리의 playwright-core 1.60.0 이 요구하는
 * `chromium_headless_shell-1223` 은 그래서 **남의 캐시에 무임승차**한 상태였고,
 * 2026-08-20 21:03 에 다른 프로젝트(더 최신 playwright = 리비전 1228 요구)가 install 을
 * 돌리자 고아로 판정돼 삭제됐다. 그날 이후 `capture-stories` 크론이 나흘 연속 500 으로
 * 죽었다(스토리는 24h 수명이라 소급 수집이 불가능하다 — 나흘분은 영구 유실).
 *
 * ⛔ **"이미 있으니 건너뛴다"로 최적화하지 말 것.** 파일 존재만 확인하고 install 을
 * 건너뛰면 등록이 안 되고, 그러면 이 사고가 그대로 재발한다. `playwright install` 은
 * 이미 받아둔 리비전에는 다운로드 없이 등록만 갱신하고 즉시 끝난다(무비용).
 *
 * **왜 `--only-shell` 인가:** 프로덕션 수집 경로(`story-viewer-fetch.ts`
 * `launchStoryContext`)는 비서버리스에서 `chromium.launchPersistentContext` 를
 * `headless: true` 로 띄우고, playwright 는 그 조합에서 full chromium 이 아니라
 * **headless shell** 을 쓴다(사고 당시 오류 메시지가 가리킨 것도 그 바이너리다).
 * 헤드풀 e2e 가 필요하면 그때 `npx playwright install chromium` 을 따로 돌린다.
 *
 * **서버리스는 대상이 아니다** — Vercel 경로는 `@sparticuz/chromium`(npm 의존성이라
 * 락파일이 보호한다)을 쓰고 이 캐시를 보지 않는다. 거기서 받으면 빌드 시간만 태운다.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 확보 명령 — 등록(`.links`)이 목적이므로 이미 받아둔 리비전에도 그대로 돌린다. */
export const INSTALL_ARGS = ["playwright", "install", "chromium", "--only-shell"];

/** 이 트리에 playwright-core 가 없으면 확보할 대상 자체가 없다(부분 설치·의존성 축소 방어). */
export function hasPlaywrightCore(require_ = createRequire(import.meta.url)) {
  try {
    require_.resolve("playwright-core/package.json");
    return true;
  } catch {
    return false;
  }
}

/**
 * 확보를 건너뛸 환경이면 사유 문자열을, 진행할 환경이면 null 을 돌려준다.
 *
 * - `VERCEL` — 서버리스 빌드. 위 헤더대로 `@sparticuz/chromium` 을 쓰므로 이 캐시가
 *   불필요하다(받으면 빌드 시간만 소모).
 * - `CI` — GitHub Actions. 현재 워크플로 5종(release-preflight · migration-guard ·
 *   promote-auto · scheduled-crons · daily-db-backup) 중 Playwright 브라우저를 쓰는
 *   것은 없다(실측 2026-08-25). ⚠️ CI 에서 e2e 를 돌리기 시작하면 이 줄부터 고친다.
 */
export function skipReason(env = process.env, hasCore = hasPlaywrightCore()) {
  if (!hasCore) return "playwright-core 미설치";
  if (env.VERCEL) return "Vercel 빌드(@sparticuz/chromium 경로)";
  if (env.CI) return "CI(브라우저를 쓰는 워크플로 없음)";
  return null;
}

/**
 * @param run 확보 명령 실행자. 계약 테스트가 스파이를 넣는다 — vitest 는 `.mjs` 를 변환하지
 *   않아 `vi.mock("node:child_process")` 가 이 파일에 닿지 않는다(목이 안 먹고 **실제 설치가
 *   돌아가** 계약이 검증되지 않는 것을 실측으로 확인했다). 그래서 주입으로 가른다.
 */
export function main(run = (args) => execFileSync("npx", args, { cwd: REPO_ROOT, stdio: "inherit" })) {
  const skip = skipReason();
  if (skip) {
    console.log(`[playwright] 브라우저 확보 생략 — ${skip}`);
    return 0;
  }

  try {
    run(INSTALL_ARGS);
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    // **fail-closed 다(오너 확정 2026-08-25).** 이 자리는 셀프호스트 **배포**
    // (`infra/selfhost/deploy.sh` 138행 `npm install`)가 매번 통과하는 지점이라 이 반환값이
    // 곧 배포 정책이다 — `deploy.sh` 는 `set -euo pipefail` 이라 여기서 그대로 중단된다.
    //
    // ⛔ **`return 0`(경고만 남기고 완주)로 되돌리지 말 것.** 확보 실패를 삼키면 브라우저 없는
    // 프로덕션이 서고, 그 사실은 **다음 자정 수집이 죽어야** 드러난다. 이번 사고에서 그 지연이
    // 실제로 나흘이었고 스토리는 24h 수명이라 소급 수집이 불가능하다(나흘분 영구 유실).
    // 배포 한 번이 막히는 비용 < 수집이 조용히 유실되는 비용이라는 것이 이 선택의 근거다.
    // 같은 계열의 선례: 크론 인증도 `CRON_SECRET` 미설정이면 아무도 통과 못 하는 fail-closed 다
    // (`src/lib/cron-auth.ts`).
    //
    // ℹ️ 스토리 러너 plist 는 같은 갈림길에서 반대(계속 진행)를 택했는데, 그쪽은 갱신이
    // 실패해도 **구코드로 수집은 됐다.** 여기는 실패하면 수집이 **아예 불가능**하다.
    console.error(`[playwright] 브라우저 확보 실패 — 배포를 중단한다: ${detail}`);
    console.error(`[playwright] 수동 복구 후 재시도: npx ${INSTALL_ARGS.join(" ")}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) process.exit(main());
