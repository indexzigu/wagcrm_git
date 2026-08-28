/**
 * 로그인 **화면까지만** 데려다 놓는다 — 비밀번호는 사람이 누른다.
 *
 * ## ⛔ 이 모듈은 절대 타이핑하지 않는다
 *
 * 여기 있는 것은 클릭뿐이다. `fill` · `type` · `press` · `insertText` 가 **한 줄도
 * 없어야** 하고, 계약 테스트가 그것을 소스 스캔으로 강제한다. 인증서 비밀번호를
 * 프로그램이 입력하는 순간 이 도구의 전제(「자동화는 입력까지, 발급·서명은 사람이」)가
 * 무너진다 — 그 선은 언어를 바꿔도, 모듈을 바꿔도 같다.
 *
 * 그래서 이 파일의 목표는 **여섯 자리를 누를 창을 띄워 놓는 것**까지다. 오너가 창을
 * 찾아 들어가는 수고를 없애되, 마지막 행위는 사람에게 남긴다.
 *
 * ## 왜 id 가 아니라 글자로 누르는가
 *
 * 로그인 화면의 요소 id 는 `mf_txppWframe_loginboxFrame_wq_uuid_923` 처럼 **자동
 * 생성**이다(2026-08-06 덤프 실측) — `selectors.ts` 가 경고하는 바로 그 종류라 세션마다
 * 바뀐다. 반면 이 화면의 버튼은 사람이 읽는 글자가 또렷하고(「공동·금융인증」 등) 잘
 * 바뀌지 않는다. 게다가 그 다음 화면들(인증 수단 선택 → 인증서 목록)은 **클릭해야
 * 생기므로** 미리 덤프할 수도 없다. 이 화면에서는 글자가 id 보다 안정적인 좌표다.
 *
 * 못 찾으면 **거기서 멈춘다.** 다음 단계를 추측해 아무 버튼이나 누르지 않는다 —
 * 로그인 화면에서의 오클릭은 인증 수단을 잘못 고르는 것으로 이어진다.
 */
import type { Page } from "playwright";
import { assertClickAllowed } from "./guards";
import type { SelectorMap } from "./selectors";

/**
 * 세션이 끊긴 채 로그인 필요 화면으로 들어가면 홈택스가 띄우는 **모달 알림**의 문구.
 *
 * 🪤 이 모달이 이 기능의 실제 실패 원인이었다(2026-08-07 오너 실사용 + 실화면 실측).
 * 모달은 화면 전체를 덮는 오버레이라 뒤쪽 로그인 카드가 **보이기는 해도 눌리지 않는다**
 * — Playwright 는 요소를 visible 로 판정한 뒤 클릭에서 "다른 요소가 포인터 이벤트를
 * 가로챈다"로 타임아웃한다. 그래서 로그인 단계 1번(「공동·금융인증」)에서 그대로 멈췄고,
 * 겉보기엔 "셀렉터를 못 찾는다"처럼 보였다(맵은 멀쩡했다).
 */
const LOGIN_REQUIRED_ALERT_PATTERN = /로그인\s*정보가\s*없습니다/;

/** 모달의 「확인」 — 누르면 홈택스가 스스로 로그인 페이지로 이동한다(모달 문구 그대로). */
const ALERT_CONFIRM_LABEL = "확인";

/**
 * WebSquare 표준 알림의 확인 버튼. **id 앞부분은 자동 생성**이라(`info700806079`)
 * 접미사로만 잡는다 — 실측 id: `mf_wfHeader_info700806079_wframe_btn_confirm`.
 */
const ALERT_CONFIRM_SELECTOR = 'input[id$="_wframe_btn_confirm"]';

/** 로그인 필요 알림이 지금 떠 있는가 — 「로그인이 풀렸다」의 **단정적** 신호다. */
export async function hasLoginRequiredAlert(page: Page): Promise<boolean> {
  // 여기서도 `.first().isVisible()` 을 쓰지 않는다 — 같은 함정을 두 번 밟지 않기 위해
  // 판정 방식을 한 가지(보이는 것의 개수)로 통일한다.
  return page
    .getByText(LOGIN_REQUIRED_ALERT_PATTERN)
    .filter({ visible: true })
    .count()
    .then((n) => n > 0)
    .catch(() => false);
}

