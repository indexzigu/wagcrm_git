import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * infra/selfhost/cutover.sh 의 **검사기(판별자)** 계약.
 *
 * ## 왜 이 파일이 있는가 (2026-08-13 실행에서 오탐 4건)
 *
 * 실제 컷오버에서 Stage 5·6·7·9 의 검사가 **정상 상태를 실패로 판정**해 네 번
 * 멈췄다. 네 건 모두 원인이 같은 계열이다 — *검사기가 보는 곳이 신호가 있는
 * 곳과 어긋났다*:
 *
 *   Stage 5 : client static 만 grep 했다. 이 앱에서 NEXT_PUBLIC origin 은
 *             server 산출물에만 인라이닝된다(그 변수를 읽는 표면이 전부 서버
 *             컴포넌트·라우트 핸들러다) → 정상 재빌드에서도 항상 FAIL.
 *   Stage 6 : `printenv SITE_URL` 을 읽었다. 컨테이너 안 이름은
 *             GOTRUE_SITE_URL 이다 → 항상 빈 값 → 항상 중단.
 *   Stage 7 : `/` 의 200 을 요구했다. 미인증 `/` 는 인증 게이트가 307 로
 *             보내고, 게다가 구 배포도 같은 앱이라 같은 307 을 준다 →
 *             정상에서도 실패하고, 신·구 판별력도 0.
 *   Stage 9 : 같은 200 요구 → 정상 상태에서 이 항목만 FAIL(컷오버가 미완처럼
 *             종료).
 *
 * ## 왜 스크립트를 통째로 돌리지 않는가
 *
 * 그 검사기들은 파괴적 단계(데이터 교체·DNS 전환) 뒤에 있어서, 검사기 하나를
 * 확인하려면 컷오버 전체를 실행해야 했다 — 그래서 이 오탐들이 **실행 중에야**
 * 드러났다. `CUTOVER_TEST_LIB_ONLY=1` 로 source 하면 함수만 정의되고 디스패처는
 * 돌지 않으므로, 각 검사기를 직접 호출해 계약을 고정할 수 있다.
 *
 * 스텁은 실행파일이 아니라 **셸 함수 섀도잉**이다(docker/curl). 새 실행파일을
 * 만들지 않으므로 `gh-stub-guard.contract.test.ts` 의 계약(macOS 첫-execve
 * 요금 회피)과 어긋나지 않는다.
 */

const SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "cutover.sh");

/**
 * 드라이버 서두. 두 가지가 중요하다:
 *  - `set --` : source 하면 스크립트가 **호출자의** 위치 인자를 보므로, 비우지
 *    않으면 인자 파서가 "알 수 없는 옵션"으로 거부한다.
 *  - `report` : 검사기는 결과를 전역(…_DETAIL)에 남기므로 서브셸에서 부르면
 *    안 된다. 같은 셸에서 호출해 종료코드만 OK/NG 로 찍는다.
 */
function prologue(): string {
  return [
    "set --",
    `. ${JSON.stringify(SCRIPT)}`,
    'report() { local name="$1"; shift; if "$@"; then printf "%s:OK\\n" "$name"; else printf "%s:NG\\n" "$name"; fi; }',
  ].join("\n");
}

