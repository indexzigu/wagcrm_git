import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * 셀프호스트 스크립트를 「홈이 다른 두 번째 맥」에서도 그대로 돌게 하는 계약(2026-11 맥북 이관).
 *
 * 핵심 불변식은 **아이맥에서 아무것도 안 바뀐다**는 것이다:
 *   ① 레포의 plist 6개·crontab 은 그대로 아이맥 정본이고, 렌더러에 아이맥 값
 *      (홈 /Users/z9 · cloudflared /usr/local/bin)을 주면 **바이트 동일**하게 나온다.
 *   ② 새 맥 도구 후보(~/opt)는 기존 후보 **뒤**에, 디렉터리가 **있을 때만** 붙는다 —
 *      ~/opt 가 없는 아이맥의 PATH 문자열은 그대로다.
 *   ③ 설치 지점(preview.sh 의 plist, cutover.sh·rollback.sh 의 crontab)은 렌더러를 거치되,
 *      아이맥에서는 종전과 같은 내용을 설치한다.
 */
const REPO = path.resolve(__dirname, "..", "..");
const INFRA = path.join(REPO, "infra", "selfhost");
const RENDER = path.join(INFRA, "render-host-files.sh");
const PLISTS = [
  "kr.ygrd.wagcrm.app.plist",
  "kr.ygrd.wagcrm.agent-worker.plist",
  "kr.ygrd.wagcrm.backup.plist",
  "kr.ygrd.wagcrm.backup-weekly.plist",
  "kr.ygrd.wagcrm.tunnel.plist",
  "kr.ygrd.wagcrm.preview.plist",
];
const HOST_FILES = ["crontab", ...PLISTS.map((p) => path.join("launchd", p))];
const OPT_LOOP = "for _host_opt_dir in node/bin rclone jq cloudflared gh/bin; do";

const tmpRoots: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "selfhost-portability-"));
  tmpRoots.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpRoots) execFileSync("rm", ["-rf", d]);
});

const render = (env: Record<string, string>, args: string[]) =>
  spawnSync("bash", [RENDER, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: os.tmpdir(), ...env },
    encoding: "utf8",
  });

const renderOut = (home: string, cloudflared: string): string => {
  const out = path.join(tmp(), "out");
  const r = render({ HOME: home, RENDER_HOME: home, CLOUDFLARED_BIN: cloudflared }, ["--out", out]);
  expect(r.status, r.stderr).toBe(0);
  return out;
};

const activeCronLines = (src: string): string[] => src.split("\n").filter((l) => /^[0-9*]/.test(l));

/** 주석 줄(# 로 시작)을 걷어낸 본문 — 주석이 경고 문구로 자기 자신을 위반으로 잡지 않게. */
const codeOnly = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

describe("render-host-files.sh — 아이맥 값이면 원본과 바이트 동일", () => {
  it.each(HOST_FILES)("%s", (rel) => {
    const out = renderOut("/Users/z9", "/usr/local/bin/cloudflared");
    expect(readFileSync(path.join(out, rel)).equals(readFileSync(path.join(INFRA, rel)))).toBe(true);
  });

  it("--file 모드도 같은 결과를 낸다(설치 지점이 쓰는 모드)", () => {
    for (const rel of HOST_FILES) {
      const r = render(
        { HOME: "/Users/z9", RENDER_HOME: "/Users/z9", CLOUDFLARED_BIN: "/usr/local/bin/cloudflared" },
        ["--file", path.join(INFRA, rel)],
      );
      expect(r.status, `${rel}: ${r.stderr}`).toBe(0);
      expect(r.stdout, rel).toBe(readFileSync(path.join(INFRA, rel), "utf8"));
    }
  });
});

