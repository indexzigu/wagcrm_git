// [셀러분석] Tier0 릴스 조회수 유료 보강 — 요청 본문(추가 옵션 끔) · shortcode 병합 · 월 상한 ·
// skip 조건 · 실패 시 분석 유지 + 실패 기록 · KST 월 경계. 모든 값은 가공 데이터.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LosslessSellerData, RawPost } from "../types";

const apiCallLogCreate = vi.fn();
const apiCallLogFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ apiCallLog: { create: apiCallLogCreate, findMany: apiCallLogFindMany } }),
}));
vi.mock("@/lib/instagram-token", () => ({ applyDbInstagramToken: vi.fn().mockResolvedValue(undefined) }));

const scrapeTier0 = vi.fn();
vi.mock("../graphScraper", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graphScraper")>();
  return { ...actual, isGraphConfigured: () => true, scrapeTier0: (h: string) => scrapeTier0(h) };
});

import {
  APIFY_REEL_VIEWS_SCOPE,
  DEFAULT_REEL_VIEWS_MONTHLY_CAP_USD,
  REEL_RESULTS_LIMIT,
  REEL_VIEWS_CAP_ENV,
  __resetReelViewsInFlightForTest,
  enrichTier0ReelViews,
  maxReelCallCostUsd,
  resolveMonthlyCapUsd,
  sumMonthReelViewsSpendUsd,
} from "../apifyReelViews";
import { scrapeSellerDataWaterfall } from "../scraper";

const TOKEN = "apify_api_TEST_TOKEN_VALUE";
const NOW = new Date("2026-11-15T03:00:00Z");

function post(over: Partial<RawPost>): RawPost {
  return {
    caption: "일상",
    likes: 1,
    comments_count: 0,
    sample_comments: [],
    taken_at: "2026-11-01T00:00:00Z",
    media_type: "reel",
    video_view_count: null,
    is_sponsored: false,
    video_url: null,
    thumbnail_url: null,
    shortcode: null,
    ...over,
  };
}

function fixture(posts: RawPost[]): LosslessSellerData {
  return {
    seller_id: "sample_shop",
    source_tier: "Tier 0 (Graph API)",
    debug_info: "BD ok.",
    profile: { username: "sample_shop", follower_count: 1000 },
    raw_posts: posts,
    images: [],
  };
}

function okResponse(items: unknown[]) {
  return new Response(JSON.stringify(items), { status: 200 });
}

const origEnv = {
  tokens: process.env.APIFY_API_TOKENS,
  single: process.env.APIFY_API_TOKEN,
  cap: process.env[REEL_VIEWS_CAP_ENV],
};

beforeEach(() => {
  apiCallLogCreate.mockReset().mockResolvedValue({});
  apiCallLogFindMany.mockReset().mockResolvedValue([]);
  scrapeTier0.mockReset();
  __resetReelViewsInFlightForTest();
  process.env.APIFY_API_TOKENS = TOKEN;
  delete process.env.APIFY_API_TOKEN;
  delete process.env[REEL_VIEWS_CAP_ENV];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore("APIFY_API_TOKENS", origEnv.tokens);
  restore("APIFY_API_TOKEN", origEnv.single);
  restore(REEL_VIEWS_CAP_ENV, origEnv.cap);
});

describe("요청 본문", () => {
  it("계정 이름 1개 · 결과 상한 15 · 유료 추가 옵션 3종 전부 false", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal("fetch", fetchSpy);

    await enrichTier0ReelViews(fixture([post({ shortcode: "R1" })]), NOW);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/v2/acts/apify~instagram-reel-scraper/run-sync-get-dataset-items");
    expect(JSON.parse(init.body)).toEqual({
      username: ["sample_shop"],
      resultsLimit: REEL_RESULTS_LIMIT,
      includeSharesCount: false,
      includeTranscript: false,
      includeDownloadedVideo: false,
    });
  });
});

