import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * T-069 — GitHub 브랜치 보호 소실의 로컬 대체 방어 2문을 고정한다.
 *
 * 2026-08-26 비공개 전환으로 GitHub 무료 플랜이 rulesets/branch protection 을
 * 정지시켰다(실측: rulesets API 403 · PR #501 은 검사 시작 16분 전에 머지됨).
 * 서버가 더는 막지 않으므로 방어선이 이 맥으로 내려왔다:
 *   문① `.githooks/pre-push`  — main 직접 push(force·삭제 포함)를 push 직전 거부
 *   문② `deploy.sh` 안전장치 ⑦ — 나가는 커밋마다 원 PR 의 required 3종
 *        (guard·preflight·test) success 를 배포 직전 확인, 연결 PR 없으면 거부
 * 어느 한쪽이 조용히 빠지면 「검증 안 된 코드가 프로덕션으로」 경로가 다시 열리는데
 * 아무것도 실패하지 않아 사람이 알아차릴 계기가 없다 — 그래서 계약으로 고정한다.
 * 배경·노출 범위 실측: docs/agents/deployment.md 「Main Push Guard」.
 *
 * 🪤 **이 계약은 레포 안의 파일만 본다 — 「훅이 실제로 도는가」는 검증하지 못한다.**
 * 워크트리·메인 레포의 core.hooksPath 는 절대경로라 git 이 실행하는 것은 메인 레포
 * 작업트리의 사본이고, 그 갱신은 기계 상태(사람 몫)라 CI 러너에서 볼 수 없다.
 * 초록을 「훅이 발효했다」로 읽지 말 것 — 실제로 이 테스트 12개가 전부 통과하는
 * 상태에서 `git push <remote> HEAD:main` 이 그냥 성공한 실측이 있다(2026-08-27).
 * 발효 확인·절차는 P6 「Main Push Guard & Deploy CI Gate」 문① 항목.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(REPO_ROOT, ".githooks", "pre-push");
const DEPLOY = path.join(REPO_ROOT, "infra", "selfhost", "deploy.sh");

function runHook(stdinLine: string, env: Record<string, string> = {}) {
  const r = spawnSync("/bin/bash", [HOOK, "origin"], {
    input: `${stdinLine}\n`,
    env: { PATH: "/usr/bin:/bin", ...env },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("문① pre-push 훅 — main 직접 push 차단", () => {
  it("실행 가능한 파일로 존재한다", () => {
    const mode = statSync(HOOK).mode;
    expect(mode & 0o111, "pre-push 에 실행 비트가 없으면 git 이 조용히 무시한다").not.toBe(0);
  });

  it("main 으로의 push 를 거부한다(exit 1)", () => {
    const r = runHook("refs/heads/feat abc refs/heads/main def");
    expect(r.status).toBe(1);
    expect(r.out).toContain("차단");
  });

  it("main 삭제 push(zero sha)도 거부한다", () => {
    const zeros = "0".repeat(40);
    const r = runHook(`(delete) ${zeros} refs/heads/main def`);
    expect(r.status).toBe(1);
  });

  it("작업 브랜치 push 는 통과한다(exit 0) — 양성 프로브", () => {
    const r = runHook("refs/heads/feat abc refs/heads/claude/some-branch def");
    expect(r.status).toBe(0);
  });

  it("승격 refspec(main:release)은 통과한다 — 롤백 창구를 막으면 안 된다", () => {
    const r = runHook("refs/heads/main abc refs/heads/release def");
    expect(r.status).toBe(0);
  });

  it("ALLOW_MAIN_PUSH=1 비상 우회는 경고를 남기고 통과한다", () => {
    const r = runHook("refs/heads/feat abc refs/heads/main def", { ALLOW_MAIN_PUSH: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("ALLOW_MAIN_PUSH");
  });
});

describe("문② deploy.sh 배포 직전 CI 게이트(안전장치 ⑦)", () => {
  const src = readFileSync(DEPLOY, "utf8");

  it("게이트 블록이 존재하고 프로덕션 레인 전용이다", () => {
    const gateAt = src.indexOf("배포 직전 CI 게이트");
    expect(gateAt, "게이트 블록이 사라졌다").toBeGreaterThan(-1);
    // 게이트는 프로덕션 라벨 분기 안에 있어야 한다 — 프리뷰는 PR 없는 기능
    // 브랜치를 띄우므로 걸면 배포가 전부 죽는다.
    const gateBlock = src.slice(gateAt, src.indexOf('git checkout "$TRACK_BRANCH"', gateAt));
    expect(gateBlock).toContain('"$APP_LAUNCHD_LABEL" = "kr.ygrd.wagcrm.app"');
  });

  it("required 3종을 전부, 이름 그대로 요구한다", () => {
    // 이름 목록이 워크플로와 어긋나면 게이트가 영구 실패(또는 영구 통과)한다.
    expect(src).toContain("for GATE_NAME in guard preflight test");
    expect(src).toContain("=success");
  });

  it("연결 PR 없는 커밋(main 직접 push)을 거부한다", () => {
    expect(src).toContain("머지된 PR 로 들어온 커밋이 아닙니다");
  });

  it("우회는 SKIP_CI_GATE=1 명시뿐이고, 판정 불능은 fail-closed 다", () => {
    expect(src).toContain("SKIP_CI_GATE");
    expect(src).toContain("fail-closed");
  });

  it("나가는 커밋을 --first-parent 로 센다 — merge commit 이력에서 폭주하지 않게", () => {
    expect(src).toContain('git rev-list --first-parent "$MARKER_SHA..$LATEST"');
  });

  it("마커 판정 불가 시 상한 있는 창으로 훑고, 잘린 범위를 말한다 — 조용한 절단 금지", () => {
    // 초판은 1커밋만 봐서, 마커 유실 사이에 쌓인 커밋을 조용히 통과시켰다.
    expect(src).toContain("GATE_FALLBACK_MAX=20");
    expect(src).toContain('--max-count="$GATE_FALLBACK_MAX"');
    expect(src).toContain("미검증으로 남습니다");
    expect(src, "마커 유실만으로 배포를 영구 차단하면 SKIP_CI_GATE 가 습관이 된다")
      .not.toContain("마커가 없어 배포를 중단");
  });

  it("게이트는 체크아웃 갱신(git checkout)보다 앞에 있다", () => {
    const gateAt = src.indexOf("배포 직전 CI 게이트");
    const checkoutAt = src.indexOf('git checkout "$TRACK_BRANCH"');
    expect(checkoutAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(checkoutAt);
  });

  it("bash 문법이 성립한다(bash -n)", () => {
    const r = spawnSync("/bin/bash", ["-n", DEPLOY], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });
});
