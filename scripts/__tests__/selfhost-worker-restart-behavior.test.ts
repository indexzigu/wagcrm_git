import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 배포는 워커도 새 코드로 다시 띄워야 한다 (실사고 2026-09-06).
 *
 * **무엇이 났나:** PR #36 이 머지·배포됐는데도 수정이 동작하지 않았다. `deploy.sh` 가
 * 앱(`$APP_LAUNCHD_LABEL`)만 `kickstart` 하고 `agent-worker` 는 건드리지 않아, 워커
 * 프로세스가 3일 전 기동분 그대로였다. 앱은 `.live/current` 릴리스를 서빙하지만 워커는
 * 체크아웃을 tsx 로 직접 읽으므로 **코드는 디스크에 있는데 메모리에는 옛 것**인 상태가
 * 된다. 배포는 성공으로 보고되고 마커도 갱신되며 파일도 제자리에 있어 **겉으로는 아무
 * 신호가 없다** — 사람이 프로세스 기동 시각을 직접 재야만 드러났다.
 *
 * **왜 행위로 고정하나:** 소스 앵커만 두면 "kickstart 를 부르긴 한다"까지만 지켜진다.
 * PID 가 안 바뀌었을 때 배포를 세우는지, 워커가 없는 기계에서 배포가 죽지 않는지,
 * 프리뷰 레인이 프로덕션 워커를 건드리지 않는지는 셋 다 "성공처럼 보이는 실패"라
 * 실행으로 재야 한다.
 *
 * 방식: `deploy.sh` 에서 해당 블록을 **원본에서 발췌해 그대로 실행**한다(손수 옮겨 적으면
 * 사본이 원본과 갈라져도 초록이 유지된다). `launchctl` 은 **셸 함수로 가린다** — 임시
 * 실행파일을 만들지 않으므로 `gh-stub-guard.contract.test.ts` 가 막는 execve 요금이 없다.
 */
const DEPLOY = path.resolve(__dirname, "..", "..", "infra", "selfhost", "deploy.sh");
const deploySrc = readFileSync(DEPLOY, "utf8");

const START_ANCHOR = 'WORKER_LAUNCHD_LABEL="kr.ygrd.wagcrm.agent-worker"';
const END_ANCHOR = "[deploy] 워커 PID 교체 확인";
const LANE_GATE = 'if [ "$APP_LAUNCHD_LABEL" = "kr.ygrd.wagcrm.app" ]; then';

/** deploy.sh 에서 워커 재기동 블록을 레인 조건문까지 포함해 발췌한다. */
function extract(): string {
  const labelAt = deploySrc.indexOf(START_ANCHOR);
  expect(labelAt, `deploy.sh 에서 워커 라벨 기본값을 찾지 못했다(계약 기준을 갱신할 것)`).toBeGreaterThan(-1);
  // 레인 조건문까지 포함해야 "프리뷰에서는 안 돈다"를 실행으로 잴 수 있다.
  const gate = deploySrc.lastIndexOf(LANE_GATE, labelAt);
  expect(gate, "워커 재기동 블록의 레인 조건문을 찾지 못했다").toBeGreaterThan(-1);
  const end = deploySrc.indexOf(END_ANCHOR, gate);
  expect(end, `끝 앵커를 찾지 못했다: ${END_ANCHOR}`).toBeGreaterThan(-1);
  const close = deploySrc.indexOf("\nfi\n", end);
  expect(close, "블록을 닫는 fi 를 찾지 못했다").toBeGreaterThan(-1);
  const block = deploySrc.slice(gate, close + 4);
  expect(block.split("\n").length, "발췌 블록이 너무 짧다(앵커가 낡았을 수 있다)").toBeGreaterThan(4);
  return block;
}

const BLOCK = extract();
const PID_BEFORE = "23305";
const PID_AFTER = "87958";

type StubMode = "swap" | "stuck" | "notloaded" | "crashloop";

let workRoot = "";
beforeAll(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), "worker-restart-"));
});
afterAll(() => {
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

/**
 * `launchctl` 을 가리는 셸 함수와, 워커 plist 를 둘 가짜 HOME 을 만든다.
 * - `notloaded`  : plist 는 있는데 `list` 가 실패한다(bootout 된 상태)
 * - `swap`       : `kickstart` 뒤 PID 가 바뀌고 그대로 유지된다(정상 재기동)
 * - `stuck`      : `kickstart` 는 성공하나 PID 가 그대로다(조용한 실패)
 * - `crashloop`  : PID 가 바뀐 뒤 또 바뀐다(기동 실패 후 KeepAlive 가 되살리는 중)
 *
 * `installPlist:false` 면 plist 자체를 두지 않는다 — 워커를 운영하지 않는 기계.
 */
function makeStub(
  name: string,
  mode: StubMode,
  { installPlist = true }: { installPlist?: boolean } = {},
): { prelude: string; calls: string; home: string } {
  const dir = path.join(workRoot, name);
  const home = path.join(dir, "home");
  mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
  if (installPlist) {
    writeFileSync(path.join(home, "Library", "LaunchAgents", "kr.ygrd.wagcrm.agent-worker.plist"), "<plist/>\n");
  }
  const calls = path.join(dir, "calls.log");
  const state = path.join(dir, "pid");
  writeFileSync(state, `${PID_BEFORE}\n`);

  const prelude = [
    `_STUB_MODE=${mode}`,
    `_STUB_CALLS=${JSON.stringify(calls)}`,
    `_STUB_STATE=${JSON.stringify(state)}`,
    "launchctl() {",
    '  echo "$*" >> "$_STUB_CALLS"',
    '  if [ "$1" = "list" ]; then',
    '    if [ "$_STUB_MODE" = notloaded ]; then return 1; fi',
    // crashloop: kickstart 뒤 조회할 때마다 PID 가 또 바뀐다.
    '    if [ "$_STUB_MODE" = crashloop ] && [ -f "$_STUB_STATE.kicked" ]; then',
    '      echo $(( $(cat "$_STUB_STATE") + 1 )) > "$_STUB_STATE"',
    "    fi",
    // 실제 `launchctl list <label>` 의 출력 모양(따옴표 친 키 = 값;)을 그대로 흉내낸다.
    '    printf \'{\\n\\t"PID" = %s;\\n}\\n\' "$(cat "$_STUB_STATE")"',
    "    return 0",
    "  fi",
    '  if [ "$1" = "kickstart" ]; then',
    `    if [ "$_STUB_MODE" = swap ]; then echo ${PID_AFTER} > "$_STUB_STATE"; fi`,
    '    if [ "$_STUB_MODE" = crashloop ]; then : > "$_STUB_STATE.kicked"; fi',
    "    return 0",
    "  fi",
    "  return 0",
    "}",
  ].join("\n");

  return { prelude, calls, home };
}

function runBlock(stub: { prelude: string; home: string }, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", `${stub.prelude}\n${BLOCK}`], {
    env: { ...process.env, HOME: stub.home, APP_LAUNCHD_LABEL: "kr.ygrd.wagcrm.app", ...env },
    encoding: "utf8",
  });
}

