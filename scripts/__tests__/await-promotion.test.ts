import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ghStubEnv, writeGhStub } from "./helpers/gh-stub";

/**
 * await-promotion.sh — 배포완료 자동통지의 세션측 워처.
 *
 * 계약을 고정한다:
 *  (A) 배포상태 컨텍스트 선택(--status): 데모(wagcrm-demo)의 정상 자기-취소를 운영
 *      완료로 오판하지 않는다. promote-prod.sh 와 "동일 계약"이어야 하므로(배포 레인
 *      무접촉 원칙상 공유 소스 리팩터 불가) promote-prod-poll.test.ts 와 같은 픽스처
 *      문자열을 써서 두 스크립트의 드리프트를 여기서 잡는다.
 *  (B) 실림 판정(--check): main 커밋이 "현재 배포된 release 커밋"의 조상이고 그 배포가
 *      완료됐을 때만 live. 미승격/빌드중/승격실패를 구분한다.
 *  (E) **셀프호스트 레인(기본값, 2026-08-18)**: 마커 조상 여부로 판정하고, 마커를 못
 *      읽으면 미배포가 아니라 **판정 불가(exit 5)** 다.
 *
 * ⚠️ **(A)~(D) 는 이제 `--lane vercel` 을 명시한다.** 기본 레인이 selfhost 로 바뀌었기
 * 때문이고, 그 레인은 롤백 창구 판정으로 계속 유효하다(계약 자체는 무수정).
 *
 * 🪤 **모든 실행이 `AWAIT_DEPLOY_MARKER` 를 tmp 경로로 고정한다.** 안 하면 기본값이
 * `~/selfhost/logs/deployed.sha` 라 **오너 기계에서는 실 프로덕션 마커를 읽고** CI 에서는
 * 파일이 없어, 같은 테스트가 두 환경에서 다르게 굴러간다(로컬 초록 · CI 빨강, 또는 그
 * 반대). 테스트가 실 배포 상태에 의존하는 순간 회귀 감지력이 사라진다.
 */

const SCRIPT = path.resolve(__dirname, "..", "await-promotion.sh");

// promote-prod-poll.test.ts 와 동일한 컨텍스트 문자열(드리프트 감지용).
const PROD = "Vercel – wag-crm"; // en-dash — 비통합(per-project)
const DEMO = "Vercel – wagcrm-demo";
const CONS = "Vercel"; // 통합(Consolidated Commit Status)

// ── (A) --status: gh 만 스텁(git 불필요). gh 는 --jq 를 무시하고 픽스처 TSV 를 그대로 뱉는다.
function runStatus(fixtureLines: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "await-gh-stub-"));
  const fixture = path.join(dir, "fixture.tsv");
  writeFileSync(fixture, fixtureLines.join("\n") + (fixtureLines.length ? "\n" : ""));
  writeGhStub(dir, `#!/usr/bin/env bash\ncat "${fixture}"\n`);
  const result = spawnSync("bash", [SCRIPT, "--status", "deadbeef"], {
    env: { ...process.env, ...ghStubEnv(dir) },
    encoding: "utf8",
  });
  return { status: result.status, out: `${result.stdout}`.trim() };
}

describe("await-promotion.sh --status (배포상태 컨텍스트 선택)", () => {
  it("데모 자기-취소가 먼저 와도 운영 완료를 completed 로 본다", () => {
    const r = runStatus([
      `${DEMO}\tsuccess Canceled by Ignored Build Step`,
      `${PROD}\tsuccess Deployment has completed`,
    ]);
    expect(r.out).toBe("completed");
  });

  it("운영 자체가 취소되면 canceled 로 본다(#68~#72 유형)", () => {
    const r = runStatus([
      `${DEMO}\tsuccess Canceled by Ignored Build Step`,
      `${PROD}\tsuccess Canceled by Ignored Build Step`,
    ]);
    expect(r.out).toBe("canceled");
  });

  it("운영 빌드 실패는 failure 로 본다", () => {
    const r = runStatus([`${PROD}\tfailure Deployment failed`]);
    expect(r.out).toBe("failure");
  });

  it("데모 상태만 있으면 completed 로 오판하지 않고 none 이다", () => {
    const r = runStatus([`${DEMO}\tsuccess Canceled by Ignored Build Step`]);
    expect(r.out).toBe("none");
  });

  it("상태가 아예 없으면 none 이다(성공 가정 금지)", () => {
    const r = runStatus([]);
    expect(r.out).toBe("none");
  });

  it("통합 컨텍스트('Vercel') 완료를 completed 로 본다", () => {
    const r = runStatus([`${CONS}\tsuccess Deployment has completed`]);
    expect(r.out).toBe("completed");
  });

  it("통합 컨텍스트 취소를 canceled 로 본다", () => {
    const r = runStatus([`${CONS}\tsuccess Canceled by Ignored Build Step`]);
    expect(r.out).toBe("canceled");
  });
});

