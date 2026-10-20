import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curlStubEnv, writeCurlStub } from "./helpers/gh-stub";

/**
 * `run-cron.sh` 재시도 **행위** 계약 (자가 정상화 3단계, 2026-10-21).
 *
 * 판정은 앱, 실행은 스크립트다. 앱이 응답 헤더 `X-Cron-Retry-After-Sec` 로 재시도를
 * 요청하면 스크립트는 그만큼 기다렸다가 같은 작업을 `X-Cron-Attempt: n+1` 로 다시
 * 부른다. 앱 접속 자체가 안 되면(curl 7) 2분 뒤 1회만, 시간 초과(curl 28)는 다시 부르지
 * 않는다. 앱이 헤더를 계속 줘도 스크립트 자체 상한(재시도 2회)에서 멈춘다.
 *
 * 방식은 `run-cron-logging.test.ts` 와 같다 — 임시 체크아웃 + PATH `curl` 스텁, 스크립트는
 * `bash <파일>` 로 데이터처럼 읽는다(실행파일 신설 금지, `gh-stub-guard.contract.test.ts`).
 * 스텁은 호출마다 **각본**(본문·종료코드·응답 헤더)을 따르고 받은 인자를 기록한다.
 * 대기는 `CRON_RETRY_SLEEP_CMD` 를 기록 명령으로 바꿔 실제로 기다리지 않는다.
 */
const SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "run-cron.sh");

let root = "";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "run-cron-retry-"));
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface Step {
  body: string;
  exit?: number;
  /** 응답 헤더 줄들(`-D` 파일에 쓴다). 상태줄은 스텁이 붙인다. */
  headers?: string[];
}

/**
 * 호출 순번 i(1부터)마다 `step.<i>.*` 데이터 파일을 읽는 스텁. 각본이 끝나면 마지막
 * 단계를 반복한다(무한 재시도 회귀 시 테스트가 멈추지 않고 줄 수로 드러나게).
 * 받은 인자는 `call.<i>.args` 에 한 줄씩 남긴다.
 */
const SCRIPTED_CURL = [
  "#!/usr/bin/env bash",
  'dir="$(dirname "$CURL_STUB_IMPL")"',
  'n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))',
  'echo "$n" > "$dir/count"',
  'printf "%s\\n" "$@" > "$dir/call.$n.args"',
  'i="$n"; total=$(cat "$dir/steps")',
  '[ "$i" -gt "$total" ] && i="$total"',
  'hdr=""; prev=""',
  'for a in "$@"; do [ "$prev" = "-D" ] && hdr="$a"; prev="$a"; done',
  'code=$(cat "$dir/step.$i.exit")',
  'if [ -n "$hdr" ] && [ "$code" != 7 ] && [ "$code" != 28 ]; then',
  '  { printf "HTTP/1.1 200 OK\\r\\n"; while IFS= read -r h; do printf "%s\\r\\n" "$h"; done < "$dir/step.$i.headers"; printf "\\r\\n"; } > "$hdr"',
  "fi",
  'cat "$dir/step.$i.body"',
  'exit "$code"',
  "",
].join("\n");

