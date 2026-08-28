import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * 실질 실패 판정 회귀 — 2026-07-13~22 실사고의 기계 강제 장치.
 *
 * 이 크론은 뷰어 조회가 전량 실패해도 "요청은 처리했다"는 의미로 HTTP 200 을 반환한다.
 * 그래서 상태판이 11일간 SUCCESS 를 남기며 수집 0건을 숨겼다. 아래 두 경계가 이 판정의
 * 전부다 — **전량 조회 실패면 실패**, **조회는 됐는데 스토리가 없으면 정상**(셀러가 그날
 * 안 올린 것). 이 구분이 무너지면 매일 빨강이 되어 습관화로 신호를 잃는다.
 */

const captureMock = vi.fn();

vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));
// 수집만 목킹하고 **판정은 실물을 쓴다** — 이 파일이 지키려는 경계가 바로 그 판정이라
// 목으로 대체하면 계약이 공허해진다(로컬 러너와 공유하는 SSOT 이기도 하다).
vi.mock("@/lib/story-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/story-capture")>()),
  captureActiveCampaignStories: (...args: unknown[]) => captureMock(...args),
}));

const SECRET = "test-cron-secret";

function call() {
  return GET(
    new Request("http://localhost/api/cron/capture-stories", {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
}

function result(over: Partial<Record<string, unknown>>) {
  return {
    activeSellers: 0,
    handles: [],
    storiesSeen: 0,
    storiesNew: 0,
    thumbnailsRehosted: 0,
    handlesSkipped: 0,
    handlesFailed: 0,
    errors: [],
    ...over,
  };
}

beforeEach(() => {
  captureMock.mockReset();
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("capture-stories 실질 실패 선언", () => {
  it("시도한 핸들이 전부 조회 실패하면 failed 를 선언한다(11일 무음 실패의 형태)", async () => {
    captureMock.mockResolvedValue(
      result({
        activeSellers: 4,
        handles: ["a", "b", "c", "d"],
        handlesFailed: 4,
        errors: ["fetch a: Timeout 35000ms exceeded."],
      }),
    );

    const body = await (await call()).json();

    expect(body.failed).toBe(true);
    expect(body.failureReason).toContain("4명");
  });

  it("조회는 성공했는데 스토리가 0건이면 정상이다(셀러가 그날 안 올린 경우)", async () => {
    captureMock.mockResolvedValue(
      result({ activeSellers: 2, handles: ["a", "b"], storiesSeen: 0, handlesFailed: 0 }),
    );

    const body = await (await call()).json();

    expect(body.failed).toBe(false);
    expect(body.failureReason).toBeUndefined();
  });

  it("일부만 실패하면 정상이다(부분 실패를 빨강으로 승격하지 않는다)", async () => {
    captureMock.mockResolvedValue(
      result({ activeSellers: 3, handles: ["a", "b", "c"], storiesSeen: 7, handlesFailed: 1 }),
    );

    expect((await (await call()).json()).failed).toBe(false);
  });

  it("수집창에 셀러가 없으면 정상이다(무비용 종료 — 0/0 을 실패로 읽지 않는다)", async () => {
    captureMock.mockResolvedValue(result({}));

    expect((await (await call()).json()).failed).toBe(false);
  });

  it("인증 없는 호출은 수집을 시도하지 않는다", async () => {
    const res = await GET(new Request("http://localhost/api/cron/capture-stories"));

    expect(res.status).toBe(401);
    expect(captureMock).not.toHaveBeenCalled();
  });
});