// ── (B) --check: 실제 임시 git repo + per-sha gh 스텁. AWAIT_SKIP_FETCH 로 네트워크 차단.
function git(dir: string, args: string[]) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 실패: ${r.stderr}`);
  return r.stdout.trim();
}

/** 상태 픽스처를 sha 별 파일로 기록(스텁 gh 가 읽는다). tsvLines 비면 "상태 없음". */
function writeStatus(stubDir: string, sha: string, tsvLines: string[]) {
  writeFileSync(
    path.join(stubDir, `status.${sha}.tsv`),
    tsvLines.join("\n") + (tsvLines.length ? "\n" : ""),
  );
}

/**
 * main: A → B → C, release = B(=ff 방식의 과거 승격 커밋).
 * 반환: {repoDir, stubDir, sha:{A,B,C}}. 호출자가 writeStatus 로 B 배포상태를 정한 뒤
 * runCheck 를 호출한다.
 */
function setupRepo() {
  const repoDir = mkdtempSync(path.join(tmpdir(), "await-repo-"));
  const stubDir = mkdtempSync(path.join(tmpdir(), "await-ghmap-"));
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.email", "t@t.local"]);
  git(repoDir, ["config", "user.name", "t"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);
  const commit = (msg: string) => {
    writeFileSync(path.join(repoDir, "f.txt"), msg);
    git(repoDir, ["add", "f.txt"]);
    git(repoDir, ["commit", "-q", "-m", msg]);
    return git(repoDir, ["rev-parse", "HEAD"]);
  };
  const A = commit("A");
  const B = commit("B");
  const C = commit("C");
  // 정본 URL 을 가진 리모트(스크립트의 REMOTE 탐지가 찾는다) — 실제 fetch 는 SKIP.
  git(repoDir, ["remote", "add", "origin", "https://github.com/indexzigu/wagcrm_git.git"]);
  git(repoDir, ["update-ref", "refs/remotes/origin/main", C]);
  git(repoDir, ["update-ref", "refs/remotes/origin/release", B]);
  // per-sha gh 스텁: `api repos/.../commits/<sha>/status` → status.<sha>.tsv 를 뱉는다.
  writeGhStub(
    stubDir,
    `#!/usr/bin/env bash\n` +
      `for a in "$@"; do\n` +
      `  case "$a" in\n` +
      `    */commits/*/status)\n` +
      `      sha=$(printf '%s' "$a" | sed -E 's#.*/commits/([^/]+)/status#\\1#')\n` +
      `      f="${stubDir}/status.\${sha}.tsv"\n` +
      `      [ -f "$f" ] && cat "$f" || true\n` +
      `      exit 0 ;;\n` +
      `  esac\n` +
      `done\n` +
      `exit 0\n`,
  );
  return { repoDir, stubDir, sha: { A, B, C } };
}

/** 실 프로덕션 마커가 테스트에 새어들지 않게 하는 차단막(위 🪤). */
const NO_MARKER = path.join(tmpdir(), "await-no-such-marker-______.sha");
const baseEnv = (stubDir: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  ...ghStubEnv(stubDir),
  AWAIT_SKIP_FETCH: "1",
  AWAIT_DEPLOY_MARKER: NO_MARKER,
  ...extra,
});

