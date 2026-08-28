// 유휴 자동 종료 계약 — 「온디맨드 전환」의 두 방향 실패를 동시에 막는다.
//
// 이 기능은 실패 방향이 둘이고, 둘 다 조용하다:
//   ⓐ **너무 오래 산다** — 유휴 판정이 무언가에 걸려 안 내려가면, LaunchAgent 를 뗀
//      의미가 사라진다(상시 기동이 이름만 바뀐 상태). 실제로 `/health` 폴링을 활동으로
//      세는 바람에 첫 실측에서 3분이 지나도 안 내려갔다.
//   ⓑ **너무 일찍 죽는다** — 폼을 채우는 중이거나 오너가 화면을 검토하는 중에 나가면
//      채워 둔 홈택스 폼이 통째로 사라진다(가장 비싼 실패 — 처음부터 다시 한다).
//
// 그래서 여기서는 판정 규칙(idle.ts)과 **서버가 그 규칙을 어떻게 부르는지**(index.ts
// 소스 스캔) 양쪽을 본다. 규칙만 테스트하면 미래의 서버가 `/health` 를 다시 활동으로
// 세도 초록이기 때문이다.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_IDLE_MS,
  IDLE_WITHOUT_WINDOW_MS,
  createActivityLedger,
  resolveIdleMs,
  shouldShutdownForIdle,
} from "../idle";

const MIN = 60_000;
const base = {
  idleMs: DEFAULT_IDLE_MS,
  lastRequestAt: 0,
  lastUserInputAt: null as number | null,
  inFlight: 0,
  hasWindow: true,
  now: 0,
};

describe("유휴 판정 — 너무 일찍 죽지 않는다", () => {
  it("처리 중(inFlight>0)이면 아무리 오래 유휴여도 종료하지 않는다", () => {
    // 발행 1건은 수십 초가 걸린다. 그 사이에 나가면 반쯤 채워진 폼이 남고, 오너가
    // 그것을 "채워졌다"로 오해하면 금액이 틀린 계산서가 나간다.
    expect(shouldShutdownForIdle({ ...base, inFlight: 1, now: 10 * 60 * MIN })).toBe(false);
  });

  it("오너가 창을 만지고 있으면 요청이 없어도 종료하지 않는다", () => {
    // HTTP 만 보면 "폼을 채운 뒤 오너가 30분 넘게 검토하는" 정상 상황에서 창을 닫는다.
    const now = 40 * MIN;
    expect(
      shouldShutdownForIdle({ ...base, lastRequestAt: 0, lastUserInputAt: now - MIN, now }),
    ).toBe(false);
  });

  it("한도 이전에는 종료하지 않는다", () => {
    expect(shouldShutdownForIdle({ ...base, now: DEFAULT_IDLE_MS - 1 })).toBe(false);
  });
});

describe("유휴 판정 — 너무 오래 살지도 않는다", () => {
  it("요청도 입력도 한도를 넘으면 종료한다", () => {
    const now = 31 * MIN;
    expect(
      shouldShutdownForIdle({ ...base, lastRequestAt: 0, lastUserInputAt: MIN, now }),
    ).toBe(true);
  });

  it("창이 없으면 더 짧은 한도를 쓴다 — 잃을 것이 없다", () => {
    // 스킴이 깨웠는데 CRM 쪽이 실패해 아무 요청도 오지 않은 경우가 이것이다.
    const now = IDLE_WITHOUT_WINDOW_MS + 1;
    expect(shouldShutdownForIdle({ ...base, hasWindow: false, now })).toBe(true);
    expect(shouldShutdownForIdle({ ...base, hasWindow: true, now })).toBe(false);
  });

  it("입력 시각을 읽지 못하면(null) 요청 기준으로 판정한다 — 모른다고 영생하지 않는다", () => {
    expect(
      shouldShutdownForIdle({ ...base, lastUserInputAt: null, now: DEFAULT_IDLE_MS }),
    ).toBe(true);
  });
});

