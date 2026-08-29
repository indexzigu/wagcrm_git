import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curlStubBody, curlStubEnv, writeCurlStub } from "./helpers/gh-stub";

/**
 * `run-cron.sh` 로그 기록 **행위** 계약 (2026-08-29).
 *
 * ⭐ **존재 이유:** 이 래퍼가 응답을 200자에서 자르는 바람에, 스토리 수집 잡이 대상
 * 전원 실패한 날 그 사유가 정확히 그 상한에서 잘려 **원인을 특정할 수 없었다.**
 * 전문이 남아 있던 곳은 프로덕션 DB(`SystemTaskLog.details`) 하나뿐이었고 그 조회는
 * 에이전트 쪽에서 막힌다. 관측이 원인을 못 남기는 형태였다.
 *
 * 판정을 소스 앵커로 하지 않는 이유: 상한·라벨·절단 표기는 **문자열이 있는가**가 아니라
 * **돌렸을 때 무엇이 남는가**가 계약이다(같은 이유로 `selfhost-release-swap-behavior`
 * 가 발췌 실행을 택했다 — 앵커만으로는 `mv -h` 결함을 놓쳤다).
 *
 * 방식: 임시 체크아웃에 원본 스크립트를 그대로 두고 `curl` 을 PATH 스텁으로 갈아끼워
 * 실행한다. 스텁이 응답 본문과 종료코드를 정한다.
 *
 * 🪤 **실행파일을 새로 만들지 않는다** — 스크립트는 `bash <파일>` 로 데이터처럼 읽고,
 * `curl` 스텁은 `helpers/gh-stub.ts` 의 고정 래퍼를 쓴다. 임시 실행파일을 만들면 macOS
 * 첫-execve 검사(400~700ms)를 매번 물어 부하 시 5초 타임아웃으로 번진다
 * (`gh-stub-guard.contract.test.ts` 가 이 규약을 강제한다).
 */
const SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "run-cron.sh");

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "run-cron-"));
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * 임시 체크아웃을 만든다. 스크립트는 `cd "$(dirname "$0")/../.."` 후
 * `infra/selfhost/.env` 를 source 하므로 그 모양을 그대로 재현한다.
 */
function makeCheckout(): { scriptPath: string; home: string; stubDir: string } {
  const selfhost = path.join(root, "checkout", "infra", "selfhost");
  mkdirSync(selfhost, { recursive: true });
  const scriptPath = path.join(selfhost, "run-cron.sh");
  writeFileSync(scriptPath, readFileSync(SCRIPT, "utf8"));
  // 실제 시크릿을 쓰지 않는다 — 스텁 curl 은 헤더를 보지 않는다(P0).
  writeFileSync(path.join(selfhost, ".env"), "CRON_SECRET=stub-value-not-a-secret\n");
  const home = path.join(root, "home");
  const stubDir = path.join(root, "stub");
  mkdirSync(home, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  return { scriptPath, home, stubDir };
}

function runJob(
  body: string,
  { curlExit = 0, env = {} as Record<string, string> } = {},
): { status: number | null; line: string } {
  const { scriptPath, home, stubDir } = makeCheckout();
  const bodyFile = path.join(stubDir, "curl.body");
  writeFileSync(bodyFile, body);
  writeCurlStub(stubDir, curlStubBody(bodyFile, curlExit));

  const result = spawnSync("bash", [scriptPath, "some-job"], {
    env: { ...process.env, ...env, HOME: home, ...curlStubEnv(stubDir) },
    encoding: "utf8",
  });
  const log = path.join(home, "selfhost", "logs", "cron.log");
  // 스텁이 안 붙었거나 스크립트가 죽으면 로그 자체가 없다 — 빈 문자열로 뭉개면
  // "기록이 없다"가 "기록이 짧다"와 구분되지 않으므로 여기서 세운다.
  expect(existsSync(log), `cron.log 가 없다(stderr: ${result.stderr})`).toBe(true);
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  expect(lines, "실행 1회 = 한 줄").toHaveLength(1);
  return { status: result.status, line: lines[0] };
}

/** 상한 판정을 위해 길이만 키운 본문. 꼬리에 표식을 둬 절단 여부를 확인한다. */
function longBody(marker: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, ...extra, filler: "x".repeat(3000), tail: marker });
}

