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
    expect(line).toMatch(/\] OK {3}some-job /);
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

  it("부분 실패는 PART 로 적고 전문을 남긴다 — 알람은 아니지만 원인은 필요하다", () => {
    const body = JSON.stringify({ ok: true, processed: 10, errors: ["seller-9 스냅샷 없음"] });
    const { status, line } = runJob(body);
    expect(status).toBe(0);
    expect(line).toMatch(/\] PART some-job /);
    expect(line).toContain("seller-9 스냅샷 없음");
  });

  it("부분 실패를 WARN 으로 올리지 않는다 — 레이더가 초록인 줄을 빨강으로 적으면 거울상 어긋남이다", () => {
    // `declareStoryCaptureOutcome`(src/lib/story-capture.ts)은 **전원 실패일 때만**
    // failed:true 를 선언한다. 5명 중 2명 실패는 SystemTaskStatus 가 SUCCESS 로 적는
    // 줄이므로, cron.log 만 알람으로 적으면 습관화로 진짜 알람을 잃는다
    // (근거 주석: src/lib/system-task-status.ts «상시 노이즈까지 빨강이 되면»).
    const { line } = runJob(JSON.stringify({ ok: true, handles: 5, handlesFailed: 2, failed: false }));
    expect(line).toMatch(/\] PART some-job /);
    expect(line, "레이더 SUCCESS 인 줄이 알람 라벨을 달면 안 된다").not.toContain(" WARN ");
  });

  it("집계 카운터 0 과 빈 errors 는 실패가 아니다 — 여기서 오탐이 나면 전 줄이 WARN 이 된다", () => {
    // price-monitoring · enrich-references 가 정상 응답에 담는 요약 필드 모양이다.
    const { status, line } = runJob(
      JSON.stringify({ ok: true, summary: { total: 12, failed: 0 }, errors: [] }),
    );
    expect(status).toBe(0);
    expect(line).toMatch(/\] OK {3}some-job /);
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

  describe("절단 지점의 한글이 깨지지 않는다", () => {
    // 🪤 cron 은 `LANG` 을 물려주지 않아 `LC_CTYPE=C` 로 떨어지고, 그러면 bash 의
    // `${text:0:max}` 가 **문자가 아니라 바이트**를 센다 — 한글이 절단 경계에서
    // 깨진 바이트로 남는다(교차 검증 지적, 2026-08-29 실측). 이 잡들의 오류 메시지가
    // 한글이라 하필 원인을 읽어야 할 자리에서 깨진다.
    const KOREAN = "가나다라마바사아자차카타파하 요약 실패 사유";

    /** 깨진 바이트가 남았는지 — 유니코드 대체 문자(U+FFFD)로 판정한다. */
    function isCleanUtf8(line: string): boolean {
      return !line.includes("\uFFFD");
    }

    it("로케일이 잡히는 평상시 경로 — 상한을 **문자**로 센다", () => {
      const { line } = runJob(JSON.stringify({ ok: true, errors: [KOREAN] }), {
        env: { CRON_LOG_DETAIL_MAX: "30", LANG: "", LC_ALL: "" },
      });
      expect(isCleanUtf8(line), `깨진 바이트가 남았다: ${line}`).toBe(true);
      // ⚠️ 이 단언이 로케일 지정을 **일하게** 만든다. 폴백(불완전 시퀀스 제거)만으로도
      // 깨진 바이트는 안 남으므로, 깨짐 여부만 보면 로케일 줄이 무검증으로 남는다.
      // 접두 `{"ok":true,"errors":["` 가 22자라 30자 상한이면 한글 8자가 들어와야 한다 —
      // 바이트로 세면 그 자리에 3자도 못 담긴다.
      expect(line, "상한을 바이트로 세고 있다(로케일 지정이 죽었다)").toContain("가나다라마바사아");
    });

    it("그 로케일이 없는 호스트에서도 — 설정 실패가 조용해서 폴백이 필요하다", () => {
      // 없는 로케일을 강제해 바이트 모드로 떨어뜨린다. 폴백(끝의 불완전 시퀀스 제거)이
      // 없으면 이 테스트가 실패한다 — 즉 폴백이 죽으면 초록으로 넘어가지 않는다.
      const { line } = runJob(JSON.stringify({ ok: true, errors: [KOREAN] }), {
        env: { CRON_LOG_DETAIL_MAX: "30", CRON_LOG_LOCALE: "zz_ZZ.NOPE", LANG: "", LC_ALL: "" },
      });
      expect(isCleanUtf8(line), `깨진 바이트가 남았다: ${line}`).toBe(true);
      expect(line).toContain("자 잘림");
    });
  });
});
