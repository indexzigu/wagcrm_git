/**
 * 헬퍼가 쓰는 브라우저 — **오너 전용 영속 프로필**로 띄운다.
 *
 * 영속 프로필(`launchPersistentContext`)이어야 하는 이유: 홈택스 로그인 세션과 인증서
 * 관련 브라우저 상태가 유지돼야 오너가 매번 로그인하지 않는다. 프로필은 레포 밖
 * (`~/.wag-crm/hometax-profile`)에 둔다 — 세션 쿠키가 들어 있어 public 레포 근처에
 * 두면 안 된다(P0).
 *
 * ⚠️ **headless 로 띄우지 않는다.** 이 도구의 전제가 "오너가 화면을 보고 검토 후 직접
 * 발급"이므로, 보이지 않는 창은 설계 위반이다. 옵션으로도 열어 두지 않는다 — headless
 * 를 허용하는 순간 무인 자동화로 가는 문이 생긴다.
 *
 * 채널은 실제 Chrome 을 우선한다. 홈택스는 로컬 보안 모듈에 의존하는데, 2026-08-06
 * 스크립트 스캔에서 실제로 확인된 것은 TouchEn·nxKey(키보드 보안) · Veraport·Wizvera
 * (인증서·설치 관리) · magicline · Delfino 다(종전 주석의 "AnySign" 은 **0건** —
 * 추정이었다). 이 모듈들은 오너가 손으로 하는 전자서명 단계에 붙으므로 오너가 평소
 * 쓰는 Chrome 쪽이 성공 가능성이 높다.
 *
 * 번들 Chromium 폴백은 그 사실을 호출부가 보고한다(서명 단계에서 왜 막히는지 원인을
 * 사람이 알 수 있어야 한다). 폴백이 불리한 이유가 하나 더 있다: 번들 Chromium 은
 * UA 를 **Chrome/148** 로 보고하는데 시스템 Chrome 은 150 이었다(2026-08-06 실측).
 * 두 버전 뒤처진 UA 자체가 눈에 띄는 값이다.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { HELPER_HOME } from "./selectors";


export const PROFILE_DIR = join(HELPER_HOME, "hometax-profile");
export const HOMETAX_URL = "https://hometax.go.kr";

/**
 * 로그인 후 홈택스가 갈아 끼우는 메인 화면. 로그아웃 상태는 `index3`, 로그인 뒤는
 * `index4` 다(2026-08-07 실측 — 오너가 화면에서 확인한 전환).
 *
 * ⚠️ **이것 하나로 로그인을 판정하지 않는다.** 홈택스 내부 메뉴 코드라 언제든 바뀔 수
 * 있고, 로그인 경로에 따라 다른 화면으로 떨어질 수도 있다. `waitForLoginState` 에서
 * 「로그아웃」 링크와 **또는**으로 묶어 깨우는 용도로만 쓴다.
 */
const LOGGED_IN_URL_PATTERN = /menuCd=index4/;

export type BrowserSession = {
  context: BrowserContext;
  page: Page;
  /** 실제 Chrome 을 못 찾아 번들 Chromium 으로 떨어졌는가 — 서명 단계 진단용. */
  usedBundledChromium: boolean;
};

let session: BrowserSession | null = null;

