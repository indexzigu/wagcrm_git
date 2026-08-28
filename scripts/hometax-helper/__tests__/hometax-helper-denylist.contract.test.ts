// 홈택스 로컬 헬퍼의 **절대 금지선** 계약 — 이 파일이 "헬퍼는 발급·서명을 누르지
// 않는다"를 기계로 지킨다.
//
// 이 도구 전체의 안전성은 한 문장에 걸려 있다: 자동화는 폼 입력까지만 하고, 발급과
// 전자서명은 사람이 한다. 자동 발급은 되돌릴 수 없고(수정세금계산서 절차), 전자서명은
// 법적 행위다. 그래서 여기서는 ①금지 패턴 판정 ②deny-by-default(허용 목록 밖 거부)
// ③**가드를 우회한 click 호출이 소스에 없는지** 세 가지를 모두 본다. 마지막 항목이
// 핵심이다 — 함수만 테스트하면 미래의 코드가 그 함수를 안 부르고 page.click 을 직접
// 불러도 초록이기 때문이다.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  FORBIDDEN_CLICK_PATTERNS,
  ForbiddenClickError,
  assertClickAllowed,
  assertIssueSubmitAllowed,
  matchesForbiddenPattern,
} from "../guards";

const HELPER_DIR = resolve(process.cwd(), "scripts/hometax-helper");

describe("금지 패턴 판정", () => {
  it("발급·서명 계열 문구를 잡는다", () => {
    for (const label of ["발급하기", "전자서명", "즉시발급", "신고서 제출", "전송"]) {
      expect(matchesForbiddenPattern(label)).toBe(true);
    }
  });

  it("띄어쓰기로 우회할 수 없다", () => {
    // "발 급" 처럼 공백을 끼워 넣은 라벨이 실제 화면에 있을 수 있고(WebSquare 가
    // 마크업 사이에 공백을 넣는다), 그것이 금지선을 뚫으면 안 된다.
    expect(matchesForbiddenPattern("발 급")).toBe(true);
    expect(matchesForbiddenPattern("전자 서명 하기")).toBe(true);
  });

  it("입력을 돕는 조회·이동 문구는 막지 않는다", () => {
    // 금지 목록을 넓히면 헬퍼가 할 일이 없어진다 — 이 대조군이 그 과잉을 잡는다.
    for (const label of ["사업자번호 조회", "다음", "건별 화면", "검색"]) {
      expect(matchesForbiddenPattern(label)).toBe(false);
    }
  });

  it("이동 항목이라도 라벨에 「발급」이 들어가면 막힌다 — 처방은 라벨 개명이다", () => {
    // 가드는 라벨을 본다. 건별발급 **메뉴로 이동하는** 항목을 "건별발급"이라 부르면
    // 이동조차 막히는데, 이때 금지 목록을 완화하면 진짜 발급 버튼까지 열린다.
    // 올바른 처방은 라벨만 바꾸는 것이고(셀렉터는 그대로), 에러 메시지가 그걸 안내한다.
    expect(matchesForbiddenPattern("건별발급 메뉴")).toBe(true);
    try {
      assertClickAllowed("건별발급 메뉴", ["건별발급 메뉴"]);
      throw new Error("가드가 통과시켰다 — 금지선이 깨졌다");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenClickError);
      expect((err as Error).message).toContain("라벨");
    }
  });

  it("금지 목록에 발급·서명이 반드시 들어 있다", () => {
    // 목록을 통째로 비우거나 핵심 두 단어를 빼는 완화는 오너 승인 사안이다.
    expect(FORBIDDEN_CLICK_PATTERNS).toContain("발급");
    expect(FORBIDDEN_CLICK_PATTERNS).toContain("서명");
  });
});