describe("한도 해석 — 꺼지는 쪽으로 기울지 않는다", () => {
  it("미설정이면 기본값", () => {
    expect(resolveIdleMs(undefined)).toBe(DEFAULT_IDLE_MS);
    expect(resolveIdleMs("")).toBe(DEFAULT_IDLE_MS);
  });

  it("해석할 수 없는 값도 기본값이다 — 오타 하나로 자동 종료가 조용히 꺼지면 안 된다", () => {
    expect(resolveIdleMs("삼십")).toBe(DEFAULT_IDLE_MS);
    expect(resolveIdleMs("-5")).toBe(DEFAULT_IDLE_MS);
  });

  it("0 만이 명시적 비활성이고, 비활성이면 절대 종료하지 않는다", () => {
    expect(resolveIdleMs("0")).toBeNull();
    expect(shouldShutdownForIdle({ ...base, idleMs: null, now: 10 * 60 * MIN })).toBe(false);
  });

  it("분 단위로 해석한다", () => {
    expect(resolveIdleMs("45")).toBe(45 * MIN);
  });
});

describe("활동 장부", () => {
  it("긴 요청은 시작이 아니라 **끝** 시각으로 남는다", () => {
    // 시작 시각만 기록하면 수십 초짜리 발행이 끝나자마자 유휴로 판정될 수 있다.
    let clock = 1_000;
    const ledger = createActivityLedger(() => clock);
    ledger.begin();
    clock = 60_000;
    expect(ledger.inFlight).toBe(1);
    ledger.end();
    expect(ledger.lastRequestAt).toBe(60_000);
    expect(ledger.inFlight).toBe(0);
  });
});

describe("소스 스캔 — 서버가 규칙을 제대로 부른다", () => {
  const INDEX_SRC = readFileSync(
    resolve(process.cwd(), "scripts/hometax-helper/index.ts"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("`/health` 는 활동으로 세지 않는다 — 폴링 한 줄이 온디맨드를 무효화한다", () => {
    // 실측(2026-08-07): 15초 간격 health 폴링 때문에 유휴 종료가 영영 발화하지 않았다.
    expect(INDEX_SRC).toMatch(/const counted = !\(req\.method === "GET" && req\.url === "\/health"\)/);
    expect(INDEX_SRC).toContain("if (counted) activity.begin()");
    expect(INDEX_SRC).toContain("if (counted) activity.end()");
  });

  it("종료 전에 브라우저를 정상적으로 닫는다 — 강제 종료는 로그인 세션을 날린다", () => {
    // 2026-08-06 실측: kill -9 하면 Chrome 이 쿠키를 못 써서 홈택스 재로그인이 필요했다.
    // 온디맨드는 "다음에 깨어나도 로그인이 살아 있다"가 전제라 이 순서가 곧 전제 조건이다.
    const shutdown = INDEX_SRC.slice(INDEX_SRC.indexOf("function startIdleWatchdog"));
    expect(shutdown.indexOf("await closeSession()")).toBeGreaterThan(-1);
    expect(shutdown.indexOf("await closeSession()")).toBeLessThan(shutdown.indexOf("process.exit(0)"));
  });

  it("종료 직전에 요청이 도착하면 종료를 취소한다 — 판정과 종료 사이가 원자적이지 않다", () => {
    // `closeSession()` 은 Chrome 을 정상 종료하느라 시간이 걸린다. 그 사이 도착한
    // 요청을 무시하고 나가면 **처리 중에 죽는다**(막으려던 실패 그 자체).
    const shutdown = INDEX_SRC.slice(INDEX_SRC.indexOf("function startIdleWatchdog"));
    const closeAt = shutdown.indexOf("await closeSession()");
    const recheckAt = shutdown.indexOf("activity.inFlight > 0");
    const exitAt = shutdown.indexOf("process.exit(0)");
    expect(recheckAt).toBeGreaterThan(closeAt);
    expect(recheckAt).toBeLessThan(exitAt);
  });

  it("감시자가 실제로 켜진다", () => {
    expect(INDEX_SRC).toContain("startIdleWatchdog();");
  });

  it("입력 표식은 사람 입력만 남긴다 — 문서 로드로 찍히면 판정이 늦춰진다", () => {
    // `addInitScript` 는 새 문서마다 다시 돈다. 주입 시점에 값을 찍으면 홈택스의
    // 자동 로그아웃 리다이렉트 같은 **사람 아닌 이동**이 "방금 조작"으로 기록된다.
    const browserSrc = readFileSync(
      resolve(process.cwd(), "scripts/hometax-helper/browser.ts"),
      "utf8",
    );
    const script = browserSrc.slice(
      browserSrc.indexOf("const INPUT_MARKER_SCRIPT"),
      browserSrc.indexOf("async function launch"),
    );
    expect(script).toContain("addEventListener");
    expect(script).not.toMatch(/^\s*mark\(\);\s*$/m);
  });
});
