import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

function runWithStubs(stubs: string[], extraEnv: Record<string, string> = {}, script: string = SCRIPT) {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-db-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  // 스텁은 /usr/bin/true 심볼릭 링크 — gh-stub-guard 계약(새 실행파일 금지).
  for (const name of stubs) symlinkSync("/usr/bin/true", path.join(binDir, name));
  for (const tool of REAL_TOOLS) {
    const src = [`/usr/bin/${tool}`, `/bin/${tool}`].find((p) => existsSync(p));
    if (src) symlinkSync(src, path.join(binDir, tool));
  }
  const r = spawnSync("/bin/bash", [script], {
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

  it("프리뷰 포트가 프로덕션 DB 포트면 docker 를 건드리기 전에 중단한다", () => {
    // 2026-08-25 루프백 조치가 55432 를 프로덕션(supabase-db)에 넘겼는데 이 스크립트는
    // 그 이전 전제("supabase-db 는 호스트 포트를 안 연다") 위에서 55432 를 골라 둬,
    // 프리뷰 레인이 통째로 기동 불가가 됐다. 값을 되돌리는 편집을 여기서 잡는다.
    // 대조군(현행 값)이 이 가드를 통과해 **다음** 가드에서 멈추는 것까지 함께 고정한다 —
    // 그래야 "무엇이든 중단한다"는 무의미한 초록과 갈린다.
    const dir = mkdtempSync(path.join(tmpdir(), "preview-db-port-"));
    const mutated = path.join(dir, "mutated.sh");
    const src = readFileSync(SCRIPT, "utf8");
    const swapped = src.replace(/^PREVIEW_PORT="55433"$/m, 'PREVIEW_PORT="55432"');
    expect(swapped, "변이가 적재되지 않았다 — PREVIEW_PORT 표기가 바뀌었는지 확인할 것").not.toBe(src);
    writeFileSync(mutated, swapped);

    const bad = runWithStubs(["docker", "psql", "rclone"], {}, mutated);
    expect(bad.status).not.toBe(0);
    expect(bad.out).toMatch(/프리뷰 포트.*프로덕션 DB 포트/);

    const good = runWithStubs(["docker", "psql", "rclone"]);
    expect(good.out).not.toMatch(/프리뷰 포트.*프로덕션 DB 포트/);
  });

  it("프리뷰 DB 포트 상수가 세 스크립트에서 같은 값이다", () => {
    // 포트는 preview-db.sh 가 SSOT 이고 dev.sh·preview.sh 는 사본이다(공유 lib 없는
    // 독립 스크립트 관행). 각 파일의 자기 가드는 "프로덕션 포트가 아닌가" 만 보므로,
    // SSOT 만 다른 값으로 옮기면 세 가드가 개별적으로는 전부 통과하면서 사본이 낡는다.
    // 그러면 preview.sh 는 정상 .env 를 거부하고 dev.sh 는 DB 준비를 조용히 건너뛴다.
    const active = (src: string) => src.split("\n").filter((l) => !l.trim().startsWith("#"));
    const pick = (file: string, re: RegExp) => {
      const line = active(readFileSync(path.resolve(__dirname, "..", "..", "infra", "selfhost", file), "utf8"))
        .find((l) => re.test(l.trim()));
      expect(line, `${file} 에서 포트 상수를 찾지 못했다 — 계약 기준을 갱신할 것`).toBeDefined();
      // 값만 떼고(키 이름 제거) host:port 표기면 포트만 남긴다 — preview-db.sh 는
      // 포트 단독, 나머지 둘은 "127.0.0.1:<포트>" 라 표기가 다르다.
      const value = line!.split("=").slice(1).join("=").replace(/["']/g, "").trim();
      return value.split(":").pop()!.trim();
    };
    const ssot = pick("preview-db.sh", /^PREVIEW_PORT=/);
    expect(ssot).toMatch(/^\d+$/); // 스캐너 고장 감지
    expect(pick("dev.sh", /^DB_HOSTPORT=/), "dev.sh 의 포트가 SSOT 와 다르다").toBe(ssot);
    expect(pick("preview.sh", /^PREVIEW_DB_HOSTPORT=/), "preview.sh 의 포트가 SSOT 와 다르다").toBe(ssot);
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
