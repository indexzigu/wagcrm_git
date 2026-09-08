import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `run-agent-worker.sh` 의 **행위** 검증 (T-118 · T-119).
 *
 * ## 왜 소스 스캔만으로는 부족한가
 *
 * 이 파일 옆의 `selfhost-agent-worker.test.ts` 는 래퍼의 모양을 문자열로 고정한다.
 * 그것만으로 두 결함을 놓쳤다 — 둘 다 소스에는 "올바른 비교"가 적혀 있었고 틀린 것은
 * 실행 결과였다:
 *   - 앱 `.env` 에 `DATABASE_URL` 이 없으면 비교 서브셸이 **워커 자기 값**을 읽어
 *     "앱과 동일합니다"라는 거짓 사유로 기동을 거부한다(T-118).
 *   - `bash -x` 로 돌리면 `set -a; . env` 가 접속 문자열을 stderr 에 그대로 찍는다 —
 *     스크립트가 스스로 적어 둔 「값은 출력하지 않는다」가 그 순간 깨진다(T-119).
 *
 * ## 실기계에 닿지 않는 방법
 *
 * 1. 래퍼를 **임시 체크아웃으로 복사**해 실행한다. 스크립트 첫 줄이
 *    `cd "$(dirname "$0")/../.."` 라 모든 상대 경로가 그 임시 트리에서 해석된다 —
 *    실제 `infra/selfhost/.env`(프로덕션 크리덴셜)는 이름조차 등장하지 않는다.
 * 2. `HOME` 을 임시 디렉터리로 갈아끼운다(로그 디렉터리 mkdir 대비).
 * 3. 픽스처의 접속 문자열은 **URL 형태가 아닌 센티널 문자열**이다. 래퍼는 값을
 *    파싱하지 않고 비교만 하므로 형태가 필요 없고, 자격증명 형태를 커밋에 넣지
 *    않는다(P0 · commit-guard).
 * 4. 어떤 케이스도 `exec` 에 닿지 않는다 — `node_modules/.bin/tsx` 를 만들지 않으므로
 *    모든 가드를 통과한 실행은 마지막 tsx 검사에서 멈춘다. 그 오류가 곧
 *    **"가드를 전부 통과했다"** 는 표식이다(⛔ 실행파일 스텁 금지 —
 *    `gh-stub-guard.contract.test.ts`).
 */
const WRAPPER = path.resolve(__dirname, "..", "..", "infra", "selfhost", "run-agent-worker.sh");

/** 워커 전용 env 의 값. URL 형태가 아니어야 한다(위 3번). */
const WORKER_URL_SENTINEL = "worker-conn-sentinel-a1b2c3";
const APP_URL_SENTINEL = "app-conn-sentinel-d4e5f6";
/** 모든 가드를 통과했을 때 도달하는 마지막 검사의 문구. */
const PASSED_ALL_GUARDS = "node_modules/.bin/tsx 이 없습니다";

let workRoot: string;

beforeAll(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), "agent-worker-"));
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

type Fixture = {
  /** 워커 전용 env 파일을 두지 않는다. */
  withoutWorkerEnv?: boolean;
  /** 워커 env 는 있으나 DATABASE_URL 이 비어 있다. */
  blankWorkerUrl?: boolean;
  /** 앱 .env 를 둘지, 두면 어떤 값을 담을지. */
  appEnv?: "same" | "different" | "no-database-url" | "absent";
  /** 네이티브 addon 을 기본 경로에 둔다. */
  withAddon?: boolean;
  /** addon 오버라이드 경로에 파일을 둔다(경로는 반환값의 `addonOverride`). */
  withOverriddenAddon?: boolean;
};

type Checkout = { root: string; home: string; addonOverride: string };

const ADDON_RELATIVE = path.join("src", "lib", "agent-worker", "native", "peer-cred", "build", "Release", "peer_cred.node");

function makeCheckout(name: string, fx: Fixture = {}): Checkout {
  const root = path.join(workRoot, name, "checkout");
  const home = path.join(workRoot, name, "home");
  mkdirSync(path.join(root, "infra", "selfhost"), { recursive: true });
  mkdirSync(home, { recursive: true });
  copyFileSync(WRAPPER, path.join(root, "infra", "selfhost", "run-agent-worker.sh"));

  if (!fx.withoutWorkerEnv) {
    const value = fx.blankWorkerUrl ? "" : WORKER_URL_SENTINEL;
    writeFileSync(path.join(root, "infra", "selfhost", "agent-worker.env"), `DATABASE_URL=${value}\n`);
  }

  const appEnv = fx.appEnv ?? "absent";
  if (appEnv !== "absent") {
    const lines =
      appEnv === "no-database-url"
        ? "ENCRYPTION_KEY=not-a-connection-string\n"
        : `DATABASE_URL=${appEnv === "same" ? WORKER_URL_SENTINEL : APP_URL_SENTINEL}\n`;
    writeFileSync(path.join(root, "infra", "selfhost", ".env"), lines);
  }

  if (fx.withAddon) {
    mkdirSync(path.join(root, path.dirname(ADDON_RELATIVE)), { recursive: true });
    writeFileSync(path.join(root, ADDON_RELATIVE), "");
  }

  const addonOverride = path.join(root, "custom-peer-cred.node");
  if (fx.withOverriddenAddon) writeFileSync(addonOverride, "");

  return { root, home, addonOverride };
}