function runCheck(repoDir: string, stubDir: string, target: string, args: string[] = ["--lane", "vercel"]) {
  const r = spawnSync("bash", [SCRIPT, "--check", target, ...args], {
    cwd: repoDir,
    env: baseEnv(stubDir),
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("await-promotion.sh --check (실림 판정)", () => {
  it("현재 배포(완료)에 편입된 커밋 → live(exit 0)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    writeStatus(stubDir, sha.B, [`${PROD}\tsuccess Deployment has completed`]);
    const r = runCheck(repoDir, stubDir, sha.B);
    expect(r.status).toBe(0);
    expect(r.out).toContain("prod 에 실렸다");
  });

  it("아직 승격 안 된 최신 main 커밋 → notpromoted(exit 3)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    writeStatus(stubDir, sha.B, [`${PROD}\tsuccess Deployment has completed`]);
    const r = runCheck(repoDir, stubDir, sha.C); // release=B 이므로 C 는 미편입
    expect(r.status).toBe(3);
    expect(r.out).toContain("미승격");
  });

  it("release 편입됐으나 배포 빌드 진행 중 → pending(exit 3)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    writeStatus(stubDir, sha.B, [`${PROD}\tpending Deploying`]);
    const r = runCheck(repoDir, stubDir, sha.B);
    expect(r.status).toBe(3);
    expect(r.out).toContain("진행 중");
  });

  it("편입된 승격이 실패/취소 → failed(exit 1)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    writeStatus(stubDir, sha.B, [`${PROD}\tsuccess Canceled by Ignored Build Step`]);
    const r = runCheck(repoDir, stubDir, sha.B);
    expect(r.status).toBe(1);
    expect(r.out).toContain("실패/취소");
  });
});

