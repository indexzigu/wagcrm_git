import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * 프리뷰 레인을 위해 run-app.sh·deploy.sh 에 env 오버라이드를 추가한다. 그 과정에서
 * **프로덕션 기본값이 바뀌면 안 된다** — 오버라이드를 안 주면 오늘과 완전히 같이
 * 동작해야 한다. 기본값이 조용히 바뀌면 프로덕션이 엉뚱한 포트를 헬스체크하거나
 * 엉뚱한 launchd 서비스를 재기동한다(둘 다 "성공처럼 보이는 실패"다).
 */
const INFRA = path.resolve(__dirname, "..", "..", "infra", "selfhost");

describe("셀프호스트 프로덕션 기본값", () => {
  it("run-app.sh 의 기본 포트는 3000 이다", () => {
    const src = readFileSync(path.join(INFRA, "run-app.sh"), "utf8");
    expect(src).toMatch(/PORT="\$\{APP_PORT:-3000\}"/);
  });

  it("deploy.sh 의 기본 launchd 라벨은 프로덕션 앱이다", () => {
    const src = readFileSync(path.join(INFRA, "deploy.sh"), "utf8");
    expect(src).toMatch(/APP_LAUNCHD_LABEL:-kr\.ygrd\.wagcrm\.app/);
  });

  it("deploy.sh 의 기본 헬스체크 포트는 3000 이다", () => {
    const src = readFileSync(path.join(INFRA, "deploy.sh"), "utf8");
    expect(src).toMatch(/APP_PORT:-3000/);
  });

  it("deploy.sh 의 기본 추종 브랜치는 main 이다", () => {
    const src = readFileSync(path.join(INFRA, "deploy.sh"), "utf8");
    // 프리뷰 레인이 APP_TRACK_BRANCH 로 다른 브랜치를 띄우더라도, 오버라이드를
    // 안 준 프로덕션은 반드시 main 을 추종해야 한다 — 기본값이 조용히 바뀌면
    // 프로덕션이 엉뚱한 브랜치를 빌드한다.
    expect(src).toMatch(/TRACK_BRANCH="\$\{APP_TRACK_BRANCH:-main\}"/);
  });

  it("프리뷰 plist 는 포트 3001 과 프리뷰 체크아웃을 가리킨다", () => {
    const src = readFileSync(path.join(INFRA, "launchd", "kr.ygrd.wagcrm.preview.plist"), "utf8");
    expect(src).toContain("<string>3001</string>");
    expect(src).toContain("/Users/z9/selfhost/wagcrm-preview");
    // 프로덕션 체크아웃을 가리키면 프리뷰가 프로덕션 빌드를 실행하게 된다.
    expect(src).not.toContain("<string>/Users/z9/selfhost/wagcrm</string>");
  });

  /**
   * 배포 마커는 체크아웃 **밖**(`$(dirname "$REPO_ROOT")/logs`)에 둔다 —
   * `git reset --hard` 가 지우지 못하게 하려는 의도적 설계다. 그런데 두 체크아웃
   * (`~/selfhost/wagcrm` · `~/selfhost/wagcrm-preview`)의 부모가 **같은 `~/selfhost`**
   * 라 마커 디렉터리가 겹친다. 파일명까지 같으면 프리뷰 배포가 프로덕션 마커를
   * 덮어쓰고, 두 레인 모두 `main` 을 추종하므로 SHA 까지 같아진다 → 프로덕션
   * deploy.sh 가 "변경 없음" 으로 **조용히 종료**한다(프로덕션은 구버전을 서빙 중인데
   * 마커는 최신 — 이 스크립트가 통째로 방어하려던 바로 그 실패 모드다).
   */
  it("배포 마커 파일명이 레인마다 갈린다", () => {
    const src = readFileSync(path.join(INFRA, "deploy.sh"), "utf8");
    expect(src).toMatch(/MARKER_FILE="\$MARKER_DIR\/\$MARKER_NAME"/);
    // 프로덕션 파일명은 기존 그대로여야 한다(바뀌면 첫 배포가 전량 재빌드된다).
    expect(src).toMatch(/MARKER_NAME="deployed\.sha"/);
    // 비프로덕션 레인은 라벨에서 파생해 자동으로 갈린다 — 새 레인이 잊을 수 없게.
    expect(src).toMatch(/MARKER_NAME="deployed\.\$\{APP_LAUNCHD_LABEL##\*\.\}\.sha"/);
  });
});