/**
 * `--disable-blink-features=AutomationControlled` 는 **심층방어**다 — 관측된 문제의
 * 처방이 아니다. 이 구분을 흐리면 다음 사람이 없는 문제를 쫓는다.
 *
 * Playwright 는 기본적으로 `navigator.webdriver = true` 를 노출하고, 이 플래그를 주면
 * `false` 가 된다(2026-08-06 실측). 그래서 플래그는 유지한다. 다만 **홈택스가 그걸
 * 본다는 근거는 없다** — 같은 날 로그인 전 표면의 스크립트 128개(18.3MB)를 전수
 * 검색한 결과 `navigator.webdriver` · `webdriver` · `cdc_` · `HeadlessChrome` ·
 * `puppeteer` · `playwright` 가 **0건**이었고, 상용 봇탐지(Akamai·DataDome·PerimeterX·
 * Kasada)와 CAPTCHA·핑거프린팅 라이브러리도 0건이었다. 유일하게 걸린 `selenium` 2건은
 * WebSquare 가 자체 탑재한 테스트 러너(`selenium_myiframe`)로 **탐지가 아니라 자동화
 * 지원 코드**다. TouchEn·Veraport·magicline 등 보안 모듈이 `navigator` 에서 읽는 것은
 * `userAgent`·`appVersion`·`platform`·`msPointerEnabled` 같은 **IE 시절 기능 분기**이지
 * 자동화 판별이 아니다.
 *
 * ⛔ **`connectOverCDP` 는 탈출구가 아니다(2026-08-06 반증).** 종전 주석은 "막히면 실제
 * Chrome 에 CDP 로 붙으면 자동화 흔적이 원천적으로 없다"고 적었는데, 재 보니 **틀렸다.**
 * `console.debug(큰 객체) × 300회` 소요를 자동화 없는 생 Chrome 과 비교했을 때(2회 재현):
 *
 *   생 Chrome 2.2ms · pydoll 2.5~3.2ms · **Playwright 11.3~12.1ms ·
 *   Playwright connectOverCDP 11.9~12.8ms · Puppeteer 11.8~12.6ms**
 *
 * 즉 Playwright 가 붙는 순간 콘솔 계측이 켜지고, **attach 방식이어도 그대로다.** 이
 * 축에서 조용한 것은 pydoll 뿐이다(생 Chrome 과 구분 불가). 이 신호는 양성 대조군
 * (`Runtime.enable` 강제 ON → 20.7~21.4ms)과 음성 대조군(생 Chrome)으로 검증했다.
 * 반면 Error.stack 게터 계열의 고전적 `Runtime.enable` 누수 기법은 **양성 대조군에서도
 * 안 터져** 판정 근거로 쓸 수 없었다(Chrome 150).
 *
 * 정리하면 pydoll 의 은닉성 우위는 **실재하지만**, 홈택스가 그 축을 검사하지 않으므로
 * **살 것이 없다.** 라이브러리 교체의 진짜 비용은 API 가 아니라 금지선이다 —
 * `guards.ts` 의 deny-by-default, 소스 스캔 계약 테스트, `TaxInvoiceRow` 타입 공유가
 * 전부 TS 다. 교체하려면 그 층을 다시 짜고 페이로드 SSOT 가 언어 경계를 넘는다.
 *
 * 재검토 트리거는 **실제 차단**이다(로그인 거부·폼 미로딩·CAPTCHA·서명 모듈 실패).
 * 그때는 위 수치가 이미 있으니 `connectOverCDP` 로 시간을 버리지 말고 곧장 pydoll 을
 * 검토하라. 어느 경우에도 발급·서명은 사람이 누른다(`guards.ts`).
 */
const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--exclude-switches=enable-automation",
];

/**
 * 창에서 **사람이 마지막으로 조작한 시각**을 페이지 안에 기록해 두는 주입 스크립트.
 * 유휴 자동 종료(`idle.ts`)가 이 값을 읽어 "오너가 검토 중인 창"을 닫지 않는다.
 *
 * ⚠️ **함수가 아니라 문자열**로 넘긴다 — `tsx`(esbuild)가 함수에 주입하는 `__name`
 * 헬퍼가 브라우저 컨텍스트엔 없어 `ReferenceError` 로 죽는다(`index.ts` 의 같은 주석).
 *
 * ⛔ **주입 시점에 미리 한 번 찍지 않는다.** `addInitScript` 는 새 문서마다 다시 도는데,
 * 거기서 값을 찍으면 **사람이 아닌 이동**(홈택스의 30분 무활동 자동 로그아웃 리다이렉트
 * 등)이 "방금 조작했다"로 기록돼 유휴 판정을 무한정 미룬다. 이름 그대로 **사람 입력만**
 * 남긴다 — 입력이 없으면 값도 없고, 그 부재는 `null` 로 정직하게 흐른다.
 *
 * 값만 남기고 아무것도 보내지 않는다(P0 — 화면의 실데이터는 읽지 않는다).
 */