describe("deny-by-default — 허용 목록 밖은 거부", () => {
  it("허용 목록에 있어도 금지 패턴이면 거부한다(이중 방어)", () => {
    // 셀렉터 맵은 오너가 손으로 쓰는 파일이라, 거기에 발급 버튼을 적어 넣는 실수가
    // 가능하다. 맵에 적는 것으로 금지선을 풀 수 없어야 한다.
    expect(() => assertClickAllowed("발급하기", ["발급하기"])).toThrow(ForbiddenClickError);
  });

  it("허용 목록에 없으면 거부한다", () => {
    expect(() => assertClickAllowed("아무 버튼", ["다음"])).toThrow(ForbiddenClickError);
  });

  it("허용 목록이 비어 있으면 아무것도 클릭하지 못한다(안전한 기본값)", () => {
    // 셀렉터 맵이 없는 초기 상태가 이것이다 — "설정 전에는 동작 안 함"이 정답이고
    // "일단 눌러봄"이 아니다.
    expect(() => assertClickAllowed("다음", [])).toThrow(ForbiddenClickError);
  });

  it("허용 목록에 있고 금지 패턴이 아니면 통과한다", () => {
    expect(() => assertClickAllowed("다음", ["다음"])).not.toThrow();
  });
});

/**
 * 금지선의 **단 하나의 예외** — 「발급하기」(오너 승인 2026-08-08).
 *
 * 이 describe 가 지키는 것은 "예외가 하나로 유지되는가"다. 예외 자체는 오너가 승인한
 * 것이지만, 그 예외가 **넓어지는 것**은 승인된 적이 없다 — 라벨로 열리거나, 선언 없이
 * 눌리거나, 확인 팝업까지 이어지면 그건 다른 결정이다.
 */
describe("발급 버튼 예외 — 셀렉터 하나로만 열린다", () => {
  const DECLARED = "#mf_txppWframe_btnIsn";

  it("선언된 셀렉터와 정확히 같을 때만 통과한다", () => {
    expect(() => assertIssueSubmitAllowed(DECLARED, DECLARED)).not.toThrow();
  });

  it("선언이 없으면 누르지 못한다 — deny-by-default 는 여기서도 유지된다", () => {
    // 셀렉터 맵을 아직 안 만든 환경(또는 오너가 이 기능을 원치 않는 환경)의 기본값이
    // "발급 버튼을 안 누름"이어야 한다.
    expect(() => assertIssueSubmitAllowed(DECLARED, undefined)).toThrow(ForbiddenClickError);
    expect(() => assertIssueSubmitAllowed(DECLARED, "  ")).toThrow(ForbiddenClickError);
  });

  it("선언과 다른 요소는 누르지 못한다 — 즉시발급·일괄발급으로 번지지 않는다", () => {
    expect(() => assertIssueSubmitAllowed("#btnIsnBatch", DECLARED)).toThrow(ForbiddenClickError);
  });

  it("라벨 경로는 여전히 「발급」을 막는다 — 예외는 라벨을 통해 열리지 않는다", () => {
    // 이 예외가 생겼다고 해서 `assertClickAllowed` 가 물러나면, 홈택스의 모든 발급
    // 계열 버튼이 함께 열린다. 두 경로는 끝까지 분리돼 있어야 한다.
    expect(matchesForbiddenPattern("발급하기")).toBe(true);
    expect(() => assertClickAllowed("발급하기", ["발급하기"])).toThrow(ForbiddenClickError);
  });

  it("「서명」은 끝까지 막힌다 — 멈추는 지점이 뒤로 갔어도 서명은 사람 몫이다", () => {
    // 2026-08-08 에 금지선이 두 번 움직였다: 발급하기까지 → 비밀번호 창까지.
    // 그 과정에서 「인증 화면 이동」은 금지 목록에서 빠졌지만(오너 승인), 「서명」은
    // 남는다. 이 테스트가 초록이어야 마지막 선이 살아 있는 것이다.
    expect(matchesForbiddenPattern("전자서명")).toBe(true);
    expect(matchesForbiddenPattern("서명하기")).toBe(true);
  });

  it("인증 단계 라벨은 **선언됐을 때만** 눌린다 — 목록이 곧 자동화의 범위다", () => {
    // 「확인(인증 화면 이동)」은 이제 금지어가 아니지만, 그렇다고 아무 데서나 눌리는
    // 것은 아니다. deny-by-default 라 선언된 단계 목록 안에 있을 때만 통과한다 —
    // 비밀번호 키패드의 숫자가 안전한 이유도 정확히 이것이다(어떤 라벨과도 안 맞는다).
    const steps = ["확인(인증 화면 이동)", "금융 인증", "금융인증서", "전자세금용"];
    for (const label of steps) {
      expect(() => assertClickAllowed(label, steps)).not.toThrow();
    }
    // 선언 밖 — 키패드 숫자·서명 버튼은 어느 쪽으로도 통과하지 못한다.
    for (const outsider of ["1", "7", "확인", "서명"]) {
      expect(() => assertClickAllowed(outsider, steps)).toThrow(ForbiddenClickError);
    }
  });

  it("음성 대조군 — 로그인에 쓰는 인증 라벨은 막지 않는다", () => {
    // 「인증」 단독을 금지어로 넣었다면 로그인 자동화가 통째로 죽는다(실제로 클릭한다).
    for (const label of ["공동·금융인증", "금융인증", "전자세금용", "확인"]) {
      expect(matchesForbiddenPattern(label)).toBe(false);
    }
  });
});