/**
 * 로그인 필요 알림을 닫는다 — **그 알림일 때만.**
 *
 * ⛔ 아무 「확인」이나 누르지 않는다. 홈택스의 확인 버튼은 표준 위젯이라 같은 셀렉터를
 * 다른 알림도 쓰는데, 무엇을 확인하는지 모르는 채 누르는 것은 이 도구가 절대 하지
 * 않기로 한 일이다(발급 직전 확인창일 수도 있다). 그래서 **문구로 먼저 판별**하고,
 * 그 다음에야 누른다. 금지 패턴 검사도 그대로 지난다.
 */
export async function dismissLoginRequiredAlert(page: Page): Promise<boolean> {
  if (!(await hasLoginRequiredAlert(page))) return false;

  assertClickAllowed(ALERT_CONFIRM_LABEL, [ALERT_CONFIRM_LABEL]);
  const confirm = page.locator(ALERT_CONFIRM_SELECTOR).first();
  const visible = await confirm.isVisible({ timeout: 3_000 }).catch(() => false);
  // 접미사 규칙이 깨졌으면 보이는 「확인」 버튼으로 한 번 더 시도한다 — 문구 판별을
  // 이미 통과했으므로 대상은 이 알림이다.
  const target = visible
    ? confirm
    : page.getByRole("button", { name: ALERT_CONFIRM_LABEL, exact: true }).first();
  await target.click({ timeout: 8_000 });

  // 홈택스가 스스로 로그인 페이지로 이동한다 — 그 전환이 끝나야 다음 단계가 DOM 에 있다.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1_200);
  return true;
}

/**
 * 라벨이 **보이는 채로** 있는 곳을 찾는다 — 메인 프레임에 없으면 iframe 까지 뒤진다.
 *
 * 🪤 **인증서 선택창은 iframe 안에 있다**(2026-08-07 실측). 「공동·금융인증」을 누르면
 * 뜨는 그 창(Dream Security)의 요소는 메인 프레임 DOM 에 **한 개도 없다** — 같은
 * 시점의 덤프에서 메인 프레임 요소 452개 중 인증서 창 관련은 0개였다. 그래서
 * `page.getByText` 만 쓰던 종전 코드는 1단계까지만 성공하고 2단계(「금융인증」 탭)에서
 * 매번 「화면에서 찾지 못했다」로 멈췄다 — 화면에는 뻔히 보이는데.
 *
 * 🪤 `.filter({ visible: true })` 도 필수다. 홈택스는 숨은 메뉴 트리에 같은 문구를
 * 잔뜩 갖고 있어서, 그냥 `.first()` 를 집으면 **숨은 것**을 골라 클릭이 영영 안 된다
 * (`browser.ts` 의 로그인 판정이 밟은 것과 같은 함정).
 *
 * 🪤 **자식 프레임을 먼저 본다.** 대화창이 떠 있으면 지금 조작 대상은 그쪽이고, 뒤쪽
 * 메인 화면에는 비슷한 문구가 그대로 남아 있다 — 실측에서 메인의 「공동·금융인증」이
 * 2단계 「금융인증」에도 부분 일치했다. 메인을 먼저 보면 **직전 단계를 다시 누르는**
 * 셈이 된다.
 *
 * 🪤 **기다려야 한다.** 인증서 창은 별도 앱(`NTSMagicLine4Web`)이라 1단계 클릭 후
 * 붙는 데 시간이 걸린다. 한 번 훑고 마는 방식은 프레임이 아직 없을 때 그냥 실패했다 —
 * 그게 「화면엔 보이는데 못 찾았다」의 정체였다.
 */
/**
 * 인증서 창(`NTSMagicLine4Web`)은 보안 모듈을 얹은 별도 앱이라 붙는 데 오래 걸린다 —
 * 15초로는 부족해 2단계에서 매번 놓쳤다(2026-08-07 실측). 못 찾는 경우의 대기가
 * 길어지는 대신, 그 실패는 어차피 「열린 창에서 이어서 하세요」로 끝나므로 손해가 작다.
 */
const STEP_WAIT_MS = 30_000;

