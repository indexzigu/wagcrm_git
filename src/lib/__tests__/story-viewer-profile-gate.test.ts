import { describe, expect, it } from "vitest";
import type { BrowserContext } from "playwright-core";
import { fetchStoriesForHandles } from "../story-viewer-fetch";

/**
 * 프로필 조회 단계의 관측 회귀.
 *
 * **왜 이 테스트가 있나(실사고 2026-07-12~08-03, 21일 무수집):** 뷰어 조작은 "검색 → 프로필
 * 렌더 → STORIES 탭 클릭 → 스토리 응답" 순인데, 종전 구현은 검색 뒤 **고정 7초를 자고 곧바로
 * 탭을 클릭**했다. 그래서 프로필 조회가 실패하면 탭이 DOM 에 없어 `locator.click: Timeout` 만
 * 남았고, **왜 탭이 없는지는 어디에도 기록되지 않았다** — 프로덕션 21일치 로그가 전부 같은
 * 클릭 타임아웃 한 줄이라 IP 차단·타임아웃·UI 변경을 구분할 수 없었다(집 IP 에서는 같은 코드가
 * 정상 동작해 원인 후보만 셋으로 남았다).
 *
 * 그래서 기다리는 대상을 **명시**하고(`resultsReady`), 실패 시 그 앞 단계인 프로필 응답의
 * 상태코드·본문 앞부분을 사유에 싣는다. 진단 정보는 로깅을 덧붙여서가 아니라 **무엇을
 * 기다렸는지를 밝혀서** 얻는다(P0 무음 실패 금지의 이 경로 적용).
 */

type Scenario = {
  /** 검색 후 프로필 결과(탭)가 렌더되는가 */
  resultsRender: boolean;
  /** 프로필 조회 응답 — null 이면 응답 자체가 없었던 것(요청 미발화·네트워크 차단) */
  profileResponse: { status: number; body: string } | null;
  /**
   * 렌더 실패 순간의 화면.
   * - `null`: 읽기 자체가 예외로 깨진 것(페이지 소실)
   * - `"hang"`: 읽기가 끝나지 않는 것 — 예외보다 나쁜 실패 모드라 따로 흉내낸다
   */
  pageState?: { title: string; bodyText: string } | null | "hang";
};

/** driveViewer 가 실제로 쓰는 Page 표면만 흉내낸다. */
function makeCtx(scenario: Scenario) {
  let onResponse: ((res: unknown) => Promise<void>) | null = null;
  const ctx = {
    async newPage() {
      return {
        on: (_e: string, fn: (res: unknown) => Promise<void>) => {
          onResponse = fn;
        },
        off: () => {},
        async goto() {},
        // 화면 상태 읽기 — 실패 순간의 페이지가 무엇을 보여줬는지가 이 사고의 유일한 증거원.
        // pageState 가 null 이면 그 읽기 자체가 깨지는 상황을 흉내낸다.
        async title() {
          if (scenario.pageState === null) throw new Error("page.title: Target closed");
          // Playwright 의 title() 은 타임아웃 인자가 없어, 깨진 페이지에서 영영 안 돌아올 수 있다.
          if (scenario.pageState === "hang") return new Promise<string>(() => {});
          return scenario.pageState?.title ?? "";
        },
        async textContent() {
          if (scenario.pageState === null) throw new Error("page.textContent: Target closed");
          if (scenario.pageState === "hang") return "";
          return scenario.pageState?.bodyText ?? "";
        },
        async waitForTimeout() {},
        async fill() {},
        // 검색 버튼 클릭 — 이 시점에 프로필 조회 응답이 흐른다(성공이든 차단이든).
        async click() {
          if (scenario.profileResponse) {
            await onResponse?.({
              url: () => "https://api-wh.storiesig.info/api/v1/instagram/userInfo",
              status: () => scenario.profileResponse!.status,
              text: async () => scenario.profileResponse!.body,
            });
          }
        },
        async waitForSelector() {
          if (!scenario.resultsRender) {
            throw new Error("page.waitForSelector: Timeout 15000ms exceeded.");
          }
        },
        locator: () => ({
          first: () => ({
            async click() {
              // 탭 클릭이 서명된 스토리 요청을 트리거한다.
              await onResponse?.({
                url: () => "https://api-wh.storiesig.info/api/v1/instagram/stories",
                status: () => 200,
                text: async () => JSON.stringify({ result: [{ pk: "s-1" }] }),
              });
            },
          }),
        }),
        async close() {},
      };
    },
    async clearCookies() {},
    async close() {},
  };
  return ctx as unknown as BrowserContext;
}

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

