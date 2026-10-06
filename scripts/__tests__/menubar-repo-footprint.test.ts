import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * repo-footprint.sh 는 메뉴바 "코드·워크트리 크기" 줄의 계측 SSOT 다 — metrics.sh 의
 * 자매(측정이 du 약 18초라 30초 폴링에서 분리, 캐시 파일 경유). 두 가지를 고정한다:
 *  (1) 행위 — git/du 스텁을 FOOTPRINT_*_CMD 훅으로 주입해 hermetic 실행. 본체 안에
 *      든 워크트리를 본체에서 빼는 이중 계산 방지, 사라진 경로(missing) 집계, 운영본
 *      유무, 실패도 캐시에 남기는 것(없으면 metrics.sh 가 30초마다 다시 띄운다).
 *  (2) 소스 — 읽기 전용 계약(파괴적 명령 0, git 은 worktree list 뿐).
 */
const SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "repo-footprint.sh");

const tmp = mkdtempSync(path.join(tmpdir(), "menubar-footprint-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function stub(dir: string, name: string, body: string): string {
  const p = path.join(dir, `${name}.impl`);
  writeFileSync(p, `${body}\n`);
  return p;
}

interface Footprint {
  available: boolean;
  measuredAt?: string;
  measuredAtEpoch?: number;
  totalBytes?: number;
  mainBytes?: number;
  worktreeCount?: number;
  worktreeBytes?: number;
  deployBytes?: number | null;
  missing?: number;
  error?: string;
}

interface RunOpts {
  gitFail?: boolean;
  /** true 면 du 가 본체 줄을 내지 않는다(본체 측정 실패). */
  duNoMain?: boolean;
  /** true 면 운영 체크아웃 디렉터리를 만들지 않는다. */
  noDeploy?: boolean;
}

function run(opts: RunOpts = {}): { out: Footprint; cache: Footprint; dir: string } {
  const dir = mkdtempSync(path.join(tmp, "run-"));
  const repo = path.join(dir, "repo");
  const deploy = path.join(dir, "deploy");
  execFileSync("mkdir", ["-p", repo, ...(opts.noDeploy ? [] : [deploy])]);
  const nested = `${repo}/.claude/worktrees/a`;
  const external = `${dir}/codex/wt`;
  const gone = `${dir}/gone/wt`;

  // porcelain: 본체 → 본체 안 워크트리 → 외부 워크트리 → 디렉터리가 사라진 워크트리.
  const gitImpl = stub(
    dir,
    "git",
    opts.gitFail
      ? "exit 1"
      : `printf '%s\\n' 'worktree ${repo}' 'HEAD aaaa' 'branch refs/heads/main' '' 'worktree ${nested}' 'HEAD bbbb' 'branch refs/heads/x' '' 'worktree ${external}' 'HEAD cccc' 'branch refs/heads/y' '' 'worktree ${gone}' 'HEAD dddd' 'branch refs/heads/z' ''`,
  );
  // du -sk: 본체 12000KB 에는 안쪽 워크트리 2000KB 가 이미 들어 있다. gone 은 줄이 없다.
  // printf 는 형식 문자열을 남은 인자에 되풀이 적용한다 — (KB, 경로) 쌍이 줄이 된다.
  const duPairs = [
    ...(opts.duNoMain ? [] : ["12000", repo]),
    "2000", nested,
    "3000", external,
    ...(opts.noDeploy ? [] : ["500", deploy]),
  ];
  const duImpl = stub(dir, "du", `printf '%s\\t%s\\n' ${duPairs.map((l) => `'${l}'`).join(" ")}; exit 1`);

  const cache = path.join(dir, "cache", "repo-footprint.json");
  const out = execFileSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      FOOTPRINT_GIT_CMD: `bash ${gitImpl}`,
      FOOTPRINT_DU_CMD: `bash ${duImpl}`,
      FOOTPRINT_REPO: repo,
      FOOTPRINT_DEPLOY_DIR: deploy,
      FOOTPRINT_CACHE: cache,
    },
    encoding: "utf8",
  });
  return { out: JSON.parse(out), cache: JSON.parse(readFileSync(cache, "utf8")), dir };
}

