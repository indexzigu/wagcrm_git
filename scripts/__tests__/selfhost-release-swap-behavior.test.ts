import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 릴리스 교체·정리 **행위** 계약 (2026-08-29).
 *
 * 짝인 `selfhost-release-swap.contract.test.ts` 는 소스 앵커만 본다 — "필요한 줄이
 * 올바른 순서로 있는가". 그것만으로는 **실행했을 때 무슨 일이 일어나는가**를 못 잡는다.
 *
 * ⭐ **이 테스트가 존재하는 이유는 실제로 그 구멍에 빠졌기 때문이다.** 초판은 심링크를
 * `mv -f` 로 교체했는데, 대상 `current` 가 이미 디렉터리를 가리키는 심링크면 `mv` 는
 * 링크를 **따라가** tmp 를 그 디렉터리 **안으로** 옮기고 `exit 0` 을 낸다. 소스만 보면
 * 완벽했고 앵커 계약도 전부 초록이었는데, 손으로 4회 돌려보니 `current` 가 **1회차**를
 * 가리키고 있었다(= 두 번째 배포부터 영영 갱신 안 됨, 그런데 배포는 매번 성공 보고).
 * `mv -fh` 로 고쳤고, 그 회귀를 여기서 **실행으로** 고정한다.
 *
 * 방식: `deploy.sh` 의 해당 블록을 **원본에서 발췌해 그대로 실행**한다. 손수 옮겨 적으면
 * 그 사본이 원본과 갈라져도 초록이 유지된다 — 이 레포가 반복해서 밟은 결함이다.
 */
const DEPLOY = path.resolve(__dirname, "..", "..", "infra", "selfhost", "deploy.sh");
const deploySrc = readFileSync(DEPLOY, "utf8");

/** deploy.sh 에서 시작·끝 앵커 사이를 발췌한다. 못 찾으면 계약 기준이 낡은 것이므로 실패시킨다. */
function extract(startAnchor: string, endAnchor: string): string {
  const start = deploySrc.indexOf(startAnchor);
  expect(start, `deploy.sh 에서 시작 앵커를 찾지 못했다(계약 기준을 갱신할 것): ${startAnchor}`).toBeGreaterThan(-1);
  const end = deploySrc.indexOf(endAnchor, start);
  expect(end, `deploy.sh 에서 끝 앵커를 찾지 못했다(계약 기준을 갱신할 것): ${endAnchor}`).toBeGreaterThan(-1);
  const block = deploySrc.slice(start, end + endAnchor.length);
  // 스캐너 고장 감지 — 발췌가 비었거나 지나치게 짧으면 앵커가 낡은 것이다.
  expect(block.split("\n").length, `발췌 블록이 너무 짧다(앵커가 낡았을 수 있다)`).toBeGreaterThan(4);
  return block;
}

const SWAP = extract('LIVE_DIR="$REPO_ROOT/.live"', 'echo "[deploy] 릴리스 교체: .live/current → releases/$RELEASE_ID"');
const PRUNE = extract('RELEASE_KEEP="${RELEASE_KEEP:-3}"', 'done < <(cd "$LIVE_DIR/releases" 2>/dev/null && ls -1td -- */ 2>/dev/null | sed \'s#/$##\' || true)');

let workRoot = "";
beforeAll(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), "release-swap-"));
});
afterAll(() => {
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

function makeRepo(name: string): string {
  const repo = path.join(workRoot, name);
  mkdirSync(repo, { recursive: true });
  return repo;
}

/** 빌드 산출물을 만든 뒤 교체 블록을 실행한다. */
function deployOnce(repo: string, sha: string) {
  mkdirSync(path.join(repo, ".next", "standalone"), { recursive: true });
  writeFileSync(path.join(repo, ".next", "standalone", "server.js"), `server-${sha}\n`);
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", SWAP], {
    cwd: repo,
    env: { ...process.env, REPO_ROOT: repo, AFTER: sha },
    encoding: "utf8",
  });
  expect(r.status, `교체 실패: ${r.stdout}${r.stderr}`).toBe(0);
  return `${r.stdout}${r.stderr}`;
}

function prune(repo: string, keep: number) {
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", PRUNE], {
    cwd: repo,
    env: { ...process.env, LIVE_DIR: path.join(repo, ".live"), RELEASE_KEEP: String(keep) },
    encoding: "utf8",
  });
  expect(r.status, `정리 실패: ${r.stdout}${r.stderr}`).toBe(0);
  return `${r.stdout}${r.stderr}`;
}

const served = (repo: string) => readFileSync(path.join(repo, ".live", "current", "server.js"), "utf8").trim();
const target = (repo: string) => readlinkSync(path.join(repo, ".live", "current"));

