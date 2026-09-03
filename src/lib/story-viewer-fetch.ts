// 무료 익명 스토리 뷰어를 실제 브라우저(Playwright)로 조작해 공개 계정 스토리를 받아온다.
// 계정·유료 API키·쿠키 불필요. 뷰어 API는 사이트 JS가 서명(_s)을 붙여야 응답하므로 서버 직
// fetch로는 불가 — 반드시 브라우저에서 그들 JS를 실행시켜 서명을 생성해야 한다(2026-07-10 실증).
//
// 실행 환경 2가지 공용:
//  - Vercel 서버리스: @sparticuz/chromium 바이너리 + playwright-core (executablePath 주입)
//  - 로컬(러너/dev): playwright-core 가 ms-playwright 캐시 브라우저를 자동 탐색
// ⚠ Vercel 데이터센터 IP는 뷰어 Cloudflare에 막힐 수 있음(미검증 리스크) — 그때 수동 경로가 보조.
import type { BrowserContext, Page } from "playwright-core";

/** 시도할 뷰어들 — 첫 성공에서 멈춘다(하나 죽어도 다음으로 폴백). storiesig.info 계열이 STORIES 버튼→
 *  /api/v1/instagram/stories POST(서명 포함) 흐름으로 검증됨. selector/흐름이 다르면 여기에 추가. */
type Viewer = {
  name: string;
  home: string;
  searchInput: string;
  searchButton: string;
  storiesButtonText: RegExp;
  storiesApi: RegExp; // 캡처할 스토리 응답 URL 패턴
  /** 검색 결과(프로필)가 렌더됐음을 뜻하는 selector — 탭은 이게 뜬 뒤에야 DOM 에 존재한다 */
  resultsReady: string;
  /** 프로필 조회 응답 URL 패턴 — 결과가 안 뜰 때 **왜 안 떴는지**의 유일한 증거원 */
  profileApi: RegExp;
};

const VIEWERS: Viewer[] = [
  {
    name: "storiesig",
    home: "https://storiesig.info/en/",
    searchInput: "input.search-form__input",
    searchButton: "button.search-form__button",
    storiesButtonText: /^stories$/i,
    storiesApi: /\/api\/v1\/instagram\/stories/,
    resultsReady: "button.tabs-component__button",
    profileApi: /\/api\/v1\/instagram\/userInfo/,
  },
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function isServerless(): boolean {
  return !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV);
}

/** 컨텍스트 공통 옵션 — persistent(default) 컨텍스트에 UA·뷰포트를 직접 싣는다. */
const CONTEXT_OPTS = {
  headless: true,
  userAgent: UA,
  viewport: { width: 1280, height: 900 },
  locale: "en-US",
} as const;

/**
 * 환경별 브라우저 기동 — **default(persistent) 컨텍스트**를 반환한다.
 *
 * ⚠ @sparticuz/chromium(headless_shell)은 `--single-process`(Lambda 필수 플래그)로 돌아,
 * playwright가 `browser.newContext()`로 **신규 incognito 컨텍스트를 만들면 브라우저가 즉사**한다
 * ("Target page, context or browser has been closed" — 프로덕션 실사고 2026-07-13, Chromium 141·148
 * 동일 재현 = 버전 무관). 업스트림 FAQ(Sparticuz/chromium#298)의 해법이 "default 컨텍스트 사용"이고,
 * playwright에서 그 방법이 launchPersistentContext다. newContext() 재도입 금지.
 *
 * ⚠ 버전 계약은 여전히 유효: playwright-core 기대 Chromium 메이저 = @sparticuz 메이저
 * (story-browser-version.contract.test.ts가 기계 강제).
 */