describe("repo-footprint.sh 행위 계약", () => {
  it("본체 안 워크트리는 본체에서 빼고, 사라진 경로는 missing 으로 센다", () => {
    const { out, cache } = run();
    expect(out.available).toBe(true);
    // 본체 12000 - 안쪽 2000 = 10000KB
    expect(out.mainBytes).toBe(10000 * 1024);
    // 워크트리 3개 목록 중 측정된 2개 합(2000+3000), 사라진 1개는 missing.
    expect(out.worktreeCount).toBe(2);
    expect(out.worktreeBytes).toBe(5000 * 1024);
    expect(out.missing).toBe(1);
    expect(out.deployBytes).toBe(500 * 1024);
    // 합계 = 본체(안쪽 제외) + 워크트리 + 운영본 — 안쪽 워크트리가 두 번 들어가면 틀린다.
    expect(out.totalBytes).toBe((10000 + 5000 + 500) * 1024);
    expect(typeof out.measuredAtEpoch).toBe("number");
    // stdout 과 캐시는 같은 한 줄이다.
    expect(cache).toEqual(out);
  });

  it("운영 체크아웃이 없으면 deployBytes=null, 합계에서 빠진다", () => {
    const { out } = run({ noDeploy: true });
    expect(out.available).toBe(true);
    expect(out.deployBytes).toBeNull();
    expect(out.totalBytes).toBe((10000 + 5000) * 1024);
  });

  it("git 실패 → available=false 를 캐시에도 남기고 exit 0", () => {
    const { out, cache } = run({ gitFail: true });
    expect(out.available).toBe(false);
    expect(out.error).toContain("git worktree list");
    expect(cache.available).toBe(false);
  });

  it("본체 du 실패 → available=false (워크트리만으로 합계를 지어내지 않는다)", () => {
    const { out } = run({ duNoMain: true });
    expect(out.available).toBe(false);
    expect(out.error).toContain("본체");
  });

  it("실패 메시지에 따옴표가 섞여도 캐시 한 줄은 유효한 JSON 이고, 5분 뒤 재시도되게 시각을 25분 전으로 적는다", () => {
    const dir = mkdtempSync(path.join(tmp, "run-"));
    const cache = path.join(dir, "cache", "repo-footprint.json");
    const before = Math.floor(Date.now() / 1000);
    const out = execFileSync("bash", [SCRIPT], {
      env: { ...process.env, FOOTPRINT_REPO: `${dir}/no"such\\repo`, FOOTPRINT_CACHE: cache },
      encoding: "utf8",
    });
    const parsed: Footprint = JSON.parse(out); // 깨졌다면 여기서 던진다
    expect(parsed.available).toBe(false);
    expect(parsed.error).not.toMatch(/["\\]/);
    expect(parsed.measuredAtEpoch).toBeLessThanOrEqual(before - 1500 + 5);
    expect(parsed.measuredAtEpoch).toBeGreaterThanOrEqual(before - 1500 - 5);
  });

  it("실행이 끝나면 잠금 디렉터리를 남기지 않는다", () => {
    const { dir } = run();
    expect(existsSync(path.join(dir, "cache", "repo-footprint.json.lock"))).toBe(false);
  });
});

describe("repo-footprint.sh 소스 계약 — 읽기 전용", () => {
  const SRC = readFileSync(SCRIPT, "utf8");
  const active = SRC.split("\n").filter((l) => !l.trim().startsWith("#"));

  it("파괴적 명령이 없다(rm -rf · git 쓰기 명령)", () => {
    const destructive = active.filter((l) =>
      /rm\s+-rf|(\$GIT|\bgit)\s+(worktree\s+(remove|prune)|branch\s+-[dD]|reset|clean|checkout|push)/.test(l),
    );
    expect(destructive).toEqual([]);
  });

  it("git 사용은 worktree list 뿐이다", () => {
    const lines = active.filter((l) => /(\$GIT|\bgit)\s+-C\s+\S+\s+[a-z]/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/worktree list/);
  });
});
