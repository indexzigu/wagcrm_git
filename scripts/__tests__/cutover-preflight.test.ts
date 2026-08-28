import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * infra/selfhost/cutover.sh Stage 1(사전 점검) — 파괴적 작업 전에 막아야 하는
 * 두 전제를 고정한다.
 *
 *  (E) 뒤 단계가 부르는 호스트 실행파일이 PATH 에서 잡히는가.
 *      Stage 3a 는 "클라우드 원본"을 떠야 해서 docker exec 로 대체할 수 없고
 *      호스트 psql/pg_dump 가 필요하다. macOS 의 libpq 는 brew keg-only 라
 *      /usr/local/bin 에 링크가 없어 대화형 셸에도 psql 이 없었다(실측) —
 *      가드가 없으면 Stage 2(백업)까지 다 돌고 3a 에서 command not found 로
 *      죽는다. 이 레포에서 PATH 미해석은 이미 세 번 재발한 부류다.
 *  (F) Stage 3~4 가 요구하는 .env.cutover 3개 키가 준비됐는가. 없으면 역시
 *      백업을 다 돌린 뒤 Stage 3 에서 중단된다.
 *
 * 두 가드 모두 "값"은 출력하지 않는다(공개 레포·로그 안전) — 키 이름만 본다.
 */

const SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "cutover.sh");

/**
 * 스크립트가 Stage 1 을 도는 데 실제로 필요한 시스템 도구들. 검증 대상 9개
 * (psql·pg_dump·docker·rclone·jq·curl·node·npx·cloudflared)는 여기 없다 —
 * 그것들만 스텁으로 통제한다.
 *
 * ⚠️ `/usr/bin` 을 통째로 PATH 에 얹으면 안 된다: Ubuntu CI 러너에는 실제
 * postgresql-client 가 깔려 있어 "psql 없음" 전제가 조용히 무너진다(실측 —
 * macOS 는 libpq 가 keg 안에만 있어 로컬에서는 통과했고 CI 에서만 드러났다).
 */
const REAL_TOOLS = [
  "date", "tee", "mkdir", "rm", "sed", "grep", "cut", "head", "tail", "sort",
  "tr", "cat", "mktemp", "seq", "id", "dirname", "basename", "sleep", "comm",
  "diff", "awk", "env", "gzip", "ln", "mv", "cp",
];

function linkRealTools(binDir: string) {
  for (const tool of REAL_TOOLS) {
    const src = [`/usr/bin/${tool}`, `/bin/${tool}`].find((p) => existsSync(p));
    if (src) symlinkSync(src, path.join(binDir, tool));
  }
}

/** PATH 를 통제한 채 Stage 1 을 돌린다. 다른 가드(앱 서빙·R2 등)는 이 환경에서
 *  당연히 FAIL 하므로 종료코드는 항상 nonzero 다 — 가드 E/F 의 출력만 본다. */
