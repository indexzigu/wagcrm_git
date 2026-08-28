import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * preview-db.sh 는 이제 `preview.sh up` 만이 부르지만(2026-08-13 온디맨드 전환 —
 * 그전에는 cron 이 매일 밤에도 불렀다), **프로덕션 컨테이너와 같은 이름공간에서
 * docker 를 조작**한다는 점은 그대로다. PATH 방어도 그대로 필요하다: 부모인
 * preview.sh 역시 launchd/cron 계열과 같은 PATH 후보를 직접 세워 물려준다.
 * 두 가지를 고정한다:
 *   (A) 필수 실행파일이 PATH 에서 안 잡히면 아무것도 하지 않고 죽는다
 *       (이 레포에서 PATH 미해석은 네 번 재발했다 — libpq keg-only 포함).
 *   (B) 프로덕션 컨테이너 이름을 절대 대상으로 삼지 않는다 — 이름 오염으로
 *       `docker rm -f supabase-db` 가 나가는 것이 이 스크립트의 최악 사고다.
 */
const SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "preview-db.sh");

const REAL_TOOLS = [
  "date", "tee", "mkdir", "rm", "sed", "grep", "cut", "head", "tail", "sort",
  "tr", "cat", "mktemp", "seq", "id", "dirname", "basename", "sleep", "env", "gzip",
];

function runWithStubs(stubs: string[], extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-db-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  // 스텁은 /usr/bin/true 심볼릭 링크 — gh-stub-guard 계약(새 실행파일 금지).
  for (const name of stubs) symlinkSync("/usr/bin/true", path.join(binDir, name));
  for (const tool of REAL_TOOLS) {
    const src = [`/usr/bin/${tool}`, `/bin/${tool}`].find((p) => existsSync(p));
    if (src) symlinkSync(src, path.join(binDir, tool));
  }
  const r = spawnSync("/bin/bash", [SCRIPT], {
    env: { PATH: binDir, HOME: dir, PREVIEW_DB_TEST_PATH_CANDIDATES: path.join(dir, "empty"), ...extraEnv },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("preview-db.sh 가드", () => {
  it("docker·psql·rclone 이 없으면 이름을 대며 중단한다", () => {
    const r = runWithStubs([]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/찾지 못함:.*docker/);
    expect(r.out).toMatch(/찾지 못함:.*psql/);
    expect(r.out).toMatch(/찾지 못함:.*rclone/);
  });

  it("프로덕션 컨테이너 이름을 대상으로 삼지 않는다", () => {
    // 소스 자체의 계약 — 이 이름이 파괴적 명령의 인자로 등장하면 안 된다.
    const src = readFileSync(SCRIPT, "utf8");
    const destructive = src
      .split("\n")
      .filter((l) => /docker\s+(rm|stop|kill)/.test(l) && !l.trim().startsWith("#"));
    expect(destructive.length).toBeGreaterThan(0); // 스캐너 고장 감지
    for (const line of destructive) {
      expect(line, `파괴적 명령이 프로덕션 컨테이너를 가리킨다: ${line}`).not.toContain("supabase-db");
    }
  });
});
