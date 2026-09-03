import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WAG Agent Worker launchd 래퍼·plist 계약 (계보 [HHostWAG], Task 7).
 *
 * 이 워커는 앱과 별개의 최소권한 DB role(wag_agent_worker)로 접속해야 한다 —
 * 설치 패킷(`task-8-install-packet.md` §A-2-1 MEDIUM-2)이 지목한 실사고
 * 위험은 "워커에 앱용 DATABASE_URL(전체 권한)이 실수로 들어가도 아무 신호가
 * 없다"는 것이었다. 그래서 이 계약은 래퍼가 ① 워커 전용 env 파일만 주
 * 소스로 쓰고 ② 앱 .env 와 값이 같으면 기동을 막고 ③ 값을 어디에도 echo 하지
 * 않는지를 소스 스캔 + 실제 `bash -n` 파싱으로 확인한다. plist 쪽은
 * `kr.ygrd.wagcrm.app.plist`(참조 템플릿)와 같은 키 구조를 갖는지,
 * 크리덴셜을 EnvironmentVariables 에 박아 PUBLIC 레포에 흘리지 않는지를 본다.
 */
const INFRA = path.resolve(__dirname, "..", "..", "infra", "selfhost");
const WRAPPER = path.join(INFRA, "run-agent-worker.sh");
const PLIST = path.join(INFRA, "launchd", "kr.ygrd.wagcrm.agent-worker.plist");

function activeLines(src: string): string[] {
  return src.split("\n").filter((l) => !l.trim().startsWith("#"));
}

