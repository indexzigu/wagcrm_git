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
