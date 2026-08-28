import { defineConfig } from "vitest/config";
import path from "path";

// HERMETIC_ONLY=1(= CI 비차단 test 잡)일 때, 격리 러너(SQLite·시크릿 없음)에서
// 통과 불가한 비-hermetic 테스트를 제외한다. 로컬 `npm test`(플래그 없음)는 전체
// 스위트를 그대로 실행한다. 제외 사유:
//  - campaignService.recalcRounds / campaignGroupService: Postgres 전용 동작
//    (pg_advisory_lock·동시성) — SQLite에서 재현 불가
// 각 항목은 PR 본문의 후속 과제로 추적한다.
// (enrich-references/route는 stale mock(reference-enrich-apify→proxy 미갱신)이 실 네트워크를
//  타서 4건 상시 실패하던 것 — mock 타깃 교정으로 hermetic화, 제외 해제 2026-07-11)
const hermeticExcludes =
  process.env.HERMETIC_ONLY === "1"
    ? [
        "src/services/__tests__/campaignService.recalcRounds.test.ts",
        "src/services/__tests__/campaignGroupService.test.ts",
      ]
    : [];

// 자가호스트 CI 는 잡 여러 개가 같은 VM 을 나눠 쓴다(활성 러너 2개 — P6
// 「Self-Hosted Preflight Runner」). 워커 상한이 없으면 vitest 가 **잡마다** nproc 만큼
// 띄워 초과구독이 되고, 각 워커가 느려져 기본 5초 testTimeout 이 무더기로
// 터진다. ⚠️ VM 은 **2026-08-27 부터 4 vCPU** 다(그전 8 — P6 T-070). 아래 실측은 8 vCPU
// 시절의 것이고, vCPU 가 줄어든 지금 초과구독은 더 쉽게 일어난다.
// 실측(2026-08-26 러너 증설 당일, 8 vCPU): 잡 2개 동시 실행에서 test 잡이 7~8분 → 16분,
// calendar-page-client(`Test timed out in 5000ms`) · orderFulfillment.realdb(`Hook timed
// out in 30000ms`) 2파일 실패 — 코드는 그대로였고 부하만 달랐다.
// ⛔ 이 증상을 테스트 결함으로 읽고 timeout 값을 올리지 말 것 — 원인은 초과구독이다.
// ⛔ **이 상한을 「그러니 러너를 늘려도 된다」는 근거로 읽지 말 것.** 구조적으로 겹침을
// 막는 것은 **활성 러너 2개**이고 이 상한은 그 위에 얹은 보조 장치다 — `next build` ·
// `npm ci` 는 이 상한 밖에서 코어를 다투므로, 러너를 3개로 되돌리면 상한이 있어도 5초
// 타임아웃이 그대로 재현된다(2026-08-26 실측으로 기각된 형상. 복귀 조건은 P6).
// 값은 워크플로가 러너 레인별로 준다(`release-preflight.yml` test 잡). GitHub 러너로
// 폴백하면 잡이 머신을 독점하므로 상한을 주지 않는다 — 두 레인의 정답이 서로 다르다.
const rawMaxWorkers = process.env.VITEST_MAX_WORKERS?.trim();
const parsedMaxWorkers = rawMaxWorkers?.endsWith("%")
  ? rawMaxWorkers
  : Number(rawMaxWorkers);
const maxWorkers =
  rawMaxWorkers && (typeof parsedMaxWorkers === "string" || Number.isFinite(parsedMaxWorkers))
    ? parsedMaxWorkers
    : undefined;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    exclude: [
      "e2e/**",
      "**/node_modules/**",
      ".next/**",
      ".claude/worktrees/**",
      ...hermeticExcludes,
    ],
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/setup.ts"],
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
