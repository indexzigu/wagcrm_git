import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `preview.sh` 의 `cmd_down` **행위** 검증.
 *
 * ## 왜 소스 스캔만으로는 부족한가
 *
 * 이 파일 옆의 `preview-control.test.ts` 는 파괴적 명령이 프로덕션을 가리키지 않는지
 * **소스를 읽어** 고정한다. 그것만으로 두 번 연속 결함을 놓쳤다:
 *   - `bootout` 이 비동기라 삭제가 살아 있는 앱과 경합하던 것,
 *   - 체크아웃이 **심링크**면 문자열 가드가 통과해 rm -rf 가 프로덕션에 떨어지던 것.
 * 둘 다 소스에는 "올바른 변수"가 적혀 있었다 — 틀린 것은 **실행 결과**였다.
 *
 * ## 실기계에 닿지 않는 방법
 *
 * 1. 스크립트 끝의 디스패치(`case "${1:-}" in …`)를 잘라낸 사본을 `source` 한다 —
 *    함수 정의와 상단 가드만 로드되고 아무 명령도 실행되지 않는다.
 * 2. `launchctl`·`docker` 를 **셸 함수**로 미리 정의한다. 함수는 PATH 조회보다 우선하고
 *    `command -v` 에도 잡히므로 실데몬에 닿을 경로가 없다.
 *    ⛔ 실행파일 스텁을 만들지 않는다 — `gh-stub-guard.contract.test.ts` 가 금지한다
 *    (새 실행파일의 첫 execve 가 느려 vitest 5초 타임아웃 플레이크를 만든다).
 * 3. `HOME` 을 임시 디렉터리로 갈아끼운다. 스크립트의 모든 경로가 `$HOME` 에서
 *    유도되므로 실제 `~/selfhost` 는 이름조차 등장하지 않는다.
 */
const SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "preview.sh");
const DISPATCH_MARKER = 'case "${1:-}" in';

let workRoot: string;
let scriptUnderTest: string;

beforeAll(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), "preview-down-"));
  const raw = readFileSync(SCRIPT, "utf8");
  const idx = raw.indexOf(DISPATCH_MARKER);
  // 스캐너 고장 감지 — 디스패치 형태가 바뀌면 잘라내기가 조용히 실패해 source 가
  // 실제 명령을 실행하게 된다. 그 전에 여기서 멈춘다.
  expect(idx, "preview.sh 의 디스패치 블록을 찾지 못했다 — 잘라내기 기준을 갱신할 것").toBeGreaterThan(0);
  scriptUnderTest = path.join(workRoot, "preview-under-test.sh");
  writeFileSync(scriptUnderTest, raw.slice(0, idx));
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

type Fixture = {
  /** 프리뷰 체크아웃을 프로덕션 체크아웃으로 향하는 심링크로 만든다(사고 재현). */
  symlinkCheckout?: boolean;
  /** 체크아웃에 `.git` 을 두지 않는다. */
  withoutGit?: boolean;
  /** 체크아웃 디렉터리 자체를 만들지 않는다. */
  withoutCheckout?: boolean;
  /** 마커 자리를 디렉터리로 만든다 — `rm -f` 가 EISDIR 로 실패한다(권한 조작 없이 실패 재현). */
  markerUndeletable?: boolean;
  /** plist 자리를 디렉터리로 만든다 — `rm -f` 가 EISDIR 로 실패한다(권한 조작 없이 실패 재현). */
  plistUndeletable?: boolean;
};

function makeHome(name: string, fx: Fixture = {}): string {
  const home = path.join(workRoot, name);
  mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(path.join(home, "selfhost", "logs"), { recursive: true });

  // 프로덕션 쪽 — 어떤 경우에도 무손상이어야 한다.
  mkdirSync(path.join(home, "selfhost", "wagcrm", ".next", "server", "app"), { recursive: true });
  mkdirSync(path.join(home, "selfhost", "wagcrm", ".git"), { recursive: true });
  writeFileSync(path.join(home, "selfhost", "wagcrm", ".next", "server", "app", "page.rsc"), "PROD");
  writeFileSync(path.join(home, "selfhost", "logs", "deployed.sha"), "prodsha\n");

  const preview = path.join(home, "selfhost", "wagcrm-preview");
  if (fx.symlinkCheckout) {
    symlinkSync(path.join(home, "selfhost", "wagcrm"), preview);
  } else if (!fx.withoutCheckout) {
    mkdirSync(path.join(preview, ".next", "standalone", ".next", "server", "app"), { recursive: true });
    mkdirSync(path.join(preview, ".next", "server", "app"), { recursive: true });
    writeFileSync(path.join(preview, ".next", "server", "app", "page.rsc"), "PREVIEW-PRERENDERED");
    if (!fx.withoutGit) mkdirSync(path.join(preview, ".git"), { recursive: true });
  }

  const marker = path.join(home, "selfhost", "logs", "deployed.preview.sha");
  if (fx.markerUndeletable) mkdirSync(marker, { recursive: true });
  else writeFileSync(marker, "previewsha\n");

  const plist = path.join(home, "Library", "LaunchAgents", "kr.ygrd.wagcrm.preview.plist");
  if (fx.plistUndeletable) mkdirSync(plist, { recursive: true });
  else writeFileSync(plist, "<plist/>");
  return home;
}