const INPUT_MARKER_SCRIPT = `(() => {
  const mark = () => { try { window.__hometaxHelperLastInput = Date.now(); } catch (e) {} };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'focus']) {
    window.addEventListener(type, mark, true);
  }
})()`;

/**
 * 창 가로 비율 기본값 — 오너 지시(2026-08-07): 최대화 대신 **화면 가로의 30~50%**.
 * 조회·입력은 전부 셀렉터 기반이라 창을 좁혀도 깨지지 않는다(좌표를 쓰는 경로는
 * `/click` 하나뿐이고, 그쪽은 호출 직전 `/screenshot` 좌표를 쓰므로 창 크기와 **함께**
 * 움직인다 — 즉 자기정합적이다).
 */
const DEFAULT_WIDTH_FRACTION = 0.4;

/** 너무 좁으면 홈택스 표가 가로 스크롤 뒤로 숨어 사람이 검토를 못 한다. */
const MIN_WINDOW_WIDTH = 900;

/**
 * 창을 띄울 때 쓰는 **초기** 크기. `HOMETAX_HELPER_WINDOW_SIZE=1200x900` 으로 직접
 * 지정하면 그 값이 최종이고(아래 맞춤도 건너뛴다), 없으면 무난한 기본값으로 띄운 뒤
 * `fitWindowToScreen` 이 실제 화면에 맞춰 조정한다.
 */
export function resolveInitialWindowSize(): { width: number; height: number; explicit: boolean } {
  const explicit = process.env.HOMETAX_HELPER_WINDOW_SIZE?.match(/^(\d+)x(\d+)$/);
  if (explicit) return { width: Number(explicit[1]), height: Number(explicit[2]), explicit: true };
  return { width: 1200, height: 900, explicit: false };
}

/**
 * 띄운 창을 화면 가로의 40%(하한 900px)·세로 90% 로 맞춘다.
 *
 * ⛔ **osascript 로 Finder 에 화면 크기를 묻지 않는다**(2026-08-09 실사용 지적).
 * 종전 구현이 그랬는데, macOS 가 「'node'에서 'Finder'을(를) 제어하려고 합니다」
 * 자동화 권한 팝업을 띄웠다 — 오너가 정체를 알 수 없는 권한 요청을 받는 것 자체가
 * 결함이고, 「허용 안 함」을 누르면 그 뒤로는 조용히 실패해 창이 기본 크기로만 떴다.
 *
 * 처방: **띄운 Chrome 자신에게 묻는다.** 페이지의 `screen.availWidth/Height` 는 아무
 * 권한도 필요 없고, 리사이즈는 CDP(`Browser.setWindowBounds`)로 한다 — 외부 프로세스
 * 호출이 0이라 권한 팝업이 구조적으로 없다. 실패하면 초기 크기(1200x900)로 남을
 * 뿐이라 조용히 넘어가도 안전하지만, 사실은 로그로 남긴다(P0).
 */
async function fitWindowToScreen(context: BrowserContext, page: Page): Promise<void> {
  try {
    const parsedFraction = Number(process.env.HOMETAX_HELPER_WINDOW_FRACTION);
    const fraction =
      Number.isFinite(parsedFraction) && parsedFraction > 0 && parsedFraction <= 1
        ? parsedFraction
        : DEFAULT_WIDTH_FRACTION;

    // 문자열 evaluate — 이 헬퍼는 tsx(esbuild)로 돌아 함수 전달이 `__name` 주입으로
    // 깨진다(`INSPECT_SCRIPT` 주석의 실측). availWidth/Height 는 메뉴바·독을 뺀 값이다.
    const screen = (await page.evaluate(
      "({ width: screen.availWidth, height: screen.availHeight })",
    )) as { width: number; height: number };
    if (!screen || screen.width <= 0 || screen.height <= 0) return;

    const width = Math.max(MIN_WINDOW_WIDTH, Math.round(screen.width * fraction));
    // 세로는 줄이지 않는다 — 목록 한 페이지(10행)가 한눈에 들어와야 오너가 검토한다.
    const height = Math.round(screen.height * 0.9);

    const cdp = await context.newCDPSession(page);
    try {
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 0, top: 0, width, height, windowState: "normal" },
      });
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch (err) {
    console.log(
      "[hometax-helper] 창 크기 맞춤 실패(기본 크기로 유지):",
      err instanceof Error ? err.message.split("\n")[0] : String(err),
    );
  }
}