describe("render-host-files.sh — 두 번째 맥(홈 /Users/z9ro, 도구 ~/opt)", () => {
  const HOME2 = "/Users/z9ro";
  const CF2 = "/Users/z9ro/opt/cloudflared/cloudflared";

  it("원본 홈 경로가 하나도 남지 않고, 바뀐 것은 홈 접두와 cloudflared 뿐이다", () => {
    const out = renderOut(HOME2, CF2);
    for (const rel of HOST_FILES) {
      const src = readFileSync(path.join(INFRA, rel), "utf8");
      const got = readFileSync(path.join(out, rel), "utf8");
      expect(got, rel).not.toContain("/Users/z9/");
      const expected = src
        .split("<string>/usr/local/bin/cloudflared</string>")
        .join(rel.endsWith("tunnel.plist") ? `<string>${CF2}</string>` : "<string>/usr/local/bin/cloudflared</string>")
        .split("/Users/z9/")
        .join(`${HOME2}/`);
      expect(got, rel).toBe(expected);
    }
  });

  it("tunnel plist 는 새 맥의 cloudflared 와 그 홈의 터널 설정을 가리킨다", () => {
    const got = readFileSync(path.join(renderOut(HOME2, CF2), "launchd", "kr.ygrd.wagcrm.tunnel.plist"), "utf8");
    expect(got).toContain(`<string>${CF2}</string>`);
    expect(got).toContain(`<string>${HOME2}/.cloudflared/config.yml</string>`);
    expect(got).not.toContain("/usr/local/bin/cloudflared");
  });

  it("crontab 활성 줄 수가 같고, 활성 줄은 전부 새 홈의 운영 체크아웃을 부른다", () => {
    const src = activeCronLines(readFileSync(path.join(INFRA, "crontab"), "utf8"));
    const got = activeCronLines(readFileSync(path.join(renderOut(HOME2, CF2), "crontab"), "utf8"));
    expect(got).toHaveLength(src.length);
    expect(got.length).toBeGreaterThan(0);
    for (const line of got) expect(line).toContain(` ${HOME2}/selfhost/wagcrm/infra/selfhost/`);
  });

  it("이미 렌더된 파일을 다시 넣어도 두 번 바뀌지 않는다(/Users/z9ro 는 /Users/z9/ 와 매치 안 됨)", () => {
    const out = renderOut(HOME2, CF2);
    const r = render({ HOME: HOME2, RENDER_HOME: HOME2, CLOUDFLARED_BIN: CF2 }, ["--file", path.join(out, "crontab")]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFileSync(path.join(out, "crontab"), "utf8"));
  });
});