type Daemon = {
  /** `launchctl list` 종료코드. 0 = 아직 로드됨, 1 = 도메인에서 빠짐(정상 down). */
  launchctlListRc?: number;
  /** `docker info` 종료코드. 0 = 데몬 도달 가능. */
  dockerInfoRc?: number;
  /** `docker inspect` 종료코드. 1 = 컨테이너 없음(정상 down). */
  dockerInspectRc?: number;
};

/** `cmd_down` 을 지정 횟수만큼 실행하고 마지막 종료코드와 출력을 돌려준다. */
function runDown(home: string, daemon: Daemon = {}, times = 1) {
  const { launchctlListRc = 1, dockerInfoRc = 0, dockerInspectRc = 1 } = daemon;
  const driver = `
set -uo pipefail
launchctl() { case "$1" in list) return ${launchctlListRc} ;; *) return 0 ;; esac; }
docker() { case "$1" in info) return ${dockerInfoRc} ;; inspect) return ${dockerInspectRc} ;; *) return 0 ;; esac; }
. "${scriptUnderTest}"
for _ in $(seq 1 ${times}); do cmd_down; done
`;
  const r = spawnSync("bash", ["-c", driver], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const at = (home: string, ...p: string[]) => path.join(home, ...p);
const PREVIEW_NEXT = ["selfhost", "wagcrm-preview", ".next"];
const PREVIEW_MARKER = ["selfhost", "logs", "deployed.preview.sha"];
const PROD_NEXT = ["selfhost", "wagcrm", ".next"];
const PROD_MARKER = ["selfhost", "logs", "deployed.sha"];
const PLIST = ["Library", "LaunchAgents", "kr.ygrd.wagcrm.preview.plist"];

/** 프로덕션 레인은 어떤 시나리오에서도 손상되지 않아야 한다. */
function expectProductionIntact(home: string) {
  expect(existsSync(at(home, ...PROD_NEXT)), "프로덕션 빌드 산출물이 사라졌다").toBe(true);
  expect(
    existsSync(at(home, "selfhost", "wagcrm", ".next", "server", "app", "page.rsc")),
    "프로덕션 프리렌더 파일이 사라졌다",
  ).toBe(true);
  expect(existsSync(at(home, ...PROD_MARKER)), "프로덕션 배포 마커가 사라졌다").toBe(true);
}

describe("preview.sh cmd_down 행위", () => {
  it("정상 정리 — 다섯을 지우고 exit 0", { timeout: 20_000 }, () => {
    const home = makeHome("normal");
    const { code, out } = runDown(home);

    expect(code, out).toBe(0);
    expect(existsSync(at(home, ...PREVIEW_NEXT))).toBe(false);
    expect(existsSync(at(home, ...PREVIEW_MARKER))).toBe(false);
    expect(existsSync(at(home, ...PLIST))).toBe(false);
    expect(out).toContain("닫힘");
    expectProductionIntact(home);
  });

  it("반복 실행이 멱등이다", { timeout: 20_000 }, () => {
    const home = makeHome("idempotent");
    const { code, out } = runDown(home, {}, 3);

    expect(code, out).toBe(0);
    expect(existsSync(at(home, ...PREVIEW_NEXT))).toBe(false);
    expectProductionIntact(home);
  });

  it("체크아웃이 없어도 exit 0 (지울 것이 없다)", { timeout: 20_000 }, () => {
    const home = makeHome("no-checkout", { withoutCheckout: true });
    const { code, out } = runDown(home);

    expect(code, out).toBe(0);
    // 마커는 체크아웃 밖에 있으므로 체크아웃 부재와 무관하게 지워져야 한다.
    expect(existsSync(at(home, ...PREVIEW_MARKER)), "체크아웃이 없다고 마커를 남기면 다음 up 이 빌드를 건너뛴다").toBe(false);
    expectProductionIntact(home);
  });

  it("`.git` 이 없으면 추측해서 지우지 않고 실패로 보고한다", { timeout: 20_000 }, () => {
    const home = makeHome("no-git", { withoutGit: true });
    const { code, out } = runDown(home);

    expect(code, out).toBe(1);
    expect(existsSync(at(home, ...PREVIEW_NEXT)), "확인되지 않은 대상을 지웠다").toBe(true);
    expect(out).toContain("git 체크아웃으로 보이지 않습니다");
    expectProductionIntact(home);
  });

  it("심링크 체크아웃이면 지우지 않는다 — 문자열 가드가 못 잡는 사고", { timeout: 20_000 }, () => {
    // ~/selfhost/wagcrm-preview → ~/selfhost/wagcrm 심링크. 문자열 가드는 같은 문자열이라
    // 통과하고 `.git` 검사도 링크를 따라가 통과한다. 물리 경로 검사가 유일한 방어선이다.
    const home = makeHome("symlinked", { symlinkCheckout: true });
    const { code, out } = runDown(home);

    expect(code, out).toBe(1);
    expect(out).toContain("심볼릭 링크");
    expectProductionIntact(home);
  });

  it("docker 데몬에 못 붙어도 파일 삭제와 진단은 끝까지 간다", { timeout: 20_000 }, () => {
    const home = makeHome("docker-down");
    const { code, out } = runDown(home, { dockerInfoRc: 1 });

    expect(code, out).toBe(1);
    expect(out).toContain("docker 데몬에 연결하지 못했습니다");
    // 컨테이너를 확인하지 못한 것과 별개로, 디스크의 사본은 지워져야 한다.
    expect(existsSync(at(home, ...PREVIEW_NEXT))).toBe(false);
    expect(existsSync(at(home, ...PREVIEW_MARKER))).toBe(false);
    expectProductionIntact(home);
  });

  it("마커 삭제가 실패해도 산출물 삭제와 최종 진단이 잘리지 않는다", { timeout: 20_000 }, () => {
    // `rm -f <디렉터리>` 는 EISDIR 로 실패한다 — 권한을 건드리지 않고 삭제 실패를
    // 재현하는 방법이다(chmod 는 gh-stub-guard 계약이 금지한다).
    // 종전에는 이 실패가 set -e 로 cmd_down 을 그 자리에서 죽여, .next 가 남고
    // 부재 확인도 경고도 전혀 출력되지 않았다.
    const home = makeHome("marker-stuck", { markerUndeletable: true });
    const { code, out } = runDown(home);

    expect(code, out).toBe(1);
    expect(existsSync(at(home, ...PREVIEW_NEXT)), "마커 삭제 실패가 산출물 삭제를 건너뛰게 했다").toBe(false);
    expect(out, "최종 상태 확인이 잘렸다").toContain("배포 마커가 아직 남아 있습니다");
    expect(out, "프로덕션 사본 경고가 출력되지 않았다").toContain("프로덕션 사본입니다");
    expectProductionIntact(home);
  });

  it("plist 삭제가 실패해도 뒤 단계(언로드 대기·산출물 삭제·최종 진단)가 잘리지 않는다", { timeout: 20_000 }, () => {
    // `rm -f <디렉터리>` 는 EISDIR 로 실패한다 — 권한을 건드리지 않고 삭제 실패를
    // 재현하는 방법이다(chmod 는 gh-stub-guard 계약이 금지한다).
    // 종전에는 `rm -f "$PLIST_DST"` 에 `|| true` 가 없어 set -e 가 여기서 cmd_down 을
    // 죽였다 — 컨테이너도 안 지워지고, 언로드 폴링도 산출물 삭제도 프로덕션 사본
    // 경고도 전혀 출력되지 않았다(오직 `rm: … Permission denied` 류만 보였다).
    const home = makeHome("plist-stuck", { plistUndeletable: true });
    const { code, out } = runDown(home);

    expect(code, out).toBe(1);
    expect(existsSync(at(home, ...PREVIEW_NEXT)), "plist 삭제 실패가 산출물 삭제를 건너뛰게 했다").toBe(false);
    expect(existsSync(at(home, ...PREVIEW_MARKER)), "plist 삭제 실패가 마커 삭제를 건너뛰게 했다").toBe(false);
    expect(out, "최종 상태 확인이 잘렸다").toContain("plist 가 지워지지 않았습니다");
    expect(out, "프로덕션 사본 경고가 출력되지 않았다").toContain("프로덕션 사본입니다");
    expectProductionIntact(home);
  });
});