async function launch(): Promise<BrowserSession> {
  await mkdir(PROFILE_DIR, { recursive: true });
  const { width, height, explicit } = resolveInitialWindowSize();
  const options = {
    headless: false as const,
    viewport: null,
    // ⛔ `--start-maximized` 를 함께 주지 않는다 — 같이 주면 그쪽이 이겨 크기 지정이
    //    조용히 무시된다.
    args: [`--window-size=${width},${height}`, "--window-position=0,0", ...STEALTH_ARGS],
    ignoreDefaultArgs: ["--enable-automation"],
  };

  // 주입은 **페이지를 만들기 전에** 걸어야 이후 모든 문서에 적용된다. 실패해도 창은
  // 띄운다 — 유휴 판정 보조 신호가 없어질 뿐이고, 그 부재는 `null` 로 정직하게 흐른다.
  const adopt = async (context: BrowserContext, usedBundledChromium: boolean): Promise<BrowserSession> => {
    await context.addInitScript({ content: INPUT_MARKER_SCRIPT }).catch(() => {});
    const page = context.pages()[0] ?? (await context.newPage());
    // 명시 지정(HOMETAX_HELPER_WINDOW_SIZE)이 아니면 실제 화면에 맞춘다 —
    // osascript 권한 팝업 없이(위 fitWindowToScreen 주석).
    if (!explicit) await fitWindowToScreen(context, page);
    return { context, page, usedBundledChromium };
  };

  try {
    return await adopt(
      await chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel: "chrome" }),
      false,
    );
  } catch {
    return await adopt(await chromium.launchPersistentContext(PROFILE_DIR, options), true);
  }
}

/** 살아 있는 창이 있으면 재사용한다 — 매 요청마다 새 창을 열면 오너가 로그인해 둔 창을
 *  두고 빈 창이 계속 쌓인다. */
export async function getSession(): Promise<BrowserSession> {
  if (session && !session.page.isClosed()) return session;
  session = await launch();
  session.context.on("close", () => {
    session = null;
  });
  return session;
}

/**
 * 홈택스가 아직 안 열려 있으면 연다. 이미 홈택스 안(로그인 후 화면 포함)이면 그대로
 * 둔다 — 오너가 진행 중인 화면을 우리가 되돌리지 않는다.
 *
 * 🪤 `domcontentloaded` 까지만 기다리면 **부족하다**(2026-08-05 실측). 홈택스는 첫
 * 진입 후 WebSquare 셸(`/websquare/websquare.html?w2xPath=...`)로 자체 이동하는데,
 * 그 사이에 `page.evaluate` 를 부르면 `Execution context was destroyed` 로 죽는다.
 * 그래서 네트워크가 잠잠해질 때까지 한 번 더 기다린다(타임아웃은 삼킨다 — SPA 는
 * 폴링 때문에 networkidle 에 영영 도달하지 않을 수 있고, 그때는 그냥 진행하면 된다).
 */
