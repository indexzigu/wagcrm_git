// URL 스킴 깨우기 계약 — CRM 클릭이 로컬 헬퍼를 띄우는 유일한 경로다.
//
// 이 경로는 **테스트가 재현할 수 없는 부분**(LaunchServices 등록, Chrome 의 외부
// 프로토콜 확인창)이 많아서, 실측으로 알아낸 제약을 소스에 고정해 두는 것이 재발
// 방지의 전부다. 2026-08-06 실측으로 확인된 것:
//
//   ⛔ **임시 경로(`/private/tmp` 등)에 둔 `.app` 은 등록돼도 실행이 거부된다**
//      (`kLSApplicationNotFoundErr`) — 표준 위치(`~/Applications`)여야 한다.
//   ⛔ **URL 은 Apple Event 로 전달된다** — 셸 스크립트가 argv 로 못 받는다. 그래서
//      스킴은 「깨우기 전용」이고 발행 데이터는 HTTP 로만 흐른다(URL 에 사업자번호·
//      금액이 실리면 브라우저 이력·OS 로그에 남는다 — P0).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOMETAX_HELPER_WAKE_URL } from "../../../src/lib/hometax-helper-client";

const INSTALLER = readFileSync(
  resolve(process.cwd(), "scripts/hometax-helper/install-url-scheme.sh"),
  "utf8",
);
/** 생성되는 런처(앱 번들 안의 실행 파일) 본문만 잘라 본다. */
const LAUNCHER = INSTALLER.slice(
  INSTALLER.indexOf("LAUNCHER_EOF"),
  INSTALLER.lastIndexOf("LAUNCHER_EOF"),
);
/** Terminal 창에서 헬퍼를 실제로 돌리는 `.command` 본문(2026-08-09 오너 제안). */
const RUN_COMMAND = INSTALLER.slice(
  INSTALLER.indexOf("RUN_EOF"),
  INSTALLER.lastIndexOf("RUN_EOF"),
);

describe("설치 위치·등록", () => {
  it("표준 애플리케이션 디렉터리에 설치한다 — 임시 경로는 실행이 거부된다", () => {
    expect(INSTALLER).toMatch(/APP_DIR="\$HOME\/Applications\//);
    expect(INSTALLER).not.toMatch(/APP_DIR=.*\/(tmp|var\/folders)/);
  });

  it("lsregister 로 강제 재등록한다 — 옛 등록이 남으면 스킴이 엉뚱한 번들로 간다", () => {
    expect(INSTALLER).toMatch(/"\$LSREGISTER" -f "\$APP_DIR"/);
  });

  it("Dock 에 뜨지 않는 도우미로 선언한다", () => {
    expect(INSTALLER).toContain("<key>LSUIElement</key><true/>");
  });
});

describe("스킴 짝 — CRM 이 여는 URL 과 앱이 선언한 스킴이 같다", () => {
  it("선언 스킴과 클라이언트 상수가 일치한다", () => {
    // 한쪽만 바꾸면 클릭이 조용히 아무 일도 하지 않는다(CSP 짝 계약과 같은 부류).
    const scheme = new URL(HOMETAX_HELPER_WAKE_URL).protocol.replace(":", "");
    expect(INSTALLER).toContain(`<array><string>${scheme}</string></array>`);
  });

  it("깨우기 URL 은 데이터를 싣지 않는다 — Apple Event 라 어차피 못 받고, 남으면 안 된다", () => {
    expect(HOMETAX_HELPER_WAKE_URL).not.toContain("?");
    expect(HOMETAX_HELPER_WAKE_URL).not.toContain("=");
  });
});

describe("런처 — 깨우기 전용이고 중복 기동하지 않는다", () => {
  it("먼저 health 를 확인하고, 살아 있으면 아무것도 하지 않는다", () => {
    expect(LAUNCHER).toMatch(/curl .*\/health/);
    expect(LAUNCHER).toMatch(/exit 0/);
  });

  it("URL 인자를 읽지 않는다 — 「깨우기 전용」이 설계다", () => {
    expect(LAUNCHER).not.toMatch(/\$\{?1[:}]/);
  });

  it("health 검사 포트와 헬퍼가 listen 하는 포트를 같은 값으로 넘긴다", () => {
    // 갈리면 앱이 "안 떠 있다"고 오판해 켤 때마다 새 프로세스를 띄운다.
    // 헬퍼 실행은 이제 run-helper.command 몫이다(Terminal 가시 실행, 2026-08-09).
    expect(RUN_COMMAND).toContain('export HOMETAX_HELPER_PORT="$PORT"');
  });

  it("⛔ 깨우기는 홈택스 창을 열지 않는다 — 스킴만으로 로그인된 화면이 뜨면 안 된다", () => {
    // 스킴 실행에는 발신자를 가르는 장치가 없다(CORS 화이트리스트는 HTTP 엔드포인트
    // 전용). 창까지 열면 스킴을 여는 것만으로 오너의 로그인된 화면이 노출된다.
    // 창은 오리진 검사를 지나는 POST /issue 가 연다.
    expect(RUN_COMMAND).toContain("export HOMETAX_HELPER_DAEMON=1");
  });
});

describe("Terminal 가시 실행 — 오너가 보고, 끌 수 있어야 한다 (2026-08-09 오너 제안)", () => {
  // 종전 nohup 백그라운드는 실패해도 안 보였고("작동이 멈춰있는데?"의 원인 일부),
  // 임의 종료 수단도 없었다(pkill 을 알아야 했다). 이제 launcher 는 .command 를
  // `open` 으로 열어 Terminal 창에서 돌린다.
  it("launcher 는 run-helper.command 를 `open` 으로 연다 — osascript 가 아니다", () => {
    // osascript 로 Terminal 을 제어하면 자동화 권한 팝업이 뜬다(Finder 팝업과 같은
    // 부류). `open` 은 LaunchServices 경유라 팝업이 없다.
    expect(LAUNCHER).toMatch(/open .*run-helper\.command/);
    expect(LAUNCHER).not.toContain("osascript");
    expect(LAUNCHER).not.toMatch(/nohup/);
  });

  it("로그는 화면과 파일 양쪽에 남는다 — 창을 닫아도 이력이 사라지지 않는다", () => {
    expect(RUN_COMMAND).toMatch(/tee -a .*helper\.log/);
  });

  it("헬퍼는 SIGHUP(창 닫기)도 정상 종료로 잡는다 — 즉사하면 쿠키가 날아간다", () => {
    const helperSrc = readFileSync(
      resolve(process.cwd(), "scripts/hometax-helper/index.ts"),
      "utf8",
    );
    expect(helperSrc).toMatch(/\[\s*"SIGINT",\s*"SIGTERM",\s*"SIGHUP"\s*\]/);
  });
});