/**
 * 고정 배포(DEPLOY_EXPECT_SHA) — 확장 실행기의 「배포 승인」 카드 경로. 오너가 승인한 sha 와
 * origin/main 이 다르면 체크아웃·빌드·마커 전에 75 로 멈춰야 한다(사이에 들어온 머지가 승인 없이
 * 나가는 것을 막는다). 값을 안 주면 종전 동작 그대로다.
 * 방식: deploy.sh 의 fetch~"변경 없음" 판정 직전 구간을 원본에서 발췌해 git 스텁 위에서 실행한다.
 */
describe("deploy.sh 고정 배포(DEPLOY_EXPECT_SHA)", () => {
  const src = readFileSync(path.join(INFRA, "deploy.sh"), "utf8");
  const startAnchor = 'if [ -n "${DEPLOY_EXPECT_SHA:-}" ] && ! [[';
  const endAnchor = 'if [ "$LATEST" = "$MARKER_SHA" ]';
  const start = src.indexOf(startAnchor);
  const end = src.indexOf(endAnchor);
  const LATEST = "c".repeat(40);

  function runBlock(expect?: string) {
    const script = [
      "set -euo pipefail",
      'TRACK_BRANCH=main; MARKER_FILE=/nonexistent',
      'git() { echo "git $*" >&2; if [ "$1" = rev-parse ]; then echo "' + LATEST + '"; fi; }',
      src.slice(start, end),
      'echo "PASSED $LATEST"',
    ].join("\n");
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    if (expect !== undefined) env.DEPLOY_EXPECT_SHA = expect;
    try {
      const out = execFileSync("bash", ["-c", script], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, out, err: "" };
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return { status: x.status ?? 1, out: x.stdout ?? "", err: x.stderr ?? "" };
    }
  }

  it("고정 블록은 fetch 앞(형식 검사)과 「변경 없음」 판정·체크아웃 앞에 있다", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.indexOf('git fetch origin "$TRACK_BRANCH"')).toBeGreaterThan(start);
    expect(src.indexOf("exit 75")).toBeLessThan(end);
    expect(src.indexOf('git checkout "$TRACK_BRANCH"')).toBeGreaterThan(end);
  });

  it("고정 배포면 reset 도 확인한 그 sha 로, 아니면 종전처럼 origin 참조로 한다", () => {
    expect(src).toContain('git reset --hard "${DEPLOY_EXPECT_SHA:-origin/$TRACK_BRANCH}"');
  });

  it("값이 없으면 종전과 같이 진행한다", () => {
    const r = runBlock();
    expect(r.status).toBe(0);
    expect(r.out).toContain(`PASSED ${LATEST}`);
  });

  it("origin/main 이 승인 sha 와 같으면 진행한다", () => {
    expect(runBlock(LATEST).out).toContain("PASSED");
  });

  it("origin/main 이 승인 sha 와 다르면 75 로 멈추고 그 뒤를 실행하지 않는다", () => {
    const r = runBlock("d".repeat(40));
    expect(r.status).toBe(75);
    expect(r.out).not.toContain("PASSED");
    expect(r.err).toContain("승인한 sha");
  });

  it.each(["abc", "C".repeat(40), `${"c".repeat(40)} `])("형식이 틀린 값(%j)은 git 을 부르기 전에 1 로 거부한다", (bad) => {
    const r = runBlock(bad);
    expect(r.status).toBe(1);
    expect(r.err).not.toContain("git fetch");
    expect(r.out).not.toContain("PASSED");
  });
});