async function waitForVisibleByText(
  page: Page,
  label: string,
  alreadyClicked: readonly string[] = [],
  timeoutMs = STEP_WAIT_MS,
): Promise<{
  candidate: ReturnType<Page["locator"]>;
  /** 무엇으로 찾았는가 — 오클릭 진단의 근거다(아래 clickLabeledSteps 의 로그). */
  via: "text" | "alt" | "title" | "aria";
  frameUrl: string;
} | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frames = page.frames();
    const ordered = [...frames.filter((f) => f !== page.mainFrame()), page.mainFrame()];
    for (const frame of ordered) {
      /**
       * 🪤 **글자만 보면 아이콘 컨트롤을 영영 못 찾는다**(2026-08-08 실측). 발급 인증
       * 경로의 인증서 선택창(MagicLine)은 탭이 아이콘이라 라벨이 **텍스트 노드가 아니다**
       * — 그 프레임엔 링크가 0개이고 탭은 버튼도 아니어서 덤프에도 안 잡힌다.
       * `getByText("금융인증서")` 가 30초를 다 쓰고 실패했고, 프레임은 그때 분명히
       * 붙어 있었다(로그의 프레임 목록으로 확인). 그래서 접근성 라벨까지 훑는다.
       *
       * 순서는 **좁은 것부터** — 텍스트가 있으면 그게 가장 확실한 좌표이고, 없을 때만
       * alt·title·aria-label 로 내려간다(넓은 것을 먼저 보면 엉뚱한 요소를 집는다).
       */
      const byText = frame.getByText(label, { exact: false }).filter({ visible: true }).first();
      const byAlt = frame.getByAltText(label, { exact: false }).filter({ visible: true }).first();
      const byTitle = frame.getByTitle(label, { exact: false }).filter({ visible: true }).first();
      const byAria = frame.locator(`[aria-label*="${label}"]`).filter({ visible: true }).first();

      const lookups = [
        { candidate: byText, via: "text" as const },
        { candidate: byAlt, via: "alt" as const },
        { candidate: byTitle, via: "title" as const },
        { candidate: byAria, via: "aria" as const },
      ];
      let found: { candidate: typeof byText; via: "text" | "alt" | "title" | "aria" } | null = null;
      for (const lookup of lookups) {
        if ((await lookup.candidate.count().catch(() => 0)) > 0) {
          found = lookup;
          break;
        }
      }
      if (!found) continue;
      const candidate = found.candidate;
      /**
       * 🪤 **직전 단계에서 이미 누른 것을 다시 집지 않는다**(2026-08-07 실측).
       * 단계 라벨이 서로 부분 문자열이다 — 「금융인증」은 1단계 「공동·금융인증」에도
       * 걸린다. 인증서 창이 아직 안 그려진 찰나에 메인 화면을 보면 **직전 단계의
       * 요소**가 잡히고, 그것은 이미 대화창에 덮여 있어 클릭이 타임아웃한다
       * (실측 로그: `locator resolved to <span …>공동·금융인증</span>`).
       * 건너뛰면 대화창이 뜰 때까지 계속 기다린다.
       */
      const text = (await candidate.textContent().catch(() => null))?.trim() ?? "";
      if (alreadyClicked.some((prev) => text === prev)) continue;
      return { candidate, via: found.via, frameUrl: frame.url().slice(0, 60) };
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(500);
  }
}

/**
 * 라벨 목록을 순서대로 눌러 간다 — 로그인과 **발급 인증**이 공유하는 걷기 기계.
 *
 * ⛔ **복제하지 말 것.** 이 루프에는 눈에 안 보이는 해결책이 셋 박혀 있고, 사본은
 * 그중 하나를 반드시 잃는다: ①인증서 창이 별도 앱이라 30초를 기다린다 ②직전에 누른
 * 라벨을 다시 집지 않는다(단계 라벨이 서로 부분 문자열이다) ③iframe 을 메인보다
 * 먼저 본다(대화창이 조작 대상이고, 메인엔 직전 화면이 남아 있다).
 *
 * 각 라벨은 `assertClickAllowed(label, steps)` 를 지난다 — **선언된 단계만** 눌린다
 * (deny-by-default). 그래서 이 목록이 곧 자동화가 닿는 범위의 전부다.
 */