export async function launchStoryContext(): Promise<BrowserContext> {
  if (isServerless()) {
    // 브라우저 프로세스 stdout/stderr를 pw 디버그 채널로 표면화 — 크로미움이 또 죽으면
    // Vercel 런타임 로그에서 원인(플래그·메모리·라이브러리)을 직접 볼 수 있다.
    // playwright-core import(디버그 채널 초기화) 전에 설정해야 반영된다.
    if (!process.env.DEBUG?.includes("pw:browser")) {
      process.env.DEBUG = [process.env.DEBUG, "pw:browser*"].filter(Boolean).join(",");
    }
    const { chromium } = await import("playwright-core");
    const sparticuz = (await import("@sparticuz/chromium")).default;
    // 뷰어 조작은 DOM/XHR뿐이라 WebGL(swiftshader) 불필요 — 그래픽 스택을 끄면 Lambda 기동
    // 메모리·크래시 리스크가 준다. args 접근 전에 설정해야 반영된다(@sparticuz README).
    sparticuz.setGraphicsMode = false;
    // Lambda에서 쓰기 가능한 경로는 /tmp뿐. sparticuz.args에 --user-data-dir 없음 확인(충돌 없음).
    return chromium.launchPersistentContext("/tmp/story-viewer-profile", {
      ...CONTEXT_OPTS,
      args: sparticuz.args,
      executablePath: await sparticuz.executablePath(),
    });
  }
  const { chromium } = await import("playwright-core");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return chromium.launchPersistentContext(join(tmpdir(), "wag-story-viewer-profile"), CONTEXT_OPTS);
}

/**
 * 검색 결과가 안 떴을 때 남길 진단 문자열 — 프로필 조회 응답이 유일한 단서다.
 * 본문은 앞부분만 싣는다(차단 페이지인지 정상 JSON 인지 가르는 데는 충분하고,
 * 통째로 실으면 SystemTaskLog.details 의 4KB 상한을 혼자 먹는다).
 *
 * ⚠️ **상한을 올리는 것으로는 안 풀린다(2026-08-29 실사고).** 그날 이 200자 중 **161자를
 * 전부 false 인 `friendship_status` 하나가 먹어**, 판별에 필요한 필드(`is_private`·
 * `username`)는 한 글자도 실리지 않았다. 예산이 모자란 게 아니라 **노이즈가 신호를 밀어낸
 * 것**이라, 아래 `stripProfileNoise` 로 걷어낸 뒤 프리뷰한다.
 */
const PROFILE_BODY_PREVIEW_CHARS = 200;

/**
 * 값을 접을 키 — **실측으로 노이즈임이 확인된 것만** 올린다. 추측으로 늘리면 다음 사고의
 * 답이 여기서 지워진다. 막히면 그때 로그에 응답 모양이 남아 있으니 그걸 보고 늘릴 것.
 *
 * - `friendship_status`: 전부 false 인 관계 플래그 뭉치. 2026-08-29 실측으로 프리뷰 200자 중
 *   161자를 혼자 먹었고, 익명 뷰어라 이 값이 무언가를 뜻한 적이 없다.
 */
const PROFILE_NOISE_KEYS = new Set(["friendship_status"]);

/** 접힌 자리에 남길 표시 — 키는 남으므로 "응답 모양"은 계속 읽을 수 있다. */
const FOLDED = "…";

/** 진단 문자열 공통 프리뷰 — 줄바꿈을 접고 상한까지만. 예산 관리를 한자리에 모은다. */
function previewText(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * 프로필 응답에서 진단 가치가 없는 가지를 걷어낸다 — 프리뷰 예산을 신호에 쓰기 위해서다.
 *
 * ⚠️ 파싱에 실패하면(차단 페이지 HTML 등) **원문이 그대로 남아야 한다** — "JSON 이 아니었다"는
 * 사실 자체가 그때는 가장 중요한 증거다. 그래서 호출부가 try/catch 로 감싼다.
 */
/**
 * 접어도 되는 값인가 — **전부 false 일 때만** 그렇다.
 *
 * ⚠️ 키 이름만 보고 접으면 안 된다. `blocking: true`·`outgoing_request: true` 처럼 **하나라도
 * 참인 값이 오면 그게 바로 "왜 프로필이 안 떴나"의 답**인데, 이름만 보고 접는 구현은 그 답을
 * 지운다 — 이 파일이 경고하는 "추측으로 늘리면 다음 사고의 답이 지워진다"를 스스로 어기는 셈.
 * 값 모양이 예상 밖(문자열·중첩)이어도 접지 않는다: 모르는 것은 남기는 쪽이 안전하다.
 */
function isAllFalseFlags(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const values = Object.values(value);
  return values.length > 0 && values.every((v) => v === false);
}

function stripProfileNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripProfileNoise(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      // ⚠️ 키를 **지우지 않고 값만 접는다.** 통째로 지우면 "원래 없었다"와 "우리가 접었다"를
      // 구분할 수 없고, 뷰어가 응답 모양을 바꾼 것(= 이 계열 사고의 유력 원인)을 놓친다.
      out[key] = PROFILE_NOISE_KEYS.has(key) && isAllFalseFlags(v) ? FOLDED : stripProfileNoise(v);
    }
    return out;
  }
  return value;
}

