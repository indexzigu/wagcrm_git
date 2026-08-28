import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ghStubEnv, writeGhStub } from "./helpers/gh-stub";

/**
 * promote-prod.sh 배포 확인 폴링의 컨텍스트 선택을 고정한다.
 *
 * 이 레포는 Vercel 프로젝트 2개(wag-crm, wagcrm-demo)가 커밋 상태를 만들고,
 * release push 시 데모의 정상 자기-취소("Canceled by Ignored Build Step")가
 * updated_at 순서상 항상 먼저 온다. 컨텍스트 무필터 + head -1 이던 초기
 * 구현은 매 승격을 거짓 실패로 판정했다(PR #103 리뷰 CRITICAL 실증).
 * 여기서는 gh 를 스텁으로 갈아끼워 그 회귀를 픽스처로 재현·차단한다.
 */

const SCRIPT = path.resolve(__dirname, "..", "promote-prod.sh");

const PROD = "Vercel – wag-crm"; // en-dash — 비통합(per-project) 컨텍스트
const DEMO = "Vercel – wagcrm-demo";
const CONS = "Vercel"; // 통합(Consolidated Commit Status) 컨텍스트 — 실측 2026-07-24

function runPoll(fixtureLines: string[], attempts = 2) {
  const dir = mkdtempSync(path.join(tmpdir(), "promote-gh-stub-"));
  const fixture = path.join(dir, "fixture.tsv");
  writeFileSync(fixture, fixtureLines.join("\n") + (fixtureLines.length ? "\n" : ""));
  writeGhStub(dir, `#!/usr/bin/env bash\ncat "${fixture}"\n`);
  const result = spawnSync("bash", [SCRIPT, "--poll-only", "deadbeef"], {
    env: {
      ...process.env,
      ...ghStubEnv(dir),
      PROMOTE_POLL_INTERVAL: "0",
      PROMOTE_POLL_ATTEMPTS: String(attempts),
    },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("promote-prod.sh --poll-only", () => {
  it("데모의 정상 자기-취소가 먼저 와도 운영 완료를 성공으로 판정한다(리뷰 CRITICAL 회귀)", () => {
    const r = runPoll([
      `${DEMO}\tsuccess Canceled by Ignored Build Step`,
      `${PROD}\tsuccess Deployment has completed`,
    ]);
    expect(r.status).toBe(0);
    expect(r.output).toContain("배포 완료");
  });

  it("운영 자체가 취소되면 실패로 판정한다(#68~#72 유형)", () => {
    const r = runPoll([
      `${DEMO}\tsuccess Canceled by Ignored Build Step`,
      `${PROD}\tsuccess Canceled by Ignored Build Step`,
    ]);
    expect(r.status).toBe(1);
    expect(r.output).toContain("취소");
  });

  it("운영 빌드 실패(failure)를 실패로 판정한다", () => {
    const r = runPoll([`${PROD}\tfailure Deployment failed`]);
    expect(r.status).toBe(1);
  });

  it("데모 상태만 있으면(운영 상태 미생성) 성공으로 오판하지 않고 타임아웃한다", () => {
    const r = runPoll([`${DEMO}\tsuccess Canceled by Ignored Build Step`]);
    expect(r.status).toBe(1);
    expect(r.output).toContain("확인 실패");
  });

  it("상태가 아예 없으면 타임아웃한다(성공 가정 금지)", () => {
    const r = runPoll([]);
    expect(r.status).toBe(1);
  });

  // Consolidated Commit Status 회귀 — 통합 설정이면 context 가 단일 "Vercel" 이다.
  // #104 가 "Vercel – wag-crm" 정확 일치로 좁힌 뒤 통합 설정에서 못 맞춰 매 승격이
  // 거짓 타임아웃하던 실사고(2026-07-24 force 승격에서 발견).
  it("통합 컨텍스트('Vercel') 완료를 성공으로 판정한다", () => {
    const r = runPoll([`${CONS}\tsuccess Deployment has completed`]);
    expect(r.status).toBe(0);
    expect(r.output).toContain("배포 완료");
  });

  it("통합 컨텍스트 취소를 실패로 판정한다", () => {
    const r = runPoll([`${CONS}\tsuccess Canceled by Ignored Build Step`]);
    expect(r.status).toBe(1);
    expect(r.output).toContain("취소");
  });
});

/**
 * 배포 확인 실패 시 이슈 알림 (2026-08-02).
 *
 * 사람이 직접 돌린 승격의 폴링 타임아웃은 종전 터미널 밖으로 안 나갔다 — push 는
 * 이미 됐는데 배포 확인만 안 된 상태를 아무도 몰랐다(실사고). promote-auto.yml 의
 * `promote-failed` 라벨 관례를 재사용해 수동 승격도 같은 감시선에 걸리게 한다.
 *
 * 위 스텁(`runPoll`)은 인자와 무관하게 상태 픽스처만 cat 하므로 issue/label 호출도
 * 구분 없이 같은 파일을 받는다 — 이슈 알림 자체를 검증하려면 서브커맨드별로 분기하고
 * 호출을 로그로 남기는 별도 스텁이 필요하다.
 */
describe("promote-prod.sh --poll-only — 배포 확인 실패 시 이슈 알림", () => {
  function runPollWithIssueTracking(
    fixtureLines: string[],
    existingIssueNumber = "",
    attempts = 2,
  ) {
    const dir = mkdtempSync(path.join(tmpdir(), "promote-gh-issue-stub-"));
    const statusFixture = path.join(dir, "status.tsv");
    writeFileSync(statusFixture, fixtureLines.join("\n") + (fixtureLines.length ? "\n" : ""));
    const existingFixture = path.join(dir, "existing.txt");
    writeFileSync(existingFixture, existingIssueNumber);
    const callLog = path.join(dir, "calls.log");
    writeFileSync(callLog, "");
    writeGhStub(
      dir,
      [
        "#!/usr/bin/env bash",
        `echo "$*" >> "${callLog}"`,
        'case "$1" in',
        `  api) cat "${statusFixture}" ;;`,
        "  issue)",
        '    case "$2" in',
        `      list) cat "${existingFixture}" ;;`,
        '      create) echo "https://github.com/indexzigu/wagcrm/issues/999" ;;',
        "      comment) : ;;",
        "    esac",
        "    ;;",
        "  label) : ;;",
        "esac",
        "exit 0",
      ].join("\n"),
    );
    const result = spawnSync("bash", [SCRIPT, "--poll-only", "deadbeef"], {
      env: {
        ...process.env,
        ...ghStubEnv(dir),
        PROMOTE_POLL_INTERVAL: "0",
        PROMOTE_POLL_ATTEMPTS: String(attempts),
      },
      encoding: "utf8",
    });
    const calls = readFileSync(callLog, "utf8");
    return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
  }

  it("타임아웃 시 열린 이슈가 없으면 issue create 를 부른다", () => {
    const r = runPollWithIssueTracking([]);
    expect(r.status).toBe(1);
    expect(r.calls).toContain("issue create");
    expect(r.calls).toContain("promote-failed");
    expect(r.calls).not.toContain("issue comment");
  });

  it("열린 이슈(#42)가 있으면 새로 만들지 않고 코멘트한다 — 중복 방지", () => {
    const r = runPollWithIssueTracking([], "42");
    expect(r.status).toBe(1);
    expect(r.calls).toContain("issue comment 42");
    expect(r.calls).not.toContain("issue create");
  });

  it("운영 빌드 취소(#68~#72 유형)도 이슈를 연다", () => {
    const r = runPollWithIssueTracking([`${PROD}\tsuccess Canceled by Ignored Build Step`]);
    expect(r.status).toBe(1);
    expect(r.calls).toContain("issue create");
  });

  it("배포 성공이면 issue·label 관련 gh 호출을 전혀 하지 않는다", () => {
    const r = runPollWithIssueTracking([`${PROD}\tsuccess Deployment has completed`]);
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain("issue");
    expect(r.calls).not.toContain("label");
  });

  it("이슈 생성 자체가 실패해도(gh 권한 부족 등) 폴링 판정은 원래 실패(1) 그대로다", () => {
    // 부차 기능(알림)의 실패가 주 기능(승격 판정)의 신호를 가리면 안 된다는 게
    // 이 재발방지의 핵심 불변식이다 — api 호출만 성공, issue/label 은 전부 실패.
    const dir = mkdtempSync(path.join(tmpdir(), "promote-gh-brokengh-"));
    const statusFixture = path.join(dir, "status.tsv");
    writeFileSync(statusFixture, "");
    writeGhStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "api" ]; then',
        `  cat "${statusFixture}"`,
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
    );
    const result = spawnSync("bash", [SCRIPT, "--poll-only", "deadbeef"], {
      env: {
        ...process.env,
        ...ghStubEnv(dir),
        PROMOTE_POLL_INTERVAL: "0",
        PROMOTE_POLL_ATTEMPTS: "2",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
  });
});