describe("병합", () => {
  it("shortcode 로 조회수 + view_source='views' 를 넣고 1행 기록(토큰 값 없음)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okResponse([
          { shortCode: "R1", videoViewCount: 5000, videoPlayCount: 9000 },
          { shortCode: "ZZ", videoViewCount: 1 }, // 요청 데이터에 없는 릴스 — 귀속 안 됨
        ]),
      ),
    );
    const data = fixture([post({ shortcode: "R1" }), post({ shortcode: "R2" }), post({ media_type: "image", shortcode: "I1" })]);

    const result = await enrichTier0ReelViews(data, NOW);

    expect(result.status).toBe("called");
    expect(data.raw_posts[0]).toMatchObject({ video_view_count: 5000, view_source: "views" });
    expect(data.raw_posts[1].video_view_count).toBeNull();
    expect(data.raw_posts[2].video_view_count).toBeNull();
    expect(apiCallLogCreate).toHaveBeenCalledTimes(1);
    const row = apiCallLogCreate.mock.calls[0][0].data;
    expect(row).toMatchObject({ permissionScope: APIFY_REEL_VIEWS_SCOPE, provider: "INSTAGRAM", success: true, statusCode: 200 });
    const meta = JSON.parse(row.metadata);
    expect(meta).toMatchObject({ targetReels: 2, receivedReels: 2, filledReels: 1, filledFromViews: 1, filledFromPlays: 0 });
    expect(meta.estimatedCostUsd).toBeCloseTo(2 * 0.0026 + 0.001, 6);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("token=");
  });

  it("videoViewCount 가 없으면 videoPlayCount 로 채우고 view_source='plays' (url 로 shortcode 역산)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse([{ url: "https://www.instagram.com/reel/R1/", videoPlayCount: 700 }])),
    );
    const data = fixture([post({ shortcode: "R1" })]);

    await enrichTier0ReelViews(data, NOW);

    expect(data.raw_posts[0]).toMatchObject({ video_view_count: 700, view_source: "plays" });
  });

  it("이미 조회수가 있는 릴스는 덮어쓰지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse([{ shortCode: "R1", videoViewCount: 1 }, { shortCode: "R2", videoViewCount: 2 }])));
    const data = fixture([post({ shortcode: "R1", video_view_count: 999, view_source: "plays" }), post({ shortcode: "R2" })]);

    await enrichTier0ReelViews(data, NOW);

    expect(data.raw_posts[0]).toMatchObject({ video_view_count: 999, view_source: "plays" });
    expect(data.raw_posts[1]).toMatchObject({ video_view_count: 2, view_source: "views" });
  });
});

