import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, utimesSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, realpathSync } from "node:fs";
import { GNU_STAT_IMPL_BODY, writeCmdStub } from "./helpers/gh-stub";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOOP = process.env.LOOP_SRC_FOR_MUTATION ?? resolve(__dirname, "../../infra/selfhost/expansion-loop.sh");
const SQL = resolve(__dirname, "../../infra/selfhost/expansion-readonly-sql.sh");

let root: string;
let home: string;
let repo: string;
let bin: string;

// 가짜 명령은 실행 권한 없는 데이터 본문 + 고정 래퍼 링크로 만든다(gh-stub-guard 계약).
// 래퍼가 본문을 찾는 env 는 stubEnv 에 모아 run()·sql() 이 피시험 프로세스에 넘긴다.
let stubEnv: Record<string, string> = {};
const script = (name: string, body: string) => {
  const s = writeCmdStub(bin, name, `${body}\n`);
  Object.assign(stubEnv, s.env);
  return s.path;
};
const cronLog = () => {
  const p = join(home, "selfhost/logs/cron.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};
const lockDir = () => join(home, "selfhost/locks/expansion-loop");

beforeEach(() => {
  stubEnv = {};
  root = mkdtempSync(join(tmpdir(), "exp-loop-"));
  home = join(root, "home");
  repo = join(root, "repo");
  bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(repo, "docs/private/expansion/prompts"), { recursive: true });
  writeFileSync(join(repo, "docs/private/expansion/prompts/daily-run.md"), "go");
  writeFileSync(join(repo, "docs/private/expansion/prompts/skipped-card.json"), "{}");
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const UNSET_ENV = "\u0000unset";
const run = (claude: string | null, extra: Record<string, string> = {}) => {
  // 한 테스트에서 run() 을 두 번 부를 수 있다 — 같은 이름의 가짜 명령은 한 번만 만든다(stubEnv 는 테스트 단위로 유지).
  const postPath = join(bin, "post.sh");
  const post = existsSync(postPath)
    ? postPath
    : script("post.sh", `echo "$@" >> "${root}/post.argv"\ncat "$3" >> "${root}/post.content" 2>/dev/null || true`);
  // 가짜 레포는 git 저장소가 아니므로 운영 트리는 기본으로 끈다 — 운영 트리 테스트만 UNSET_ENV 으로 기본값을 쓴다.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    EXPANSION_REPO: repo,
    EXPANSION_POST_BIN: post,
    EXPANSION_HERMES_DIR: "/h",
    EXPANSION_OPS_WT: "none",
    // 앱 신원도 기본으로 끈다(가짜 HOME 에는 키가 없다) — 앱 신원 테스트만 켠다.
    EXPANSION_APP_KEY: "none",
    // 기존 테스트의 가짜 claude 는 한 번 불리는 것을 전제한다 — 단계 분기 테스트만 fork(또는 기본값)로 돌린다.
    EXPANSION_PHASES: "single",
    ...stubEnv,
    ...(claude ? { EXPANSION_CLAUDE_BIN: claude } : {}),
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === UNSET_ENV) delete env[k];
  return spawnSync("/bin/bash", [LOOP], {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
};
const today = () => new Date().toLocaleDateString("sv-SE");
// 운영자가 쓰는 카드 파일 — 가짜 claude 본문에서 만든다(래퍼가 실행 전에 옛 파일을 지우기 때문).
const cardsSh = (body = '{"cards":[{"a":1}]}') =>
  `mkdir -p "${repo}/docs/private/expansion/out"\necho '${body}' > "${repo}/docs/private/expansion/out/${today()}-cards.json"\n`;
const OK_JSON = `cat >/dev/null\necho '{"is_error":false,"total_cost_usd":1.25}'`;
const OK_CARDS = () => cardsSh() + OK_JSON;
const postCalls = () => (existsSync(join(root, "post.argv")) ? readFileSync(join(root, "post.argv"), "utf8").trim().split("\n") : []);

describe("expansion-loop.sh", () => {
  it("DRY: exit 0, OK line, no runs file, no lock left", () => {
    const r = run(null, { EXPANSION_DRY: "1" });
    expect(r.status).toBe(0);
    expect(cronLog()).toMatch(/OK expansion-loop/);
    expect(existsSync(join(repo, "docs/private/expansion/runs"))).toBe(false);
    expect(existsSync(lockDir())).toBe(false);
  });

  it("DRY: passes the default spend cap to claude", () => {
    const r = run(null, { EXPANSION_DRY: "1" });
    expect(r.stdout).toMatch(/--max-budget-usd 12 /);
  });

  it("DRY: honors a valid EXPANSION_MAX_BUDGET_USD and rejects garbage", () => {
    expect(run(null, { EXPANSION_DRY: "1", EXPANSION_MAX_BUDGET_USD: "8.5" }).stdout).toMatch(/--max-budget-usd 8\.5 /);
    expect(run(null, { EXPANSION_DRY: "1", EXPANSION_MAX_BUDGET_USD: "1;rm" }).stdout).toMatch(/--max-budget-usd 12 /);
    expect(run(null, { EXPANSION_DRY: "1", EXPANSION_MAX_BUDGET_USD: "1.2.3" }).stdout).toMatch(/--max-budget-usd 12 /);
  });

  it("pre-existing lock: SKIP, exit 0, lock untouched", () => {
    mkdirSync(lockDir(), { recursive: true });
    const r = run(null, { EXPANSION_DRY: "1" });
    expect(r.status).toBe(0);
    expect(cronLog()).toMatch(/SKIP expansion-loop/);
    expect(existsSync(lockDir())).toBe(true);
  });

  it("claude exit 1: FAIL, exit 1, lock released, post once with card path", () => {
    const c = script("claude-fail", "exit 1");
    const r = run(c);
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop/);
    expect(existsSync(lockDir())).toBe(false);
    const calls = postCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^\/h\/plugins\/wag-operator\/expansion_cards\.py post .*skipped-card\.json$/);
  });

  it("skipped card is posted as a temp copy dated today; source untouched", () => {
    const src = join(repo, "docs/private/expansion/prompts/skipped-card.json");
    const body = '{"date": "2000-01-01", "cards": []}';
    writeFileSync(src, body);
    run(script("claude-fail-d", "exit 1"));
    const posted = readFileSync(join(root, "post.content"), "utf8");
    expect(posted).toContain(`"date": "${today()}"`);
    expect(posted).not.toContain("2000-01-01");
    expect(readFileSync(src, "utf8")).toBe(body);
    expect(postCalls()[0]).not.toContain(src);
  });

  it("EXPANSION_DATE 가 운영자에게 전달되고 카드 파일명 날짜와 같다", () => {
    const envOut = join(root, "date.out");
    const c = script("claude-date", `echo "$EXPANSION_DATE" > "${envOut}"\n` + OK_CARDS());
    const r = run(c);
    expect(r.status).toBe(0);
    const d = readFileSync(envOut, "utf8").trim();
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(postCalls()[0]).toContain(`/out/${d}-cards.json`);
  });

  it("건너뜀 카드 사본 생성이 실패하면 원본을 그대로 올린다", () => {
    const src = join(repo, "docs/private/expansion/prompts/skipped-card.json");
    const body = '{"date": "2000-01-01", "cards": []}';
    writeFileSync(src, body);
    script("sed", "exit 1");
    run(script("claude-fail-s", "exit 1"), { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(readFileSync(join(root, "post.content"), "utf8")).toBe(body);
    expect(postCalls()[0]).toContain(src);
    expect(readFileSync(src, "utf8")).toBe(body);
  });

  it("건너뜀 카드 사본이 비면(sed 가 빈 출력) 원본을 그대로 올린다", () => {
    const src = join(repo, "docs/private/expansion/prompts/skipped-card.json");
    const body = '{"date": "2000-01-01", "cards": []}';
    writeFileSync(src, body);
    script("sed", "cat >/dev/null; exit 0");
    run(script("claude-fail-e", "exit 1"), { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(readFileSync(join(root, "post.content"), "utf8")).toBe(body);
  });

  it("is_error true with exit 0: FAIL", () => {
    const c = script("claude-err", `echo '{"is_error":true,"total_cost_usd":0.5}'`);
    const r = run(c);
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop/);
    expect(postCalls()).toHaveLength(1);
  });

  it("malformed JSON: FAIL", () => {
    const c = script("claude-bad", `echo 'not json'`);
    expect(run(c).status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop/);
  });

  it("post failure still FAIL with note", () => {
    const c = script("claude-fail2", "exit 1");
    rmSync(join(repo, "docs/private/expansion/prompts/skipped-card.json"));
    const r = run(c);
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/post=failed/);
  });

  it("timeout: FAIL, whole process group dead, lock released", () => {
    const pidFile = join(root, "child.pid");
    const c = script("claude-slow", `sleep 300 &\necho $! > "${pidFile}"\nwait`);
    const r = run(c, { EXPANSION_TIMEOUT_S: "2" });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop.*타임아웃/);
    expect(existsSync(lockDir())).toBe(false);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20000);

  const runsFile = () => JSON.parse(readFileSync(join(repo, "docs/private/expansion/runs", `${today()}.json`), "utf8"));
  it("I4: claude 가 exit 1 이어도 결과 JSON 의 비용을 FAIL 줄과 runs 파일에 남긴다", () => {
    const c = script("claude-fail-cost", `cat >/dev/null\necho '{"is_error":true,"total_cost_usd":0.75}'\nexit 1`);
    const r = run(c);
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop cost=0\.75 claude exit=1/);
    expect(runsFile().total_cost_usd).toBe(0.75);
  });
  it("I4: 출력 없이 실패하면 cost=unknown, runs 파일은 null(0 이 아니다)", () => {
    const c = script("claude-fail-silent", "exit 1");
    expect(run(c).status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop cost=unknown claude exit=1/);
    expect(runsFile().total_cost_usd).toBeNull();
  });
  it("I4: 타임아웃이어도 이미 나온 결과 JSON 의 비용을 남긴다", () => {
    const c = script("claude-slow-cost", `echo '{"is_error":false,"total_cost_usd":2.5}'\nsleep 300`);
    const r = run(c, { EXPANSION_TIMEOUT_S: "2" });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop cost=2\.5 타임아웃/);
  }, 20000);
  it("I4: node 가 깨지면 그 stderr 첫 줄을 사유에 붙이고 cost=unknown", () => {
    const fakeBin = join(root, "fakebin");
    mkdirSync(fakeBin);
    Object.assign(stubEnv, writeCmdStub(fakeBin, "node", "echo zz-node-broken >&2\nexit 127\n").env);
    const c = script("claude-ok-nodeless", OK_CARDS());
    const r = run(c, { PATH: `${fakeBin}:${process.env.PATH ?? ""}` });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop cost=unknown 결과 JSON 파손 zz-node-broken/);
  });

  it("success + cards file: OK line with cost, runs file, post once with cards path", () => {
    const c = script("claude-ok", OK_CARDS());
    const r = run(c);
    expect(r.status).toBe(0);
    expect(cronLog()).toMatch(/OK expansion-loop cost=1\.25 post=ok/);
    const runs = join(repo, "docs/private/expansion/runs");
    const files = readdirSync(runs);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(runs, files[0]), "utf8")).total_cost_usd).toBe(1.25);
    expect(postCalls()).toEqual([`/h/plugins/wag-operator/expansion_cards.py post ${repo}/docs/private/expansion/out/${today()}-cards.json`]);
    expect(existsSync(lockDir())).toBe(false);
  });

  it("records turns and per-model cost when the result JSON has them", () => {
    const json = '{"is_error":false,"total_cost_usd":3.5,"num_turns":42,"modelUsage":{"claude-opus-5-5":{"costUSD":2.256},"claude-sonnet-5-5":{"costUSD":1.244},"weird":{"costUSD":"x"}}}';
    const r = run(script("claude-ok-models", cardsSh() + `cat >/dev/null\necho '${json}'`));
    expect(r.status).toBe(0);
    expect(cronLog()).toMatch(/OK expansion-loop cost=3\.5 post=ok turns=42 models=opus-5-5=2\.26,sonnet-5-5=1\.24,weird=\?/);
    const rec = JSON.parse(readFileSync(join(repo, "docs/private/expansion/runs", `${today()}.json`), "utf8"));
    expect(rec.total_cost_usd).toBe(3.5);
    expect(rec.num_turns).toBe(42);
    expect(rec.model_cost_usd).toEqual({ "claude-opus-5-5": 2.26, "claude-sonnet-5-5": 1.24, weird: null });
  });

  it("missing turns/modelUsage stay null and do not change the verdict", () => {
    const r = run(script("claude-ok-nomodels", OK_CARDS()));
    expect(r.status).toBe(0);
    expect(cronLog()).toMatch(/OK expansion-loop cost=1\.25 post=ok turns=null models=unknown/);
    const rec = JSON.parse(readFileSync(join(repo, "docs/private/expansion/runs", `${today()}.json`), "utf8"));
    expect(rec.num_turns).toBeNull();
    expect(rec.model_cost_usd).toBeNull();
  });

  it("success without cards file: FAIL no-cards, skipped card posted once", () => {
    const r = run(script("claude-ok2", OK_JSON));
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop.*no-cards/);
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0]).toMatch(/skipped-card\.json$/);
  });

  it("success with empty cards array: FAIL no-cards", () => {
    expect(run(script("claude-ok3", cardsSh('{"cards":[]}') + OK_JSON)).status).toBe(1);
    expect(cronLog()).toMatch(/no-cards/);
  });

  it("cards post failure: FAIL with post=failed, exit 1", () => {
    const bad = script("post-bad", "exit 1");
    const r = run(script("claude-ok4", OK_CARDS()), { EXPANSION_POST_BIN: bad });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop cost=1\.25 post=failed/);
  });

  it("FAIL path never posts the operator's cards file", () => {
    run(script("claude-fail3", cardsSh() + "exit 1"));
    const calls = postCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toMatch(/-cards\.json/);
  });

  it("post hang: timeout recorded, exit 1", () => {
    const slow = script("post-slow", "sleep 300");
    const r = run(script("claude-fail4", "exit 1"), { EXPANSION_POST_BIN: slow, EXPANSION_POST_TIMEOUT_S: "1" });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/post=timeout/);
  });

  it("FAIL line is written before the post line", () => {
    run(script("claude-fail5", "exit 1"));
    const log = cronLog();
    expect(log.indexOf("FAIL expansion-loop")).toBeLessThan(log.indexOf("post=ok"));
  });

  it("leftover child of a normally exiting claude is killed", () => {
    const pidFile = join(root, "left.pid");
    const c = script("claude-leave", cardsSh() + `sleep 300 &\necho $! > "${pidFile}"\necho '{"is_error":false,"total_cost_usd":0}'`);
    expect(run(c).status).toBe(0);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try { process.kill(pid, 0); spawnSync("sleep", ["0.1"]); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });

  it("default prompt is daily-run even when first-run.md exists", () => {
    writeFileSync(join(repo, "docs/private/expansion/prompts/first-run.md"), "first");
    const r = run(null, { EXPANSION_DRY: "1" });
    expect(r.stdout).toContain("daily-run.md");
    expect(r.stdout).not.toContain("first-run.md");
  });

  it("stale lock is reclaimed; fresh lock still SKIPs", () => {
    mkdirSync(lockDir(), { recursive: true });
    const old = new Date(Date.now() - 3600_000);
    utimesSync(lockDir(), old, old);
    const r = run(null, { EXPANSION_DRY: "1", EXPANSION_TIMEOUT_S: "1" });
    expect(r.status).toBe(0);
    expect(cronLog()).toMatch(/SKIP expansion-loop stale-lock-reclaimed/);
    expect(cronLog()).toMatch(/OK expansion-loop/);
    expect(existsSync(lockDir())).toBe(false);
    expect(existsSync(lockDir() + ".reclaim")).toBe(false);
  });

  // CI runs on Linux: GNU `stat -f %m X` exits 1 but still prints file-system info to stdout,
  // so a BSD-first mtime probe must not trust that output. The imitation shells out to BSD stat,
  // so it only runs on macOS; on Linux the real stat is GNU and the lock tests above cover it.
  it.skipIf(process.platform !== "darwin")("GNU stat host: stale lock is still reclaimed (age is numeric)", () => {
    mkdirSync(lockDir(), { recursive: true });
    const old = new Date(Date.now() - 3600_000);
    utimesSync(lockDir(), old, old);
    script("stat", GNU_STAT_IMPL_BODY);
    const r = run(null, { EXPANSION_DRY: "1", EXPANSION_TIMEOUT_S: "1", PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(r.stderr).not.toMatch(/syntax error|arithmetic/i);
    expect(r.status).toBe(0);
    expect(cronLog()).toMatch(/SKIP expansion-loop stale-lock-reclaimed age=\d+s/);
    expect(cronLog()).toMatch(/OK expansion-loop/);
  });

  // Two runs reclaiming the same stale lock must not both end up owning it: only the holder
  // of the reclaim guard may rmdir+mkdir, so a run that finds the guard held backs off.
  it("stale lock while another run holds the reclaim guard: SKIP, lock and guard untouched", () => {
    mkdirSync(lockDir(), { recursive: true });
    mkdirSync(lockDir() + ".reclaim");
    const old = new Date(Date.now() - 3600_000);
    utimesSync(lockDir(), old, old);
    const r = run(null, { EXPANSION_DRY: "1", EXPANSION_TIMEOUT_S: "1" });
    expect(r.status).toBe(0);
    expect(cronLog()).toMatch(/SKIP expansion-loop locked/);
    expect(cronLog()).not.toMatch(/stale-lock-reclaimed/);
    expect(cronLog()).not.toMatch(/OK expansion-loop/);
    expect(existsSync(lockDir())).toBe(true);
    expect(existsSync(lockDir() + ".reclaim")).toBe(true);
  });

  it("guard left by a crashed reclaimer is cleared, but this run still SKIPs", () => {
    mkdirSync(lockDir(), { recursive: true });
    mkdirSync(lockDir() + ".reclaim");
    const old = new Date(Date.now() - 3600_000);
    utimesSync(lockDir(), old, old);
    utimesSync(lockDir() + ".reclaim", old, old);
    const r = run(null, { EXPANSION_DRY: "1", EXPANSION_TIMEOUT_S: "1" });
    expect(r.status).toBe(0);
    expect(cronLog()).toMatch(/SKIP expansion-loop locked/);
    expect(cronLog()).not.toMatch(/OK expansion-loop/);
    expect(existsSync(lockDir())).toBe(true);
    expect(existsSync(lockDir() + ".reclaim")).toBe(false);
  });
});

describe("expansion-loop.sh 운영 트리", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const opsWt = () => join(repo, ".claude/worktrees/expansion-ops");
  let origin: string;
  // 원격 main 에 marker=v1 을 올리고, 메인 체크아웃은 marker 를 바꾼 다른 브랜치에 둔다(다른 세션이 쓰는 상황).
  beforeEach(() => {
    probePath = "";
    origin = join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, ".gitignore"), "docs/private/\n.claude/worktrees/\n");
    writeFileSync(join(repo, "marker.txt"), "v1\n");
    git(repo, "add", ".gitignore", "marker.txt");
    git(repo, "commit", "-q", "-m", "v1");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(repo, "checkout", "-q", "-b", "other-session");
    writeFileSync(join(repo, "marker.txt"), "stale\n");
    git(repo, "commit", "-q", "-am", "stale");
  });
  const pushMain = (v: string) => {
    const tmp = join(root, `push-${v}`);
    git(root, "clone", "-q", "-b", "main", origin, tmp);
    writeFileSync(join(tmp, "marker.txt"), `${v}\n`);
    git(tmp, "commit", "-q", "-am", v);
    git(tmp, "push", "-q", "origin", "HEAD:refs/heads/main");
  };
  // 같은 이름의 가짜 명령은 한 번만 만들 수 있다 — 테스트마다 한 번 만들고 회차 사이에 재사용한다.
  let probePath = "";
  const probe = () =>
    (probePath ||= script(
      "claude-probe",
      `pwd -P > "${root}/cwd"\necho "$@" > "${root}/argv"\ncat marker.txt > "${root}/marker"\nreadlink docs/private > "${root}/link"\n${OK_CARDS()}`,
    ));
  const read = (f: string) => readFileSync(join(root, f), "utf8").trim();

  it("최신 main 으로 운영 트리를 만들고 거기서 운영자를 돌린다(docs/private 는 메인 쪽 링크)", () => {
    const r = run(probe(), { EXPANSION_OPS_WT: UNSET_ENV });
    expect(r.status).toBe(0);
    expect(read("cwd")).toBe(realpathSync(opsWt()));
    expect(read("marker")).toBe("v1");
    expect(read("link")).toBe(join(repo, "docs/private"));
    // 프롬프트가 쓰는 메인 체크아웃 절대 경로는 작업 폴더 밖이다 — 허용 폴더로 넘겨야 쓰기가 막히지 않는다.
    expect(read("argv").endsWith(`--add-dir ${repo}`)).toBe(true);
    expect(readFileSync(join(repo, "marker.txt"), "utf8").trim()).toBe("stale");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("other-session");
  }, 30000);

  it("다음 회차는 main 의 새 커밋으로 운영 트리를 옮긴다", () => {
    expect(run(probe(), { EXPANSION_OPS_WT: UNSET_ENV }).status).toBe(0);
    pushMain("v2");
    expect(run(probe(), { EXPANSION_OPS_WT: UNSET_ENV }).status).toBe(0);
    expect(read("marker")).toBe("v2");
  }, 30000);

  it("운영 트리의 추적 파일이 바뀌어 있으면 덮지 않고 FAIL, 운영자 미호출", () => {
    expect(run(probe(), { EXPANSION_OPS_WT: UNSET_ENV }).status).toBe(0);
    writeFileSync(join(opsWt(), "marker.txt"), "hand-edit\n");
    rmSync(join(root, "marker"));
    const r = run(probe(), { EXPANSION_OPS_WT: UNSET_ENV });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop.*운영 트리: 추적 파일 변경 있음/);
    expect(existsSync(join(root, "marker"))).toBe(false);
    expect(readFileSync(join(opsWt(), "marker.txt"), "utf8")).toBe("hand-edit\n");
  }, 30000);

  it("폴더만 지워지고 git 등록이 남아도 다시 만든다", () => {
    expect(run(probe(), { EXPANSION_OPS_WT: UNSET_ENV }).status).toBe(0);
    rmSync(opsWt(), { recursive: true, force: true });
    expect(run(probe(), { EXPANSION_OPS_WT: UNSET_ENV }).status).toBe(0);
    expect(read("marker")).toBe("v1");
  }, 30000);

  it("관리 폴더가 prune 돼 끊긴 운영 트리는 지우고 다시 만든다", () => {
    expect(run(probe(), { EXPANSION_OPS_WT: UNSET_ENV }).status).toBe(0);
    rmSync(join(repo, ".git/worktrees"), { recursive: true, force: true });
    writeFileSync(join(opsWt(), "hand-note.txt"), "keep\n");
    rmSync(join(root, "marker"));
    expect(run(probe(), { EXPANSION_OPS_WT: UNSET_ENV }).status).toBe(0);
    expect(read("marker")).toBe("v1");
    // 끊긴 트리는 지우지 않고 옆으로 옮긴다 — 안의 수기 파일이 남아 있어야 한다.
    const moved = readdirSync(join(repo, ".claude/worktrees")).filter((n) => n.startsWith("expansion-ops.broken-"));
    expect(moved).toHaveLength(1);
    expect(readFileSync(join(repo, ".claude/worktrees", moved[0], "hand-note.txt"), "utf8")).toBe("keep\n");
  }, 30000);

  it("fetch 가 실패하면 FAIL 사유에 남기고 운영자를 부르지 않는다", () => {
    git(repo, "remote", "remove", "origin");
    const r = run(probe(), { EXPANSION_OPS_WT: UNSET_ENV });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop.*운영 트리: fetch 실패/);
    expect(existsSync(join(root, "marker"))).toBe(false);
  }, 30000);
});

