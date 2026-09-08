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

/** 워크플로를 잡 이름 → 그 잡의 본문으로 쪼갠다(잡 헤더는 2칸, 내부 키는 4칸 이상). */
function readJobBlocks(workflow: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const headers = [...workflow.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)];
  headers.forEach((header, index) => {
    const start = header.index + header[0].length;
    const end = index + 1 < headers.length ? headers[index + 1].index : workflow.length;
    blocks.set(header[1], workflow.slice(start, end));
  });
  return blocks;
}

/**
 * 워크플로에서 잡의 `needs` 를 읽는다. 표기 세 가지(`needs: a` · `needs: [a, b]` · 블록 목록)를
 * 모두 받는다 — 표기 하나를 문자열로 못 박으면 아래 🪤 의 브리틀함이 그대로 돌아온다.
 */
function readJobNeeds(workflow: string, job: string): string[] {
  const block = readJobBlocks(workflow).get(job);
  if (!block) return [];

  const inline = /^ {4}needs:[ \t]*(.+)$/m.exec(block);
  if (inline) {
    return inline[1]
      .split("#")[0]
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  }
  const listed = /^ {4}needs:[ \t]*\n((?: {6}- .+\n)+)/m.exec(block);
  if (listed) {
    return [...listed[1].matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1].split("#")[0].trim());
  }
  return [];
}

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

  it("required 3종을 전부 요구하고, 그 이름을 **워크플로에서 파생**한다", () => {
    // 이름 목록이 워크플로와 어긋나면 게이트가 영구 실패(또는 영구 통과)한다.
    //
    // 🪤 **종전 이 단언은 `for GATE_NAME in guard preflight test` 를 문자열로 박아
    // 뒀는데, 그것이 막으려던 사고를 그대로 겪었다**(2026-08-28). 테스트를 4분할하자
    // 체크 이름이 `test (1)`…`test (4)` 가 됐고, 정확 일치로 `test` 를 찾던 게이트가
    // 그것을 영영 못 찾아 **모든 배포가 막혔다**. 문자열을 고정하면 워크플로가 바뀔 때
    // 테스트가 함께 갱신되지 않고, 오히려 올바른 수정을 되돌리라고 압박한다.
    // ⇒ 이름을 **워크플로 파일에서 읽어** 게이트가 그것을 덮는지 본다.
    const wf = readFileSync(
      path.join(process.cwd(), ".github", "workflows", "release-preflight.yml"),
      "utf8",
    );
    expect(src).toContain("=success");
    expect(src).toContain("for GATE_NAME in guard preflight");
    // `test` 를 판정한다는 사실은 구현 방식과 무관하게 남아야 한다.
    expect(src).toMatch(/startswith\("test"\)|\.name == "test"/);

    // **핵심 계약: 분할하더라도 `test` 라는 체크 이름은 유지돼야 한다.**
    // 분할은 구현 세부이고, `test` 는 소비자 셋(이 게이트·브랜치 보호·이 테스트)이
    // 의존하는 인터페이스다. 조각을 `test (N)` 으로 그대로 노출하면 그 셋이 동시에
    // 깨진다 — 2026-08-28 에 실제로 그렇게 배포가 세 번 막혔다. 조각은 다른 이름으로
    // 돌리고 집계 잡이 `test` 를 보고한다.
    const isSharded = /matrix:\s*\n\s*shard:\s*\[/.test(wf);
    if (isSharded) {
      expect(wf, "분할 잡이 `test` 라는 이름을 직접 쓰면 체크가 `test (N)` 이 된다").toMatch(
        /^ {2}test-shard:/m,
      );
      expect(wf, "조각을 모아 `test` 로 보고하는 집계 잡이 없다").toMatch(/^ {2}test:\s*$/m);
      // 🪤 **여기서도 문자열을 박지 않는다 — 위 주석의 교훈이 이 줄에 그대로 적용된다.**
      // 종전 `toContain("needs: test-shard")` 는 테스트를 돌리는 잡이 하나 늘어 `needs` 가
      // 리스트가 되는 순간(정당한 변경) 깨졌다. 지킬 불변식은 표기가 아니라
      // **"테스트를 돌리는 잡이 하나도 빠짐없이 집계 뒤에 선다"** 이다 — 빠진 잡은 required
      // 가 아니라서 빨개져도 머지·배포가 그대로 나간다(체크 이름 `test` 가 인터페이스인 것과
      // 같은 축). 새 테스트 잡을 집계에 안 물리는 것이 이 계약이 막는 회귀다.
      // 🪤 **잡을 이름(`test-*`)으로 찾지 않는다.** 이름 규약을 벗어난 새 테스트 잡은 그
      // 방식이 **아예 발견하지 못해** 루프가 조용히 통과한다(리뷰 교차검증에서 실측 —
      // `test-realpg` 를 `realpg-audit` 으로 개명하니 14건 전부 초록이었다). 스캐너가 못 보는
      // 것은 지켜지지 않는 것과 같으므로, 판정 근거를 이름이 아니라 **그 잡이 테스트를
      // 실제로 돌리는가**(테스트 명령의 존재)로 옮긴다.
      const aggregated = readJobNeeds(wf, "test");
      const testJobs = [...readJobBlocks(wf)]
        .filter(([name, body]) => name !== "test" && /npm run test:ci\b/.test(body))
        .map(([name]) => name);
      // 양성 대조군 — 스캐너가 고장 나면 목록이 비어 아래 루프가 공허하게 통과한다.
      expect(testJobs, "테스트를 돌리는 잡을 하나도 찾지 못했다(스캐너 고장)").toContain(
        "test-shard",
      );
      for (const job of testJobs) {
        expect(aggregated, `집계 잡이 \`${job}\` 결과를 기다리지 않는다`).toContain(job);
      }
      expect(
        wf,
        "집계 잡에 always() 가 없으면 조각 실패 시 아예 안 돌아 체크가 pending 으로 남는다",
      ).toContain("if: always() && github.event_name != 'push'");
    }
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