describe("driveViewer — 프로필 결과 대기(명시적 대기 대상)", () => {
  it("프로필 결과가 렌더되면 스토리 탭을 눌러 정상 수집한다", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () => makeCtx({ resultsRender: true, profileResponse: { status: 200, body: "{}" } }),
      now: c.now,
      sleep: c.sleep,
    });

    expect(out[0].error).toBeUndefined();
    expect(out[0].items).toHaveLength(1);
  });

  it("프로필 결과가 안 뜨면 프로필 조회의 **상태코드**를 사유에 담는다(차단 판별)", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 403, body: "<html>Attention Required! | Cloudflare</html>" },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    // 종전엔 "locator.click: Timeout" 만 남아 아래 어느 것도 알 수 없었다.
    expect(out[0].error).toContain("403");
    expect(out[0].error).toContain("Cloudflare");
    expect(out[0].error).toContain("프로필");
  });

  it("프로필 응답 자체가 없으면 '응답 없음'을 명시한다(상태코드 부재와 200 을 혼동 금지)", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () => makeCtx({ resultsRender: false, profileResponse: null }),
      now: c.now,
      sleep: c.sleep,
    });

    expect(out[0].error).toContain("응답 없음");
  });

  it("프로필이 200 인데도 결과가 안 뜨면 그 사실이 드러난다(렌더·타이밍 계열 분리)", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({ resultsRender: false, profileResponse: { status: 200, body: '{"result":{"user":{}}}' } }),
      now: c.now,
      sleep: c.sleep,
    });

    expect(out[0].error).toContain("200");
    expect(out[0].error).not.toContain("응답 없음");
  });
});

/**
 * 화면 미렌더의 **사유**까지 남기는 회귀.
 *
 * **왜 이 테스트가 있나(실사고 2026-08-29, 하루치 전량 무수집):** 위 게이트 덕에 "프로필은
 * 200 이었는데 화면이 안 떴다"까지는 알 수 있었다. 그런데 거기서 멈췄다 — 차단 화면이었는지,
 * 계정이 비공개였는지, 뷰어 UI 가 바뀐 것인지 가를 증거가 **어디에도 없었다.**
 *
 * 절단이 두 겹이었다. 바깥 겹(크론 로그 200자)은 run-cron.sh 가 닫았지만, 안쪽 겹은 이
 * 파일이 검증하는 사유 문자열 자체였다. 프로필 본문 프리뷰 200자 중 **161자를 전부 false 인
 * 중첩 객체가 먹어**, 판별에 필요한 필드는 한 글자도 실리지 않았다(실측).
 *
 * 그래서 두 가지를 고정한다: ① 실패 순간의 **화면 상태**를 함께 남긴다 ② 프로필 본문은
 * 예산을 신호에 쓴다. 진단은 로깅을 늘려서가 아니라 **예산을 어디에 쓰는지**로 얻는다.
 */