describe("릴리스 교체 행위", () => {
  it("배포할 때마다 current 가 **방금 만든** 릴리스를 가리킨다", () => {
    // ⭐ 이 단언이 `mv -f` → `mv -fh` 회귀를 잡는다. `-h` 가 없으면 2회차부터 current 가
    // 1회차에 고정되므로 아래 세 번째 단언에서 터진다.
    const repo = makeRepo("sequential");
    deployOnce(repo, "aaa111");
    expect(served(repo)).toBe("server-aaa111");
    deployOnce(repo, "bbb222");
    expect(served(repo)).toBe("server-bbb222");
    deployOnce(repo, "ccc333");
    expect(served(repo)).toBe("server-ccc333");
    expect(target(repo)).toBe("releases/ccc333");
  });

  it("심링크를 따라간 잔해(current.tmp)가 릴리스 안에 남지 않는다", () => {
    // `mv` 가 링크를 따라가면 tmp 가 옛 릴리스 **안으로** 들어간다 — 그 흔적을 직접 센다.
    const repo = makeRepo("no-residue");
    deployOnce(repo, "aaa111");
    deployOnce(repo, "bbb222");
    expect(existsSync(path.join(repo, ".live", "releases", "aaa111", "current.tmp"))).toBe(false);
    expect(existsSync(path.join(repo, ".live", "current.tmp"))).toBe(false);
  });

  it("같은 SHA 로 재배포해도 **서빙 중인 릴리스를 덮어쓰지 않는다**", () => {
    // FORCE=1 재배포가 이 경로다. 덮어쓰면 살아 있는 프로세스의 파일이 사라진다 —
    // 이 스크립트가 애초에 막으려는 사고를 스스로 일으키는 것이다.
    const repo = makeRepo("same-sha");
    deployOnce(repo, "aaa111");
    deployOnce(repo, "aaa111");
    expect(existsSync(path.join(repo, ".live", "releases", "aaa111"))).toBe(true);
    expect(target(repo)).toBe("releases/aaa111-2");
    expect(served(repo)).toBe("server-aaa111");
  });

  it("빌드 트리에는 산출물이 남지 않는다 — 복사가 아니라 이동이다", () => {
    // 남으면 "어느 쪽이 서빙 중인가"가 둘로 갈리고, run-app.sh 의 폴백이 영구히
    // 성립 가능해져 무증상 열화로 바뀐다(run-app.sh 주석의 ⛔ 항목).
    const repo = makeRepo("moved-not-copied");
    deployOnce(repo, "aaa111");
    expect(existsSync(path.join(repo, ".next", "standalone"))).toBe(false);
  });
});

describe("오래된 릴리스 정리 행위", () => {
  it("최신 N개를 남기고 나머지를 지운다", () => {
    const repo = makeRepo("prune-keep");
    for (const sha of ["aaa111", "bbb222", "ccc333", "ddd444"]) deployOnce(repo, sha);
    prune(repo, 2);
    expect(existsSync(path.join(repo, ".live", "releases", "ddd444"))).toBe(true);
    expect(existsSync(path.join(repo, ".live", "releases", "ccc333"))).toBe(true);
    expect(existsSync(path.join(repo, ".live", "releases", "bbb222"))).toBe(false);
    expect(existsSync(path.join(repo, ".live", "releases", "aaa111"))).toBe(false);
    expect(served(repo)).toBe("server-ddd444");
  });

  it("**롤백 상태** — current 가 오래된 릴리스를 가리켜도 그것만은 지우지 않는다", () => {
    // 링크를 이전 릴리스로 되돌린 뒤 배포가 돌면, 보관 개수만 보고 지우면 서빙 중인
    // 트리가 사라진다. 이 경우가 정리 로직에서 유일하게 치명적인 지점이다.
    const repo = makeRepo("prune-rollback");
    for (const sha of ["aaa111", "bbb222", "ccc333", "ddd444"]) deployOnce(repo, sha);
    // `mv` 의 "대상 심링크를 따라가지 않는다" 옵션은 BSD `-h` · GNU `-T` 로 갈린다
    // (deploy.sh 의 같은 판정과 짝) — 이 테스트는 macOS 와 CI(Linux) 양쪽에서 돈다.
    spawnSync("bash", ["-euo", "pipefail", "-c",
      'if mv --version >/dev/null 2>&1; then F="-T"; else F="-h"; fi; ' +
      'ln -sfn "releases/aaa111" "$1/.live/current.tmp" && mv -f "$F" "$1/.live/current.tmp" "$1/.live/current"',
      "_", repo]);
    expect(target(repo)).toBe("releases/aaa111");
    prune(repo, 1);
    expect(existsSync(path.join(repo, ".live", "releases", "aaa111")), "서빙 중인 릴리스를 지웠다").toBe(true);
    expect(served(repo), "롤백된 릴리스를 더 이상 읽을 수 없다").toBe("server-aaa111");
  });

  it("릴리스가 보관 개수 이하면 아무것도 지우지 않는다(멱등)", () => {
    const repo = makeRepo("prune-noop");
    deployOnce(repo, "aaa111");
    const out = prune(repo, 3);
    expect(out).not.toContain("오래된 릴리스 제거");
    expect(served(repo)).toBe("server-aaa111");
  });
});