function runPreflight(opts: { stubs: string[]; envFile?: string | null }) {
  const dir = mkdtempSync(path.join(tmpdir(), "cutover-preflight-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  // 스텁은 /usr/bin/true 로의 심볼릭 링크다 — gh-stub-guard.contract.test.ts 의
  // 계약(새 실행파일 금지) 그대로다. 실행 비트를 새로 줄 필요가 없고, 실제
  // execve 대상은 이미 검사가 끝난 시스템 바이너리라 macOS 첫-execve 요금
  // (400~700ms)이 붙지 않는다. 가드 E 는 `command -v` 만 하므로 실행조차 하지
  // 않는다(command -v 는 링크를 따라가 대상의 실행 비트를 본다).
  for (const name of opts.stubs) {
    symlinkSync("/usr/bin/true", path.join(binDir, name));
  }
  linkRealTools(binDir);

  // 스크립트가 스스로 얹는 PATH 후보(libpq keg 포함)를 빈 디렉터리로 갈아
  // 끼운다 — libpq 가 깔린 기계에서도 "실행파일 없음" 경로가 재현돼야 한다.
  const emptyDir = path.join(dir, "empty");
  mkdirSync(emptyDir);

  const env: Record<string, string> = {
    // 오직 이 디렉터리만 — 실 시스템 경로를 물려주면 CI 러너의 실제 psql 이
    // 잡혀 "없음" 전제가 무너진다(위 REAL_TOOLS 주석 참고).
    PATH: binDir,
    HOME: dir, // LOG_DIR=$HOME/selfhost/logs — 실 홈을 건드리지 않게 격리
    CUTOVER_TEST_NOW_HM: "1500", // 시간대 가드는 통과시켜 E/F 만 남긴다
    CUTOVER_TEST_PATH_CANDIDATES: emptyDir,
  };
  env.CUTOVER_TEST_ENV_FILE = opts.envFile ?? path.join(dir, "absent.env");

  const r = spawnSync("/bin/bash", [SCRIPT], { env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function writeEnvFile(dir: string, body: string) {
  const p = path.join(dir, "cutover.env");
  writeFileSync(p, body);
  return p;
}

// bash 없이는 아무 것도 못 하므로 최소 스텁 집합에 항상 포함시킨다.
const ALL_BINS = [
  "psql",
  "pg_dump",
  "docker",
  "rclone",
  "jq",
  "curl",
  "node",
  "npx",
  "cloudflared",
];

describe("cutover.sh Stage 1 가드 E — 필수 실행파일", () => {
  it("psql/pg_dump 가 PATH 에 없으면 이름을 대며 FAIL 한다", () => {
    const r = runPreflight({ stubs: ALL_BINS.filter((b) => b !== "psql" && b !== "pg_dump") });
    expect(r.out).toContain("[가드] 필수 실행파일 ... FAIL");
    expect(r.out).toMatch(/찾지 못함:.*psql/);
    expect(r.out).toMatch(/찾지 못함:.*pg_dump/);
    // 조치 안내(libpq)가 함께 나와야 한다 — 이 실패는 설치 문제라 원인만으론 못 고친다.
    expect(r.out).toContain("libpq");
    expect(r.status).not.toBe(0);
  });

  it("전부 잡히면 PASS 한다", () => {
    const r = runPreflight({ stubs: ALL_BINS });
    expect(r.out).toContain("[가드] 필수 실행파일");
    expect(r.out).not.toContain("[가드] 필수 실행파일 ... FAIL");
  });

  it("Stage 1 이 하나라도 FAIL 하면 Stage 2(백업) 로 넘어가지 않는다", () => {
    const r = runPreflight({ stubs: [] });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("중단: Stage 1(사전 점검) 실패");
    expect(r.out).not.toContain("=== Stage 2");
  });
});

describe("cutover.sh Stage 1 가드 F — 컷오버 크리덴셜", () => {
  it("파일이 없으면 FAIL 하고 README 절을 가리킨다", () => {
    const r = runPreflight({ stubs: ALL_BINS, envFile: null });
    expect(r.out).toContain("[가드] 컷오버 크리덴셜 ... FAIL");
    expect(r.out).toContain(".env.cutover");
  });

  // 픽스처는 자리표시자다 — 진짜 연결 문자열 형태를 쓰면 commit-guard 가
  // "URL 내장 자격증명"으로 잡는다(PUBLIC 레포, P0). 가드 F 는 값의 형태를
  // 보지 않고 "비어있지 않은가"만 보므로 자리표시자로 충분하다.
  const FILLED = "PLACEHOLDER-VALUE";

  it("키가 비어 있으면 그 키 이름만 대고 값은 출력하지 않는다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cutover-env-"));
    const envFile = writeEnvFile(
      dir,
      `PROD_URL='${FILLED}'\nSRC_URL='${FILLED}'\nSRC_SERVICE_KEY=''\n`,
    );
    const r = runPreflight({ stubs: ALL_BINS, envFile });
    expect(r.out).toContain("[가드] 컷오버 크리덴셜 ... FAIL");
    expect(r.out).toMatch(/값이 비었음:.*SRC_SERVICE_KEY/);
    // 채워진 키 이름도, 값도 출력에 실리지 않는다.
    expect(r.out).not.toContain("PROD_URL");
    expect(r.out).not.toContain(FILLED);
  });

  it("3개 키가 모두 채워져 있으면 PASS 한다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cutover-env-"));
    const envFile = writeEnvFile(
      dir,
      `PROD_URL='${FILLED}'\nSRC_URL='${FILLED}'\nSRC_SERVICE_KEY='${FILLED}'\n`,
    );
    const r = runPreflight({ stubs: ALL_BINS, envFile });
    expect(r.out).toContain("[가드] 컷오버 크리덴셜");
    expect(r.out).not.toContain("[가드] 컷오버 크리덴셜 ... FAIL");
  });

  it("$ 가 든 값도 잘리지 않고 PASS 한다(단일 인용부호 전제)", () => {
    // 이 레포의 반복 함정: `$` 가 든 값을 겹따옴표로 두면 셸 소싱에서 조용히
    // 잘린다(실측 29자→23자). 단일 인용부호면 그대로 살아 가드가 PASS 해야 한다.
    const dir = mkdtempSync(path.join(tmpdir(), "cutover-env-"));
    const envFile = writeEnvFile(
      dir,
      `PROD_URL='pa\$\$-${FILLED}'\nSRC_URL='${FILLED}'\nSRC_SERVICE_KEY='${FILLED}'\n`,
    );
    const r = runPreflight({ stubs: ALL_BINS, envFile });
    expect(r.out).not.toContain("[가드] 컷오버 크리덴셜 ... FAIL");
  });
});