type RunOptions = { trace?: boolean; addonOverride?: string; withoutNode?: boolean };

/**
 * `command -v node` 를 실패하게 만드는 스텁. 래퍼가 PATH 후보(`/usr/local/bin` ·
 * `/opt/homebrew/bin`)를 자기 손으로 붙이므로 **env 로는 node 를 숨길 수 없다** —
 * 그 경로에 node 가 있는 기계에서는 PATH 를 비워도 찾아진다. bash 는 비대화형
 * 실행 시 `BASH_ENV` 를 먼저 source 하므로 거기서 `command` 를 함수로 덮는다:
 * 함수는 빌트인보다 우선하고, 실행파일을 새로 만들지 않으므로
 * `gh-stub-guard.contract.test.ts` 의 금지에도 걸리지 않는다.
 */
const NO_NODE_STUB = `command() {
  if [ "\${1:-}" = "-v" ] && [ "\${2:-}" = "node" ]; then return 1; fi
  builtin command "$@"
}
`;

function run(checkout: Checkout, options: RunOptions = {}) {
  const args = options.trace ? ["-x", "infra/selfhost/run-agent-worker.sh"] : ["infra/selfhost/run-agent-worker.sh"];
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: checkout.home };
  delete env.DATABASE_URL;
  delete env.WAG_AGENT_WORKER_PEER_CRED_ADDON;
  if (options.addonOverride !== undefined) env.WAG_AGENT_WORKER_PEER_CRED_ADDON = options.addonOverride;
  if (options.withoutNode) {
    const stub = path.join(checkout.root, "no-node.sh");
    writeFileSync(stub, NO_NODE_STUB);
    env.BASH_ENV = stub;
  }

  const result = spawnSync("bash", args, { cwd: checkout.root, env, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, stderr: result.stderr };
}

describe("run-agent-worker.sh 기동 가드", () => {
  it("워커 전용 env 가 없으면 그 사실을 말하고 멈춘다", { timeout: 20_000 }, () => {
    const { code, out } = run(makeCheckout("no-worker-env", { withoutWorkerEnv: true }));

    expect(code, out).toBe(1);
    expect(out).toContain("agent-worker.env 이 없습니다");
  });

  it("워커 DATABASE_URL 이 비어 있으면 멈춘다", { timeout: 20_000 }, () => {
    const { code, out } = run(makeCheckout("blank-url", { blankWorkerUrl: true }));

    expect(code, out).toBe(1);
    expect(out).toContain("DATABASE_URL 이 비어 있습니다");
  });

  it("앱 .env 와 접속 문자열이 같으면 멈춘다(값은 출력하지 않는다)", { timeout: 20_000 }, () => {
    const { code, out } = run(makeCheckout("same-url", { appEnv: "same", withAddon: true }));

    expect(code, out).toBe(1);
    expect(out).toContain("동일합니다");
    expect(out, "거부 사유를 설명하며 값 자체를 흘렸다").not.toContain(WORKER_URL_SENTINEL);
  });

  it("앱 .env 에 DATABASE_URL 이 없으면 '동일합니다'로 거부하지 않는다 (T-118)", { timeout: 20_000 }, () => {
    // 회귀 대상: 비교 서브셸이 부모의 export 를 물려받아 **워커 자기 값**을 앱 값으로
    // 읽던 결함. 사실과 다른 사유로 거부되면 KeepAlive 가 10초마다 그 거짓말을 반복
    // 기록하고, 진짜 원인(앱 .env 에 키가 없음)은 어디에도 남지 않는다.
    const { code, out } = run(makeCheckout("app-env-without-url", { appEnv: "no-database-url", withAddon: true }));

    expect(out, "앱 .env 에 DATABASE_URL 이 없는데 '동일하다'고 거부했다").not.toContain("동일합니다");
    expect(out, "비교 단계를 통과하지 못했다").toContain(PASSED_ALL_GUARDS);
    expect(code, out).toBe(1);
  });

  it("앱 .env 와 값이 다르면 비교를 통과한다", { timeout: 20_000 }, () => {
    const { code, out } = run(makeCheckout("different-url", { appEnv: "different", withAddon: true }));

    expect(code, out).toBe(1);
    expect(out).toContain(PASSED_ALL_GUARDS);
  });

  it("모든 실패 안내가 어느 로그 파일에 남는지 함께 말한다 (T-118)", { timeout: 20_000 }, () => {
    const { out } = run(makeCheckout("log-hint", { withoutWorkerEnv: true }));

    expect(out).toContain("agent-worker.err.log");
  });
});