function describeProfileProbe(probe: { status: number; body: string } | null): string {
  if (!probe) return "프로필 조회 응답 없음(요청 미발화·네트워크 차단 의심)";
  let body = probe.body;
  try {
    body = JSON.stringify(stripProfileNoise(JSON.parse(body)));
  } catch {
    /* JSON 이 아니거나 모양이 예상 밖 — 원문 프리뷰가 곧 증거다 */
  }
  return `프로필 조회 status=${probe.status} 본문:${previewText(body, PROFILE_BODY_PREVIEW_CHARS)}`;
}

/** 화면 본문 프리뷰 상한 — 차단 화면인지 빈 결과인지 가르는 데 필요한 만큼만. */
const PAGE_STATE_PREVIEW_CHARS = 200;

/** 화면 제목 상한 — 제목은 짧은 게 정상이고, 길면 그 자체가 비정상 신호다(예산도 지킨다). */
const PAGE_TITLE_PREVIEW_CHARS = 80;

/** 화면 상태 읽기의 상한 — 이미 실패한 경로라 여기서 더 기다리면 조회 예산만 먹는다. */
const PAGE_STATE_READ_TIMEOUT_MS = 2_000;

/**
 * 상한 안에 못 끝나면 null 로 접는다.
 *
 * ⚠️ **`page.title()` 은 Playwright 가 타임아웃 인자를 아예 받지 않는다**(`title(): Promise<string>`).
 * 이 레포는 `setDefaultTimeout` 도 걸지 않아 기본 상한조차 없다 — 그래서 상한을 밖에서 건다.
 * 이 보호가 없으면 **이미 깨진 페이지**(차단 챌린지·닫히지 않은 다이얼로그·single-process 크래시)
 * 에서 `title()` 이 영영 안 돌아오고, `driveViewer` 가 끝나지 않아 조회 예산·`maxDuration` 을
 * 넘겨 **성공한 핸들의 스토리까지 통째로 유실**된다(이 파일이 예산 기계를 만든 이유 그 자체).
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  // 진 쪽이 나중에 거부해도 unhandled rejection 으로 새지 않게 미리 삼킨다.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

/**
 * 화면 대기가 깨진 순간의 페이지 상태 — "응답은 정상인데 화면이 안 떴다"의 유일한 증거원.
 *
 * **왜 필요한가(2026-08-29 실사고):** 프로필 조회가 200 이었는데도 결과 화면이 안 떴다.
 * 차단 화면이었는지·계정이 비공개였는지·뷰어 UI 가 바뀐 것인지 가를 증거가 **아무 데도
 * 없었고**, 스토리는 24h 수명이라 소급 재현도 불가능했다. 프로필 응답(직전 단계)만 계측하면
 * 실패 지점이 그다음 단계로 옮겨간 순간 다시 깜깜해진다.
 *
 * ⚠️ **이 함수는 throw 하지도, 매달리지도 않는다.** 이미 깨진 페이지에서 읽는 것이라 예외와
 * **멈춤(hang)** 둘 다 가능한데, 어느 쪽이든 원래 실패 사유를 잃는다 — 예외는 사유를 덮어써
 * **진단이 진단을 잡아먹고**, 멈춤은 그보다 나빠서 실행 전체를 예산 밖으로 끌고 간다.
 * 그래서 예외는 try/catch 로, 멈춤은 `withDeadline` 으로 각각 막는다(둘 다 필요하다).
 */