describe("skip(호출·기록 없음)", () => {
  it("릴스 0개", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const data = fixture([post({ media_type: "image", shortcode: "I1" })]);

    const r = await enrichTier0ReelViews(data, NOW);

    expect(r).toEqual({ status: "skipped", reason: "no reels" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(apiCallLogCreate).not.toHaveBeenCalled();
    expect(apiCallLogFindMany).not.toHaveBeenCalled();
  });

  it("모든 릴스에 이미 조회수가 있다(Tier1 형)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const r = await enrichTier0ReelViews(fixture([post({ shortcode: "R1", video_view_count: 10, view_source: "views" })]), NOW);

    expect(r.status).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(apiCallLogCreate).not.toHaveBeenCalled();
  });

  it("이번 달 지출 + 이번 호출 최대 비용이 상한을 넘으면 호출하지 않는다", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // 기본 상한 $2 에서 최대 1회 비용만큼 여유가 모자라게
    const spent = DEFAULT_REEL_VIEWS_MONTHLY_CAP_USD - maxReelCallCostUsd() + 0.001;
    apiCallLogFindMany.mockResolvedValue([{ metadata: JSON.stringify({ estimatedCostUsd: spent }) }]);
    const data = fixture([post({ shortcode: "R1" })]);

    const r = await enrichTier0ReelViews(data, NOW);

    expect(r.status).toBe("skipped");
    expect(r.status === "skipped" && r.reason).toContain("monthly cap");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(apiCallLogCreate).not.toHaveBeenCalled();
    expect(data.raw_posts[0].video_view_count).toBeNull();
    expect(data.debug_info).toContain("Reel views skipped");
    expect(data.reel_views_notice).toContain("상한");
  });

  it("동시 실행: 진행 중 호출의 최대 비용을 예약해 두 번째 실행은 상한으로 건너뛴다", async () => {
    // 여유가 정확히 1회분(1.5회분 미만)만 남은 상태
    const spent = DEFAULT_REEL_VIEWS_MONTHLY_CAP_USD - maxReelCallCostUsd() * 1.5;
    apiCallLogFindMany.mockResolvedValue([{ metadata: JSON.stringify({ estimatedCostUsd: spent }) }]);
    let release: (r: Response) => void = () => {};
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    vi.stubGlobal("fetch", fetchSpy);

    const first = enrichTier0ReelViews(fixture([post({ shortcode: "R1" })]), NOW);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const secondData = fixture([post({ shortcode: "R2" })]);
    const second = await enrichTier0ReelViews(secondData, NOW);

    expect(second.status === "skipped" && second.reason).toContain("in-flight");
    expect(secondData.reel_views_notice).toContain("상한");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    release(okResponse([]));
    expect((await first).status).toBe("called");
    // 예약은 기록 뒤 풀린다 — 같은 지출 기준이면 다음 실행은 다시 호출할 수 있다
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse([])));
    expect((await enrichTier0ReelViews(fixture([post({ shortcode: "R3" })]), NOW)).status).toBe("called");
  });

  it("정상 보강·상한 안 건너뜀(릴스 0개 등)에는 오너 안내를 달지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse([{ shortCode: "R1", videoViewCount: 5 }])));
    const ok = fixture([post({ shortcode: "R1" })]);
    await enrichTier0ReelViews(ok, NOW);
    expect(ok.reel_views_notice).toBeUndefined();
    const none = fixture([post({ media_type: "image", shortcode: "P1" })]);
    await enrichTier0ReelViews(none, NOW);
    expect(none.reel_views_notice).toBeUndefined();
  });

  it("상한 안이면 호출한다(경계 바로 아래)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal("fetch", fetchSpy);
    const spent = DEFAULT_REEL_VIEWS_MONTHLY_CAP_USD - maxReelCallCostUsd();
    apiCallLogFindMany.mockResolvedValue([{ metadata: JSON.stringify({ estimatedCostUsd: spent }) }]);

    await enrichTier0ReelViews(fixture([post({ shortcode: "R1" })]), NOW);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("env 상한 0 = 보강 끔", async () => {
    process.env[REEL_VIEWS_CAP_ENV] = "0";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await enrichTier0ReelViews(fixture([post({ shortcode: "R1" })]), NOW);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("지출 조회가 실패하면 닫힌 쪽(호출 안 함)", async () => {
    apiCallLogFindMany.mockRejectedValue(new Error("db down"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const r = await enrichTier0ReelViews(fixture([post({ shortcode: "R1" })]), NOW);

    expect(r.status).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("실패", () => {
  it("HTTP 실패: Tier0 데이터 유지 · 실패 1행(최대 비용으로 계상) · console.error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("hard limit exceeded", { status: 402 })));
    const data = fixture([post({ shortcode: "R1" })]);

    const r = await enrichTier0ReelViews(data, NOW);

    expect(r.status).toBe("called");
    expect(data.raw_posts[0].video_view_count).toBeNull();
    expect(data.debug_info).toContain("Apify reel views failed");
    const row = apiCallLogCreate.mock.calls[0][0].data;
    expect(row).toMatchObject({ success: false, statusCode: 402 });
    expect(row.errorMessage).toContain("hard limit");
    expect(JSON.parse(row.metadata).estimatedCostUsd).toBe(maxReelCallCostUsd());
    expect(console.error).toHaveBeenCalled();
    expect(data.reel_views_notice).toContain("실패");
  });

  it("네트워크 오류도 1행(statusCode 0)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    await enrichTier0ReelViews(fixture([post({ shortcode: "R1" })]), NOW);

    const row = apiCallLogCreate.mock.calls[0][0].data;
    expect(row).toMatchObject({ success: false, statusCode: 0, errorMessage: "ECONNRESET" });
  });

  it("워터폴에서 보강이 실패해도 분석은 Tier0 로 끝난다(Tier1 강등 없음)", async () => {
    scrapeTier0.mockResolvedValue(fixture([post({ shortcode: "R1" })]));
    // 댓글 호출(1번째)은 빈 성공, 릴스 호출(2번째)은 실패
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(okResponse([]))
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchSpy);

    const data = await scrapeSellerDataWaterfall("sample_shop", { enrichReelViews: true });

    expect(data.source_tier).toContain("Tier 0");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1][0])).toContain("instagram-reel-scraper");
    expect(data.raw_posts[0].video_view_count).toBeNull();
  });
});

describe("옵션 기본값(크론·자동 경로)", () => {
  it("enrichReelViews 미지정이면 릴스 액터를 부르지 않는다", async () => {
    scrapeTier0.mockResolvedValue(fixture([post({ shortcode: "R1" })]));
    const fetchSpy = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal("fetch", fetchSpy);

    await scrapeSellerDataWaterfall("sample_shop");

    for (const [url] of fetchSpy.mock.calls) expect(String(url)).not.toContain("instagram-reel-scraper");
    expect(apiCallLogFindMany).not.toHaveBeenCalled();
  });
});

describe("월 경계(KST)", () => {
  it("이번 달 시작은 KST 1일 00:00 = 전날 15:00 UTC", async () => {
    await sumMonthReelViewsSpendUsd(new Date("2026-11-30T16:00:00Z")); // KST 12-01 01:00
    expect(apiCallLogFindMany.mock.calls[0][0].where).toEqual({
      permissionScope: APIFY_REEL_VIEWS_SCOPE,
      calledAt: { gte: new Date("2026-11-30T15:00:00Z") },
    });

    await sumMonthReelViewsSpendUsd(new Date("2026-11-30T14:59:00Z")); // KST 11-30 23:59
    expect(apiCallLogFindMany.mock.calls[1][0].where.calledAt.gte).toEqual(new Date("2026-10-31T15:00:00Z"));
  });

  it("합산: 비용을 못 읽는 행은 최대 비용으로 센다", async () => {
    apiCallLogFindMany.mockResolvedValue([
      { metadata: JSON.stringify({ estimatedCostUsd: 0.01 }) },
      { metadata: "not-json" },
      { metadata: null },
    ]);
    const total = await sumMonthReelViewsSpendUsd(NOW);
    expect(total).toBeCloseTo(0.01 + 2 * maxReelCallCostUsd(), 6);
  });
});

describe("상한 env 해석", () => {
  it("미설정·빈값 → 기본 $2, 잘못된 값 → 기본 + 경고, 숫자 → 그대로", () => {
    expect(resolveMonthlyCapUsd(undefined)).toBe(2);
    expect(resolveMonthlyCapUsd("")).toBe(2);
    expect(resolveMonthlyCapUsd("abc")).toBe(2);
    expect(resolveMonthlyCapUsd("-1")).toBe(2);
    expect(console.warn).toHaveBeenCalled();
    expect(resolveMonthlyCapUsd("3.5")).toBe(3.5);
  });
});