describe("run-agent-worker.sh addon 경로", () => {
  it("addon 이 없으면 빌드 명령과 함께 멈춘다", { timeout: 20_000 }, () => {
    const { code, out } = run(makeCheckout("no-addon"));

    expect(code, out).toBe(1);
    expect(out).toContain("npm run agent-worker:build-native");
  });

  it("WAG_AGENT_WORKER_PEER_CRED_ADDON 오버라이드를 존중한다 (T-119)", { timeout: 20_000 }, () => {
    // 회귀 대상: 런북이 권하는 오버라이드를 래퍼가 무시하고 기본 경로만 보던 결함.
    // 기본 경로에는 addon 이 **없고** 오버라이드 경로에만 있는 상태 — 워커 본체는
    // 뜰 수 있는데 래퍼가 먼저 막던 조합이다.
    const checkout = makeCheckout("addon-override", { withOverriddenAddon: true });
    const { code, out } = run(checkout, { addonOverride: checkout.addonOverride });

    expect(out, "오버라이드를 무시하고 기본 경로를 봤다").not.toContain("agent-worker:build-native");
    expect(out).toContain(PASSED_ALL_GUARDS);
    expect(code, out).toBe(1);
  });

  it("오버라이드 경로에 파일이 없으면 그 경로를 짚어 멈춘다", { timeout: 20_000 }, () => {
    const checkout = makeCheckout("addon-override-missing");
    const { code, out } = run(checkout, { addonOverride: checkout.addonOverride });

    expect(code, out).toBe(1);
    expect(out).toContain("custom-peer-cred.node");
  });
});

describe("run-agent-worker.sh node 탐지", () => {
  it("node 를 못 찾으면 PATH 를 보여주고 멈춘다", { timeout: 20_000 }, () => {
    // launchd GUI 에이전트의 기본 PATH 에는 Homebrew node 가 없다 — 래퍼가 후보를
    // 직접 붙이는 이유이자, 그 목록이 낡으면 exec 가 "command not found" 로 죽어
    // KeepAlive 크래시루프가 되던 자리다. 그 실패를 재현해 안내가 실제로 나오는지 본다.
    const { code, out } = run(makeCheckout("no-node", { appEnv: "different", withAddon: true }), {
      withoutNode: true,
    });

    expect(code, out).toBe(1);
    expect(out).toContain("node 실행파일을 찾을 수 없습니다");
    expect(out, "고칠 대상인 PATH 를 안 보여주면 안내가 반쪽이다").toContain("/opt/homebrew/bin");
  });

  it("스텁이 없으면 같은 픽스처가 node 검사를 통과한다 — 스텁 자체의 대조군", { timeout: 20_000 }, () => {
    // 위 테스트가 "스텁이 실제로 무언가를 바꿨다"를 증명하려면 짝이 필요하다.
    // 이것이 없으면 픽스처가 다른 이유로 죽어도 위 단언이 초록일 수 있다.
    const { out } = run(makeCheckout("node-present", { appEnv: "different", withAddon: true }));

    expect(out).not.toContain("node 실행파일을 찾을 수 없습니다");
    expect(out).toContain(PASSED_ALL_GUARDS);
  });
});

describe("run-agent-worker.sh 추적 모드", () => {
  it("`bash -x` 로 돌려도 접속 문자열을 출력하지 않는다 (T-119)", { timeout: 20_000 }, () => {
    const checkout = makeCheckout("xtrace", { appEnv: "different", withAddon: true });
    const { code, out } = run(checkout, { trace: true });

    expect(out, "추적 모드가 워커 접속 문자열을 흘렸다").not.toContain(WORKER_URL_SENTINEL);
    expect(out, "추적 모드가 앱 접속 문자열을 흘렸다").not.toContain(APP_URL_SENTINEL);
    // 봉인이 스크립트 전체를 끄는 것으로 때워지지 않았는지 — 봉인 구간 밖은 계속
    // 추적된다(그러지 않으면 디버깅 수단 자체가 사라진다).
    expect(out, "봉인 구간 밖의 추적까지 꺼졌다").toContain("+ export NODE_ENV=production");
    expect(code, out).toBe(1);
  });

  it("추적 모드가 아니면 추적 출력이 아예 없다", { timeout: 20_000 }, () => {
    const checkout = makeCheckout("no-xtrace", { appEnv: "different", withAddon: true });
    const { out } = run(checkout);

    expect(out).not.toContain("+ export NODE_ENV=production");
  });
});
