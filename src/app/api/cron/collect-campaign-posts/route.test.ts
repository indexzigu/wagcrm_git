import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * 실질 실패 판정 회귀 — 수집창 셀러 전원이 실패해도 HTTP 200 이라 `failed` 선언이 없으면
 * SUCCESS 로 기록된다(`CronOutcomeBody` 계약).
 *
 * 이 잡에는 그 형태의 **실사고 기록이 이미 있다**(`campaign-posts-refresh.ts` 의 토큰 게이트
 * 주석, 2026-08-26): Tier0 토큰이 프로세스 env 에 얹히지 않으면 수집기가 창 안 셀러를
 * 한 명도 갱신하지 못한 채 조기 반환하는데, 크론 상태는 세 회차 모두 SUCCESS 였다.
 * 아래 첫 경계가 정확히 그 형태다.
 *
 * 시도는 `activeSellers - skipped` 다 — 오늘(KST) 이미 갱신돼 건너뛴 셀러는 시도가 아니다.
 */

const refreshMock = vi.fn();

vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));
vi.mock("@/lib/campaign-posts-refresh", () => ({
  refreshCampaignWindowPosts: (...args: unknown[]) => refreshMock(...args),
}));

const SECRET = "test-cron-secret";

function call() {
  return GET(
    new Request("http://localhost/api/cron/collect-campaign-posts", {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
}

beforeEach(() => {
  refreshMock.mockReset();
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("collect-campaign-posts 실질 실패 선언", () => {
  it("창 안 셀러를 한 명도 갱신하지 못하면 failed 를 선언한다(토큰 미설정 실사고의 형태)", async () => {
    refreshMock.mockResolvedValue({
      activeSellers: 2,
      refreshed: 0,
      skipped: 0,
      errors: ["INSTAGRAM_ACCESS_TOKEN/BUSINESS_ACCOUNT_ID 미설정: Tier0 수집 불가"],
    });

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
    expect(body.failureReason).toContain("2");
  });

  it("하나라도 갱신했으면 정상이다", async () => {
    refreshMock.mockResolvedValue({
      activeSellers: 2,
      refreshed: 1,
      skipped: 0,
      errors: ["someone: boom"],
    });

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("전원 오늘 이미 갱신돼 건너뛰면 정상이다(시도 0 — 상시 빨강 방지)", async () => {
    refreshMock.mockResolvedValue({ activeSellers: 2, refreshed: 0, skipped: 2, errors: [] });

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });

  it("수집창에 셀러가 없으면 정상이다(무비용 종료)", async () => {
    refreshMock.mockResolvedValue({ activeSellers: 0, refreshed: 0, skipped: 0, errors: [] });

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
  });
});
