import { describe, expect, it } from "vitest";
import type { BrowserContext } from "playwright-core";
import { PAGE_STATE_TIMEOUTS, fetchStoriesForHandles } from "../story-viewer-fetch";

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
  /** 탭을 눌렀을 때 스토리 응답이 흐르는가(기본 true) — false 면 "스토리 응답 미포착" 경로 */
  storiesRespond?: boolean;
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
          // 제목과 본문 **둘 다** 멈추게 한다 — 상한이 한쪽에만 걸린 구현을 잡으려면
          // 두 경로가 모두 막혀 있어야 한다.
          if (scenario.pageState === "hang") return new Promise<string>(() => {});
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
              // 뷰어가 스토리 응답을 안 주는 회차 — 탭은 눌렸지만 아무것도 안 흐른다.
              if (scenario.storiesRespond === false) return;
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

  it("관계 플래그에 참인 값이 있으면 접지 않고 보존한다(그게 렌더 실패의 단서다)", async () => {
    const c = clock();
    const blocked = JSON.stringify({
      result: [{ user: { pk: "0000000000", friendship_status: { following: false, blocking: true } } }],
    });
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: blocked },
          pageState: { title: "StoriesIG", bodyText: "" },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    // 이름만 보고 접는 구현이면 이 단서가 통째로 사라진다.
    expect(out[0].error).toContain("blocking");
    expect(out[0].error).not.toContain('"friendship_status":"…"');
  });

  it("참인 플래그를 살리느라 판별 필드를 도로 잃지 않는다(08-29 재현 방지)", async () => {
    const c = clock();
    // 참 1개 + 거짓 여럿 — 뭉치를 통째로 남기면 거짓 플래그가 예산을 먹어 아래 둘이 잘린다.
    const blockedWithNoise = JSON.stringify({
      result: [
        {
          user: {
            pk: "0000000000",
            friendship_status: {
              following: false,
              blocking: true,
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
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: blockedWithNoise },
          pageState: { title: "StoriesIG", bodyText: "" },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    // 단서와 판별 필드가 **함께** 살아야 한다 — 어느 한쪽만 지키는 구현은 여기서 걸린다.
    expect(out[0].error).toContain("blocking");
    expect(out[0].error).toContain("is_private");
    expect(out[0].error).toContain("username");
  });

  it("스토리 응답을 못 잡았을 때도 3지 선다로 두지 않고 프로필 응답을 싣는다", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          // 검색 결과는 떴지만(탭 렌더 성공) 스토리 응답이 안 잡히는 경로.
          resultsRender: true,
          storiesRespond: false,
          profileResponse: { status: 200, body: '{"result":[{"user":{"is_private":true}}]}' },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    expect(out[0].error).toContain("스토리 응답 미포착");
    // 이게 없으면 "비공개/스토리없음/차단" 셋 중 무엇인지 영영 못 가른다.
    expect(out[0].error).toContain("is_private");
  });

  it("화면 제목 읽기가 끝나지 않아도 실행이 매달리지 않는다(예산 보호)", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: "{}" },
          // page.title()·textContent 가 영영 안 돌아오는 상황. Playwright 는 title() 에
          // 타임아웃 인자를 주지 않으므로, 상한을 밖에서 걸지 않으면 여기서 실행이 멈춘다.
          pageState: "hang",
        }),
      now: c.now,
      sleep: c.sleep,
    });

    // 멈추지 않고 사유가 만들어졌다는 것 자체가 판정이다.
    expect(out[0].error).toContain("검색 결과 미렌더");
    expect(out[0].error).toContain("200");
    // 멈춤과 예외를 같은 말로 적으면, 이 커밋이 쓰인 이유인 멈춤을 로그에서 못 가른다.
    expect(out[0].error).toContain("시한 초과");
    expect(out[0].error).not.toContain("읽기 실패");
  }, 20_000);

  /**
   * ⚠️ 이 자리에 "이력 저장 상한 안에 든다"를 단언하던 테스트가 있었는데 걷어냈다.
   * 그 단언은 **이 파일이 지킬 수 없는 약속**이었다 — 진짜 상한은 직렬화 뒤에, 다른 모듈이
   * 접두를 붙인 다음 걸리므로 여기서 잰 원문 길이 합과 애초에 다른 값이다. 게다가 핸들 수를
   * 고정한 테스트라 셀러가 늘어도 영영 초록이어서 경보 구실도 못 했다.
   * 지금 이 테스트가 지키는 것은 **"아무도 빠지지 않는다"** 하나다(그건 여기서 지킬 수 있다).
   */
  it("실패한 핸들이 전원 결과에 남는다(뒤쪽이 조용히 사라지지 않게)", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["a", "b", "c"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: PROFILE_BODY_SHAPE_0829 },
          pageState: { title: "x".repeat(300), bodyText: "y".repeat(900) },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    expect(out.map((r) => r.handle)).toEqual(["a", "b", "c"]);
    expect(out.every((r) => (r.error ?? "").length > 0)).toBe(true);
  });

  it("남기는 값 안의 노이즈도 계속 걷는다(중첩 노이즈가 그대로 실리지 않게)", async () => {
    const c = clock();
    const nested = JSON.stringify({
      result: [
        {
          user: {
            // 참이 하나 있어 뭉치가 보존되는데, 그 안에 또 노이즈 키가 있다.
            friendship_status: {
              blocking: true,
              friendship_status: { following: false, blocking: false, muting: false },
            },
            is_private: true,
          },
        },
      ],
    });
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: nested },
          pageState: { title: "StoriesIG", bodyText: "" },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    expect(out[0].error).toContain("blocking");
    // 중첩된 전부-거짓 뭉치는 접혀야 한다. 재귀를 빼면 muting 까지 그대로 실린다.
    expect(out[0].error).not.toContain("muting");
  });

  it("접기 표시와 같은 키가 원본에 있으면 덮어쓰지 않는다", async () => {
    const c = clock();
    // ⚠️ `muting: false` 가 **반드시 있어야 한다.** 접을 항목이 하나도 없으면 그 앞의 조기
    // 반환에 걸려 가드 줄에 **도달조차 못 하고**, 가드를 통째로 지워도 초록인 공허한 테스트가
    // 된다(5회차 리뷰가 변이로 잡은 실제 구멍).
    const collide = JSON.stringify({
      result: [
        { user: { friendship_status: { blocking: true, muting: false, "…": "원본값" }, is_private: true } },
      ],
    });
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: collide },
          pageState: { title: "StoriesIG", bodyText: "" },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    // 개수를 잃는 편이 실데이터를 잃는 것보다 낫다.
    expect(out[0].error).toContain("원본값");
  });

  /**
   * 프리뷰 상한 3종을 각각 못박는다.
   *
   * ⚠️ **한 축이 다른 축을 대신해 주지 않는다.** 종전엔 "사유 합계가 저장 상한 안"이라는
   * 느슨한 단언 하나가 상한 인상을 우연히 잡고 있었는데, 그 단언이 재는 값이 실제 저장 크기와
   * 달라 걷어냈다. 그러자 **상한을 20,000 으로 올려도 전부 초록**이 됐다(5회차 리뷰가 변이로
   * 확인). 걷어낸 것이 못 지키던 축이 있다고 해서 아무것도 안 지킨 것은 아니었다.
   */
  it("화면 본문이 길어도 상한까지만 싣는다", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: "{}" },
          pageState: { title: "t", bodyText: "y".repeat(5_000) },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    const body = /화면:(y+)/.exec(out[0].error ?? "")?.[1] ?? "";
    expect(body.length).toBe(200);
  });

  it("프로필 본문이 길어도 상한까지만 싣는다", async () => {
    const c = clock();
    // 접기를 거쳐도 여전히 긴 응답 — 노이즈가 아니라 진짜 데이터가 많은 경우다.
    const huge = JSON.stringify({ note: "z".repeat(5_000) });
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: huge },
          pageState: { title: "t", bodyText: "" },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    const preview = /본문:(\S+?) \//.exec(out[0].error ?? "")?.[1] ?? "";
    expect(preview.length).toBe(200);
  });

  it("본문 읽기 상한이 바깥 상한보다 짧다(어느 쪽이 이길지 정해지게)", () => {
    // 같은 값이면 "(시한 초과)"와 "(읽기 실패)"가 회차마다 뒤바뀌어 사유를 믿을 수 없게 된다.
    expect(PAGE_STATE_TIMEOUTS.innerText).toBeLessThan(PAGE_STATE_TIMEOUTS.outer);
  });

  it("화면 제목이 길어도 상한까지만 싣는다(이력 저장 예산 보호)", async () => {
    const c = clock();
    const out = await fetchStoriesForHandles(["someone"], {
      launch: async () =>
        makeCtx({
          resultsRender: false,
          profileResponse: { status: 200, body: "{}" },
          pageState: { title: "가".repeat(500), bodyText: "" },
        }),
      now: c.now,
      sleep: c.sleep,
    });

    const title = /화면 제목:(가+)/.exec(out[0].error ?? "")?.[1] ?? "";
    // 상한을 지우거나 크게 늘리면 여기서 걸린다(종전엔 500자가 그대로 실렸다).
    expect(title.length).toBe(80);
  });
});
