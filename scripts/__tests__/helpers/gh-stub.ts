import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `gh` 스텁을 "테스트마다 새 실행파일"이 아니라 **내용 고정 래퍼 + 데이터 본문**으로 만든다.
 *
 * ── 왜 (2026-08-04, 선재 flaky 의 근본원인) ──────────────────────────────────
 * macOS 는 **새로 만들어진 실행파일의 첫 execve** 마다 보안 검사를 돌린다. 이 레포에서
 * 실측한 비용(Darwin 25):
 *   - 갓 만든 실행파일 첫 실행      : 400~700ms
 *   - 같은 파일 재실행(검사 캐시됨) : ~23ms
 *   - 같은 바이트를 `bash <파일>` 로 **데이터**로 읽기 : ~6ms
 *
 * 종전 스텁은 테스트마다 임시 디렉터리에 `gh` 를 새로 쓰고 `chmod +x` 했으므로 이 요금을
 * **테스트당 1~2회** 물었다(픽스처 경로를 본문에 박아 넣어 내용이 매번 달랐고, 검사는
 * 내용이 아니라 파일 단위로 캐시된다). 머신 부하가 높으면 이 검사가 늘어져 vitest 기본
 * `testTimeout`(5000ms)을 넘겼고, 그래서 `await-promotion.test.ts` ·
 * `promote-prod-poll.test.ts` 가 4회 중 1회꼴로 **매번 다른 테스트**에서 실패했다
 * (실패 건의 지속시간이 전부 5.0~5.8s 로 몰려 있던 이유).
 *
 * ── 처방 ────────────────────────────────────────────────────────────────────
 * 실제로 execve 되는 파일은 **내용이 고정된 래퍼 하나**뿐이라 머신당 사실상 1회만 검사받고
 * 이후 재사용된다. 테스트별 스텁 본문은 실행 권한 없는 데이터 파일로 두고 `GH_STUB_IMPL`
 * 환경변수로 넘긴다(피시험 스크립트가 env 를 그대로 물려주므로 `gh` 가 읽을 수 있다).
 *
 * ⚠️ 바뀌는 것은 **실행 경로뿐이고 스텁의 동작은 그대로**다 — 이 파일들이 고정하는
 * 승격·배포 판정 계약(데모 자기-취소 오판 방지 등)은 손대지 않는다.
 */

/**
 * 래퍼 본문이 바뀌면 디렉터리 이름의 버전을 올린다(구 래퍼와 섞이지 않게).
 *
 * 이 둘을 export 하는 이유: `gh-stub-guard.contract.test.ts` 가 **본문과 버전을 한 쌍으로
 * 고정**한다. 본문만 고치고 버전을 안 올리면 머신에 남은 구 래퍼가 계속 쓰여 "고쳤는데
 * 안 바뀐다"가 되므로, 그 순간 계약이 실패해 버전 승급을 강제한다.
 */
export const GH_STUB_WRAPPER_DIR_NAME = "wagcrm-gh-stub-v1";
export const GH_STUB_WRAPPER_BODY =
  '#!/usr/bin/env bash\nexec bash "$GH_STUB_IMPL" "$@"\n';

const WRAPPER_DIR = path.join(tmpdir(), GH_STUB_WRAPPER_DIR_NAME);
const WRAPPER_BODY = GH_STUB_WRAPPER_BODY;

function ensureWrapper(): string {
  const wrapper = path.join(WRAPPER_DIR, "gh");
  let current = "";
  try {
    current = readFileSync(wrapper, "utf8");
  } catch {
    // 없으면 아래에서 만든다.
  }
  if (current !== WRAPPER_BODY) {
    mkdirSync(WRAPPER_DIR, { recursive: true });
    // 원자적 교체 — vitest 는 파일별 fork 로 병렬 실행되므로 반쯤 쓰인 파일이 execve 되면 안 된다.
    const staging = path.join(WRAPPER_DIR, `gh.${process.pid}.tmp`);
    writeFileSync(staging, WRAPPER_BODY);
    chmodSync(staging, 0o755);
    renameSync(staging, wrapper);
  }
  return WRAPPER_DIR;
}

/** 스텁 본문(bash 소스)을 `dir/gh.impl` 에 둔다. 실행 권한은 주지 않는다(데이터 파일). */
export function writeGhStub(dir: string, body: string): string {
  const impl = path.join(dir, "gh.impl");
  writeFileSync(impl, body);
  return impl;
}