describe("expansion-loop.sh 실패 사유", () => {
  it("claude exit 1 이면 결과 JSON 의 result 앞부분을 사유에 붙인다", () => {
    const c = script(
      "claude-login",
      `cat >/dev/null\necho '{"is_error":true,"total_cost_usd":0,"result":"Not logged in\\n  Please run /login"}'\nexit 1`,
    );
    expect(run(c).status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop cost=0 claude exit=1 Not logged in Please run \/login \| /);
  }, 20000);
  it("is_error=true 면 result 앞부분을 사유에 붙이고 160자로 자른다", () => {
    const long = "x".repeat(300);
    const c = script("claude-iserr", `cat >/dev/null\necho '{"is_error":true,"total_cost_usd":0.1,"result":"${long}"}'`);
    expect(run(c).status).toBe(1);
    const line = cronLog().split("\n").find((l) => l.includes("FAIL expansion-loop")) ?? "";
    expect(line).toContain(`결과 is_error=true ${"x".repeat(160)}`);
    expect(line).not.toContain("x".repeat(161));
  }, 20000);
});

describe("expansion-loop.sh 앱 신원", () => {
  // 가짜 발급 스크립트: 인자를 기록하고 고정 토큰을 낸다(node 로 실행된다 — 실행 권한 없는 데이터 파일).
  const tokenScript = (body = 'process.stdout.write("tok_stub_value\\n");') => {
    const p = join(root, "fake-token.mjs");
    writeFileSync(
      p,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(root, "token.argv"))}, process.argv.slice(2).join(" ") + "\\n");\n${body}\n`,
    );
    return p;
  };
  const key = () => {
    const p = join(root, "app.pem");
    writeFileSync(p, "not-a-real-key");
    return p;
  };
  // 가짜 claude: 받은 GH_TOKEN·GITHUB_TOKEN 을 기록한다.
  const envProbe = () =>
    script(
      "claude-env",
      `echo "GH=\${GH_TOKEN-<unset>} GITHUB=\${GITHUB_TOKEN-<unset>}" > "${root}/claude.env"\n${OK_CARDS()}`,
    );
  // 가짜 게시기: 카드 게시 단계가 받은 GH_TOKEN 을 기록한다(앱 토큰은 회차에만 준다).
  const postProbe = () =>
    script("post-env.sh", `echo "GH=\${GH_TOKEN-<unset>}" > "${root}/post.env"`);
  const claudeEnv = () => (existsSync(join(root, "claude.env")) ? readFileSync(join(root, "claude.env"), "utf8").trim() : "");

  it("키가 있으면 회차 직전에 앱 토큰을 받아 GH_TOKEN 으로 넘기고 GITHUB_TOKEN 은 지운다", () => {
    const r = run(envProbe(), {
      EXPANSION_APP_KEY: key(),
      EXPANSION_APP_TOKEN_SCRIPT: tokenScript(),
      GH_TOKEN: "owner_token_must_not_leak",
      GITHUB_TOKEN: "owner_token_must_not_leak",
    });
    expect(r.status).toBe(0);
    expect(claudeEnv()).toBe("GH=tok_stub_value GITHUB=<unset>");
    expect(readFileSync(join(root, "token.argv"), "utf8").trim()).toBe(`5832880 183673676 ${join(root, "app.pem")}`);
    expect(cronLog()).not.toContain("tok_stub_value");
  }, 20000);

  it("카드 게시 단계에는 앱 토큰을 넘기지 않는다", () => {
    const r = run(envProbe(), {
      EXPANSION_APP_KEY: key(),
      EXPANSION_APP_TOKEN_SCRIPT: tokenScript(),
      EXPANSION_POST_BIN: postProbe(),
    });
    expect(r.status).toBe(0);
    expect(claudeEnv()).toBe("GH=tok_stub_value GITHUB=<unset>");
    expect(readFileSync(join(root, "post.env"), "utf8").trim()).toBe("GH=<unset>");
  }, 20000);

  it("키 파일이 없으면 오너 자격으로 물러서지 않고 FAIL 로 멈춘다", () => {
    const r = run(envProbe(), { EXPANSION_APP_KEY: join(root, "missing.pem"), EXPANSION_APP_TOKEN_SCRIPT: tokenScript() });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop.*앱 키 없음/);
    expect(existsSync(join(root, "claude.env"))).toBe(false);
  }, 20000);

  it("빈 값은 끄는 값이 아니다 — 오너 자격으로 진행하지 않고 FAIL", () => {
    const r = run(envProbe(), { EXPANSION_APP_KEY: "", EXPANSION_APP_TOKEN_SCRIPT: tokenScript(), GH_TOKEN: "owner_token" });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop.*앱 키 없음/);
    expect(existsSync(join(root, "claude.env"))).toBe(false);
  }, 20000);

  it("기본값(EXPANSION_APP_KEY 미지정)은 HOME/selfhost/expansion-app.pem 을 찾는다", () => {
    const r = run(envProbe(), { EXPANSION_APP_KEY: UNSET_ENV, EXPANSION_APP_TOKEN_SCRIPT: tokenScript() });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop.*앱 키 없음/);
  }, 20000);

  it("발급이 실패하면 사유 첫 줄을 남기고 회차를 부르지 않는다", () => {
    const r = run(envProbe(), {
      EXPANSION_APP_KEY: key(),
      EXPANSION_APP_TOKEN_SCRIPT: tokenScript('process.stderr.write("expansion-app-token: HTTP 401 Bad credentials\\n"); process.exit(1);'),
    });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop.*앱 토큰 발급 실패 expansion-app-token: HTTP 401 Bad credentials/);
    expect(existsSync(join(root, "claude.env"))).toBe(false);
  }, 20000);

  it("빈 토큰이면 FAIL", () => {
    const r = run(envProbe(), { EXPANSION_APP_KEY: key(), EXPANSION_APP_TOKEN_SCRIPT: tokenScript("") });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop.*앱 토큰 발급 실패 \(빈 토큰\)/);
  }, 20000);

  it("시간 상한이 토큰 수명(3600s)보다 길면 발급 전에 FAIL", () => {
    const r = run(envProbe(), { EXPANSION_APP_KEY: key(), EXPANSION_APP_TOKEN_SCRIPT: tokenScript(), EXPANSION_TIMEOUT_S: "3601" });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/FAIL expansion-loop.*시간 상한 3601s 가 앱 토큰 수명 3600s 보다 길다/);
    expect(existsSync(join(root, "token.argv"))).toBe(false);
  }, 20000);

  it("none 이면 GH_TOKEN 을 건드리지 않는다(테스트·수동 실행용)", () => {
    const r = run(envProbe(), { GH_TOKEN: "untouched" });
    expect(r.status).toBe(0);
    expect(claudeEnv()).toBe("GH=untouched GITHUB=<unset>");
  }, 20000);
});

describe("expansion-loop.sh 단계 분기(fork)", () => {
  const SID = "0123abcd-0000-4000-8000-00000000000a";
  type Resp = { json?: string; rc?: number };
  // 가짜 claude: stdin 의 단계 표지로 단계를 가리고, 호출 인자·단계를 기록한 뒤 그 단계의 응답을 낸다.
  // 갈래의 비용은 실물처럼 A 를 포함한 누적값으로 준다. 카드 파일은 단계 D(또는 single)가 쓴다.
  const forkStub = (resp: Record<string, Resp>) => {
    for (const [p, r] of Object.entries(resp)) {
      if (r.json !== undefined) writeFileSync(join(root, `resp-${p}.json`), r.json);
      if (r.rc !== undefined) writeFileSync(join(root, `rc-${p}`), String(r.rc));
    }
    return script(
      "claude-phased",
      [
        'in=$(cat)',
        'case "$in" in',
        '  *"【단계 A】"*) p=A ;;',
        '  *"【단계 B】"*) p=B ;;',
        '  *"【단계 C】"*) p=C ;;',
        '  *"【단계 D】"*) p=D ;;',
        '  *) p=S ;;',
        'esac',
        `printf '%s\\n' "$p" >> "${root}/phases"`,
        `printf '%s\\n' "$*" >> "${root}/calls"`,
        `printf '%s' "$in" > "${root}/stdin-$p"`,
        `if [ "$p" = D ] || [ "$p" = S ]; then`,
        cardsSh(),
        "fi",
        `[ -f "${root}/resp-$p.json" ] && cat "${root}/resp-$p.json"`,
        `[ -f "${root}/rc-$p" ] && exit "$(cat "${root}/rc-$p")"`,
        "exit 0",
      ].join("\n"),
    );
  };
  const lines = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8").trim().split("\n") : []);
  const runRec = () => JSON.parse(readFileSync(join(repo, "docs/private/expansion/runs", `${today()}.json`), "utf8"));
  const res = (cost: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ is_error: false, total_cost_usd: cost, session_id: SID, ...extra });
  const happy = () => ({
    A: { json: res(1.0, { num_turns: 10, modelUsage: { "claude-opus-5-5": { costUSD: 0.8 }, "claude-sonnet-5-5": { costUSD: 0.2 } } }) },
    B: { json: res(1.5, { num_turns: 5, modelUsage: { "claude-opus-5-5": { costUSD: 1.2 }, "claude-sonnet-5-5": { costUSD: 0.3 } } }) },
    C: { json: res(1.25, { num_turns: 6, modelUsage: { "claude-opus-5-5": { costUSD: 1.0 }, "claude-sonnet-5-5": { costUSD: 0.25 } } }) },
    D: { json: res(1.75, { num_turns: 7, modelUsage: { "claude-opus-5-5": { costUSD: 1.4 }, "claude-sonnet-5-5": { costUSD: 0.35 } } }) },
  });

  it("1 기본값은 fork: 4번 부르고 갈래는 모두 A 세션에서 가르며, 비용은 A + 갈래 몫의 합", () => {
    const r = run(forkStub(happy()), { EXPANSION_PHASES: UNSET_ENV });
    expect(r.status).toBe(0);
    expect(lines("phases")).toEqual(["A", "B", "C", "D"]);
    const calls = lines("calls");
    expect(calls[0]).not.toContain("--resume");
    expect(calls[0]).not.toContain("--fork-session");
    for (const c of calls.slice(1)) {
      expect(c).toMatch(new RegExp(`^-p --resume ${SID} --fork-session `));
      expect(c.endsWith(`--add-dir ${repo}`)).toBe(true);
    }
    // A 는 daily-run.md 본문 뒤에 단계 A 줄을 받고, 갈래는 자기 단계 줄만 받는다.
    const a = readFileSync(join(root, "stdin-A"), "utf8");
    expect(a.startsWith("go")).toBe(true);
    expect(a).toContain("【단계 A】 이번 호출은 0~3절만 한다. 3절을 마치면 run.md 에 `단계 A 끝` 한 줄을 쓰고 멈춘다.");
    expect(readFileSync(join(root, "stdin-B"), "utf8")).toMatch(/^【단계 B】 앞 대화\(단계 A\)에 이어 4·5절만 한다\./);
    expect(readFileSync(join(root, "stdin-C"), "utf8")).toMatch(/^【단계 C】 앞 대화\(단계 A\)에 이어 7절만 한다\./);
    expect(readFileSync(join(root, "stdin-D"), "utf8")).toMatch(/^【단계 D】 앞 대화\(단계 A\)에 이어 6·8·9·10·11절만 한다\./);
    expect(cronLog()).toMatch(/OK expansion-loop cost=2\.5 post=ok turns=28 models=opus-5-5=2,sonnet-5-5=0\.5 phases=fork/);
    const rec = runRec();
    expect(rec.total_cost_usd).toBe(2.5);
    expect(rec.num_turns).toBe(28);
    expect(rec.model_cost_usd).toEqual({ "claude-opus-5-5": 2, "claude-sonnet-5-5": 0.5 });
    expect(postCalls()).toEqual([`/h/plugins/wag-operator/expansion_cards.py post ${repo}/docs/private/expansion/out/${today()}-cards.json`]);
  }, 20000);

  it("2 single 은 예전처럼 한 번만 부르고 --resume 이 없다", () => {
    const r = run(forkStub({ S: { json: res(1.25) } }), { EXPANSION_PHASES: "single" });
    expect(r.status).toBe(0);
    expect(lines("phases")).toEqual(["S"]);
    expect(lines("calls")[0]).not.toContain("--resume");
    expect(readFileSync(join(root, "stdin-S"), "utf8")).toBe("go");
    expect(cronLog()).toMatch(/OK expansion-loop cost=1\.25 post=ok .*phases=single/);
  }, 20000);

  it("3 A 가 session_id 를 주지 않으면 FAIL, B 는 부르지 않는다", () => {
    const r = run(forkStub({ A: { json: '{"is_error":false,"total_cost_usd":1.0}' } }), { EXPANSION_PHASES: "fork" });
    expect(r.status).toBe(1);
    expect(lines("phases")).toEqual(["A"]);
    expect(cronLog()).toMatch(/FAIL expansion-loop cost=1 단계 A 세션 없음/);
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0]).toMatch(/skipped-card\.json$/);
  }, 20000);

  it("3b session_id 형식이 틀려도 세션 없음으로 FAIL", () => {
    const r = run(forkStub({ A: { json: JSON.stringify({ is_error: false, total_cost_usd: 1, session_id: "../evil" }) } }), {
      EXPANSION_PHASES: "fork",
    });
    expect(r.status).toBe(1);
    expect(lines("phases")).toEqual(["A"]);
    expect(cronLog()).toMatch(/FAIL expansion-loop .*단계 A 세션 없음/);
  }, 20000);

  it("4 B 가 is_error 면 「단계 B」 로 FAIL, C·D 미호출, 비용은 A + B 몫", () => {
    const h = happy();
    const r = run(
      forkStub({ A: h.A, B: { json: JSON.stringify({ is_error: true, total_cost_usd: 1.5, session_id: SID, result: "boom" }) } }),
      { EXPANSION_PHASES: "fork" },
    );
    expect(r.status).toBe(1);
    expect(lines("phases")).toEqual(["A", "B"]);
    expect(cronLog()).toMatch(/FAIL expansion-loop cost=1\.5 단계 B: 결과 is_error=true boom/);
    expect(runRec().total_cost_usd).toBe(1.5);
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0]).toMatch(/skipped-card\.json$/);
  }, 20000);

  it("4b 갈래가 exit≠0 이면 「단계 C: claude exit=」 로 FAIL, D 미호출", () => {
    const h = happy();
    const r = run(forkStub({ A: h.A, B: h.B, C: { json: res(1.25), rc: 2 } }), { EXPANSION_PHASES: "fork" });
    expect(r.status).toBe(1);
    expect(lines("phases")).toEqual(["A", "B", "C"]);
    expect(cronLog()).toMatch(/FAIL expansion-loop cost=1\.75 단계 C: claude exit=2/);
  }, 20000);

  it("5 갈래 예산 상한 = cost(A) + (MAX − 지금까지 쓴 돈); 남은 예산이 없으면 갈래를 부르지 않는다", () => {
    const r = run(forkStub(happy()), { EXPANSION_PHASES: "fork" });
    expect(r.status).toBe(0);
    const cap = (c: string) => c.match(/--max-budget-usd (\S+)/)?.[1];
    // A 12 · B 1+(12−1) · C 1+(12−1.5) · D 1+(12−1.75)
    expect(lines("calls").map(cap)).toEqual(["12", "12", "11.5", "11.25"]);
  }, 20000);

  it("5b A 가 예산을 다 쓰면 「단계 B: 예산 소진」 으로 FAIL", () => {
    const r = run(forkStub(happy()), { EXPANSION_PHASES: "fork", EXPANSION_MAX_BUDGET_USD: "1" });
    expect(r.status).toBe(1);
    expect(lines("phases")).toEqual(["A"]);
    expect(cronLog()).toMatch(/FAIL expansion-loop cost=1 단계 B: 예산 소진/);
  });

  it("6 DRY 는 단계마다 한 줄씩 4줄을 찍고 claude 를 부르지 않는다(잘못된 값은 fork)", () => {
    for (const v of [UNSET_ENV, "fork", "bogus"]) {
      const r = run(null, { EXPANSION_DRY: "1", EXPANSION_PHASES: v });
      expect(r.status).toBe(0);
      const dry = r.stdout.trim().split("\n");
      expect(dry.map((l) => l.slice(0, 10))).toEqual(["DRY: 단계 A:", "DRY: 단계 B:", "DRY: 단계 C:", "DRY: 단계 D:"]);
      expect(dry[0]).toMatch(/--max-budget-usd 12 .*daily-run\.md/);
      for (const l of dry.slice(1)) expect(l).toMatch(/--resume <A session_id> --fork-session /);
    }
    expect(cronLog()).toMatch(/OK expansion-loop cost=0 dry=1 phases=fork/);
    expect(run(null, { EXPANSION_DRY: "1", EXPANSION_PHASES: "single" }).stdout.trim().split("\n")).toHaveLength(1);
  });

  it("갈래 도중 실패해도 건너뜀 카드 게시에는 앱 토큰을 넘기지 않는다", () => {
    const tok = join(root, "fake-token.mjs");
    writeFileSync(tok, 'process.stdout.write("tok_stub_value\\n");\n');
    const keyPath = join(root, "app.pem");
    writeFileSync(keyPath, "not-a-real-key");
    const post = script("post-env.sh", `echo "GH=\${GH_TOKEN-<unset>}" > "${root}/post.env"`);
    const h = happy();
    const r = run(forkStub({ A: h.A, B: { json: res(1.5), rc: 1 } }), {
      EXPANSION_PHASES: "fork",
      EXPANSION_APP_KEY: keyPath,
      EXPANSION_APP_TOKEN_SCRIPT: tok,
      EXPANSION_POST_BIN: post,
    });
    expect(r.status).toBe(1);
    expect(cronLog()).toMatch(/단계 B: claude exit=1/);
    expect(readFileSync(join(root, "post.env"), "utf8").trim()).toBe("GH=<unset>");
  }, 20000);
});

describe("expansion-readonly-sql.sh", () => {
  const sql = (arg: string) => {
    const dockerLog = join(root, "docker.log");
    script("docker", `echo "PGOPTIONS_ARGS: $@" >> "${dockerLog}"`);
    const r = spawnSync("/bin/bash", [SQL, arg], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, ...stubEnv },
      encoding: "utf8",
    });
    return { r, called: existsSync(dockerLog) ? readFileSync(dockerLog, "utf8") : "" };
  };

  it.each(["DELETE FROM x", "update t set a=1", "select 1; drop table x", "-- select\ndelete from x", "/* a */ insert into t values (1)", "", "/* /* */ select 1 */ COPY (select 1) TO PROGRAM 'touch /tmp/x'", "/* /* */ select */ DELETE FROM x", "select 1 /* x */", "select 1 -- x", "-- c\n select 1", "/* a /* b */ c */ select 1", "-- x\rDELETE FROM t;\nselect 1", "-- x\rSET default_transaction_read_only=off; COMMIT; DELETE FROM t;\nselect 1", "-- x\rSET TRANSACTION READ WRITE; DELETE FROM t;\nselect 1", "select 1\r", "select\u00011"])(
    "rejects %j before docker",
    (q) => {
      const { r, called } = sql(q);
      expect(r.status).toBe(2);
      expect(called).toBe("");
    },
  );

  it.each(["copy", "pg_terminate_backend", "pg_cancel_backend", "set_config", "pg_reload_conf", "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "lo_import", "lo_export", "dblink", "reset", "set role", "set session"])(
    "denylist rejects %s (any case) before docker",
    (w) => {
      const { r, called } = sql(`select ${w.toUpperCase()} (1)`);
      expect(r.status).toBe(2);
      expect(called).toBe("");
    },
  );

  it.each([
    'select * from"vault"."decrypted_secrets"',
    'select*from"vault".decrypted_secrets',
    "select * from vault\n.decrypted_secrets",
    'select "vault"\n."decrypted_secrets"',
    'select"net"."worker_restart"()',
    'select * from"net"."_http_response"',
    "select net.http_get('http://x')",
    'select "net"."http_get"(\'http://x\')',
    "select NET . http_get('x')",
    "select http_post('x','y')",
    "select http_get('x')",
    "select vault.decrypted_secrets",
    'select * from "vault"."secrets"',
    "select pg_sleep(100)",
    "select pg_catalog.pg_sleep(1)",
    "select pg_create_physical_replication_slot('s')",
    "select pg_create_logical_replication_slot('s','x')",
    "select pg_drop_replication_slot('s')",
    "select pg_stat_reset()",
    "select pg_stat_statements_reset()",
    "select pg_stat_reset_shared('bgwriter')",
    'select "pg_stat_reset"()',
  ])("new deny rejects %s before docker", (q) => {
    const { r, called } = sql(q);
    expect(r.status).toBe(2);
    expect(called).toBe("");
  });

  it("data-modifying CTE reaches docker as wag_expansion_ro with read-only session, never supabase_admin", () => {
    const { r, called } = sql("WITH d AS (DELETE FROM x RETURNING *) SELECT * FROM d");
    expect(r.status).toBe(0);
    expect(called).toContain("PGOPTIONS=-c default_transaction_read_only=on");
    expect(called).toContain("-h 127.0.0.1 -U wag_expansion_ro ");
    expect(called).not.toContain("-U postgres");
    expect(called).not.toContain("supabase_admin");
  });

  it.each(["select dblink_exec('x','y')", "select dblink_connect('x')", "select pg_read_binary_file('x')", "select pg_ls_waldir()", "select lo_import('x')"])(
    "prefix denylist rejects %s before docker",
    (q) => {
      const { r, called } = sql(q);
      expect(r.status).toBe(2);
      expect(called).toBe("");
    },
  );

  it.each(["select 1", "select lower(name) from t", "select\n 1\t", 'select "createdAt" from "Campaign" where id = 1'])("negative control passes: %j", (q) => {
    const { r, called } = sql(q);
    expect(r.status).toBe(0);
    expect(called).toContain("-h 127.0.0.1 -U wag_expansion_ro ");
    expect(called).not.toContain("-U postgres");
  });

  it.each([
    'select U&"pg_terminate\\005fbackend"(pid) from pg_stat_activity',
    "select U&\"!0073et_config\" UESCAPE '!' ('a','b',false)",
    'select U&"\\0064blink_exec"(\'dbname=postgres\',\'delete from t\')',
    "select u&'abc'",
    "select query_to_xml('select dbl'||'ink_exec(1)', true, true, '')",
    "select query_to_xmlschema('select 1', true, true, '')",
    "select query_to_xml_and_xmlschema('select 1', true, true, '')",
    "select cursor_to_xml('c', 1, true, true, '')",
    "select * from ts_stat('select 1')",
    "select ts_rewrite('a'::tsquery, 'select 1')",
    'select "query_to_xml"(\'select 1\', true, true, \'\')',
    "select pg_catalog.ts_stat('select 1')",
  ])("respelling bypass rejected before docker: %s", (q) => {
    const { r, called } = sql(q);
    expect(r.status).toBe(2);
    expect(called).toBe("");
  });

  it("passes the validated string to docker -c exactly", () => {
    const q = 'select "createdAt" from "Campaign" where id = 1';
    const { r, called } = sql(q);
    expect(r.status).toBe(0);
    expect(called.trim().endsWith(`-c ${q}`)).toBe(true);
  });

  it("accepts WITH and one trailing semicolon", () => {
    expect(sql("WITH a AS (select 1) select * from a;").r.status).toBe(0);
  });

  it("requires exactly one argument", () => {
    const r = spawnSync("/bin/bash", [SQL], { env: { PATH: process.env.PATH ?? "", HOME: home }, encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});