function plutilAvailable(): boolean {
  try {
    execFileSync("plutil", ["-help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("run-agent-worker.sh", () => {
  const src = readFileSync(WRAPPER, "utf8");

  it("실행 가능 비트가 있다", () => {
    const mode = statSync(WRAPPER).mode;
    // 소유자 실행 비트(0o100) 확인 — 커밋된 파일 모드가 0755 인지.
    // ⚠️ 이 파일에 실행권한 부여 명령의 리터럴을 쓰지 말 것(주석·메시지 안이어도).
    // `gh-stub-guard.contract.test.ts` 가 테스트 소스를 문자열로 스캔해 그 리터럴을
    // 발견하면 실패한다 — 실제로 실행 파일을 만드는지와 무관하게 걸린다.
    expect(mode & 0o100, "소유자 실행 비트가 없다 — 파일 모드를 0755 로 커밋할 것").toBeGreaterThan(0);
  });

  it("bash -n 으로 문법 오류 없이 파싱된다", () => {
    expect(() => execFileSync("bash", ["-n", WRAPPER], { stdio: "pipe" })).not.toThrow();
  });

  it("set -euo pipefail 로 시작한다", () => {
    expect(src).toMatch(/^#!.*bash\nset -euo pipefail/);
  });

  it("워커 전용 env 파일(agent-worker.env)을 메인 프로세스 env 로 source 한다", () => {
    expect(src).toMatch(/ENV_FILE="infra\/selfhost\/agent-worker\.env"/);
    // set -a 로 감싼 최상위(들여쓰기 없는) source 는 이 파일 하나여야 한다.
    const topLevelSources = activeLines(src).filter((l) => /^\.\s+"\$ENV_FILE"$/.test(l.trim()));
    expect(topLevelSources.length).toBeGreaterThan(0);
  });

  it("앱 .env(infra/selfhost/.env)를 메인 env 로 source하지 않는다 — 읽더라도 비교용 서브셸 안에서만", () => {
    // 앱 .env 경로 리터럴이 등장은 하되(동일 여부 비교를 위해 필요), 그
    // source 는 반드시 괄호로 연 서브셸( "$( ... )" ) 안에 있어야 한다 —
    // 그래야 앱 .env 값이 메인 프로세스 환경으로 새지 않는다.
    expect(src).toContain('APP_ENV_FILE="infra/selfhost/.env"');
    const subshellStart = src.indexOf('APP_DATABASE_URL="$(');
    expect(subshellStart, "앱 .env 비교가 서브셸 안에 있지 않다").toBeGreaterThan(-1);
    const subshellEnd = src.indexOf(")\"", subshellStart);
    const subshellBody = src.slice(subshellStart, subshellEnd);
    expect(subshellBody).toMatch(/\.\s+"\$APP_ENV_FILE"/);
    // APP_ENV_FILE 을 source 하는 줄은 정확히 한 번, 그것도 서브셸 안에서만
    // 등장해야 한다 — 서브셸 밖에 같은 줄이 하나 더 있으면 메인 프로세스
    // env 로도 새는 것이다.
    const allAppSourceLines = activeLines(src).filter((l) => /^\.\s+"\$APP_ENV_FILE"$/.test(l.trim()));
    expect(allAppSourceLines.length).toBe(1);
  });

  it("agent-worker.env 가 없으면 한글 오류로 중단한다", () => {
    expect(src).toMatch(/if \[ ! -f "\$ENV_FILE" \]; then/);
    expect(src).toMatch(/치명적 오류.*agent-worker\.env|치명적 오류.*ENV_FILE/);
  });

  it("DATABASE_URL 이 비어 있으면 한글 오류로 중단한다", () => {
    expect(src).toMatch(/if \[ -z "\$\{DATABASE_URL:-\}" \]; then/);
  });

  it("워커 DATABASE_URL 이 앱 DATABASE_URL 과 같으면 중단하고, 값은 echo 하지 않는다", () => {
    expect(src).toMatch(/\[ "\$APP_DATABASE_URL" = "\$DATABASE_URL" \]/);
    // echo 는 사람이 읽는 stderr 출력 통로다 — 여기에 DATABASE_URL 값 변수가
    // 실리면 로그로 값이 샌다. printf 는 예외다: 서브셸 안에서 command
    // substitution 으로 값을 상위 변수에 담아 반환하는 용도로만 한 줄 쓰고,
    // 그 결과는 터미널/로그로 출력되지 않는다 — 아래에서 그 한 줄만 허용한다.
    const echoes = activeLines(src).filter((l) => /\becho\b/.test(l));
    for (const line of echoes) {
      expect(line, `DATABASE_URL 값을 출력할 위험이 있는 줄: ${line}`).not.toMatch(
        /\$DATABASE_URL\b|\$APP_DATABASE_URL\b|\$\{DATABASE_URL\b|\$\{APP_DATABASE_URL\b/,
      );
    }
    // 값을 담아 반환하는 printf 는 서브셸 안의 값 전달용 한 줄만 허용하고, 그
    // 한 줄 말고는 printf 로 DATABASE_URL 값을 다루는 곳이 없어야 한다.
    const printfs = activeLines(src).filter((l) => /\bprintf\b/.test(l));
    const valuePrintfs = printfs.filter((l) => /printf '%s' "\$\{DATABASE_URL:-\}"/.test(l));
    expect(printfs.length, "예상 밖의 printf 사용 — DATABASE_URL 노출 여부를 다시 확인할 것").toBe(1);
    expect(valuePrintfs.length).toBe(1);
  });

  it("네이티브 addon 부재를 빌드 명령과 함께 한글 오류로 막는다", () => {
    expect(src).toContain("src/lib/agent-worker/native/peer-cred/build/Release/peer_cred.node");
    expect(src).toContain("npm run agent-worker:build-native");
  });

  it("NODE_ENV=production 을 설정한다", () => {
    expect(src).toMatch(/export NODE_ENV=production/);
  });

  it("PATH 후보를 직접 추가하고 node 존재를 command -v 로 확인한다(run-app.sh 관례)", () => {
    expect(src).toMatch(/export PATH="\/usr\/local\/bin:\/opt\/homebrew\/bin:\$PATH"/);
    expect(src).toMatch(/NODE_BIN="\$\(command -v node \|\| true\)"/);
  });

  it("StandardOut/ErrorPath 상위 디렉터리를 방어적으로 만든다", () => {
    expect(src).toMatch(/mkdir -p "\$HOME\/selfhost\/logs"/);
  });

  it("레포 로컬 tsx 로 scripts/agent-worker.ts 를 exec 한다(전역 도구 미사용)", () => {
    expect(src).toMatch(/exec "\$NODE_BIN" --import tsx scripts\/agent-worker\.ts/);
    expect(src).toContain('TSX_BIN="node_modules/.bin/tsx"');
  });

  it("npm run build 나 postinstall 을 실행형으로 호출하지 않는다(런처는 실행만, 빌드는 배포 절차 소관)", () => {
    // "npm ci 를 실행하세요" 같은 사람이 읽는 오류 메시지 문자열은 허용한다 —
    // 여기서 막는 것은 스크립트가 그 명령을 **실행**하는 줄이다.
    const invocationLines = activeLines(src).filter(
      (l) => /\bnpm\s+(run\s+build|ci|install)\b/.test(l) && !/치명적 오류/.test(l),
    );
    expect(invocationLines, `빌드/설치 명령을 직접 실행하는 줄: ${invocationLines.join(" | ")}`).toEqual([]);
    expect(src).not.toMatch(/postinstall/);
  });
});

describe("kr.ygrd.wagcrm.agent-worker.plist", () => {
  const src = readFileSync(PLIST, "utf8");

  it("plutil -lint 를 통과한다(가능한 환경에서)", () => {
    if (!plutilAvailable()) {
      // plutil 이 없는 CI 환경 — XML 파싱으로 대체 검증(아래 다른 케이스들이
      // 실질적인 XML 구조를 이미 문자열 매칭으로 확인한다).
      expect(src.trim().startsWith("<?xml")).toBe(true);
      return;
    }
    expect(() => execFileSync("plutil", ["-lint", PLIST], { stdio: "pipe" })).not.toThrow();
  });

  it("Label 이 kr.ygrd.wagcrm.agent-worker 다", () => {
    expect(src).toMatch(/<key>Label<\/key>\s*\n\s*<string>kr\.ygrd\.wagcrm\.agent-worker<\/string>/);
  });

  it("ProgramArguments 가 run-agent-worker.sh 절대경로를 가리킨다", () => {
    expect(src).toContain("<string>/bin/bash</string>");
    expect(src).toContain("<string>/Users/z9/selfhost/wagcrm/infra/selfhost/run-agent-worker.sh</string>");
  });

  it("WorkingDirectory 가 배포 체크아웃 루트다", () => {
    expect(src).toMatch(/<key>WorkingDirectory<\/key>\s*\n\s*<string>\/Users\/z9\/selfhost\/wagcrm<\/string>/);
  });

  it("RunAtLoad·KeepAlive 가 true 다", () => {
    expect(src).toMatch(/<key>RunAtLoad<\/key>\s*\n\s*<true\/>/);
    expect(src).toMatch(/<key>KeepAlive<\/key>\s*\n\s*<true\/>/);
  });

  it("ThrottleInterval 이 10 이다", () => {
    expect(src).toMatch(/<key>ThrottleInterval<\/key>\s*\n\s*<integer>10<\/integer>/);
  });

  it("ExitTimeOut 이 30 이다(워커가 SIGTERM 으로 lease 를 정리할 시간)", () => {
    expect(src).toMatch(/<key>ExitTimeOut<\/key>\s*\n\s*<integer>30<\/integer>/);
  });

  it("로그 경로가 agent-worker.{out,err}.log 다", () => {
    expect(src).toMatch(/<key>StandardOutPath<\/key>\s*\n\s*<string>\/Users\/z9\/selfhost\/logs\/agent-worker\.out\.log<\/string>/);
    expect(src).toMatch(/<key>StandardErrorPath<\/key>\s*\n\s*<string>\/Users\/z9\/selfhost\/logs\/agent-worker\.err\.log<\/string>/);
  });

  it("EnvironmentVariables 키가 없다(크리덴셜을 PUBLIC 레포 plist 에 박지 않는다)", () => {
    expect(src).not.toContain("<key>EnvironmentVariables</key>");
  });

  it("실 크리덴셜 리터럴(비밀번호·URL 스킴)을 담지 않는다", () => {
    expect(src).not.toMatch(/postgres(ql)?:\/\//i);
    expect(src).not.toMatch(/password/i);
  });
});

describe(".gitignore 가 agent-worker.env 를 커버한다", () => {
  it("infra/selfhost/agent-worker.env 줄이 있다", () => {
    const gitignore = readFileSync(path.resolve(__dirname, "..", "..", ".gitignore"), "utf8");
    expect(gitignore).toContain("infra/selfhost/agent-worker.env");
  });
});

describe("existsSync 스모크 — 파일 경로 자체가 계약 기준과 일치한다", () => {
  it("래퍼·plist 가 정확히 문서화된 경로에 있다", () => {
    expect(existsSync(WRAPPER)).toBe(true);
    expect(existsSync(PLIST)).toBe(true);
  });
});