describe("deploy.sh — 배포는 워커도 새 코드로 다시 띄운다", () => {
  it("워커를 kickstart 하고 PID 교체를 확인한다", () => {
    const stub = makeStub("swap", "swap");
    const r = runBlock(stub);

    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const calls = readFileSync(stub.calls, "utf8");
    expect(calls).toContain("kickstart -k gui/");
    expect(calls).toContain("kr.ygrd.wagcrm.agent-worker");
    // 판정 기준은 앱 재기동과 같다 — 명령이 받아들여진 것이 아니라 PID 가 실제로 바뀐 것.
    expect(r.stdout).toContain(`${PID_BEFORE} → ${PID_AFTER}`);
  });

  it("PID 가 그대로면 배포를 세운다 — 옛 코드가 계속 도는 것을 성공으로 보고하지 않는다", () => {
    const stub = makeStub("stuck", "stuck");
    // 대기 상한만 줄여 시간 초과 경로를 그대로 탄다(기본값 40 은 아래 계약이 지킨다).
    const r = runBlock(stub, { WORKER_RESTART_WAIT_TRIES: "2" });

    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("워커 PID");
    expect(`${r.stdout}${r.stderr}`).toContain("agent-worker.err.log");
  });

  it("기동 직후 PID 가 또 바뀌면 배포를 세운다 — crash loop 를 성공으로 기록하지 않는다", () => {
    const stub = makeStub("crashloop", "crashloop");
    const r = runBlock(stub);

    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("crash loop");
  }, 30_000);

  it("워커를 운영하지 않는 기계(plist 없음)에서는 건너뛰고 배포를 계속한다", () => {
    const stub = makeStub("noplist", "swap", { installPlist: false });
    const r = runBlock(stub);

    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("건너뜀");
    expect(existsSync(stub.calls)).toBe(false);
  });

  it("설치돼 있는데 내려가 있으면 건너뛰지 않고 배포를 세운다", () => {
    // bootout 한 채 잊은 상태를 "미설치"로 오인해 지나가면, 이 가드가 없애려는
    // 무증상 상태(배포는 성공인데 워커는 안 돎)가 그대로 재현된다.
    const stub = makeStub("notloaded", "notloaded");
    const r = runBlock(stub);

    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("launchd 에 올라가 있지 않습니다");
    expect(readFileSync(stub.calls, "utf8")).not.toContain("kickstart");
  });

  it("PID 교체 대기 상한은 plist 의 ExitTimeOut 보다 길다", () => {
    // 워커는 SIGTERM 뒤 lease 정리에 ExitTimeOut 까지 쓸 수 있다. 대기 상한이 그보다
    // 짧으면 **정상 종료 중인 워커**를 "PID 안 바뀜"으로 오판해 배포를 세운다.
    // 두 값이 서로 다른 파일에 있어 한쪽만 바뀌면 조용히 어긋난다 — 여기서 묶어 둔다.
    const tries = Number(/WORKER_RESTART_WAIT_TRIES:-(\d+)/.exec(deploySrc)?.[1]);
    const plist = readFileSync(
      path.resolve(__dirname, "..", "..", "infra", "selfhost", "launchd", "kr.ygrd.wagcrm.agent-worker.plist"),
      "utf8",
    );
    const exitTimeOut = Number(/<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist)?.[1]);

    expect(tries, "deploy.sh 에서 대기 상한 기본값을 읽지 못했다").toBeGreaterThan(0);
    expect(exitTimeOut, "plist 에서 ExitTimeOut 을 읽지 못했다").toBeGreaterThan(0);
    expect(tries).toBeGreaterThan(exitTimeOut);
  });

  it("프리뷰 레인은 프로덕션 워커를 건드리지 않는다", () => {
    const stub = makeStub("preview", "swap");
    const r = runBlock(stub, { APP_LAUNCHD_LABEL: "kr.ygrd.wagcrm.preview" });

    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    // 호출 기록 파일 자체가 없어야 한다 — launchctl 이 한 번도 불리지 않았다는 뜻이다.
    expect(existsSync(stub.calls)).toBe(false);
  });
});