export async function clickLabeledSteps(
  page: Page,
  steps: readonly string[],
): Promise<{ clicked: string[]; stoppedAt: string | null }> {
  const clicked: string[] = [];
  for (const label of steps) {
    assertClickAllowed(label, steps);
    const startedAt = Date.now();
    const target = await waitForVisibleByText(page, label, clicked);
    /**
     * **무엇을 집었는지까지** 남긴다(2026-08-09 확장). 종전에는 「찾음」만 남겨서,
     * 걷기가 성공을 보고했는데 화면이 엉뚱한 상태로 남는 증상(인증서 선택창 멈춤 —
     * 미해결)에서 **무엇을 클릭했는지** 알 수 없었다. 매치 경로(text/alt/title/aria)·
     * 프레임·요소 텍스트가 있으면 오클릭인지 정상 클릭 후 화면이 안 넘어간 것인지
     * 갈 수 있다.
     */
    if (!target) {
      console.log(
        `[hometax-helper] 단계 "${label}": 못 찾음 (${Date.now() - startedAt}ms) ` +
          `프레임=${page.frames().map((f) => f.url().slice(0, 60)).join(" | ")}`,
      );
      // ⛔ 추측해서 다음으로 넘어가지 않는다. 인증 화면의 오클릭은 인증 수단을 잘못
      //    고르는 것으로 이어지고, 그건 오너가 되돌려야 하는 상태다.
      return { clicked, stoppedAt: label };
    }
    const matchedText =
      ((await target.candidate.textContent().catch(() => null))?.trim() ?? "").slice(0, 30);
    console.log(
      `[hometax-helper] 단계 "${label}": 찾음 (${Date.now() - startedAt}ms, ${target.via}` +
        `${matchedText ? `, 텍스트="${matchedText}"` : ""}) 프레임=${target.frameUrl}`,
    );
    try {
      await target.candidate.click({ timeout: 8_000 });
    } catch (err) {
      // ⛔ 삼키지 않는다(P0). 「찾았는데 못 눌렀다」는 「못 찾았다」와 전혀 다른 사실인데,
      //    응답 문구가 같아 원인을 헛짚게 만든다(2026-08-07 실측 — 실제로 그랬다).
      console.error(
        `[hometax-helper] 단계 "${label}" 클릭 실패:`,
        err instanceof Error ? err.message.split("\n").slice(0, 6).join(" / ") : String(err),
      );
      return { clicked, stoppedAt: label };
    }
    clicked.push(label);
    await page.waitForTimeout(900);
  }
  return { clicked, stoppedAt: null };
}

export type LoginPromptOutcome = {
  /** 실제로 누른 단계(순서대로). */
  clicked: string[];
  /** 못 찾아 멈춘 단계 — 있으면 그 앞까지만 진행된 상태다. */
  stoppedAt: string | null;
  /** 맵에 로그인 단계가 없어 아무것도 하지 않았는가. */
  notConfigured: boolean;
  /** 화면을 막던 「로그인 정보가 없습니다」 알림을 닫고 시작했는가. */
  dismissedAlert: boolean;
};

/**
 * 로그인 단계를 순서대로 눌러 **인증서 비밀번호 창까지** 간다.
 *
 * 각 라벨은 `assertClickAllowed` 를 지난다 — 로그인 화면이라도 금지선은 같다.
 */
export async function navigateToLoginPrompt(
  page: Page,
  map: SelectorMap,
): Promise<LoginPromptOutcome> {
  // 🪤 **모달을 먼저 치운다.** 이것이 없으면 아래 단계가 전부 「보이는데 눌리지 않는」
  //    상태가 되어 1번에서 멈춘다(위 LOGIN_REQUIRED_ALERT_PATTERN 주석의 실사고).
  //    실패해도 계속 진행한다 — 알림이 없는 정상 경로가 더 흔하고, 못 닫았으면
  //    어차피 아래에서 stoppedAt 으로 정직하게 드러난다.
  const dismissedAlert = await dismissLoginRequiredAlert(page).catch(() => false);

  const steps = map.login?.steps ?? [];
  if (steps.length === 0) {
    return { clicked: [], stoppedAt: null, notConfigured: true, dismissedAlert };
  }

  // 걷기는 발급 인증과 **같은 기계**를 쓴다(위 `clickLabeledSteps` 의 ⛔ 주석).
  const { clicked, stoppedAt } = await clickLabeledSteps(page, steps);

  // 여기서 끝이다. 비밀번호 창이 떠 있으면 오너가 여섯 자리를 누른다.
  return { clicked, stoppedAt, notConfigured: false, dismissedAlert };
}