describe("run-cron.sh 로그 기록", () => {
  it("정상 응답은 짧게 요약한다 — cron.log 하루치 훑기가 이 상한의 목적이다", () => {
    const { status, line } = runJob(longBody("TAIL-MARKER"));
    expect(status).toBe(0);
    expect(line).toMatch(/\] OK {2}some-job /);
    expect(line, "정상 줄에 응답 전문이 실리면 안 된다").not.toContain("TAIL-MARKER");
    expect(line).toContain("자 잘림");
  });

  it("핸들러가 스스로 실패를 선언하면(2xx + failed:true) 전문을 남기고 WARN 으로 적는다", () => {
    // 2026-08-29 실사고의 모양: HTTP 는 200 인데 잡은 전원 실패였다.
    const body = JSON.stringify({
      ok: true,
      failed: true,
      failureReason: "대상 3명 전원 스토리 조회 실패(수집 0건)",
      errors: ["fetch <handle-a> 실패", "fetch <handle-b> 실패", "fetch <handle-c> 실패"],
    });
    const { status, line } = runJob(body);
    // 종료코드는 0 — 잡 성패의 SSOT 는 SystemTaskStatus 이고 이 래퍼는 기록만 한다.
    expect(status).toBe(0);
    expect(line).toMatch(/\] WARN some-job /);
    expect(line, "여기서 잘리면 이 계약의 목적이 무너진다").toContain("fetch <handle-c> 실패");
    expect(line).not.toContain("자 잘림");
  });

  it("부분 실패(비어 있지 않은 errors)도 전문을 남긴다", () => {
    const body = JSON.stringify({ ok: true, processed: 10, errors: ["seller-9 스냅샷 없음"] });
    const { line } = runJob(body);
    expect(line).toMatch(/\] WARN some-job /);
    expect(line).toContain("seller-9 스냅샷 없음");
  });

  it("0 이 아닌 *Failed 카운터도 부분 실패로 본다", () => {
    const { line } = runJob(JSON.stringify({ ok: true, handles: 3, handlesFailed: 2 }));
    expect(line).toMatch(/\] WARN some-job /);
  });

  it("집계 카운터 0 과 빈 errors 는 실패가 아니다 — 여기서 오탐이 나면 전 줄이 WARN 이 된다", () => {
    // price-monitoring · enrich-references 가 정상 응답에 담는 요약 필드 모양이다.
    const { status, line } = runJob(
      JSON.stringify({ ok: true, summary: { total: 12, failed: 0 }, errors: [] }),
    );
    expect(status).toBe(0);
    expect(line).toMatch(/\] OK {2}some-job /);
  });

  it("HTTP 실패는 FAIL + 전문 + 종료코드 1 이다", () => {
    const { status, line } = runJob("curl: (22) The requested URL returned error: 500", {
      curlExit: 22,
    });
    expect(status).toBe(1);
    expect(line).toMatch(/\] FAIL some-job /);
    expect(line).toContain("returned error: 500");
  });

  it("상한을 넘겨 자를 때는 잘린 사실과 잘린 양을 남긴다 — 조용한 절단이 이 변경의 원인이다", () => {
    const { line } = runJob(longBody("TAIL-MARKER", { errors: ["부분 실패"] }), {
      env: { CRON_LOG_DETAIL_MAX: "50" },
    });
    expect(line).toMatch(/…\[\d+자 잘림 — 전문은 SystemTaskLog\.details\]$/);
    expect(line).not.toContain("TAIL-MARKER");
  });

  it("여러 줄 응답도 한 줄로 접는다", () => {
    const { line } = runJob("curl: (7) 연결 실패\n두 번째 줄", { curlExit: 7 });
    expect(line).toContain("두 번째 줄");
  });
});
