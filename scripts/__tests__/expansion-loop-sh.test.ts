import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, utimesSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOOP = process.env.LOOP_SRC_FOR_MUTATION ?? resolve(__dirname, "../../infra/selfhost/expansion-loop.sh");
const SQL = resolve(__dirname, "../../infra/selfhost/expansion-readonly-sql.sh");

let root: string;
let home: string;
let repo: string;
let bin: string;

const script = (name: string, body: string) => {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const cronLog = () => {
  const p = join(home, "selfhost/logs/cron.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};
const lockDir = () => join(home, "selfhost/locks/expansion-loop");

beforeEach(() => {
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

const run = (claude: string | null, extra: Record<string, string> = {}) => {
  const post = script("post.sh", `echo "$@" >> "${root}/post.argv"\ncat "$3" >> "${root}/post.content" 2>/dev/null || true`);
  return spawnSync("/bin/bash", [LOOP], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      EXPANSION_REPO: repo,
      EXPANSION_POST_BIN: post,
      EXPANSION_HERMES_DIR: "/h",
      ...(claude ? { EXPANSION_CLAUDE_BIN: claude } : {}),
      ...extra,
    },
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
    const node = join(fakeBin, "node");
    writeFileSync(node, "#!/bin/bash\necho zz-node-broken >&2\nexit 127\n");
    chmodSync(node, 0o755);
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
  });
});

describe("expansion-readonly-sql.sh", () => {
  const sql = (arg: string) => {
    const dockerLog = join(root, "docker.log");
    script("docker", `echo "PGOPTIONS_ARGS: $@" >> "${dockerLog}"`);
    const r = spawnSync("/bin/bash", [SQL, arg], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home },
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

  it("data-modifying CTE reaches docker as postgres with read-only session, never supabase_admin", () => {
    const { r, called } = sql("WITH d AS (DELETE FROM x RETURNING *) SELECT * FROM d");
    expect(r.status).toBe(0);
    expect(called).toContain("PGOPTIONS=-c default_transaction_read_only=on");
    expect(called).toContain("-U postgres");
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
    expect(called).toContain("-U postgres");
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