function runScripted(
  steps: Step[],
  env: Record<string, string> = {},
): { status: number | null; lines: string[]; calls: string[][]; sleeps: string[]; tmpLeft: string[] } {
  const selfhost = path.join(root, "checkout", "infra", "selfhost");
  mkdirSync(selfhost, { recursive: true });
  const scriptPath = path.join(selfhost, "run-cron.sh");
  writeFileSync(scriptPath, readFileSync(SCRIPT, "utf8"));
  writeFileSync(path.join(selfhost, ".env"), "CRON_SECRET=stub-value-not-a-secret\n");
  const home = path.join(root, "home");
  const stubDir = path.join(root, "stub");
  const tmp = path.join(root, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(tmp, { recursive: true });

  writeFileSync(path.join(stubDir, "steps"), String(steps.length));
  steps.forEach((s, idx) => {
    const i = idx + 1;
    writeFileSync(path.join(stubDir, `step.${i}.body`), s.body);
    writeFileSync(path.join(stubDir, `step.${i}.exit`), String(s.exit ?? 0));
    writeFileSync(path.join(stubDir, `step.${i}.headers`), (s.headers ?? []).map((h) => `${h}\n`).join(""));
  });
  writeCurlStub(stubDir, SCRIPTED_CURL);
  const sleepLog = path.join(root, "sleeps");
  // 대기 기록기 — 실행파일이 아니라 `bash <파일>` 로 읽히는 데이터 파일이다.
  // (스크립트는 훅을 따옴표 없이 펼치므로 공백으로만 쪼개진다 — 경로에 공백이 없어야 한다.)
  const sleepRecorder = path.join(stubDir, "sleep.sh");
  writeFileSync(sleepRecorder, `echo "$1" >> ${JSON.stringify(sleepLog)}\n`);

  const result = spawnSync("bash", [scriptPath, "some-job"], {
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: tmp,
      // 대기 기록: 스크립트는 `$CRON_RETRY_SLEEP_CMD <초>` 로 부른다. 실제로 기다리지 않는다.
      CRON_RETRY_SLEEP_CMD: `bash ${sleepRecorder}`,
      ...env,
      ...curlStubEnv(stubDir),
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  const log = path.join(home, "selfhost", "logs", "cron.log");
  expect(existsSync(log), `cron.log 가 없다(stderr: ${result.stderr})`).toBe(true);
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  // 스크립트가 curl 에 닿기 전에 멈추면(임시 파일 실패) 호출 기록 파일 자체가 없다.
  const countFile = path.join(stubDir, "count");
  const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8").trim()) : 0;
  const calls = Array.from({ length: count }, (_, k) =>
    readFileSync(path.join(stubDir, `call.${k + 1}.args`), "utf8").trimEnd().split("\n"),
  );
  const sleeps = existsSync(sleepLog) ? readFileSync(sleepLog, "utf8").trimEnd().split("\n") : [];
  return { status: result.status, lines, calls, sleeps, tmpLeft: readdirSync(tmp) };
}

const OK = JSON.stringify({ ok: true, processed: 3 });
const FAILED_200 = JSON.stringify({ ok: true, failed: true, failureReason: "fetch failed" });
const HTTP_500 = "curl: (22) The requested URL returned error: 500";

function attemptHeader(args: string[]): string | undefined {
  return args.find((a) => /^X-Cron-Attempt:/.test(a));
}

describe("run-cron.sh 재시도", () => {
  it("재시도 헤더가 없으면 1회 호출·1줄 — 기존 동작 그대로", () => {
    const r = runScripted([{ body: OK }]);
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/\] OK {3}some-job /);
    expect(r.sleeps).toEqual([]);
    expect(attemptHeader(r.calls[0]), "첫 회도 회차 헤더를 싣는다").toBe("X-Cron-Attempt: 1");
  });

  it("앱이 600초 뒤 재시도를 요청하면 기다렸다 2회차로 다시 부른다", () => {
    const r = runScripted([
      { body: FAILED_200, headers: ["X-Cron-Retry-After-Sec: 600"] },
      { body: OK },
    ]);
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(attemptHeader(r.calls[0])).toBe("X-Cron-Attempt: 1");
    expect(attemptHeader(r.calls[1])).toBe("X-Cron-Attempt: 2");
    expect(r.sleeps).toEqual(["600"]);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toMatch(/\] WARN some-job /);
    expect(r.lines[1]).toMatch(/\] RETRY some-job 1\/2 after 600s \(앱 판정\)$/);
    expect(r.lines[2]).toMatch(/\] OK {3}some-job /);
  });

  it("HTTP 500(curl 22)에 실린 헤더도 읽는다 — -f 실패여도 -D 파일에 헤더가 남는다", () => {
    const r = runScripted([
      { body: HTTP_500, exit: 22, headers: ["x-cron-retry-after-sec: 1800"] },
      { body: OK },
    ]);
    expect(r.calls).toHaveLength(2);
    expect(r.sleeps).toEqual(["1800"]);
    expect(r.lines[0]).toMatch(/\] FAIL some-job /);
    expect(r.lines[1]).toMatch(/RETRY some-job 1\/2 after 1800s \(앱 판정\)$/);
    expect(r.status, "최종 회차가 성공이면 종료코드 0").toBe(0);
  });

  it("최종 회차가 호출 실패면 종료코드 1 — 마지막 회차가 판정한다", () => {
    const r = runScripted([
      { body: OK.replace("3", "0"), headers: ["X-Cron-Retry-After-Sec: 600"] },
      { body: HTTP_500, exit: 22 },
    ]);
    expect(r.calls).toHaveLength(2);
    expect(r.status).toBe(1);
    expect(r.lines.at(-1)).toMatch(/\] FAIL some-job /);
  });

  it("앱이 헤더를 계속 줘도 재시도 2회(총 3회 호출)에서 멈춘다 — 스크립트 자체 상한", () => {
    const r = runScripted([{ body: HTTP_500, exit: 22, headers: ["X-Cron-Retry-After-Sec: 600"] }]);
    expect(r.calls).toHaveLength(3);
    expect(r.calls.map(attemptHeader)).toEqual([
      "X-Cron-Attempt: 1",
      "X-Cron-Attempt: 2",
      "X-Cron-Attempt: 3",
    ]);
    expect(r.sleeps).toEqual(["600", "600"]);
    expect(r.lines.filter((l) => / RETRY /.test(l))).toHaveLength(2);
    expect(r.lines.filter((l) => / FAIL /.test(l))).toHaveLength(3);
    expect(r.lines[3]).toMatch(/RETRY some-job 2\/2 after 600s/);
    expect(r.status).toBe(1);
  });

  it.each([
    ["0"],
    ["3601"],
    ["-5"],
    ["abc"],
    ["60.5"],
    [""],
  ])("헤더 값 %j 는 다시 부르지 않고 건너뛴 사실만 1줄 남긴다 — 정수 1..3600 만 받는다", (value) => {
    const r = runScripted([{ body: FAILED_200, headers: [`X-Cron-Retry-After-Sec: ${value}`] }, { body: OK }]);
    expect(r.calls).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toMatch(/\] RETRY some-job 건너뜀: 재시도 신호 값 이상 '/);
    expect(r.lines[1].endsWith(`'${value}'`)).toBe(true);
    expect(r.status, "종료코드 판정은 그대로(호출은 성공)").toBe(0);
  });

  it("이상한 재시도 신호 값이 길면 잘라서 남긴다(한 줄 불변식)", () => {
    const long = "9".repeat(100);
    const r = runScripted([{ body: FAILED_200, headers: [`X-Cron-Retry-After-Sec: ${long}`] }]);
    expect(r.calls).toHaveLength(1);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toMatch(/재시도 신호 값 이상 '9{40}…'$/);
  });

  it("응답 헤더 임시 파일을 만들지 못하면 조용히 죽지 않고 FAIL 1줄 + 종료코드 1", () => {
    const r = runScripted([{ body: OK }], { TMPDIR: path.join(root, "no-such-dir", "deeper") });
    expect(r.calls, "curl 까지 가지 않는다").toHaveLength(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] FAIL some-job 임시 파일을 만들지 못함/);
    expect(r.status).toBe(1);
  });

  it("다음 회차 전에 임시 파일을 비우지 못하면 FAIL 1줄 + 종료코드 1 — 낡은 헤더로 다시 부르지 않는다", () => {
    // 대기 훅이 그 사이 임시 파일을 디렉터리로 바꿔 둔다 → 다음 회차의 비우기가 실패한다.
    const swap = path.join(root, "swap.sh");
    writeFileSync(swap, 'for f in "$TMPDIR"/run-cron-hdr.*; do rm -f "$f"; mkdir "$f"; done\n');
    const r = runScripted(
      [{ body: FAILED_200, headers: ["X-Cron-Retry-After-Sec: 600"] }, { body: OK }],
      { CRON_RETRY_SLEEP_CMD: `bash ${swap}` },
    );
    expect(r.calls).toHaveLength(1);
    expect(r.lines.at(-1)).toMatch(/\] FAIL some-job 임시 파일을 비우지 못함/);
    expect(r.status).toBe(1);
  });

  it("앞자리 0 이 붙은 값도 10진수로 읽는다(8진수 오독 금지)", () => {
    const r = runScripted([{ body: FAILED_200, headers: ["X-Cron-Retry-After-Sec: 0090"] }, { body: OK }]);
    expect(r.sleeps).toEqual(["90"]);
  });

  it("앱 응답 없음(curl 7)이면 2분 뒤 1회만 다시 부른다 — 요청이 앱에 안 닿았으니 회차는 그대로 1", () => {
    const r = runScripted([
      { body: "curl: (7) Failed to connect to 127.0.0.1 port 3000", exit: 7 },
      { body: OK },
    ]);
    expect(r.calls).toHaveLength(2);
    expect(r.sleeps).toEqual(["120"]);
    expect(r.lines[0]).toMatch(/\] FAIL some-job /);
    expect(r.lines[1]).toMatch(/\] RETRY some-job 1\/1 after 120s \(앱 응답 없음\)$/);
    expect(r.lines[2]).toMatch(/\] OK {3}some-job /);
    expect(attemptHeader(r.calls[1]), "앱이 본 첫 회차").toBe("X-Cron-Attempt: 1");
    expect(r.status).toBe(0);
  });

  it("앱 응답 없음이 두 번이면 더 부르지 않고 종료코드 1", () => {
    const r = runScripted([{ body: "curl: (7) Failed to connect", exit: 7 }]);
    expect(r.calls).toHaveLength(2);
    expect(r.sleeps).toEqual(["120"]);
    expect(r.status).toBe(1);
  });

  it("시간 초과(curl 28)는 다시 부르지 않는다 — 앱 안에서 아직 돌고 있을 수 있다", () => {
    const r = runScripted([{ body: "curl: (28) Operation timed out", exit: 28 }, { body: OK }]);
    expect(r.calls).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
    expect(r.lines).toHaveLength(1);
    expect(r.status).toBe(1);
  });

  it("응답 헤더 임시 파일을 남기지 않는다", () => {
    const r = runScripted([
      { body: FAILED_200, headers: ["X-Cron-Retry-After-Sec: 600"] },
      { body: OK },
    ]);
    expect(r.tmpLeft).toEqual([]);
  });
});
