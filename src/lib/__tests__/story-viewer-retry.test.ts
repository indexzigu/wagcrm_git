import { describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright-core";
import { fetchStoriesForHandles, STORY_FETCH_BUDGET_MS } from "../story-viewer-fetch";

/**
 * 지연 재시도 + 조회 예산 회귀.
 *
 * 왜 예산이 안전장치인가: `captureActiveCampaignStories` 는 **전 핸들을 다 조회한 뒤에야**
 * 저장한다. 조회가 라우트 maxDuration(300s)을 먹어치우면 플랫폼이 함수를 죽여 **성공한
 * 핸들의 스토리까지 통째로 유실**되고, 응답이 없으니 withSystemTaskStatus 의 RUNNING 마커가
 * 고착된다. 즉 나이브한 재시도는 현 상태보다 나쁘다 — 아래 테스트가 그 경계를 고정한다.
 *
 * 왜 즉시가 아니라 지연 재시도인가: 로컬 실측에서 1차에 `page.goto: Timeout` 이 난 핸들이
 * 시간이 지난 뒤 재시도에서 성공했다(2/2). 같은 순간을 다시 때리는 건 의미가 적다.
 */

/** driveViewer 가 쓰는 Page 표면만 흉내낸다. goto 가 throw 하면 그 시도는 실패한다. */
function makeCtx(
  behavior: (handle: string, attempt: number) => "ok" | "fail",
  // 시도 1회가 실제로 시간을 먹는 것을 모사한다 — 이게 없으면 예산 테스트가 무의미해진다
  onAttempt: () => void = () => {},
) {
  const attempts = new Map<string, number>();
  const calls: string[] = [];
  let filled = "";

  const ctx = {
    async newPage() {
      let onResponse: ((res: unknown) => Promise<void>) | null = null;
      return {
        on: (_e: string, fn: (res: unknown) => Promise<void>) => {
          onResponse = fn;
        },
        off: () => {},
        // goto 는 fill 보다 앞서 실행돼 아직 어느 핸들인지 모른다 — 성공/실패 판정은 click 시점으로 미룬다.
        async goto() {},
        async waitForTimeout() {},
        // 검색 결과 대기 — 이 하네스는 성공/실패를 click 시점에 가르므로 여기선 항상 통과시킨다.
        // (미렌더 분기 자체의 계약은 story-viewer-profile-gate.test.ts 소관)
        async waitForSelector() {},
        async fill(_sel: string, value: string) {
          filled = value;
        },
        async click() {
          const n = (attempts.get(filled) ?? 0) + 1;
          attempts.set(filled, n);
          calls.push(`${filled}#${n}`);
          onAttempt();
          if (behavior(filled, n) === "fail") {
            throw new Error("page.goto: Timeout 35000ms exceeded.");
          }
          // 성공 경로 — 스토리 응답을 흘려보낸다.
          await onResponse?.({
            url: () => "https://storiesig.info/api/v1/instagram/stories",
            text: async () => JSON.stringify({ result: [{ pk: `${filled}-1` }] }),
          });
        },
        locator: () => ({ first: () => ({ click: async () => {} }) }),
        async close() {},
      };
    },
    async clearCookies() {},
    async close() {},
  };

  return { ctx: ctx as unknown as BrowserContext, calls };
}

/** 시간을 수동으로 굴린다 — 각 시도는 PER_ATTEMPT_WORST_MS(45s) 상당을 소비했다고 본다. */
function makeClock(stepMs = 45_000) {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: () => (t += stepMs),
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("fetchStoriesForHandles — 지연 재시도", () => {
  it("1차 실패한 핸들만 2차에서 재시도하고, 성공하면 결과를 덮어쓴다", async () => {
    // a 는 1차 실패·2차 성공(로컬에서 실제로 관측된 형태), b 는 1차부터 성공
    const { ctx, calls } = makeCtx((h, n) => (h === "a" && n === 1 ? "fail" : "ok"));
    const clock = makeClock(0);

    const out = await fetchStoriesForHandles(["a", "b"], {
      launch: async () => ctx,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(out.map((o) => o.handle)).toEqual(["a", "b"]);
    expect(out[0].error).toBeUndefined();
    expect(out[0].items).toHaveLength(1);
    // b 는 성공했으므로 재시도되지 않는다(불필요한 예산 소모 금지)
    expect(calls).toEqual(["a#1", "b#1", "a#2"]);
  });

  it("2차도 실패하면 1차·2차 사유를 모두 남긴다(무음 실패 금지)", async () => {
    const { ctx } = makeCtx(() => "fail");
    const clock = makeClock(0);

    const out = await fetchStoriesForHandles(["a"], {
      launch: async () => ctx,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(out[0].error).toContain("1차:");
    expect(out[0].error).toContain("2차:");
  });

  it("핸들이 하나뿐이면 재시도 전에 최소 간격을 채운다(즉시 재시도 금지)", async () => {
    const { ctx } = makeCtx((_h, n) => (n === 1 ? "fail" : "ok"));
    const clock = makeClock(0);
    const sleep = vi.fn(clock.sleep);

    await fetchStoriesForHandles(["solo"], { launch: async () => ctx, now: clock.now, sleep });

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(0);
  });
});

describe("fetchStoriesForHandles — 조회 예산(총 유실 방지)", () => {
  it("예산이 1회분뿐이면 재시도를 포기하고 그 사실을 사유에 남긴다", async () => {
    const clock = makeClock(); // 시도 1회 = 45s 소모
    const { ctx, calls } = makeCtx(
      () => "fail",
      () => clock.advance(),
    );

    const out = await fetchStoriesForHandles(["a"], {
      launch: async () => ctx,
      now: clock.now,
      sleep: clock.sleep,
      budgetMs: 50_000, // 45s 짜리 시도 하나만 들어간다
    });

    expect(calls).toEqual(["a#1"]); // 2차는 아예 시작하지 않았다
    expect(out[0].error).toContain("재시도 예산 소진");
  });

  it("예산이 바닥나면 남은 핸들을 시도조차 하지 않고 그 사실을 드러낸다", async () => {
    const clock = makeClock();
    const { ctx, calls } = makeCtx(
      () => "fail",
      () => clock.advance(),
    );

    const out = await fetchStoriesForHandles(["a", "b", "c"], {
      launch: async () => ctx,
      now: clock.now,
      sleep: clock.sleep,
      budgetMs: 50_000,
    });

    // a 만 실제로 시도됐고, b·c 는 예산이 없어 건너뛰었다 — 조용히 빈 결과를 주지 않는다
    expect(calls).toEqual(["a#1"]);
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.handle)).toEqual(["a", "b", "c"]);
    expect(out[1].error).toContain("시도하지 않음");
    expect(out[2].error).toContain("시도하지 않음");
  });

  it("예산이 넉넉하면 1차에 일부라도 성공한 회차는 실패분 전량을 재시도한다(가드 과잉 차단 없음)", async () => {
    const clock = makeClock();
    // b 만 1차 성공 = 혼재 → 계통 장애가 아니므로 a·c 둘 다 재시도돼야 한다
    const { ctx, calls } = makeCtx(
      (h, n) => (h === "b" || n > 1 ? "ok" : "fail"),
      () => clock.advance(),
    );

    await fetchStoriesForHandles(["a", "b", "c"], {
      launch: async () => ctx,
      now: clock.now,
      sleep: clock.sleep,
      // ⚠️ 운영 예산(200s)이 아니라 넉넉한 값을 쓴다 — 이 테스트가 보려는 건 "계통 장애가
      // 아니면 실패분 전량을 재시도한다"이지 예산 용량이 아니다(용량은 아래 테스트가 고정).
      budgetMs: 500_000,
    });

    expect(calls).toEqual(["a#1", "b#1", "c#1", "a#2", "c#2"]);
  });

  it("운영 예산 200s 는 45s 시도를 4회까지만 담는다 — 셀러가 많으면 재시도가 줄어든다", async () => {
    const clock = makeClock();
    const { ctx, calls } = makeCtx(
      () => "fail",
      () => clock.advance(),
    );

    await fetchStoriesForHandles(["a", "b", "c", "d"], {
      launch: async () => ctx,
      now: clock.now,
      sleep: clock.sleep,
      budgetMs: STORY_FETCH_BUDGET_MS,
    });

    // 최악 가정(45s/시도)에서는 1차 4회로 예산이 차 재시도가 0회다. 실제 실패는 ≈35s 라
    // 보통 1회는 들어가지만, **셀러 수가 늘면 재시도 여력이 준다**는 성질을 여기 고정한다.
    // 이 한계를 넓히려면 라우트 maxDuration 상향이 선행돼야 한다(예산 상수만 올리면 함수가 죽는다).
    expect(calls).toEqual(["a#1", "b#1", "c#1", "d#1"]);
  });
});

describe("fetchStoriesForHandles — 계통 장애 조기 포기", () => {
  it("1차 전멸 + 탐침 재시도도 실패면 나머지 재시도를 생략한다(매일 헛태우기 방지)", async () => {
    const clock = makeClock();
    const { ctx, calls } = makeCtx(
      () => "fail",
      () => clock.advance(),
    );

    const out = await fetchStoriesForHandles(["a", "b", "c"], {
      launch: async () => ctx,
      now: clock.now,
      sleep: clock.sleep,
      budgetMs: STORY_FETCH_BUDGET_MS, // 예산은 넉넉 — 포기 사유가 예산이 아님을 분리
    });

    // 1차 3회 + 탐침 1회로 끝. b·c 는 재시도하지 않는다.
    expect(calls).toEqual(["a#1", "b#1", "c#1", "a#2"]);
    expect(out[1].error).toContain("계통 장애 판단");
    expect(out[2].error).toContain("계통 장애 판단");
  });

  it("1차 전멸이어도 탐침이 성공하면 나머지를 계속 재시도한다(일시 전면 장애 회복)", async () => {
    const clock = makeClock();
    const { ctx, calls } = makeCtx(
      (_h, n) => (n === 1 ? "fail" : "ok"),
      () => clock.advance(),
    );

    const out = await fetchStoriesForHandles(["a", "b"], {
      launch: async () => ctx,
      now: clock.now,
      sleep: clock.sleep,
      budgetMs: STORY_FETCH_BUDGET_MS,
    });

    expect(calls).toEqual(["a#1", "b#1", "a#2", "b#2"]);
    expect(out.every((o) => !o.error)).toBe(true);
  });

  it("예산 상수는 라우트 maxDuration(300s)보다 작아 저장·리호스팅 몫을 남긴다", () => {
    // 이 부등식이 깨지면 조회가 예산을 다 먹고 저장 전에 함수가 죽는다 — 회귀 가드
    expect(STORY_FETCH_BUDGET_MS).toBeLessThan(300_000);
    expect(300_000 - STORY_FETCH_BUDGET_MS).toBeGreaterThanOrEqual(60_000);
  });
});