async function describePageState(page: Page): Promise<string> {
  const read = async (work: () => Promise<string | null>): Promise<string | null> => {
    try {
      return await withDeadline(work(), PAGE_STATE_READ_TIMEOUT_MS);
    } catch {
      return null;
    }
  };
  const title = await read(() => page.title());
  // textContent 는 자체 타임아웃도 받는다 — 밖의 상한과 겹치지만, 안쪽은 **작업 자체를 중단**하고
  // 바깥은 **기다림만 끊는다**. 둘은 다른 일을 하므로 함께 둔다.
  const bodyText = await read(() => page.textContent("body", { timeout: PAGE_STATE_READ_TIMEOUT_MS }));
  if (title === null && bodyText === null) return "화면 상태 읽기 실패(페이지 소실·응답 없음)";
  const titleText = title === null ? "(읽기 실패)" : previewText(title, PAGE_TITLE_PREVIEW_CHARS);
  return `화면 제목:${titleText} 화면:${previewText(bodyText ?? "", PAGE_STATE_PREVIEW_CHARS)}`;
}

/** 검색 결과가 뜨기를 기다리는 상한 — 종전의 고정 7s 대기 + 탭 클릭 8s 타임아웃과 같은 총량이다. */
const RESULTS_READY_TIMEOUT_MS = 15_000;