/**
 * `writeGhStub(dir, …)` 로 둔 스텁이 `gh` 로 잡히게 하는 env 조각.
 * spawnSync 의 env 에 펼쳐 쓴다: `env: { ...process.env, ...ghStubEnv(dir) }`.
 */
export function ghStubEnv(dir: string): { PATH: string; GH_STUB_IMPL: string } {
  return {
    PATH: `${ensureWrapper()}:${process.env.PATH}`,
    GH_STUB_IMPL: path.join(dir, "gh.impl"),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * `stat` 스텁 레인 (2026-08-21 추가)
 *
 * 왜 여기에: 위 처방("실제로 execve 되는 파일은 내용 고정 래퍼 하나")은 `gh` 만의 것이
 * 아니라 **PATH 로 잡히는 모든 스텁**에 적용된다. 새 헬퍼 파일을 만들면
 * `gh-stub-guard.contract.test.ts` 의 예외 목록을 늘려야 하는데, 그 목록은 "추가는 flaky
 * 를 되살리는 결정"이라고 경고한다 — 이미 예외인 이 파일에 얹는 편이 규약에 맞다.
 *
 * 왜 `gh` 와 래퍼를 공유하지 않는가: 래퍼 본문은 impl 경로를 담은 env 변수 이름을 박아
 * 두고 있어 명령마다 달라야 한다. 버전 디렉터리를 갈라 두면 한쪽 본문을 고쳐도 다른 쪽
 * 래퍼가 무효화되지 않는다(위 "본문↔버전 한 쌍" 함정의 격리).
 *
 * 용도: GNU coreutils 호스트를 흉내 내는 stat. BSD(macOS)와 GNU 의 `-f` 의미가 정반대라
 * macOS 에서는 GNU 분기가 **구조적으로 재현되지 않는다** — CI 에서만 터지는 결함을
 * 로컬에서 잡으려면 흉내가 필요하다(notify.sh line 127, 2026-08-21).
 */
export const STAT_STUB_WRAPPER_DIR_NAME = "wagcrm-stat-stub-v1";
export const STAT_STUB_WRAPPER_BODY =
  '#!/usr/bin/env bash\nexec bash "$STAT_STUB_IMPL" "$@"\n';

const STAT_WRAPPER_DIR = path.join(tmpdir(), STAT_STUB_WRAPPER_DIR_NAME);

function ensureStatWrapper(): string {
  const wrapper = path.join(STAT_WRAPPER_DIR, "stat");
  let current = "";
  try {
    current = readFileSync(wrapper, "utf8");
  } catch {
    // 없으면 아래에서 만든다.
  }
  if (current !== STAT_STUB_WRAPPER_BODY) {
    mkdirSync(STAT_WRAPPER_DIR, { recursive: true });
    const staging = path.join(STAT_WRAPPER_DIR, `stat.${process.pid}.tmp`);
    writeFileSync(staging, STAT_STUB_WRAPPER_BODY);
    chmodSync(staging, 0o755);
    renameSync(staging, wrapper);
  }
  return STAT_WRAPPER_DIR;
}

/**
 * GNU coreutils `stat` 흉내 본문. 실행 권한 없는 데이터 파일이다.
 *
 * 재현 대상 두 가지:
 *  - `-f` 는 GNU 에서 `--file-system`(불리언)이라 **뒤 인자가 전부 파일 피연산자**다.
 *    그래서 `stat -f %m X` 는 없는 `%m` 때문에 exit 1 이면서도 X 의 블록을 stdout 에 뱉는다.
 *  - `-c %Y` 는 정상 동작한다(실제 값은 절대경로 BSD stat 으로 뽑아 스텁 재귀를 피한다).
 */
export const GNU_STAT_IMPL_BODY = [
  "#!/usr/bin/env bash",
  'if [ "${1:-}" = "-f" ]; then',
  "  shift; rc=0",
  '  for op in "$@"; do',
  '    if [ -e "$op" ]; then printf \'  File: "%s"\\n    ID: 1 Namelen: 255\\n\' "$op"',
  "    else printf 'stat: cannot read file system information for %s\\n' \"$op\" >&2; rc=1; fi",
  "  done",
  '  exit "$rc"',
  "fi",
  'if [ "${1:-}" = "-c" ]; then',
  '  shift; fmt="$1"; shift',
  '  for op in "$@"; do [ -e "$op" ] || { echo "stat: cannot stat $op" >&2; exit 1; }; done',
  '  if [ "$fmt" = "%Y" ]; then /usr/bin/stat -f %m "$@"; exit 0; fi',
  "  exit 1",
  "fi",
  'exec /usr/bin/stat "$@"',
  "",
].join("\n");

/** 스텁 본문을 `dir/stat.impl` 에 둔다. 실행 권한은 주지 않는다(데이터 파일). */
export function writeStatStub(dir: string, body: string): string {
  const impl = path.join(dir, "stat.impl");
  writeFileSync(impl, body);
  return impl;
}

/** `writeStatStub(dir, …)` 로 둔 스텁이 `stat` 으로 잡히게 하는 env 조각. */
export function statStubEnv(dir: string): {
  PATH: string;
  STAT_STUB_IMPL: string;
} {
  return {
    PATH: `${ensureStatWrapper()}:${process.env.PATH}`,
    STAT_STUB_IMPL: path.join(dir, "stat.impl"),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * `curl` 스텁 레인 (2026-08-29 추가)
 *
 * 왜 여기에: 위 처방은 `gh` 만의 것이 아니라 **PATH 로 잡히는 모든 스텁**에 적용된다.
 * 새 헬퍼 파일을 만들면 `gh-stub-guard.contract.test.ts` 의 예외 목록을 늘려야 하는데
 * 그 목록은 "추가는 flaky 를 되살리는 결정"이라고 경고한다 — 이미 예외인 이 파일에
 * 얹는 편이 규약에 맞다(stat 레인이 같은 판단으로 여기 들어왔다).
 *
 * 용도: `infra/selfhost/run-cron.sh` 처럼 응답 본문과 종료코드에 따라 분기하는 래퍼를
 * **네트워크 없이** 실행으로 검증한다. 스텁이 응답과 종료코드를 정한다.
 */
export const CURL_STUB_WRAPPER_DIR_NAME = "wagcrm-curl-stub-v1";
export const CURL_STUB_WRAPPER_BODY =
  '#!/usr/bin/env bash\nexec bash "$CURL_STUB_IMPL" "$@"\n';

const CURL_WRAPPER_DIR = path.join(tmpdir(), CURL_STUB_WRAPPER_DIR_NAME);

function ensureCurlWrapper(): string {
  const wrapper = path.join(CURL_WRAPPER_DIR, "curl");
  let current = "";
  try {
    current = readFileSync(wrapper, "utf8");
  } catch {
    // 없으면 아래에서 만든다.
  }
  if (current !== CURL_STUB_WRAPPER_BODY) {
    mkdirSync(CURL_WRAPPER_DIR, { recursive: true });
    const staging = path.join(CURL_WRAPPER_DIR, `curl.${process.pid}.tmp`);
    writeFileSync(staging, CURL_STUB_WRAPPER_BODY);
    chmodSync(staging, 0o755);
    renameSync(staging, wrapper);
  }
  return CURL_WRAPPER_DIR;
}

/**
 * 응답 본문과 종료코드를 고정한 `curl` 스텁 본문을 만든다.
 * 본문은 **별도 데이터 파일**(`curl.body`)에 두고 여기서는 읽어 뱉기만 한다 —
 * 본문을 스크립트 안에 끼워 넣으면 따옴표·백슬래시 이스케이프가 응답을 조용히 바꾼다.
 */
export function curlStubBody(bodyFile: string, exitCode: number): string {
  return [
    "#!/usr/bin/env bash",
    `cat ${JSON.stringify(bodyFile)}`,
    `exit ${exitCode}`,
    "",
  ].join("\n");
}

/** 스텁 본문을 `dir/curl.impl` 에 둔다. 실행 권한은 주지 않는다(데이터 파일). */
export function writeCurlStub(dir: string, body: string): string {
  const impl = path.join(dir, "curl.impl");
  writeFileSync(impl, body);
  return impl;
}

/** `writeCurlStub(dir, …)` 로 둔 스텁이 `curl` 로 잡히게 하는 env 조각. */
export function curlStubEnv(dir: string): { PATH: string; CURL_STUB_IMPL: string } {
  return {
    PATH: `${ensureCurlWrapper()}:${process.env.PATH}`,
    CURL_STUB_IMPL: path.join(dir, "curl.impl"),
  };
}