describe("driveViewer — 화면 미렌더의 사유(2026-08-29 회귀)", () => {
  /**
   * 그날 프로덕션이 받은 응답의 **모양**만 옮긴 것 — 식별자·핸들은 전부 가짜다(공개 레포라
   * 실데이터를 커밋하지 않는다. 이름에 `REAL` 을 쓰지 않는 이유이기도 하다).
   * 고정해야 하는 것은 값이 아니라 "판별 필드가 보일러플레이트 뒤에 눕는다"는 배치다.
   */
  const PROFILE_BODY_SHAPE_0829 = JSON.stringify({
    result: [
      {
        user: {
          pk: "0000000000",
          friendship_status: {
            following: false,
            blocking: false,
            is_feed_favorite: false,
            outgoing_request: false,
            followed_by: false,
            incoming_request: false,
            is_restricted: false,
            is_bestie: false,
          },
          is_private: true,
          username: "someone",
        },
      },
    ],
  });

  it("실패 순간의 화면 상태(제목·안내문구)를 사유에 담는다", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: "{}" },
          pageState: { title: "Just a moment...", bodyText: "Verify you are human before continuing" },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    // 이게 있어야 "차단 화면이었다" 를 로그만 보고 말할 수 있다.
    expect(out[0].error).toContain("Just a moment");
    expect(out[0].error).toContain("Verify you are human");
  });

  it("화면 상태 읽기가 깨져도 원래 실패 사유를 덮지 않는다(진단이 진단을 잡아먹지 않게)", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: "{}" },
          pageState: null, // title/textContent 가 throw 한다
        }),
      now: c.now,
      sleep: c.sleep,
    });

    expect(out[0].error).toContain("검색 결과 미렌더");
    expect(out[0].error).toContain("200");
  });

  it("프로필 본문 프리뷰가 보일러플레이트에 먹히지 않고 판별 필드를 싣는다", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: PROFILE_BODY_SHAPE_0829 },
          pageState: { title: "StoriesIG", bodyText: "" },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    // 08-29 에는 이 둘이 정확히 200자 뒤에 있어 잘려 나갔다.
    expect(out[0].error).toContain("is_private");
    expect(out[0].error).toContain("username");
    // 접기 표시까지 못박는다 — 이게 있어야 "상한만 올린 구현"과 구분된다(상한을 올리면
    // 위 두 필드는 실리지만 노이즈도 그대로 실린다).
    expect(out[0].error).toContain('"friendship_status":"…"');
  });

  /**
   * ⚠️ 이 테스트가 잡는 변이는 **try/catch 제거**다(파싱은 남기고 보호만 없애는 회귀).
   * 파싱 자체를 통째로 되돌리는 변이는 잡지 못한다 — 그때는 원문 슬라이스라 결과가 같다.
   * 그 축은 위 "접기 표시" 단언이 맡는다. 두 테스트가 함께 있어야 경로가 덮인다.
   */
  it("JSON 이 아니어도 진단 문자열이 정상적으로 만들어진다(파싱 실패가 사유를 날리지 않게)", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: {
            status: 429,
            body: "<html><title>Rate limited</title>Too many requests</html>",
          },
          pageState: { title: "", bodyText: "" },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    expect(out[0].error).toContain("429");
    expect(out[0].error).toContain("Rate limited");
    // 파싱 예외가 새면 사유가 통째로 예외 메시지로 바뀐다 — 그걸 못박는다.
    expect(out[0].error).toContain("검색 결과 미렌더");
  });

  it("화면 제목 읽기가 끝나지 않아도 실행이 매달리지 않는다(예산 보호)", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: "{}" },
          // page.title() 이 영영 안 돌아오는 상황. Playwright 는 title() 에 타임아웃 인자를
          // 주지 않으므로, 상한을 밖에서 걸지 않으면 여기서 실행 전체가 멈춘다.
          pageState: "hang",
        }),
      now: c.now,
      sleep: c.sleep,
    });

    // 멈추지 않고 사유가 만들어졌다는 것 자체가 판정이다.
    expect(out[0].error).toContain("검색 결과 미렌더");
    expect(out[0].error).toContain("200");
  }, 20_000);
});