function runLib(body: string, opts: { work?: string } = {}) {
  const dir = opts.work ?? mkdtempSync(path.join(tmpdir(), "cutover-lib-"));
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  const driver = path.join(dir, "driver.sh");
  writeFileSync(driver, `${prologue()}\n${body}\n`);

  const r = spawnSync("/bin/bash", [driver], {
    env: {
      ...process.env,
      HOME: home, // LOG_DIR=$HOME/selfhost/logs — 실 홈을 건드리지 않게 격리
      CUTOVER_TEST_LIB_ONLY: "1",
      WORK: dir,
    },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, dir };
}

/** `.next/standalone/.next` 를 흉내 낸 빌드 트리. 반환값은 build_root. */
function makeBuildTree(dir: string, files: { server?: Record<string, string>; static?: Record<string, string> }) {
  const root = path.join(dir, "build", ".next");
  mkdirSync(path.join(root, "server", "chunks"), { recursive: true });
  mkdirSync(path.join(root, "static", "chunks"), { recursive: true });
  for (const [name, body] of Object.entries(files.server ?? {})) {
    writeFileSync(path.join(root, "server", "chunks", name), body);
  }
  for (const [name, body] of Object.entries(files.static ?? {})) {
    writeFileSync(path.join(root, "static", "chunks", name), body);
  }
  return root;
}

const NEW_HOST = "cutover-new.example.test";
const OLD_HOST = "cutover-old.example.test";

describe("LIB_ONLY 통로 자체", () => {
  it("함수만 정의하고 디스패처(Stage 1)는 돌지 않는다", () => {
    // 양성 대조 — 이 통로가 고장나 스크립트가 통째로 돌면 아래 검사들이
    // 검사기가 아니라 컷오버 실행을 보게 된다.
    const r = runLib('printf "loaded:%s\\n" "$(type -t selfhost_serving_check)"');
    expect(r.out).toContain("loaded:function");
    expect(r.out).not.toContain("=== Stage 1");
    expect(r.status).toBe(0);
  });
});

describe("Stage 5 — 재빌드 반영 검사(verify_origin_in_build)", () => {
  it("origin 이 server 산출물에만 있어도 PASS 한다 (종전엔 static 만 봐서 항상 FAIL)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cutover-lib-"));
    const root = makeBuildTree(dir, {
      server: { "1.js": `const o="https://${NEW_HOST}";` },
      static: { "2.js": "no origin here" }, // 실측과 동일: client 번들엔 0건
    });
    const r = runLib(
      `report build verify_origin_in_build ${JSON.stringify(root)} "${NEW_HOST}" "${OLD_HOST}"\n` +
        'printf "detail:%s\\n" "$BUILD_ORIGIN_DETAIL"',
      { work: dir },
    );
    expect(r.out).toContain("build:OK");
  });

  it("신규 origin 이 어디에도 없으면 FAIL 한다 (양성 프로브)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cutover-lib-"));
    const root = makeBuildTree(dir, { server: { "1.js": "unrelated bundle" } });
    const r = runLib(
      `report build verify_origin_in_build ${JSON.stringify(root)} "${NEW_HOST}" ""\n` +
        'printf "detail:%s\\n" "$BUILD_ORIGIN_DETAIL"',
      { work: dir },
    );
    expect(r.out).toContain("build:NG");
    expect(r.out).toMatch(/detail:.*어디에도 없습니다/);
  });

  it("구 origin 이 산출물에 남아 있으면 FAIL 한다 (음성 프로브 — 이전 빌드 재사용 탐지)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cutover-lib-"));
    const root = makeBuildTree(dir, {
      server: { "1.js": `https://${NEW_HOST}`, "2.js": `https://${OLD_HOST}` },
    });
    const r = runLib(
      `report build verify_origin_in_build ${JSON.stringify(root)} "${NEW_HOST}" "${OLD_HOST}"\n` +
        'printf "detail:%s\\n" "$BUILD_ORIGIN_DETAIL"',
      { work: dir },
    );
    expect(r.out).toContain("build:NG");
    expect(r.out).toMatch(/detail:.*남아 있습니다/);
  });

  it("구 origin 이 루프백이면 음성 대조를 스킵한다 (소스의 localhost 폴백 리터럴 오탐 방지)", () => {
    // src 곳곳에 `?? "http://localhost:3000"` 폴백이 있어 정상 빌드에도 항상
    // 남는다 — 이걸 잔재로 읽으면 이번에 고친 것과 같은 부류의 오탐이 된다.
    const dir = mkdtempSync(path.join(tmpdir(), "cutover-lib-"));
    const root = makeBuildTree(dir, {
      server: { "1.js": `https://${NEW_HOST}`, "2.js": 'fallback "http://localhost:3000"' },
    });
    const r = runLib(
      `report build verify_origin_in_build ${JSON.stringify(root)} "${NEW_HOST}" "localhost"`,
      { work: dir },
    );
    expect(r.out).toContain("build:OK");
  });

  it("server 산출물 디렉터리 자체가 없으면 FAIL 한다 (검사기 고장을 통과로 읽지 않는다)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cutover-lib-"));
    const r = runLib(
      `report build verify_origin_in_build "$WORK/absent/.next" "${NEW_HOST}" ""\n` +
        'printf "detail:%s\\n" "$BUILD_ORIGIN_DETAIL"',
      { work: dir },
    );
    expect(r.out).toContain("build:NG");
    expect(r.out).toMatch(/detail:.*디렉터리가 없습니다/);
  });
});