// ── (C) --watch: 배포완료 자동통지의 핵심 — pending→completed 전이 순간 종료(=세션 재소환).
describe("await-promotion.sh --watch (전이 시 발화)", () => {
  it("대기 중 배포가 완료되면 즉시 종료한다(exit 0) — 통지 발화 재현", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    // 호출 카운터 기반 전이 스텁: 처음 3콜(첫 폴링 라운드)은 pending, 이후 completed.
    // 이렇게 하면 라운드1 = 아직(대기), 라운드2 = 완료 → 워처가 '깨어나' 종료함을 증명한다.
    const counter = path.join(stubDir, "n");
    writeFileSync(counter, "0");
    writeGhStub(
      stubDir,
      `#!/usr/bin/env bash\n` +
        `for a in "$@"; do\n` +
        `  case "$a" in\n` +
        `    */commits/*/status)\n` +
        `      sha=$(printf '%s' "$a" | sed -E 's#.*/commits/([^/]+)/status#\\1#')\n` +
        `      [ "$sha" = "${sha.B}" ] || { exit 0; }\n` +
        `      n=$(cat "${counter}"); n=$((n+1)); echo "$n" > "${counter}"\n` +
        `      if [ "$n" -le 3 ]; then echo "${PROD}\tpending Deploying";\n` +
        `      else echo "${PROD}\tsuccess Deployment has completed"; fi\n` +
        `      exit 0 ;;\n` +
        `  esac\n` +
        `done\n` +
        `exit 0\n`,
    );
    const r = spawnSync("bash", [SCRIPT, "--watch", sha.B, "--lane", "vercel"], {
      cwd: repoDir,
      env: baseEnv(stubDir, {
        AWAIT_POLL_INTERVAL: "0", // 테스트 즉시 진행
        AWAIT_POLL_ATTEMPTS: "8",
      }),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("실렸다");
  });

  it("제한 시간 내 미완료면 타임아웃한다(exit 2, 성공 오판 없음)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    writeStatus(stubDir, sha.B, [`${PROD}\tpending Deploying`]); // 계속 pending
    const r = spawnSync("bash", [SCRIPT, "--watch", sha.B, "--lane", "vercel"], {
      cwd: repoDir,
      env: baseEnv(stubDir, {
        AWAIT_POLL_INTERVAL: "0",
        AWAIT_POLL_ATTEMPTS: "3",
      }),
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
  });
});

// ── (D) --await-merge: 미머지 PR 에 그대로 걸 수 있는 앞단(머지 대기 → 승격 대기).
//
// 왜 이 계약이 필요했나: `--watch --pr <NN>` 은 머지커밋 SHA 를 요구해 **미머지 PR 이면
// 즉시 exit 1** 이다. 그래서 "머지되면 배포까지 확인해줘"라는 가장 흔한 요청마다 세션이
// 임시 래퍼 스크립트를 새로 짜고 있었다(2026-07-29 하루에 세 번). 앞단을 스크립트로
// 흡수하되, 승격 판정 계약(위 A~C)은 건드리지 않는다.

/** PR 엔드포인트까지 답하는 스텁. mergedAfter 콜 수만큼 미머지로 버티다 머지된다. */
function writePrStub(
  stubDir: string,
  opts: { pr: number; sha: string; mergedAfter: number; state?: string },
) {
  const counter = path.join(stubDir, "prn");
  writeFileSync(counter, "0");
  writeGhStub(
    stubDir,
    `#!/usr/bin/env bash\n` +
      `jq=""\n` +
      `for a in "$@"; do case "$prev" in --jq) jq="$a";; esac; prev="$a"; done\n` +
      `for a in "$@"; do\n` +
      `  case "$a" in\n` +
      `    */pulls/${opts.pr})\n` +
      `      case "$jq" in\n` +
      `        .merged)\n` +
      `          n=$(cat "${counter}"); n=$((n+1)); echo "$n" > "${counter}"\n` +
      `          if [ "$n" -gt ${opts.mergedAfter} ]; then echo true; else echo false; fi ;;\n` +
      `        .state) echo "${opts.state ?? "open"}" ;;\n` +
      `        *) echo "${opts.sha}" ;;\n` +
      `      esac\n` +
      `      exit 0 ;;\n` +
      `    */commits/*/status)\n` +
      `      sha=$(printf '%s' "$a" | sed -E 's#.*/commits/([^/]+)/status#\\1#')\n` +
      `      f="${stubDir}/status.\${sha}.tsv"\n` +
      `      [ -f "$f" ] && cat "$f" || true\n` +
      `      exit 0 ;;\n` +
      `  esac\n` +
      `done\n` +
      `exit 0\n`,
  );
}

function runWatchAwaitMerge(repoDir: string, stubDir: string, pr: number, extraEnv = {}) {
  const r = spawnSync(
    "bash",
    [SCRIPT, "--watch", "--pr", String(pr), "--await-merge", "--lane", "vercel"],
    {
      cwd: repoDir,
      env: baseEnv(stubDir, {
        AWAIT_POLL_INTERVAL: "0",
        AWAIT_POLL_ATTEMPTS: "5",
        AWAIT_MERGE_ATTEMPTS: "5",
        ...extraEnv,
      }),
      encoding: "utf8",
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("await-promotion.sh --await-merge (머지 대기 앞단)", () => {
  it("미머지로 시작해도 머지되면 승격 판정으로 넘어가 실림에서 종료한다(exit 0)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    writePrStub(stubDir, { pr: 42, sha: sha.B, mergedAfter: 2 });
    writeStatus(stubDir, sha.B, [`${PROD}\tsuccess Deployment has completed`]);
    const r = runWatchAwaitMerge(repoDir, stubDir, 42);
    expect(r.status).toBe(0);
    expect(r.out).toContain("머지 확인");
    expect(r.out).toContain("실렸다");
  });

  it("머지 없이 닫힌 PR 은 무한 대기하지 않고 exit 4 로 끊는다", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    writePrStub(stubDir, { pr: 43, sha: sha.B, mergedAfter: 999, state: "closed" });
    const r = runWatchAwaitMerge(repoDir, stubDir, 43);
    expect(r.status).toBe(4);
    expect(r.out).toContain("머지되지 않고 닫혔다");
  });

  it("제한 시간 내 미머지면 타임아웃한다(exit 2, 성공 오판 없음)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    writePrStub(stubDir, { pr: 44, sha: sha.B, mergedAfter: 999 });
    const r = runWatchAwaitMerge(repoDir, stubDir, 44);
    expect(r.status).toBe(2);
    expect(r.out).toContain("머지 미확인");
  });

  it("--check 와는 섞지 않는다(1회 조회 계약 보호)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    writePrStub(stubDir, { pr: 45, sha: sha.B, mergedAfter: 0 });
    const r = spawnSync("bash", [SCRIPT, "--check", "--pr", "45", "--await-merge"], {
      cwd: repoDir,
      env: baseEnv(stubDir),
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("--watch 에서만");
  });

  it("sha 대상에는 붙일 수 없다(머지 여부를 알 수 없다)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    const r = spawnSync("bash", [SCRIPT, "--watch", sha.B, "--await-merge"], {
      cwd: repoDir,
      env: baseEnv(stubDir),
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("--pr");
  });

  it("플래그를 안 주면 기존 계약 그대로 — 미머지 PR 은 즉시 실패한다(exit 1)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    writePrStub(stubDir, { pr: 46, sha: sha.B, mergedAfter: 999 });
    const r = spawnSync("bash", [SCRIPT, "--watch", "--pr", "46"], {
      cwd: repoDir,
      env: baseEnv(stubDir),
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("머지되지 않았거나");
  });
});

// ── (E) 셀프호스트 레인 = 기본값 (2026-08-18 레인 교체) ───────────────────────
//
// 🚨 **이 블록이 고정하는 실사고:** 2026-08-13 컷오버로 프로덕션이 자체호스팅으로 옮겨간
// 뒤에도 이 스크립트는 `release` 편입 + Vercel 커밋상태로 판정하고 있었다. `release` 는
// 롤백 창구라 전진하지 않으므로 **컷오버 이후 머지분은 실제로 배포돼 있어도 영원히
// "아직 미승격"** 이었다 — 실측(2026-08-18): prod 에 있는 PR #407 에 `--check` → exit 3,
// `--watch` 는 영원히 통지하지 않음(조용한 미통지). 이 도구가 없애려던 수동 폴링이
// 그대로 돌아온 상태였고, 같은 결함이 `board:check` 에서 먼저 드러났다(#407).
//
// 판정 모델은 그 수정이 밟은 것을 재사용한다 — 마커 조상 여부 + **판정 불가는 미배포가
// 아니다**. 여기서 3(아직)과 5(모른다)를 접으면 그 원칙이 무너진다.

/** 마커 파일을 쓴다(내용은 그대로 — 형태 검증까지 테스트하기 위해 정규화하지 않는다). */
function writeMarker(stubDir: string, content: string) {
  const f = path.join(stubDir, "deployed.sha");
  writeFileSync(f, content);
  return f;
}

function runSelfhost(
  repoDir: string,
  stubDir: string,
  target: string,
  marker: string | null,
  extraArgs: string[] = [],
) {
  const r = spawnSync("bash", [SCRIPT, "--check", target, ...extraArgs], {
    cwd: repoDir,
    env: baseEnv(stubDir, marker === null ? {} : { AWAIT_DEPLOY_MARKER: marker }),
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("await-promotion.sh — 셀프호스트 레인(기본값)", () => {
  it("마커의 조상이면 live(exit 0)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    const m = writeMarker(stubDir, `${sha.C}\n`);
    const r = runSelfhost(repoDir, stubDir, sha.B, m);
    expect(r.status).toBe(0);
    expect(r.out).toContain("prod 에 실렸다");
  });

  it("마커보다 나중 커밋이면 아직 반영 안 됨(exit 3)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    const m = writeMarker(stubDir, `${sha.B}\n`);
    const r = runSelfhost(repoDir, stubDir, sha.C, m);
    expect(r.status).toBe(3);
    expect(r.out).toContain("아직 서버에 반영 안 됨");
  });

  /**
   * 🚨 회귀의 핵심 — 두 레인이 같은 커밋에 **다른 답**을 내야 한다.
   * 셀프호스트로 배포됐지만 `release` 에는 없는 커밋이 실제 프로덕션의 정상 상태다.
   * 이 단언이 깨지면 판정이 다시 은퇴한 레인으로 돌아간 것이다.
   */
  it("🚨 셀프호스트 배포 O · release 미편입 → 기본=live, vercel 레인=미승격", () => {
    const { repoDir, stubDir, sha } = setupRepo(); // release = B, main tip = C
    const m = writeMarker(stubDir, `${sha.C}\n`); // 서버는 C 를 서빙 중
    writeStatus(stubDir, sha.B, [`${PROD}\tsuccess Deployment has completed`]);

    expect(runSelfhost(repoDir, stubDir, sha.C, m).status).toBe(0); // 기본 레인
    const vercel = runSelfhost(repoDir, stubDir, sha.C, m, ["--lane", "vercel"]);
    expect(vercel.status).toBe(3); // 롤백 창구에는 정말로 없다 — 그쪽 답도 맞다
    expect(vercel.out).toContain("미승격");
  });

  it("⚠️ 마커 부재는 판정 불가(exit 5)이지 미배포(3)가 아니다", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    const r = runSelfhost(repoDir, stubDir, sha.B, path.join(stubDir, "absent.sha"));
    expect(r.status).toBe(5);
    expect(r.out).toContain("판정 불가");
    expect(r.out).toContain("미배포가 아니다");
  });

  it("⚠️ 빈 파일·비-SHA 내용도 판정 불가다 — '배포된 것이 없다'로 읽지 않는다", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    for (const content of ["", "\n", "(마커 없음)\n", "abc12\n"]) {
      const r = runSelfhost(repoDir, stubDir, sha.B, writeMarker(stubDir, content));
      expect(r.status, `내용=${JSON.stringify(content)}`).toBe(5);
    }
  });

  it("git 이 모르는 SHA 도 판정 불가다(다른 레포·fetch 범위 밖)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    const m = writeMarker(stubDir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
    const r = runSelfhost(repoDir, stubDir, sha.B, m);
    expect(r.status).toBe(5);
    expect(r.out).toContain("모른다");
  });

  it("배포가 진행되면 --watch 가 그 순간 깨어난다(exit 0)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    // 마커를 B 로 두고, 워처가 도는 동안 C 로 갱신되는 상황을 스크립트로 재현한다.
    const m = writeMarker(stubDir, `${sha.B}\n`);
    // 🪤 **실행 권한 스텁을 만들지 않는다** — macOS 첫-execve 보안 검사(400~700ms)를 매번
    // 물어 부하 시 5초 타임아웃 플레이크로 번진다(gh-stub-guard.contract.test.ts 가 고정).
    // 백그라운드 서브셸로 마커만 갈아끼운다: 파일도, chmod 도 없다.
    spawnSync("bash", ["-c", `( sleep 1; printf '%s\\n' "${sha.C}" > "${m}" ) >/dev/null 2>&1 &`], {
      cwd: repoDir,
    });
    const r = spawnSync("bash", [SCRIPT, "--watch", sha.C], {
      cwd: repoDir,
      env: baseEnv(stubDir, {
        AWAIT_DEPLOY_MARKER: m,
        AWAIT_POLL_INTERVAL: "1",
        AWAIT_POLL_ATTEMPTS: "10",
      }),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("실렸다");
  });

  /**
   * 🪤 판정 근거가 없는 워처는 **영원히 깨지 않는다** — 이 도구가 없애려던 조용한
   * 미통지 그 자체다. 기다리는 척하지 말고 즉시 끊어야 사람이 알아차린다.
   * (이 단언이 없으면 "마커 없음 → 계속 폴링"으로 되돌아가도 테스트가 초록이다.)
   */
  it("⚠️ 판정 불가면 --watch 는 매달리지 않고 즉시 중단한다(exit 5)", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    const started = Date.now();
    const r = spawnSync("bash", [SCRIPT, "--watch", sha.B], {
      cwd: repoDir,
      env: baseEnv(stubDir, {
        AWAIT_DEPLOY_MARKER: path.join(stubDir, "absent.sha"),
        AWAIT_POLL_INTERVAL: "30", // 매달리면 이 간격에 걸려 오래 걸린다
        AWAIT_POLL_ATTEMPTS: "10",
      }),
      encoding: "utf8",
    });
    expect(r.status).toBe(5);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(`${r.stdout}${r.stderr}`).toContain("영원히 깨지 않는다");
  });

  it("--lane 값이 잘못되면 조용히 기본값으로 떨어지지 않고 멈춘다", () => {
    const { repoDir, stubDir, sha } = setupRepo();
    const r = runSelfhost(repoDir, stubDir, sha.B, null, ["--lane", "bogus"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("selfhost|vercel");
  });
});