describe("render-host-files.sh — 거부 경로", () => {
  it("--out 이 레포 체크아웃 안이면 폴더를 만들기 전에 거부한다", () => {
    const target = path.join(INFRA, `render-probe-${process.pid}`);
    const r = render({ HOME: "/Users/z9", CLOUDFLARED_BIN: "/usr/local/bin/cloudflared" }, ["--out", target]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("레포 체크아웃 안");
    expect(existsSync(target)).toBe(false);
  });

  it.each(["relative/home", "/Users/a#b", "/Users/a b", "/Users/a&b"])("RENDER_HOME=%s 는 거부한다", (bad) => {
    const r = render({ HOME: "/Users/z9", RENDER_HOME: bad }, ["--file", path.join(INFRA, "crontab")]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  it("--out 이 '..' 나 심볼릭 링크로 레포 안을 우회해 가리켜도 폴더를 만들기 전에 거부한다", () => {
    const viaDots = path.join(os.tmpdir(), path.relative(os.tmpdir(), path.join(INFRA, `render-probe-dots-${process.pid}`)));
    const r1 = render({ HOME: "/Users/z9", CLOUDFLARED_BIN: "/usr/local/bin/cloudflared" }, ["--out", `${os.tmpdir()}/../..${viaDots}`]);
    expect(r1.status).not.toBe(0);
    const link = path.join(tmp(), "into-repo");
    execFileSync("ln", ["-s", INFRA, link]);
    const r2 = render({ HOME: "/Users/z9", CLOUDFLARED_BIN: "/usr/local/bin/cloudflared" }, ["--out", path.join(link, `render-probe-link-${process.pid}`)]);
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain("심볼릭 링크");
    expect(readdirSync(INFRA).filter((f) => f.startsWith("render-probe"))).toEqual([]);
  });

  it("CLOUDFLARED_BIN 에 허용 밖 문자가 있으면 tunnel 렌더를 거부한다", () => {
    const r = render({ HOME: "/Users/z9", CLOUDFLARED_BIN: "/opt/cf#x" }, [
      "--file",
      path.join(INFRA, "launchd", "kr.ygrd.wagcrm.tunnel.plist"),
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("하드코딩 홈 제거", () => {
  const scripts = readdirSync(INFRA).filter((f) => f.endsWith(".sh"));

  it("셸 스크립트 본문(주석 제외)에 /Users/z9 리터럴이 없다 — 렌더러의 원본 접두 상수만 예외", () => {
    expect(scripts.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of scripts) {
      for (const line of codeOnly(readFileSync(path.join(INFRA, f), "utf8")).split("\n")) {
        if (!line.includes("/Users/z9")) continue;
        if (f === "render-host-files.sh" && line.trim() === 'SOURCE_HOME_PREFIX="/Users/z9/"') continue;
        offenders.push(`${f}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each([
    ["backup.sh", 'R2_CREDS_FILE="$HOME/selfhost/r2-credentials.txt"'],
    ["backup.sh", 'LOG_DIR="$HOME/selfhost/logs"'],
    ["backup-weekly.sh", 'LOG_DIR="$HOME/selfhost/logs"'],
    ["restore-drill.sh", 'R2_CREDS_FILE="$HOME/selfhost/r2-credentials.txt"'],
    ["restore-drill.sh", 'LOG_FILE="$HOME/selfhost/logs/restore-drill.log"'],
    ["cutover.sh", 'R2_CREDS_FILE="$HOME/selfhost/r2-credentials.txt"'],
  ])("%s: %s", (f, line) => {
    expect(readFileSync(path.join(INFRA, f), "utf8").split("\n")).toContain(line);
  });
});

describe("~/opt 도구 후보", () => {
  const scripts = readdirSync(INFRA).filter((f) => f.endsWith(".sh"));
  const pathSetters = scripts.filter((f) =>
    /(export PATH=|PATH_CANDIDATES=).*\/opt\/homebrew\/bin/.test(codeOnly(readFileSync(path.join(INFRA, f), "utf8"))),
  );

  it("Homebrew 후보를 가진 스크립트 전부와 deploy.sh 가 같은 ~/opt 후보 줄을 갖는다", () => {
    expect(pathSetters).toEqual(
      expect.arrayContaining(["run-app.sh", "run-agent-worker.sh", "backup.sh", "backup-weekly.sh", "restore-drill.sh", "cutover.sh"]),
    );
    for (const f of [...pathSetters, "deploy.sh"]) {
      const src = readFileSync(path.join(INFRA, f), "utf8");
      expect(src.split("\n").filter((l) => l === OPT_LOOP), f).toHaveLength(1);
    }
  });

  it("~/opt 후보는 기존 Homebrew 후보보다 뒤에 온다(아이맥 해석 순서 불변)", () => {
    for (const f of pathSetters) {
      const src = readFileSync(path.join(INFRA, f), "utf8");
      if (/^PATH_CANDIDATES=/m.test(src)) {
        // 후보 목록형(cutover·preview-db): 미리 계산한 ~/opt 후보를 기본 목록 **끝**에 붙인다.
        expect(src, f).toMatch(/^PATH_CANDIDATES="\$\{[A-Z_]+:-\/usr\/local\/bin:\/opt\/homebrew\/bin:[^}]*\$HOST_OPT_CANDIDATES\}"$/m);
        continue;
      }
      const lines = src.split("\n");
      const brew = lines.findIndex((l) => !/^\s*#/.test(l) && /\/opt\/homebrew\/bin/.test(l) && /PATH/.test(l));
      const opt = lines.indexOf(OPT_LOOP);
      expect(brew, f).toBeGreaterThanOrEqual(0);
      expect(opt, f).toBeGreaterThan(brew);
    }
  });

  it("기존 PATH 줄은 문자 그대로 남는다(run-app·run-agent-worker)", () => {
    for (const f of ["run-app.sh", "run-agent-worker.sh"]) {
      expect(readFileSync(path.join(INFRA, f), "utf8"), f).toContain('export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"\n');
    }
  });

  /** run-app.sh 에서 실제 블록 텍스트를 잘라 그대로 실행한다(재구현 프로브 금지). */
  const extractBlock = (): string => {
    const lines = readFileSync(path.join(INFRA, "run-app.sh"), "utf8").split("\n");
    const start = lines.indexOf(OPT_LOOP);
    const end = lines.indexOf("done", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return lines.slice(start, end + 1).join("\n");
  };
  const runBlock = (home: string | undefined) => {
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    if (home !== undefined) env.HOME = home;
    return execFileSync("bash", ["-euo", "pipefail", "-c", `${extractBlock()}\nprintf '%s' "$PATH"`], { env, encoding: "utf8" });
  };

  it("~/opt 가 없으면 PATH 가 한 글자도 안 바뀐다(아이맥)", () => {
    expect(runBlock(tmp())).toBe("/usr/bin:/bin");
  });

  it("HOME 이 비어 있어도 죽지 않고 아무것도 안 붙인다(set -u)", () => {
    expect(runBlock("")).toBe("/usr/bin:/bin");
  });

  it("있는 디렉터리만, 정해진 순서로 뒤에 붙는다", () => {
    const home = tmp();
    for (const d of ["opt/node/bin", "opt/jq", "opt/cloudflared", "opt/gh/bin"]) mkdirSync(path.join(home, d), { recursive: true });
    expect(runBlock(home)).toBe(
      `/usr/bin:/bin:${home}/opt/node/bin:${home}/opt/jq:${home}/opt/cloudflared:${home}/opt/gh/bin`,
    );
  });
});

describe("설치 지점은 렌더러를 거친다", () => {
  it("cutover.sh·rollback.sh 는 crontab 원본을 직접 설치하지 않는다", () => {
    for (const f of ["cutover.sh", "rollback.sh"]) {
      const code = codeOnly(readFileSync(path.join(INFRA, f), "utf8"));
      expect(code, f).not.toMatch(/crontab "\$CRONTAB_FILE"/);
      expect(code, f).toContain("if ! install_rendered_crontab; then");
    }
  });

  it("preview.sh 는 plist 를 복사하지 않고 렌더해 설치한다", () => {
    const code = codeOnly(readFileSync(path.join(INFRA, "preview.sh"), "utf8"));
    expect(code).not.toMatch(/\bcp\b[^\n]*launchd\/\$PLIST_NAME/);
    expect(code).toContain('"$PREVIEW_SELF_DIR/render-host-files.sh" --file "$PREVIEW_CHECKOUT/infra/selfhost/launchd/$PLIST_NAME" > "$PLIST_DST"');
  });

  const installFn = (f: string): string => {
    const src = readFileSync(path.join(INFRA, f), "utf8");
    const start = src.indexOf("install_rendered_crontab() {");
    expect(start, f).toBeGreaterThan(0);
    return src.slice(start, src.indexOf("\n}\n", start) + 3);
  };

  it("cutover.sh 와 rollback.sh 의 설치 함수는 같은 본문이다(아래 행위 테스트가 둘 다를 대표하도록)", () => {
    expect(installFn("cutover.sh")).toBe(installFn("rollback.sh"));
  });

  /** rollback.sh 의 실제 함수 정의를 잘라 가짜 crontab 으로 실행한다. */
  const runInstall = (crontabFile: string, home: string) => {
    const fn = installFn("rollback.sh");
    expect(fn).toContain("render-host-files.sh");
    const record = path.join(tmp(), "installed");
    // 가짜 crontab 은 실행파일이 아니라 bash 함수로 가로챈다 — 새 실행파일 생성은
    // gh-stub-guard 계약이 금지한다(macOS 첫 execve 검사 지연 → 타 테스트 타임아웃 flaky).
    const fakeCrontab = `crontab() { cat "$1" > ${JSON.stringify(record)}; }`;
    const r = spawnSync("bash", ["-euo", "pipefail", "-c", `${fakeCrontab}\n${fn}\ninstall_rendered_crontab`], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        TMPDIR: os.tmpdir(),
        REPO_ROOT: REPO,
        CRONTAB_FILE: crontabFile,
      },
      encoding: "utf8",
    });
    return { status: r.status, stderr: r.stderr, installed: existsSync(record) ? readFileSync(record, "utf8") : null };
  };

  it("아이맥(HOME=/Users/z9)에서는 레포 crontab 과 바이트 동일한 내용을 설치한다", () => {
    const crontab = path.join(INFRA, "crontab");
    const r = runInstall(crontab, "/Users/z9");
    expect(r.status, r.stderr).toBe(0);
    expect(r.installed).toBe(readFileSync(crontab, "utf8"));
  });

  it("렌더가 실패하면 crontab 을 아예 부르지 않는다(빈 crontab 설치 방지)", () => {
    const r = runInstall(path.join(tmp(), "no-such-crontab"), "/Users/z9");
    expect(r.status).not.toBe(0);
    expect(r.installed).toBeNull();
  });
});