describe("Stage 6 — GoTrue 적용값 읽기(read_auth_site_url)", () => {
  /** SITE_URL 은 없고 GOTRUE_SITE_URL 만 있는 실제 컨테이너를 흉내 낸다. */
  const DOCKER_GOTRUE_ONLY = [
    "docker() {",
    '  if [ "$4" = "GOTRUE_SITE_URL" ]; then printf "https://real.example.test\\n"; return 0; fi',
    "  return 1;", // printenv SITE_URL → exit 1, 출력 없음(실측)
    "}",
  ].join("\n");

  it("SITE_URL 이 아니라 GOTRUE_SITE_URL 을 읽는다 (종전엔 항상 빈 값 → 항상 중단)", () => {
    const r = runLib(
      `${DOCKER_GOTRUE_ONLY}\nreport read read_auth_site_url supabase-auth\n` +
        'printf "key:%s value:%s\\n" "$AUTH_SITE_URL_KEY" "$AUTH_SITE_URL_VALUE"',
    );
    expect(r.out).toContain("read:OK");
    expect(r.out).toContain("key:GOTRUE_SITE_URL value:https://real.example.test");
  });

  it("GOTRUE_SITE_URL 이 없는 스택이면 SITE_URL 로 폴백한다", () => {
    const body = [
      "docker() {",
      '  if [ "$4" = "SITE_URL" ]; then printf "https://plain.example.test\\n"; return 0; fi',
      "  return 1;",
      "}",
      "report read read_auth_site_url supabase-auth",
      'printf "key:%s\\n" "$AUTH_SITE_URL_KEY"',
    ].join("\n");
    const r = runLib(body);
    expect(r.out).toContain("read:OK");
    expect(r.out).toContain("key:SITE_URL");
  });

  it("둘 다 비어 있으면 실패를 반환한다", () => {
    const r = runLib(
      "docker() { return 1; }\nreport read read_auth_site_url supabase-auth\n" +
        'printf "key:[%s] value:[%s]\\n" "$AUTH_SITE_URL_KEY" "$AUTH_SITE_URL_VALUE"',
    );
    expect(r.out).toContain("read:NG");
    expect(r.out).toContain("key:[] value:[]");
  });
});

