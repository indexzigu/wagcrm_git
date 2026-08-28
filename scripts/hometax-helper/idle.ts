/**
 * 유휴 자동 종료 — **순수 판정 규칙**. 타이머·프로세스·브라우저에 의존하지 않아 그대로
 * 단위 테스트한다(서버를 띄우지 않고 규칙만 검증할 수 있어야 한다).
 *
 * ## 왜 필요한가
 *
 * 헬퍼는 원래 LaunchAgent 로 **상시 기동**했다(#311). 웹페이지가 로컬 프로세스를
 * 시작시킬 수 없으니 「항상 켜져 있다」로 「누르면 켜진다」를 흉내 낸 것이다. 그런데
 * 발행은 **월 10회 미만**이라, 그 흉내의 대가로 Chrome 을 포함한 프로세스가 한 달 내내
 * 떠 있었다. 이제 CRM 버튼이 `hometax-helper://` 스킴으로 헬퍼를 **깨우므로**(온디맨드),
 * 헬퍼는 할 일이 끝나면 스스로 나가야 한다 — 안 그러면 상시 기동이 이름만 바뀐 셈이다.
 *
 * ## 무엇을 "활동"으로 보는가 (이 판정의 핵심)
 *
 * HTTP 요청만 보면 **오너의 창을 닫아 버린다.** 헬퍼가 폼을 채운 뒤 오너가 화면에서
 * 금액을 검토하는 동안엔 HTTP 요청이 한 건도 없는데, 그 시간이 30분을 넘길 수 있다.
 * 그때 종료하면 브라우저 컨텍스트가 닫히고 **채워 놓은 폼이 통째로 사라진다** — 이
 * 도구에서 가장 비싼 실패다(오너가 다시 처음부터 한다). 그래서 활동은 두 축이다:
 *
 *   ① HTTP 요청(발행·조회·검사) — 처리 **중**이면 절대 종료하지 않는다(`inFlight`).
 *   ② 브라우저 창의 **사람 입력**(클릭·키·스크롤) — `browser.ts` 가 주입 스크립트로
 *      마지막 시각을 기록하고 이 판정에 넘긴다.
 *
 * ②를 읽지 못하는 상황(창이 없다·평가 실패)은 `null` 로 오고, 그때는 ①만으로 잰다 —
 * "모르니 영원히 산다"로 가면 온디맨드 전환이 무의미해지기 때문이다.
 */

/** 창이 살아 있을 때의 유휴 한도(기본 30분). 오너의 검토 시간을 삼키지 않을 만큼 길다. */
export const DEFAULT_IDLE_MS = 30 * 60_000;

/**
 * 창조차 없을 때의 유휴 한도(5분). 스킴이 깨웠는데 CRM 쪽이 실패해 아무 요청도 오지
 * 않은 경우가 이것이다 — 잃을 것이 없으니 빨리 내려간다.
 */
export const IDLE_WITHOUT_WINDOW_MS = 5 * 60_000;

/** 판정 주기. 분 단위 한도를 다루므로 30초면 충분하고, 깨어 있는 비용도 무시할 만하다. */
export const IDLE_CHECK_INTERVAL_MS = 30_000;

/**
 * `HOMETAX_HELPER_IDLE_MINUTES` 해석. `0` 은 **명시적 비활성**(상시 기동으로 되돌리고
 * 싶을 때의 탈출구)이고, 해석할 수 없는 값은 기본값으로 떨어진다 — 오타 하나로 자동
 * 종료가 조용히 꺼지면 온디맨드 전환이 무효가 되기 때문이다(fail-safe 방향은 "켜짐").
 */
export function resolveIdleMs(raw: string | undefined): number | null {
  const text = (raw ?? "").trim();
  if (text === "") return DEFAULT_IDLE_MS;
  const minutes = Number(text);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_IDLE_MS;
  if (minutes === 0) return null;
  return minutes * 60_000;
}

export type IdleDecisionInput = {
  /** 유휴 한도(ms). `null` 이면 자동 종료 비활성. */
  idleMs: number | null;
  /** 마지막 HTTP 활동 시각(ms epoch). */
  lastRequestAt: number;
  /** 브라우저 창에서 사람이 마지막으로 조작한 시각. 읽지 못했으면 `null`. */
  lastUserInputAt: number | null;
  /** 처리 중인 요청 수. 1건이라도 있으면 종료하지 않는다. */
  inFlight: number;
  /** 브라우저 창이 살아 있는가. 없으면 더 짧은 한도를 쓴다. */
  hasWindow: boolean;
  now: number;
};

/**
 * 지금 종료해도 되는가. ⛔ **처리 중(`inFlight > 0`)이면 무조건 false** — 폼을 채우는
 * 도중에 나가면 반쯤 채워진 화면이 남는다(그 상태를 오너가 "채워졌다"로 오해하면
 * 금액이 틀린 계산서가 나간다).
 */
export function shouldShutdownForIdle(input: IdleDecisionInput): boolean {
  if (input.idleMs === null) return false;
  if (input.inFlight > 0) return false;

  const threshold = input.hasWindow
    ? input.idleMs
    : Math.min(IDLE_WITHOUT_WINDOW_MS, input.idleMs);

  const lastActivityAt = Math.max(input.lastRequestAt, input.lastUserInputAt ?? 0);
  return input.now - lastActivityAt >= threshold;
}

/**
 * 활동 장부 — 서버가 요청마다 `begin`/`end` 를 부른다.
 *
 * `end` 에서도 시각을 갱신하는 것은 의도다: 발행 1건이 수십 초 걸리므로, 시작 시각만
 * 기록하면 긴 요청이 끝나자마자 유휴로 판정될 수 있다.
 */
export function createActivityLedger(now: () => number = Date.now) {
  let lastRequestAt = now();
  let inFlight = 0;
  return {
    begin() {
      inFlight += 1;
      lastRequestAt = now();
    },
    end() {
      inFlight = Math.max(0, inFlight - 1);
      lastRequestAt = now();
    },
    get lastRequestAt() {
      return lastRequestAt;
    },
    get inFlight() {
      return inFlight;
    },
  };
}