/** 한 뷰어에서 한 핸들의 스토리 원시 items 배열을 받아온다. 실패 시 throw(호출부가 다음 뷰어로 폴백). */
async function driveViewer(page: Page, viewer: Viewer, handle: string): Promise<unknown[]> {
  let storyBody: string | null = null;
  // 프로필 조회 결과를 붙잡아 둔다 — 결과가 안 떴을 때 사유를 말할 수 있는 유일한 근거다.
  let profileProbe: { status: number; body: string } | null = null;
  const onResponse = async (res: import("playwright-core").Response) => {
    if (viewer.storiesApi.test(res.url())) {
      try {
        storyBody = await res.text();
      } catch {
        /* 응답 본문 소실 — storyBody null 유지, 아래서 실패 처리 */
      }
      return;
    }
    if (viewer.profileApi.test(res.url())) {
      try {
        profileProbe = { status: res.status(), body: await res.text() };
      } catch {
        profileProbe = { status: res.status(), body: "(본문 읽기 실패)" };
      }
    }
  };
  page.on("response", onResponse);

  await page.goto(viewer.home, { waitUntil: "domcontentloaded", timeout: 35000 });
  await page.waitForTimeout(2500);
  await page.fill(viewer.searchInput, handle);
  await page.click(viewer.searchButton);

  // ⚠️ 고정 대기로 넘기지 말 것 — 기다리는 **대상**을 명시해야 실패 사유가 에러에 실린다.
  // 종전엔 7초를 자고 곧바로 탭을 클릭해, 프로필 조회가 실패한 회차도 `locator.click: Timeout`
  // 한 줄만 남겼다(프로덕션 21일 무수집을 원인 미상으로 만든 지점 — 2026-08-03).
  try {
    await page.waitForSelector(viewer.resultsReady, { timeout: RESULTS_READY_TIMEOUT_MS });
  } catch {
    // 직전 단계(프로필 응답)와 **그 순간의 화면**을 함께 싣는다 — 2026-08-29 에는 앞엣것만
    // 있어서 "200 인데 화면이 안 떴다"까지만 알고 그 이유는 끝내 확정하지 못했다.
    const pageState = await describePageState(page);
    throw new Error(
      `${viewer.name}: 검색 결과 미렌더(핸들 ${handle}): ${describeProfileProbe(profileProbe)} / ${pageState}`,
    );
  }

  // STORIES 탭 클릭이 실제 스토리 fetch(서명 포함)를 트리거한다
  await page.locator("button", { hasText: viewer.storiesButtonText }).first().click({ timeout: 8000 });
  await page.waitForTimeout(8000);
  page.off("response", onResponse);

  // 3지 선다("비공개/스토리없음/차단")를 그대로 두지 않는다 — 그 셋을 가르는 증거를 이미
  // 손에 들고 있는데(profileProbe) 싣지 않으면, 실패 지점이 여기로 옮겨간 회차에서 08-29 와
  // 똑같이 원인 미상이 된다.
  if (!storyBody) {
    throw new Error(
      `${viewer.name}: 스토리 응답 미포착(핸들 ${handle}, 비공개/스토리없음/차단 가능): ${describeProfileProbe(profileProbe)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(storyBody);
  } catch {
    throw new Error(`${viewer.name}: 스토리 응답 JSON 파싱 실패`);
  }
  const result = (parsed as { result?: unknown })?.result;
  // storiesig: result = 스토리 배열. 형식이 어긋나면 뷰어 변경 신호 — 드러낸다.
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray((result as { items?: unknown[] }).items)) {
    return (result as { items: unknown[] }).items;
  }
  return [];
}

export type HandleStories = { handle: string; items: unknown[]; error?: string };

/**
 * 한 핸들 1회 시도의 최악 소요 — goto 타임아웃 35s 가 지배적이고 나머지 대기가 붙는다.
 * 예산 판정용 보수적 상수다(실측: 프로덕션 전량 실패 회차가 핸들당 ≈35s 로 84.6s·130.5s 종료).
 */
const PER_ATTEMPT_WORST_MS = 45_000;

/**
 * 조회 단계에 허용할 총 예산. 라우트 `maxDuration`(300s)에서 **저장·썸네일 리호스팅 몫을
 * 남긴다** — 이 함수는 전 핸들을 다 조회한 뒤에야 저장이 시작되므로, 조회가 예산을 다 먹으면
 * 플랫폼이 함수를 죽여 **성공한 핸들의 스토리까지 통째로 유실**되고 응답이 없어 래퍼의
 * RUNNING 마커가 고착된다(재시도를 넣을 때 가장 위험한 실패 모드).
 */
export const STORY_FETCH_BUDGET_MS = 200_000;

/** 핸들당 최대 시도 횟수(1 = 재시도 없음). 2차는 1차 전 순회가 끝난 뒤에만 돈다. */
const MAX_ATTEMPTS = 2;

/**
 * 재시도 전 최소 간격 — 즉시 재시도는 같은 순간 상태(느린 엣지·일시 차단)를 다시 맞을 뿐이다.
 * 실측 근거: 로컬에서 1차에 goto 타임아웃 난 핸들이 **약 2분 뒤** 재시도에서 성공했다(2/2).
 * 핸들이 여러 개면 1차 순회 자체가 이 간격을 채우므로 추가 대기 없이 넘어간다.
 */
const MIN_RETRY_GAP_MS = 20_000;

/** 한 핸들을 한 번 시도한다 — 뷰어 목록을 순서대로 폴백. 성공 시 items, 실패 시 error 문자열. */
async function attemptHandle(
  ctx: BrowserContext,
  handle: string,
): Promise<{ items: unknown[] } | { error: string }> {
  const errors: string[] = [];
  for (const viewer of VIEWERS) {
    const page = await ctx.newPage();
    try {
      const items = await driveViewer(page, viewer, handle);
      await page.close().catch(() => {});
      return { items };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      await page.close().catch(() => {});
    }
  }
  return { error: errors.join(" / ") };
}

/**
 * 여러 핸들의 스토리를 한 브라우저 세션에서 순회 수집한다. 컨텍스트는 default(persistent) 1개 —
 * 신규 incognito 컨텍스트는 @sparticuz headless_shell에서 브라우저를 죽인다(launchStoryContext 주석).
 * 상태 격리는 시도마다 새 페이지 + 핸들 사이 쿠키 클리어로 대신한다. 핸들별 에러는 격리
 * (한 셀러 실패가 전체를 죽이지 않음). 뷰어는 순서대로 폴백.
 */
export async function fetchStoriesForHandles(
  handles: string[],
  // opts 는 테스트 이음매다(프로덕션은 전부 기본값) — 실브라우저·실시계 없이 예산·재시도
  // 규칙을 검증하려면 시간과 브라우저 기동이 주입 가능해야 한다.
  opts: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    budgetMs?: number;
    launch?: () => Promise<BrowserContext>;
  } = {},
): Promise<HandleStories[]> {
  if (handles.length === 0) return [];
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.budgetMs ?? STORY_FETCH_BUDGET_MS);
  const enoughBudget = () => deadline - now() >= PER_ATTEMPT_WORST_MS;

  const ctx = await (opts.launch ?? launchStoryContext)();
  /** 핸들 → 최종 결과. 1차 순회 후 실패분만 재시도해 덮어쓴다. */
  const results = new Map<string, HandleStories>();
  const failedAt = new Map<string, number>(); // 재시도 최소 간격 판정용

  try {
    for (const handle of handles) {
      // 예산이 모자라면 시도조차 하지 않는다 — 죽는 것보다 남은 핸들을 명시적으로 포기하는 게 낫다.
      // (P0: 무음 실패 금지 — 왜 안 돌았는지를 error 로 드러낸다.)
      if (!enoughBudget()) {
        results.set(handle, { handle, items: [], error: "조회 예산 소진: 시도하지 않음(1차)" });
        continue;
      }
      const r = await attemptHandle(ctx, handle);
      // 다음 핸들 검색이 이전 상태(쿠키·세션)에 영향받지 않도록 클리어(구 newContext 격리의 대체).
      await ctx.clearCookies().catch(() => {});
      if ("items" in r) {
        results.set(handle, { handle, items: r.items });
      } else {
        results.set(handle, { handle, items: [], error: r.error });
        failedAt.set(handle, now());
      }
    }

    // 2차 — 1차 전 순회가 끝난 뒤 실패분만. 즉시 재시도가 아니라 지연 재시도인 이유는
    // MIN_RETRY_GAP_MS 주석 참조(로컬 실측: 같은 핸들이 시간이 지나자 성공).
    if (MAX_ATTEMPTS > 1) {
      // 1차 전멸 = 계통 장애(데이터센터 IP 차단 등) 신호. 그때 전 핸들을 재시도하면 확실히
      // 실패할 일에 매일 핸들수×35s 를 태운다. 그래서 **한 건만 탐침**하고, 그것도 실패하면
      // 나머지는 포기한다 — 일시 장애(1차에 일부 성공)면 이 제한이 걸리지 않는다.
      // 근거: 로컬 실측의 일시 장애는 2핸들 중 1개만 실패(혼재)했고, prod 계통 장애는 10일간 전량 실패였다.
      const noneSucceeded = handles.every((h) => results.get(h)?.error);
      let probeFailed = false;

      for (const handle of handles) {
        const prev = results.get(handle);
        if (!prev?.error || !failedAt.has(handle)) continue; // 성공했거나 아예 시도 못 한 건 건너뜀
        if (probeFailed) {
          results.set(handle, { handle, items: [], error: `${prev.error} / 계통 장애 판단: 재시도 생략` });
          continue;
        }
        if (!enoughBudget()) {
          results.set(handle, { handle, items: [], error: `${prev.error} / 재시도 예산 소진` });
          continue;
        }
        const gap = now() - failedAt.get(handle)!;
        // 핸들이 하나뿐이면 1차 순회가 간격을 못 채우므로 여기서 채운다(예산 확인 후).
        if (gap < MIN_RETRY_GAP_MS && deadline - now() >= PER_ATTEMPT_WORST_MS + (MIN_RETRY_GAP_MS - gap)) {
          await sleep(MIN_RETRY_GAP_MS - gap);
        }
        const r = await attemptHandle(ctx, handle);
        await ctx.clearCookies().catch(() => {});
        if ("items" in r) {
          results.set(handle, { handle, items: r.items });
        } else {
          // 1차·2차 사유를 모두 남긴다 — 같은 에러의 반복인지, 다른 지점에서 죽는지가 진단의 핵심.
          results.set(handle, { handle, items: [], error: `1차: ${prev.error} / 2차: ${r.error}` });
          if (noneSucceeded) probeFailed = true; // 탐침 실패 → 남은 재시도 생략
        }
      }
    }
  } finally {
    await ctx.close();
  }

  return handles.map((h) => results.get(h) ?? { handle: h, items: [], error: "결과 누락(내부 오류)" });
}
