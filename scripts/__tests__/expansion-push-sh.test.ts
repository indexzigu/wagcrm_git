import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PUSH = process.env.PUSH_SRC_FOR_MUTATION ?? resolve(__dirname, "../../infra/selfhost/expansion-push.sh");
const OK_CHECKER = `process.stdout.write("OK: 점검 통과 PR 제목·커밋 가드 점검 포함\\n");\n`;
const REAL_CHECKER = readFileSync(resolve(__dirname, "../expansion-prepush-check.mjs"), "utf8");
const REAL_GUARD = readFileSync(resolve(__dirname, "../commit-guard.mjs"), "utf8");
// 커밋 가드 표본은 실행 중에 조립한다(이 파일이 레포 커밋 가드에 걸리지 않게).
const FAKE_KEY = ["sk", "-", "Q".repeat(8), "r".repeat(8), "7".repeat(8)].join("");

let root: string;
let home: string;
let origin: string;
let wt: string;
let title: string;
let deny: string;
let tmpHome: string;

const isoEnv = () => ({ PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: isoEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// origin 의 main 에 가짜 점검기·커밋 가드를 심는다(null 이면 그 파일 없음). 가드 기본값은 진짜 commit-guard.mjs.
const setup = (checker: string | null, guard: string | null = REAL_GUARD) => {
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "t@example.com");
  git(seed, "config", "user.name", "t");
  writeFileSync(join(seed, "README"), "x");
  mkdirSync(join(seed, "scripts"));
  if (checker !== null) writeFileSync(join(seed, "scripts/expansion-prepush-check.mjs"), checker);
  if (guard !== null) writeFileSync(join(seed, "scripts/commit-guard.mjs"), guard);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(root, "clone", "-q", origin, wt);
  git(wt, "config", "user.email", "t@example.com");
  git(wt, "config", "user.name", "t");
  git(wt, "checkout", "-q", "-b", "exp/demo-slug");
  writeFileSync(join(wt, "a.txt"), "a");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "feat: a");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "exp-push-"));
  home = join(root, "home");
  origin = join(root, "origin.git");
  wt = join(root, "wt");
  tmpHome = join(root, "tmp");
  mkdirSync(home);
  mkdirSync(tmpHome);
  title = join(root, "title.txt");
  deny = join(root, "deny.txt");
  writeFileSync(title, "feat: 데모\n");
  writeFileSync(deny, "zzterm\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// 스크립트 사본의 상수 두 줄(EXPECTED_ORIGIN·DENYLIST)만 로컬 경로로 바꾼다(각각 정확히 1회 일치해야 한다).
const ORIGIN_RE = /^readonly EXPECTED_ORIGIN=.*$/gm;
const DENYLIST_RE = /^readonly DENYLIST=.*$/gm;
const scriptCopy = (expectedOrigin = origin) => {
  const src = readFileSync(PUSH, "utf8");
  expect(src.match(ORIGIN_RE)?.length).toBe(1);
  expect(src.match(DENYLIST_RE)?.length).toBe(1);
  const p = join(root, "expansion-push.copy.sh");
  writeFileSync(
    p,
    src
      .replace(ORIGIN_RE, `readonly EXPECTED_ORIGIN=${JSON.stringify(expectedOrigin)}`)
      .replace(DENYLIST_RE, `readonly DENYLIST=${JSON.stringify(deny)}`),
  );
  return p;
};
const run = (args: string[] | null = null, env: Record<string, string> = {}, expectedOrigin = origin) =>
  spawnSync("/bin/bash", [scriptCopy(expectedOrigin), ...(args ?? [wt, "demo-slug", title])], {
    env: { ...isoEnv(), TMPDIR: tmpHome, ...env },
    encoding: "utf8",
    timeout: 30000,
  });
const remoteRef = () => {
  const r = spawnSync("git", ["-C", origin, "rev-parse", "--verify", "-q", "refs/heads/exp/demo-slug"], { encoding: "utf8", env: isoEnv() });
  return r.status === 0 ? r.stdout.trim() : null;
};
const expectBlocked = (r: ReturnType<typeof run>) => {
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("BLOCKED:");
  expect(remoteRef()).toBeNull();
};

describe("expansion-push.sh", () => {
  it("통과하면 push 하고 PUSHED 줄을 낸다", () => {
    setup(OK_CHECKER);
    const r = run();
    const sha = git(wt, "rev-parse", "HEAD");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`PUSHED: exp/demo-slug ${sha}`);
    expect(remoteRef()).toBe(sha);
  });
  it("브랜치가 다르면 막는다", () => {
    setup(OK_CHECKER);
    git(wt, "checkout", "-q", "-b", "exp/other-one");
    expectBlocked(run());
  });
  it("작업 트리가 더러우면 막는다", () => {
    setup(OK_CHECKER);
    writeFileSync(join(wt, "dirty.txt"), "d");
    expectBlocked(run());
  });
  it("origin/main 에 점검기가 없으면 막는다", () => {
    setup(null);
    expectBlocked(run());
  });
  it("점검기가 빈 파일이면 막는다", () => {
    setup("");
    expectBlocked(run());
  });
  it("종료코드 0 이어도 OK 줄이 없으면 막는다", () => {
    setup(`process.stdout.write("done\\n");\n`);
    expectBlocked(run());
  });
  it("OK 줄에 PR 제목 표지가 없으면 막는다", () => {
    setup(`process.stdout.write("OK: 브랜치명 점검 통과\\n");\n`);
    expectBlocked(run());
  });
  it("점검기가 종료코드 1 이면 막고 stderr 를 보인다", () => {
    setup(`process.stderr.write("BLOCKED: 1건\\n");process.exit(1);\n`);
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("BLOCKED: 1건");
  });
  it("금지어 파일이 없으면 막는다", () => {
    setup(OK_CHECKER);
    rmSync(deny);
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("금지어 파일이 없거나 비어 있다");
  });
  it("제목 파일이 비어 있으면 종료코드 2", () => {
    setup(OK_CHECKER);
    writeFileSync(title, "");
    const r = run();
    expect(r.status).toBe(2);
    expect(remoteRef()).toBeNull();
  });
  it("상대 경로 워크트리는 종료코드 2", () => {
    setup(OK_CHECKER);
    expect(run(["wt", "demo-slug", title]).status).toBe(2);
    expect(remoteRef()).toBeNull();
  });
  it("잘못된 slug 는 종료코드 2", () => {
    setup(OK_CHECKER);
    expect(run([wt, "Bad_Slug", title]).status).toBe(2);
    expect(run([wt, "ab", title]).status).toBe(2);
    expect(remoteRef()).toBeNull();
  });
  it("인자 개수가 틀리면 종료코드 2", () => {
    setup(OK_CHECKER);
    expect(run([wt, "demo-slug"]).status).toBe(2);
  });
  it("성공·실패 모두 임시 디렉터리를 남기지 않는다", () => {
    setup(OK_CHECKER);
    expect(run().status).toBe(0);
    rmSync(deny);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("금지어 파일이 없거나 비어 있다");
    expect(readdirSync(tmpHome)).toEqual([]);
  });

  const BAD = `process.stderr.write("BLOCKED: 1건\\n");process.exit(1);\n`;
  const BRANCH_OK = () => {
    mkdirSync(join(wt, "scripts"), { recursive: true });
    writeFileSync(join(wt, "scripts/expansion-prepush-check.mjs"), OK_CHECKER);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "feat: 브랜치 쪽 점검기");
  };
  it("브랜치 쪽 점검기가 늘 OK 여도 origin/main 의 신뢰 사본을 쓴다", () => {
    setup(BAD);
    BRANCH_OK();
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("노출 점검기 실패");
  });
  it("로컬 브랜치 origin/main 으로 기준을 가로채도 막힌다", () => {
    setup(BAD);
    BRANCH_OK();
    git(wt, "branch", "origin/main", "HEAD");
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("노출 점검기 실패");
  });
  it("로컬 태그 origin/main 으로 기준을 가로채도 막힌다", () => {
    setup(BAD);
    BRANCH_OK();
    git(wt, "tag", "origin/main", "HEAD");
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("노출 점검기 실패");
  });
  it("stdout 에 OK 를 내도 종료코드 1 이면 막는다", () => {
    setup(`process.stdout.write("OK: PR 제목\\n");process.exit(1);\n`);
    expectBlocked(run());
  });
  it("OK 가 stderr 에만 있으면 막는다", () => {
    setup(`process.stderr.write("OK: PR 제목\\n");\n`);
    expectBlocked(run());
  });
  it("점검기가 커밋을 만들면(HEAD 변경) 막는다", () => {
    setup(
      `import {spawnSync as s} from "node:child_process";` +
        `s("git",["-c","user.email=t@example.com","-c","user.name=t","commit","-q","--allow-empty","-m","slip"]);` +
        OK_CHECKER,
    );
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("HEAD 가 바뀌었다");
  });
  it("점검기가 브랜치를 바꾸면 막는다", () => {
    setup(`import {spawnSync as s} from "node:child_process";s("git",["checkout","-q","-b","exp/other-one"]);` + OK_CHECKER);
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("브랜치가 바뀌었다");
  });
  it("fetch 가 실패하면 막는다", () => {
    setup(OK_CHECKER);
    // 주소 대조는 통과시키고(기대값도 같은 없는 경로) fetch 에서 실패하게 한다.
    const missing = join(root, "missing.git");
    git(wt, "remote", "set-url", "origin", missing);
    const r = run(null, {}, missing);
    expectBlocked(r);
    expect(r.stderr).toContain("BLOCKED: git fetch origin main 실패");
  });
  it("점검기는 기준 SHA·금지어 경로·제목 파일 절대경로·임시 커밋 가드 사본을 받는다", () => {
    const rec = join(root, "argv.json");
    const guardRec = join(root, "guard-copy.mjs");
    setup(
      `import {writeFileSync as w, readFileSync as r} from "node:fs";const a=process.argv.slice(2);` +
        `w(${JSON.stringify(rec)},JSON.stringify(a));w(${JSON.stringify(guardRec)},r(a[5]));` +
        OK_CHECKER,
    );
    const base = git(origin, "rev-parse", "refs/heads/main");
    expect(run().status).toBe(0);
    const argv = JSON.parse(readFileSync(rec, "utf8"));
    expect(argv.slice(0, 5)).toEqual([base, deny, "--title-file", title, "--guard"]);
    expect(argv[5].startsWith(`${tmpHome}/exp-push.`)).toBe(true);
    expect(argv[5].endsWith("/commit-guard.mjs")).toBe(true);
    // 기준 커밋의 커밋 가드를 그대로 꺼냈다.
    expect(readFileSync(guardRec, "utf8")).toBe(REAL_GUARD);
  });
  it("기준 커밋에 커밋 가드가 없으면 막는다", () => {
    setup(OK_CHECKER, null);
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("점검 기준 커밋에서 커밋 가드를 꺼내지 못했다");
  });
  it("기준 커밋의 커밋 가드가 빈 파일이면 막는다", () => {
    setup(OK_CHECKER, "");
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("커밋 가드가 비어 있다");
  });
  it("OK 줄에 커밋 가드 표지가 없으면 막는다", () => {
    setup(`process.stdout.write("OK: 점검 통과 PR 제목\\n");\n`);
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("커밋 가드 점검 통과 OK 줄을 내지 않았다");
  });
  it("진짜 점검기·커밋 가드: 추가 줄의 키 형태를 막고 원문은 출력하지 않는다", () => {
    setup(REAL_CHECKER);
    writeFileSync(join(wt, "a.txt"), `const k = "${FAKE_KEY}";\n`);
    git(wt, "commit", "-qam", "feat: key");
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("commit-guard (시크릿·이메일·주민번호 형태): 1건");
    expect(`${r.stdout}${r.stderr}`).not.toContain(FAKE_KEY.slice(3));
  });
  it("진짜 점검기·커밋 가드: 깨끗하면 push 한다", () => {
    setup(REAL_CHECKER);
    const r = run();
    expect(r.status).toBe(0);
    expect(remoteRef()).toBe(git(wt, "rev-parse", "HEAD"));
  });
  it("I1: replace ref 로 기준 커밋을 바꿔치기해도 진짜 점검기를 쓴다", () => {
    setup(BAD);
    const base = git(origin, "rev-parse", "refs/heads/main");
    // 기준 커밋 위에 점검기만 늘 OK 로 바꾼 가짜 커밋을 만들어 replace 로 기준 커밋을 덮는다.
    const fake = join(root, "fake");
    git(root, "clone", "-q", origin, fake);
    git(fake, "config", "user.email", "t@example.com");
    git(fake, "config", "user.name", "t");
    writeFileSync(join(fake, "scripts/expansion-prepush-check.mjs"), OK_CHECKER);
    git(fake, "commit", "-qam", "init");
    const evil = git(fake, "rev-parse", "HEAD");
    git(wt, "fetch", "-q", fake, "HEAD");
    git(wt, "replace", base, evil);
    // 대조군: replace 가 걸린 채 그냥 git show 는 늘 OK 인 점검기를 꺼낸다.
    expect(git(wt, "show", `${base}:scripts/expansion-prepush-check.mjs`)).toContain("OK:");
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("노출 점검기 실패");
    expect(r.stderr).toContain("BLOCKED: 1건");
  });
  it("하위 폴더를 받아도 워크트리 최상위에서 점검기를 돌린다", () => {
    const rec = join(root, "cwd.txt");
    setup(`import {writeFileSync as w} from "node:fs";w(${JSON.stringify(rec)},process.cwd());` + OK_CHECKER);
    mkdirSync(join(wt, "sub"));
    writeFileSync(join(wt, "sub/keep.txt"), "k");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "feat: sub");
    const r = run([join(wt, "sub"), "demo-slug", title]);
    expect(r.status).toBe(0);
    expect(realpathSync(readFileSync(rec, "utf8"))).toBe(realpathSync(wt));
  });
  it("push.followTags 가 켜져 있어도 주석 태그를 올리지 않는다", () => {
    setup(OK_CHECKER);
    git(wt, "config", "push.followTags", "true");
    git(wt, "tag", "-a", "v-unchecked", "-m", "t");
    expect(run().status).toBe(0);
    expect(git(origin, "tag", "-l")).toBe("");
  });
  it("remote.origin.pushurl 이 있으면 막는다", () => {
    setup(OK_CHECKER);
    git(wt, "config", "remote.origin.pushurl", join(root, "elsewhere.git"));
    expectBlocked(run());
  });
  it("push 한 ref 는 기록한 SHA 와 같다", () => {
    setup(OK_CHECKER);
    const r = run();
    expect(remoteRef()).toBe(git(wt, "rev-parse", "HEAD"));
    expect(r.stdout).toContain(remoteRef() as string);
  });
  it("개행이 낀 slug 는 종료코드 2", () => {
    setup(OK_CHECKER);
    expect(run([wt, "demo-slug\nx", title]).status).toBe(2);
  });

  const bare = (name: string) => {
    const p = join(root, name);
    git(root, "init", "-q", "--bare", "-b", "main", p);
    return p;
  };
  const refsOf = (p: string) => git(p, "for-each-ref");
  it("원문 스크립트에는 EXPECTED_ORIGIN 환경변수 덮어쓰기가 없다", () => {
    expect(readFileSync(PUSH, "utf8")).not.toMatch(/\$\{EXPECTED_ORIGIN:-/);
  });
  it("원문 스크립트의 금지어 경로는 env 로 못 바꾸는 상수다", () => {
    const src = readFileSync(PUSH, "utf8");
    expect(src).not.toContain("EXPANSION_DENYLIST");
    expect(src.match(DENYLIST_RE)).toEqual([`readonly DENYLIST="$HOME/Projects/wag-crm/docs/private/expansion/denylist.txt"`]);
  });
  it("상속된 EXPANSION_DENYLIST 가 약한 목록을 가리켜도 상수 목록으로 점검한다", () => {
    // 진짜 점검기를 origin main 에 심는다 — 받은 금지어 파일을 실제로 읽는다.
    setup(readFileSync(resolve(__dirname, "../expansion-prepush-check.mjs"), "utf8"));
    writeFileSync(join(wt, "a.txt"), "memo zzterm here\n");
    git(wt, "commit", "-qam", "feat: memo");
    const weak = join(root, "weak.txt");
    writeFileSync(weak, "qqunrelated\n");
    const r = run(null, { EXPANSION_DENYLIST: weak });
    expectBlocked(r);
    expect(r.stderr).toContain("노출 점검기 실패");
    expect(r.stderr).toContain("added diff lines");
    expect(r.stderr).not.toContain("zzterm");
  });
  it("origin 주소가 기대값과 다르면 막는다", () => {
    setup(OK_CHECKER);
    const other = join(root, "other.git");
    git(root, "clone", "-q", "--bare", origin, other);
    git(wt, "remote", "set-url", "origin", other);
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("origin 주소가 기대값과 다름");
  });
  it("pushurl 이 실제 다른 저장소를 가리키면 막고 거기엔 아무것도 없다", () => {
    setup(OK_CHECKER);
    const real = bare("real.git");
    git(wt, "config", "remote.origin.pushurl", real);
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("pushurl");
    expect(refsOf(real)).toBe("");
  });
  it("P1: pushInsteadOf 로 push 만 다른 저장소로 돌려도 막는다", () => {
    setup(OK_CHECKER);
    const real = bare("real.git");
    git(wt, "config", `url.${real}.pushInsteadOf`, origin);
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("origin 주소가 기대값과 다름");
    expect(refsOf(real)).toBe("");
  });
  it("P2: remote.origin.url 이 둘이면 막는다", () => {
    setup(OK_CHECKER);
    const real = bare("real.git");
    git(wt, "config", "--add", "remote.origin.url", real);
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("origin 주소가 기대값과 다름");
    expect(refsOf(real)).toBe("");
  });
  it("P4: 환경변수 GIT_CONFIG_* 로 push 대상을 바꿔도 소용없다", () => {
    setup(OK_CHECKER);
    const real = bare("real.git");
    const r = run(null, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${real}.pushInsteadOf`,
      GIT_CONFIG_VALUE_0: origin,
    });
    expect(r.status).toBe(0);
    expect(refsOf(real)).toBe("");
    expect(remoteRef()).toBe(git(wt, "rev-parse", "HEAD"));
  });
  it("점검 중 원격 main 이 움직이면 막는다", () => {
    setup(
      `import {execFileSync as e} from "node:child_process";\n` +
        `const g=(...a)=>e("git",["-c","user.email=t@example.com","-c","user.name=t","--git-dir",${JSON.stringify(origin)},...a],{encoding:"utf8"}).trim();\n` +
        `const m=g("rev-parse","refs/heads/main");g("update-ref","refs/heads/main",g("commit-tree",m+"^{tree}","-p",m,"-m","x"));\n` +
        OK_CHECKER,
    );
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("원격 main 이 점검 기준과 다름");
  });
  it("push 가 거절되면 BLOCKED: git push 실패", () => {
    setup(OK_CHECKER);
    // 원격 거절은 실행파일 훅 대신 ref 충돌로 만든다(gh-stub-guard 계약): refs/heads/exp 가 파일 ref 이면
    // refs/heads/exp/<slug> 를 만들 수 없어 push 가 실패한다.
    const g = (...a: string[]) => execFileSync("git", ["--git-dir", origin, ...a], { encoding: "utf8" }).trim();
    g("update-ref", "refs/heads/exp", g("rev-parse", "refs/heads/main"));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("BLOCKED: git push 실패");
    expect(remoteRef()).toBeNull();
  });
  it("git status 가 실패하면 BLOCKED: git status 실패", () => {
    setup(OK_CHECKER);
    writeFileSync(join(wt, ".git/index"), "garbage-not-an-index");
    const r = run();
    expectBlocked(r);
    expect(r.stderr).toContain("BLOCKED: git status 실패");
  });
  it("헤더에 신뢰 경계 문구가 있다", () => {
    const head = readFileSync(PUSH, "utf8").split("\n").slice(0, 30).join("\n");
    expect(head).toContain("신뢰 경계");
    expect(head).toContain("막지 않는 것");
    expect(head).toContain("push 자격증명의 분리");
    // 범위 밖 항목은 「막지 않는 것」~「진짜 경계」 사이에 있어야 한다(PATH 는 헤더 밖에도 나와서 구간으로 좁힌다).
    const outOfScope = head.slice(head.indexOf("막지 않는 것"), head.indexOf("진짜 경계"));
    expect(outOfScope.length).toBeGreaterThan(0);
    for (const kw of ["PATH", "fsmonitor", "경합", "TLS"]) expect(outOfScope).toContain(kw);
  });
});