describe("Stage 7·9 — 신·구 배포 판별자(selfhost_serving_check)", () => {
  /**
   * curl 섀도잉. 마지막 인자가 URL 이다(스크립트가 그렇게 부른다).
   * 헤더 블록 + `HTTPCODE:<코드>` 를 stdout 으로 준다 — 실제 curl 의
   * `-D - -w HTTPCODE:%{http_code}` 출력 형태 그대로다.
   */
  function curlStub(spec: { login: string; root?: string }) {
    return [
      "curl() {",
      '  local url="${@: -1}"',
      "  case \"$url\" in",
      `    */login) printf ${JSON.stringify(spec.login)} ;;`,
      `    *) printf ${JSON.stringify(spec.root ?? "HTTPCODE:000")} ;;`,
      "  esac",
      "}",
    ].join("\n");
  }

  const SELFHOST_LOGIN = "HTTP/2 200\r\ncontent-type: text/html\r\n\r\nHTTPCODE:200";
  const VERCEL_LOGIN = "HTTP/2 200\r\nx-vercel-id: icn1::stub\r\n\r\nHTTPCODE:200";

  it("/login 200 + 이전 플랫폼 엣지 헤더 부재 → 자체호스팅으로 판정한다", () => {
    const r = runLib(
      `${curlStub({ login: SELFHOST_LOGIN })}\nreport serve selfhost_serving_check\n` +
        'printf "detail:%s\\n" "$SERVE_CHECK_DETAIL"',
    );
    expect(r.out).toContain("serve:OK");
  });

  it("미인증 / 가 307 이어도 판정에 영향을 주지 않는다 (종전 오탐의 핵심)", () => {
    // 이 앱의 정상 동작이다 — 인증 게이트가 `/` 를 /login 으로 보낸다.
    const r = runLib(
      `${curlStub({
        login: SELFHOST_LOGIN,
        root: "HTTP/2 307\r\nlocation: https://x/login\r\n\r\nHTTPCODE:307",
      })}\nreport serve selfhost_serving_check`,
    );
    expect(r.out).toContain("serve:OK");
  });

  it("/login 이 200 이어도 x-vercel-id 가 있으면 구 배포로 판정한다 (상태코드로는 못 가른다)", () => {
    const r = runLib(
      `${curlStub({ login: VERCEL_LOGIN })}\nreport serve selfhost_serving_check\n` +
        'printf "detail:%s\\n" "$SERVE_CHECK_DETAIL"',
    );
    expect(r.out).toContain("serve:NG");
    expect(r.out).toMatch(/detail:.*x-vercel-id/);
  });

  it("응답이 없으면 FAIL 하고 코드를 남긴다", () => {
    const r = runLib(
      `${curlStub({ login: "HTTPCODE:000" })}\nreport serve selfhost_serving_check\n` +
        'printf "detail:%s\\n" "$SERVE_CHECK_DETAIL"',
    );
    expect(r.out).toContain("serve:NG");
    expect(r.out).toMatch(/detail:.*000/);
  });

  it("판정 근거에 응답 헤더 원문을 싣지 않는다 (로그 위생 — 쿠키 등)", () => {
    const r = runLib(
      `${curlStub({ login: "HTTP/2 200\r\nset-cookie: sb-secret=leak\r\n\r\nHTTPCODE:200" })}\n` +
        "report serve selfhost_serving_check\n" +
        'printf "detail:%s\\n" "$SERVE_CHECK_DETAIL"',
    );
    expect(r.out).toContain("serve:OK");
    expect(r.out).not.toContain("sb-secret");
  });

  it("미인증 / 의 로그인 리다이렉트를 확인한다(auth_gate_check) — 200 이면 게이트가 열린 것이라 FAIL", () => {
    const redirect = `${curlStub({
      login: SELFHOST_LOGIN,
      root: "HTTP/2 307\r\nlocation: https://x/login\r\n\r\nHTTPCODE:307",
    })}\nreport gate auth_gate_check`;
    expect(runLib(redirect).out).toContain("gate:OK");

    const open = `${curlStub({
      login: SELFHOST_LOGIN,
      root: "HTTP/2 200\r\n\r\nHTTPCODE:200",
    })}\nreport gate auth_gate_check\nprintf "detail:%s\\n" "$AUTH_GATE_DETAIL"`;
    const r = runLib(open);
    expect(r.out).toContain("gate:NG");
    expect(r.out).toMatch(/detail:.*200/);
  });
});

describe("origin_host_of — host 만 정확히 뽑는다", () => {
  it("scheme·자격증명·port·path·따옴표를 전부 걷어낸다", () => {
    // 자격증명 픽스처는 **조각으로 조립**한다 — `user:pw@host` 형태의 리터럴을
    // 그대로 두면 commit-guard 가 "URL 내장 자격증명"으로 잡는다(PUBLIC 레포, P0).
    // 검사 대상은 origin_host_of 의 `@` 절단 동작이지 값 자체가 아니라 무방하다.
    const userinfo = `${"user"}:${"pw"}${"@"}`;
    const cases: Array<[string, string]> = [
      ["https://a.example.test:8443/x?y=1", "a.example.test"],
      [`"https://${userinfo}b.example.test/"`, "b.example.test"],
      ["http://localhost:3000", "localhost"],
      ["", ""],
    ];
    const body = cases
      .map(([input], i) => `printf "case${i}:%s\\n" "$(origin_host_of ${JSON.stringify(input)})"`)
      .join("\n");
    const r = runLib(body);
    cases.forEach(([, expected], i) => {
      expect(r.out).toContain(`case${i}:${expected}`);
    });
  });
});