export async function ensureHometaxOpen(page: Page): Promise<void> {
  if (page.url().includes("hometax.go.kr")) return;
  await page.goto(HOMETAX_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

/**
 * 그 문구를 단 **누를 수 있는 것**이 화면에 있는가(링크·버튼).
 *
 * 로그인 판정은 이 함수 하나로 한다. 같은 자리에서 두 가지 방식이 각각 실패했고,
 * 둘 다 **판정을 정반대로 뒤집었다**(2026-08-07 실측):
 *
 * ⛔ **`.getByText(...).first().isVisible()`** — 홈택스는 전체메뉴 트리와 로그인 박스를
 *    **DOM 에 두고 숨기므로** 같은 문구가 여러 번 잡히는데, `.first()` 가 **숨은 것**을
 *    집으면 「그 문구가 화면에 없다」가 된다(덤프상 「로그인」 5곳 중 2곳이 숨김).
 *    → 로그아웃 상태를 **로그인됨**으로 오판해, 발급 메뉴로 들어갔다가 「로그인 정보가
 *    없습니다」 모달 앞에서 조용히 헛돌았다.
 * ⛔ **문구 존재로 판정** — 홈택스 **로그인 페이지** 하단에는 "…이용하신 후 반드시
 *    [로그아웃]을 하시기 바랍니다"라는 안내문이 있다. 「로그아웃이 보이면 로그인된
 *    것」 규칙이 **로그인 화면을 로그인됨**으로 판정했다(자동 재개가 여기서 오발동한다).
 *    같은 화면에서 클릭 가능한 「로그아웃」은 **0개**였다(음성 대조군).
 *
 * 상태를 말해 주는 것은 문장이 아니라 **메뉴**다. 그래서 누를 수 있는 것만 센다.
 */
function visibleClickable(page: Page, text: string) {
  const byText = page.locator("a, button").filter({ hasText: text }).filter({ visible: true });
  // WebSquare 는 버튼을 `input[type=button]` 으로도 그린다 — 그쪽은 텍스트가 아니라
  // value 라 위 필터에 걸리지 않는다.
  const byValue = page
    .locator(`input[type=button][value*="${text}"], input[type=submit][value*="${text}"]`)
    .filter({ visible: true });
  return byText.or(byValue);
}

async function hasVisibleClickable(page: Page, text: string): Promise<boolean> {
  return visibleClickable(page, text)
    .count()
    .then((n) => n > 0)
    .catch(() => false);
}

/**
 * 로그인 여부 **추정**. 단정이 아니라 힌트다 — 틀려도 헬퍼는 폼 채우기를 시도하고
 * 실패하면 그 단계를 보고한다(빈 폼을 "성공"이라 말하지 않는 계약이 최종 방어선이다).
 *
 * 🪤 홈택스는 WebSquare SPA 라 `domcontentloaded` 직후에는 메뉴가 **아직 없다** —
 * 첫 구현은 2초 타임아웃으로 검사했다가, 로그인하지 않은 메인 화면에서도 "로그인"
 * 문구를 못 찾아 `false`(로그인됨)를 반환했다(2026-08-05 실측). 그래서 렌더가 끝날
 * 시간을 먼저 준다.
 *
 * 🪤 **두 방향을 다 본다**(2026-08-07 실사고 정정). 종전에는 「로그인」 문구 하나만
 * 봤는데, 그 문구는 로그인 **후** 화면에도 남아 있을 수 있고(숨은 로그인 박스) 위
 * `.first()` 함정까지 겹쳐 **로그아웃 상태를 로그인됨으로 오판**했다. 그 오판의 대가는
 * 조용하지 않았다: 로그인 유도로 가지 않고 발급·조회 메뉴로 진입했다가 홈택스가 띄우는
 * 「로그인 정보가 없습니다」 모달에 막혀, 오너에게는 "아무 일도 안 일어난다"로 보였다.
 * - 「로그아웃」이 보이면 → 로그인된 것이다(가장 확실한 신호. 실측: 로그아웃 상태의
 *   메인 화면에는 이 문구가 **0곳**이다).
 * - 아니면서 「로그인」이 보이면 → 로그아웃이다.
 * - 둘 다 아니면 **모른다** → 종전대로 `false`(진행해 보고 실패하면 보고). 여기서
 *   섣불리 「로그아웃」으로 단정하면, 멀쩡히 로그인된 세션에서 오너가 채우던 화면을
 *   로그인 페이지로 끌고 가 버린다.
 */
export async function looksLoggedOut(page: Page): Promise<boolean> {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  if (await hasVisibleClickable(page, "로그아웃")) return false;
  return hasVisibleClickable(page, "로그인");
}

/**
 * 로그인 상태 **읽기 전용** 판정 — 오너가 로그인을 끝냈는지 CRM 이 지켜보기 위한 것.
 *
 * ⛔ **아무것도 클릭하지 않고 아무 데도 이동하지 않는다.** 이 함수가 도는 동안 오너는
 * 인증서 비밀번호를 누르고 있다 — 거기서 단계 클릭을 한 번이라도 다시 하면 창이
 * 초기화되어 **오너가 누르던 것이 날아간다.** 폴링 경로에 부수효과를 넣지 말 것.
 *
 * ⛔ `looksLoggedOut` 을 그대로 쓰지 않는 이유는 그 함수의 `networkidle` 대기다 —
 * 로그인 중에는 통신이 계속 일어나 매 폴링이 최대 15초씩 늘어진다. 여기서는 지금
 * 그려진 화면만 본다.
 *
 * 세 번째 값 `UNKNOWN` 을 남기는 것은 의도다. 창이 없거나 화면이 아직 안 그려졌을 때
 * 그것을 「로그아웃」으로 접으면 CRM 이 영영 기다리고, 「로그인됨」으로 접으면 로그인도
 * 안 된 채 발행을 시도한다 — 둘 다 틀린 방향이라 모른다고 답한다.
 */
export async function readLoginState(): Promise<"IN" | "OUT" | "UNKNOWN"> {
  if (!hasLiveSession()) return "UNKNOWN";
  const page = session!.page;
  if (await hasVisibleClickable(page, "로그아웃")) return "IN";
  if (await hasVisibleClickable(page, "로그인")) return "OUT";
  return "UNKNOWN";
}

/**
 * 로그인이 **끝나는 순간까지 기다린다** — 되묻지 않고 기다리는 쪽으로 뒤집은 것이다.
 *
 * 🪤 종전에는 CRM 이 2초마다 `readLoginState()` 를 물었다. 그러면 **간격이 곧 지연**이라
 * 오너가 여섯 자리를 다 눌러도 화면이 최대 2초쯤 멍하니 있었고(실사용 체감 지적,
 * 2026-08-07), 폴링마다 무거운 WebSquare 화면에 DOM 질의를 새로 날리는 비용도 있었다.
 *
 * 여기서는 「로그아웃」 링크가 **보이게 되는 순간**을 Playwright 가 직접 기다린다.
 * 로그인이 끝나면 홈택스가 페이지를 이동하는데, 로케이터 대기는 그 이동을 넘어 스스로
 * 다시 해석하므로 **이동 자체가 곧 신호**가 된다 — 새 화면이 그려지는 즉시 깨어난다.
 *
 * ⛔ 여전히 아무것도 클릭하지 않는다(오너가 비밀번호를 누르는 중이다). 대기는 순수
 * 관찰이고, 판정 기준은 `readLoginState` 와 같은 **클릭 가능한** 「로그아웃」이다
 * (문구만 보면 로그인 페이지의 안내문에 걸려 뒤집힌다 — 위 `visibleClickable` 주석).
 *
 * 시간이 다 되면 그 시점의 상태를 그대로 돌려준다. 「아직 아니다」와 「모른다」를 여기서
 * 합치지 않는 이유는 `readLoginState` 주석과 같다.
 */
export async function waitForLoginState(
  timeoutMs: number,
): Promise<"IN" | "OUT" | "UNKNOWN"> {
  const immediate = await readLoginState();
  if (immediate === "IN" || timeoutMs <= 0 || !hasLiveSession()) return immediate;

  /**
   * **깨우기는 두 신호 중 빠른 쪽, 판정은 링크.** 둘을 갈라 두는 것이 요점이다.
   *
   * 로그인이 끝나면 홈택스가 메인 화면을 갈아 끼우므로 신호가 둘이다:
   * ①URL 이동(`menuCd=index3` → `index4`) ②「로그아웃」 링크가 보이기. **실측 시차는
   * 353ms**였다(2026-08-07 실제 로그인 1회: 이동 +23,578ms · 링크 +23,931ms).
   *
   * 🪤 **①만으로 판정하면 안 된다** — 이동이 렌더보다 빨라서, 그 순간 상태를 읽으면
   * 아직 「로그아웃」이 없어 `OUT` 이 나온다. 즉 ①은 「곧 된다」는 신호이지 「됐다」가
   * 아니다. 그래서 ①은 깨우는 데만 쓰고, 답은 ②로 확인한 뒤 낸다.
   *
   * 🪤 **②만 보면 단일 실패점이 된다** — 홈택스가 헤더를 `a`·`button` 이 아닌 것으로
   * 바꾸면 로그인이 끝나도 영영 못 알아챈다. 반대로 `index4` 라는 내부 코드가 바뀌면
   * ①이 죽는다. 둘을 **또는**으로 묶으면 한쪽이 깨져도 나머지가 잡는다.
   */
  const startedAt = Date.now();
  const page = session!.page;
  const link = visibleClickable(page, "로그아웃").first();

  type WakeSignal = "link" | "url" | null;
  const racers: Array<Promise<WakeSignal>> = [
    link.waitFor({ state: "visible", timeout: timeoutMs }).then((): WakeSignal => "link").catch(() => null),
  ];
  /**
   * 🪤 **이미 그 URL 이면 URL 은 신호가 아니다.** `waitForURL` 은 현재 주소가 이미
   * 맞으면 **즉시** 반환한다 — 세션이 만료돼 `index4` 화면에 머문 채 로그아웃된 상태가
   * 그렇다. 그대로 두면 깨어남 → 링크 없음 → `OUT` 반환을 5초마다 반복하며 헛돈다
   * (기다리라고 만든 long-poll 이 도리어 짧은 폴링이 된다). 주소가 **바뀌는 것**만
   * 신호로 삼는다.
   */
  if (!LOGGED_IN_URL_PATTERN.test(page.url())) {
    racers.push(
      page.waitForURL(LOGGED_IN_URL_PATTERN, { timeout: timeoutMs }).then((): WakeSignal => "url").catch(() => null),
    );
  }
  const wokeBy = await Promise.race(racers);

  // ①로 깨어났으면 렌더가 아직일 수 있다 — 짧게만 더 기다린다(위 실측 353ms 기준으로
  // 넉넉하되, 신호가 헛것이었을 때 오래 붙잡지 않을 만큼).
  if (wokeBy === "url") {
    await link.waitFor({ state: "visible", timeout: Math.min(5_000, timeoutMs) }).catch(() => {});
  }

  const state = await readLoginState();
  if (state === "IN") {
    console.log(`[hometax-helper] 로그인 확인 — 대기 ${Date.now() - startedAt}ms (신호: ${wokeBy ?? "없음"})`);
  }
  return state;
}

/** 창이 살아 있는가 — 유휴 판정이 한도를 가르는 데 쓴다(창이 없으면 더 짧은 한도). */
export function hasLiveSession(): boolean {
  return session !== null && !session.page.isClosed();
}

/**
 * 창에서 사람이 마지막으로 조작한 시각(ms epoch). 모르면 `null`.
 *
 * ⛔ 모른다는 것을 "방금 조작했다"로 바꾸지 말 것 — 그러면 창이 떠 있는 한 헬퍼가
 * 영원히 살아 온디맨드 전환이 무의미해진다. 읽지 못하는 사실은 그대로 흘린다.
 */
export async function readLastUserInputAt(): Promise<number | null> {
  if (!hasLiveSession()) return null;
  try {
    const value = await session!.page.evaluate(
      "(() => (typeof window.__hometaxHelperLastInput === 'number' ? window.__hometaxHelperLastInput : null))()",
    );
    return typeof value === "number" ? value : null;
  } catch {
    // SPA 이동 중이면 실행 컨텍스트가 파괴된다 — 그건 오히려 활동의 증거지만,
    // 조용히 "지금"으로 바꾸지 않고 모른다고 답한다(위 ⛔ 와 같은 이유).
    return null;
  }
}

export async function closeSession(): Promise<void> {
  if (!session) return;
  await session.context.close().catch(() => {});
  session = null;
}