describe("소스 스캔 — 가드를 우회한 클릭이 없다", () => {
  /**
   * 주석을 걷어낸 소스만 스캔한다 — 이 파일들은 "왜 0.0.0.0 으로 열면 안 되는가"
   * 같은 설명을 주석에 담고 있어서, 원문 그대로 검사하면 **설명이 위반으로 잡힌다**
   * (실제로 첫 실행에서 그렇게 실패했다). 검사 대상은 실행되는 코드다.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  function readHelperSources(): Array<{ file: string; source: string }> {
    return readdirSync(HELPER_DIR)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({
        file: name,
        source: stripComments(readFileSync(join(HELPER_DIR, name), "utf8")),
      }));
  }

  it("클릭을 호출하는 파일은 가드를 통과시킨다", () => {
    // page.click / locator.click / mouse.click 을 부르면서 가드를 부르지 않는 파일이
    // 있으면 실패. 미래에 새 파일이 클릭을 추가해도 이 스캔에 걸린다(단위 테스트로는
    // 못 막는 지점).
    //
    // 가드는 두 형태가 허용된다:
    //   ① `assertClickAllowed` — 셀렉터로 누르는 경로. 금지 패턴 + **허용 목록**을 본다.
    //   ② `matchesForbiddenPattern` — **좌표로** 누르는 경로(`/click` 엔드포인트).
    //      좌표 클릭의 용도가 「셀렉터를 모르는 메뉴를 탐색」이라 허용 목록을 미리
    //      만들 수 없다. 그래서 허용 목록은 요구하지 않되, 클릭 직전에
    //      `elementFromPoint` 로 그 지점의 텍스트를 읽어 **금지 패턴은 그대로 검사**한다
    //      — 좌표로 발급 버튼을 누르는 우회를 막는 것이 이 예외의 유일한 조건이다.
    //      ⛔ 이 예외를 「좌표는 검사 안 함」으로 넓히지 말 것.
    const offenders = readHelperSources()
      .filter(({ source }) => /\.click\s*\(/.test(source))
      .filter(
        ({ source }) =>
          !source.includes("assertClickAllowed") && !source.includes("matchesForbiddenPattern"),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("좌표 클릭 경로는 클릭 전에 금지 패턴을 검사한다", () => {
    // 위 예외가 성립하려면 좌표 클릭 파일이 실제로 두 가지를 해야 한다:
    // ①지점의 요소를 읽고(elementFromPoint) ②금지 패턴으로 검사.
    const source = readHelperSources().find((f) => f.file === "index.ts")!.source;
    if (!/mouse\.click\s*\(/.test(source)) return; // 좌표 클릭이 없으면 검사 대상 아님
    expect(source).toContain("elementFromPoint");
    expect(source).toContain("matchesForbiddenPattern");
  });

  it("양성 대조군 — 스캔 정규식이 실제로 클릭 호출을 잡는다", () => {
    // 정규식이 깨져 아무것도 매칭하지 않으면 위 테스트가 공짜로 초록이 된다.
    // 클릭을 실제로 하는 파일(fill.ts)이 스캔에 잡히는지 확인한다.
    const clickers = readHelperSources()
      .filter(({ source }) => /\.click\s*\(/.test(source))
      .map(({ file }) => file);
    expect(clickers).toContain("fill.ts");
  });

  it("발급 클릭은 검증을 **통과한 뒤에만** 나간다 — 순서가 안전장치다", () => {
    // 2026-08-06 사고(세액이 덧붙어 100,000 → 100,000,100,000)를 잡은 것이 값 대조
    // 검사다. 발급 클릭이 그 검사보다 먼저 나가면, 조용히 틀린 금액이 확인 팝업까지
    // 올라가고 오너는 팝업 요약(합계만 보인다)에서 그걸 알아채기 어렵다.
    const source = readHelperSources().find((f) => f.file === "index.ts")!.source;
    const mismatchAt = source.indexOf("outcome.mismatched.length > 0");
    const choiceAt = source.indexOf("outcome.pendingUserChoice");
    const submitAt = source.indexOf("await submitIssueForm(");
    expect(mismatchAt).toBeGreaterThan(-1);
    expect(submitAt).toBeGreaterThan(mismatchAt);
    expect(submitAt).toBeGreaterThan(choiceAt);
  });

  it("발행 전 자체 검토가 발급 클릭보다 앞선다 — 사람 검토를 대신하는 장치다", () => {
    // 헬퍼가 발급 버튼을 누르게 되면서 오너가 폼을 눈으로 보는 단계가 사라졌다
    // (2026-08-08 개정). 그 자리를 기계 대조가 대신하므로, 이 호출이 클릭보다 뒤로
    // 가면 **아무도 보지 않은 채** 발급 확인창까지 올라간다.
    const source = readHelperSources().find((f) => f.file === "index.ts")!.source;
    const preflightAt = source.indexOf("await preflightBeforeSubmit(");
    const submitAt = source.indexOf("await submitIssueForm(");
    expect(preflightAt).toBeGreaterThan(-1);
    expect(submitAt).toBeGreaterThan(preflightAt);
  });

  it("바이트 상한을 헬퍼가 따로 정의하지 않는다 — CRM 과 같은 SSOT 를 쓴다", () => {
    // 상한이 두 벌이 되면 한쪽은 자르고 다른 쪽은 통과시키는 상태가 된다.
    const fillSrc = readHelperSources().find((f) => f.file === "fill.ts")!.source;
    expect(fillSrc).toContain("hometax-text");
    expect(fillSrc).not.toMatch(/HOMETAX_TEXT_MAX_BYTES\s*=\s*\d/);
  });

  it("발급 클릭 경로는 한 곳뿐이다 — 예외가 여러 자리로 번지지 않는다", () => {
    const callers = readHelperSources().filter(({ source }) =>
      source.includes("assertIssueSubmitAllowed"),
    );
    // guards.ts(정의) + fill.ts(유일한 사용처).
    expect(callers.map((c) => c.file).sort()).toEqual(["fill.ts", "guards.ts"]);
  });

  it("headless 로 브라우저를 띄우지 않는다", () => {
    // 이 도구의 전제가 "오너가 화면을 보고 검토 후 발급"이다. headless 를 허용하는
    // 순간 무인 자동화로 가는 문이 생기므로, 옵션으로도 두지 않는다.
    const browserSource = readHelperSources().find((f) => f.file === "browser.ts")!.source;
    expect(browserSource).toMatch(/headless:\s*false/);
    expect(browserSource).not.toMatch(/headless:\s*true/);
  });

  it("바인딩 주소가 loopback 이다 — 같은 네트워크의 다른 기기가 붙지 못한다", () => {
    const httpSource = readHelperSources().find((f) => f.file === "http.ts")!.source;
    expect(httpSource).toMatch(/BIND_HOST\s*=\s*"127\.0\.0\.1"/);
    expect(httpSource).not.toContain("0.0.0.0");
  });

  it("음성 대조군 — 주석 제거가 코드까지 지우지 않는다", () => {
    // stripComments 가 과하게 잘라내면 위 스캔들이 전부 공짜로 초록이 된다.
    // 실행 코드의 핵심 토큰이 살아 있는지 확인한다.
    const guardSource = readHelperSources().find((f) => f.file === "guards.ts")!.source;
    expect(guardSource).toContain("export function assertClickAllowed");
    expect(guardSource).toContain("FORBIDDEN_CLICK_PATTERNS");
  });
});

describe("자동계산 확인 창 — 우리가 연 창만, 문구로 판별한 뒤에 닫는다", () => {
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }
  const FILL_SRC = stripComments(
    readFileSync(resolve(process.cwd(), "scripts/hometax-helper/fill.ts"), "utf8"),
  );

  it("문구 판별이 클릭보다 앞선다 — 발급 확인 창도 같은 위젯일 수 있다", () => {
    const fn = FILL_SRC.slice(FILL_SRC.indexOf("async function confirmCalculationDialog"));
    const guardAt = fn.indexOf("CALCULATION_DIALOG_PATTERN");
    const clickAt = fn.indexOf(".click(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(clickAt);
    // 판별 문구가 실제로 자동계산 창의 것이어야 한다(아무 창이나 닫으면 안 된다).
    expect(FILL_SRC).toMatch(/공급가액\[.*세액/);
  });

  it("우리가 띄운 창을 우리가 닫는다 — 계산 클릭 뒤에 확인이 온다", () => {
    // 열어 놓고 끝내면 오너 화면이 모달에 막힌 채 남고, 「선택해 주세요」라는 잘못된
    // 안내가 나간다(2026-08-07 실사용에서 그렇게 나갔다).
    const calcAt = FILL_SRC.indexOf("calculatedAmount = true");
    const confirmAt = FILL_SRC.indexOf("await confirmCalculationDialog(page)");
    const detectAt = FILL_SRC.indexOf("pendingUserChoice = (await detectPendingChoice(page))");
    expect(confirmAt).toBeGreaterThan(calcAt);
    expect(confirmAt).toBeLessThan(detectAt);
  });
});

describe("로그인 모듈 — 구조적으로 타이핑할 수 없다", () => {
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }
  const LOGIN_SRC = stripComments(
    readFileSync(resolve(process.cwd(), "scripts/hometax-helper/login.ts"), "utf8"),
  );

  it("⛔ 타이핑 호출이 한 줄도 없다 — 인증서 비밀번호는 사람이 누른다", () => {
    // 이 도구의 전제가 「자동화는 입력까지, 발급·서명은 사람이」이고, 로그인 자동화는
    // 그 선의 반대편이다. 언어를 바꾸든 모듈을 옮기든 같다 — 그래서 이 모듈은
    // **누를 수만 있고 칠 수는 없게** 만들어 두고, 그 사실을 여기서 고정한다.
    for (const forbidden of [".fill(", ".type(", "insertText", "keyboard.press", "pressSequentially"]) {
      expect(LOGIN_SRC).not.toContain(forbidden);
    }
  });

  it("클릭은 가드를 지난다", () => {
    expect(LOGIN_SRC).toContain("assertClickAllowed");
  });

  it("양성 대조군 — 스캔이 실제로 이 파일을 읽고 있다", () => {
    // 위 not.toContain 들이 빈 문자열을 검사해 공짜로 통과하는 것을 막는다.
    expect(LOGIN_SRC).toContain("export async function navigateToLoginPrompt");
    expect(LOGIN_SRC.length).toBeGreaterThan(400);
  });

  it("못 찾으면 멈춘다 — 다음 단계를 추측하지 않는다", () => {
    // 로그인 화면의 오클릭은 인증 수단을 잘못 고르는 일이다.
    expect(LOGIN_SRC).toContain("stoppedAt");
  });

  it("⛔ 아무 「확인」이나 누르지 않는다 — 알림 문구로 먼저 판별한다", () => {
    // 홈택스의 확인 버튼은 표준 위젯이라 **발급 직전 확인창도 같은 셀렉터**를 쓸 수
    // 있다. 무엇을 확인하는지 모르는 채 누르는 것은 이 도구가 절대 하지 않기로 한
    // 일이므로, 클릭 전에 「로그인 정보가 없습니다」 문구 판별이 반드시 앞서야 한다.
    const dismiss = LOGIN_SRC.slice(LOGIN_SRC.indexOf("export async function dismissLoginRequiredAlert"));
    const guardAt = dismiss.indexOf("hasLoginRequiredAlert");
    const clickAt = dismiss.indexOf(".click(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(clickAt);
    // 판별에 쓰는 문구가 실제로 로그인 관련이어야 한다(아무 알림이나 닫으면 안 된다).
    expect(LOGIN_SRC).toMatch(/로그인\\s\*정보가\\s\*없습니다/);
  });

  it("iframe 까지 뒤지고, 보이는 것만 고른다 — 둘 다 실사고에서 나왔다", () => {
    // ① 인증서 선택창은 별도 iframe(NTSMagicLine4Web)이라 `page.getByText` 만으로는
    //    영영 안 잡힌다 — 로그인 2단계가 매번 여기서 멈췄다.
    // ② 홈택스는 숨은 메뉴에 같은 문구를 잔뜩 갖고 있어, `.first()` 는 숨은 것을 골라
    //    클릭이 안 된다(`browser.ts` 의 로그인 판정이 밟은 것과 같은 함정).
    expect(LOGIN_SRC).toContain("page.frames()");
    expect(LOGIN_SRC).toContain("filter({ visible: true })");
    // 종전의 「첫 번째를 집어 보이는지 본다」 방식으로 되돌아가지 않게 고정한다.
    expect(LOGIN_SRC).not.toMatch(/getByText\([^)]*\)\s*\n?\s*\.first\(\)\s*\n?\s*\.isVisible/);
  });

  it("찾기·클릭 실패를 삼키지 않는다 — 두 사실은 원인이 다르다", () => {
    // 「못 찾았다」와 「찾았는데 못 눌렀다」가 같은 문구로 보고돼 원인을 여러 번
    // 헛짚었다(2026-08-07). 클릭 실패 경로에 로그가 반드시 있어야 한다.
    const clickCatch = LOGIN_SRC.slice(LOGIN_SRC.indexOf("await target.click"));
    expect(clickCatch).toContain("console.error");
  });

  it("알림 확인 버튼의 자동 생성 id 를 소스에 박지 않는다", () => {
    // 실측 id 는 `mf_wfHeader_info700806079_wframe_btn_confirm` 인데 가운데가 세션마다
    // 바뀐다(`selectors.ts` 가 경고하는 그 종류). 접미사로만 잡아야 한다.
    expect(LOGIN_SRC).toContain('input[id$="_wframe_btn_confirm"]');
    expect(LOGIN_SRC).not.toMatch(/mf_\w*info\d{6,}/);
  });
});
