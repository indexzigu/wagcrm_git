// Apify 댓글 수집 지출 계측 계약 — 유료 경로라 "기록되지 않는 호출"과 "시크릿이 새는 기록"
// 둘 다 사고다. 순수 헬퍼 + 영속 경로 + fetch 어댑터의 성공/실패 분기를 한곳에서 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiCallLogCreate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ apiCallLog: { create: apiCallLogCreate } }),
}));

import {
  APIFY_COMMENT_PROVIDER,
  APIFY_COMMENT_SCOPE,
  COMMENT_COST_USD_PER_1K,
  NO_HTTP_RESPONSE,
  buildCommentUsageMetadata,
  describeApifyToken,
  estimateCommentCostUsd,
  recordApifyCommentUsage,
  truncateReason,
  type ApifyCommentCallUsage,
} from "../apify-comment-usage";
import { COMMENT_ENDPOINT_LABEL, fetchCommentsByShortcode } from "../apifyComments";

const SECRET = "apify_api_SUPERSECRETVALUE_do_not_leak";

function usageFixture(over: Partial<ApifyCommentCallUsage> = {}): ApifyCommentCallUsage {
  return {
    targetPosts: 10,
    receivedComments: 150,
    postsWithComments: 9,
    filledPosts: 9,
    durationMs: 4321,
    statusCode: 200,
    ok: true,
    errorMessage: null,
    tokenFingerprint: describeApifyToken(SECRET),
    endpoint: COMMENT_ENDPOINT_LABEL,
    ...over,
  };
}

const origTokens = process.env.APIFY_API_TOKENS;
const origSingle = process.env.APIFY_API_TOKEN;

beforeEach(() => {
  apiCallLogCreate.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (origTokens === undefined) delete process.env.APIFY_API_TOKENS;
  else process.env.APIFY_API_TOKENS = origTokens;
  if (origSingle === undefined) delete process.env.APIFY_API_TOKEN;
  else process.env.APIFY_API_TOKEN = origSingle;
});

describe("describeApifyToken — 비가역 식별자", () => {
  it("해시 앞 6자만 돌려주고 토큰 원문을 담지 않는다", () => {
    const fp = describeApifyToken(SECRET);
    expect(fp).toMatch(/^[0-9a-f]{6}$/);
    expect(SECRET).not.toContain(fp as string);
  });

  it("같은 토큰은 같은 지문, 다른 토큰은 다른 지문", () => {
    expect(describeApifyToken("a")).toBe(describeApifyToken("a"));
    expect(describeApifyToken("a")).not.toBe(describeApifyToken("b"));
  });

  it("토큰이 없으면 null(빈 문자열도 null)", () => {
    expect(describeApifyToken(undefined)).toBeNull();
    expect(describeApifyToken("")).toBeNull();
  });
});

describe("estimateCommentCostUsd — 결과 수 비례 과금", () => {
  it("1k당 단가를 그대로 적용한다", () => {
    expect(estimateCommentCostUsd(1000)).toBe(COMMENT_COST_USD_PER_1K);
    expect(estimateCommentCostUsd(150)).toBeCloseTo(0.345, 4);
  });

  it("0·음수·NaN은 0으로 떨어진다(지출 과대계상 방지)", () => {
    expect(estimateCommentCostUsd(0)).toBe(0);
    expect(estimateCommentCostUsd(-5)).toBe(0);
    expect(estimateCommentCostUsd(Number.NaN)).toBe(0);
  });
});

describe("truncateReason — 실패 사유 정규화", () => {
  it("개행을 접고 상한을 넘기면 자른다(응답 본문 통째 저장 방지)", () => {
    expect(truncateReason("a\n  b\tc")).toBe("a b c");
    const long = truncateReason("x".repeat(500));
    expect(long.length).toBeLessThanOrEqual(301);
    expect(long.endsWith("…")).toBe(true);
  });

  it("Error 객체는 message를 쓴다", () => {
    expect(truncateReason(new Error("boom"))).toBe("boom");
  });
});

describe("buildCommentUsageMetadata — 요구 필드 + 시크릿 차단", () => {
  it("타깃·수신·채움·소요시간·비용추정을 모두 담는다", () => {
    const meta = buildCommentUsageMetadata(usageFixture());
    expect(meta).toMatchObject({
      targetPosts: 10,
      receivedComments: 150,
      postsWithComments: 9,
      filledPosts: 9,
      durationMs: 4321,
      costPerThousandUsd: COMMENT_COST_USD_PER_1K,
    });
    expect(meta.estimatedCostUsd).toBeCloseTo(0.345, 4);
  });

  it("귀속 실패분(수신은 됐는데 못 채운 게시물)을 별도로 센다", () => {
    const meta = buildCommentUsageMetadata(usageFixture({ postsWithComments: 9, filledPosts: 4 }));
    expect(meta.unattributedPosts).toBe(5);
    // 음수로 새지 않는다(요청 밖 shortcode 유입 등)
    expect(buildCommentUsageMetadata(usageFixture({ postsWithComments: 2, filledPosts: 9 })).unattributedPosts).toBe(0);
  });

  it("직렬화 결과에 토큰 값이 등장하지 않는다(P0)", () => {
    const serialized = JSON.stringify(buildCommentUsageMetadata(usageFixture()));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("token=");
  });
});

describe("recordApifyCommentUsage — ApiCallLog 영속", () => {
  it("성공 호출을 기존 provider/scope 규약으로 기록한다", async () => {
    await recordApifyCommentUsage(usageFixture());
    const { data } = apiCallLogCreate.mock.calls[0][0];
    expect(data.provider).toBe(APIFY_COMMENT_PROVIDER);
    expect(data.permissionScope).toBe(APIFY_COMMENT_SCOPE);
    expect(data.success).toBe(true);
    expect(data.statusCode).toBe(200);
    expect(JSON.parse(data.metadata).receivedComments).toBe(150);
  });

  it("실패 호출도 반드시 1행 남긴다(P0 No Silent Failure)", async () => {
    await recordApifyCommentUsage(
      usageFixture({ ok: false, statusCode: 429, receivedComments: 0, postsWithComments: 0, filledPosts: 0, errorMessage: "quota exceeded" }),
    );
    const { data } = apiCallLogCreate.mock.calls[0][0];
    expect(data.success).toBe(false);
    expect(data.statusCode).toBe(429);
    expect(data.errorMessage).toBe("quota exceeded");
    expect(JSON.parse(data.metadata).estimatedCostUsd).toBe(0);
  });

  it("endpoint에 호스트도 쿼리(=토큰)도 넣지 않는다", async () => {
    await recordApifyCommentUsage(usageFixture());
    const { data } = apiCallLogCreate.mock.calls[0][0];
    expect(data.endpoint).toBe(COMMENT_ENDPOINT_LABEL);
    expect(data.endpoint).not.toContain("?");
    expect(data.endpoint).not.toContain("api.apify.com");
  });

  it("기록 실패가 수집을 깨뜨리지 않는다", async () => {
    apiCallLogCreate.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordApifyCommentUsage(usageFixture())).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("fetchCommentsByShortcode — 관측치 동반 반환", () => {
  it("성공 시 수신 댓글 수·댓글 받은 게시물 수·상태코드를 돌려준다", async () => {
    process.env.APIFY_API_TOKENS = SECRET;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { postUrl: "https://www.instagram.com/p/AAA/", text: "얼마예요?" },
            { postUrl: "https://www.instagram.com/p/AAA/", text: "링크 주세요" },
            { postUrl: "https://www.instagram.com/p/BBB/", text: "품절인가요" },
          ]),
          { status: 200 },
        ),
      ),
    );

    const { byShortcode, usage } = await fetchCommentsByShortcode(["AAA", "BBB"]);
    expect(byShortcode.get("AAA")).toHaveLength(2);
    expect(usage).toMatchObject({
      ok: true,
      statusCode: 200,
      targetPosts: 2,
      receivedComments: 3,
      postsWithComments: 2,
      errorMessage: null,
    });
    expect(usage.tokenFingerprint).toBe(describeApifyToken(SECRET));
    // durationMs 의 **값**은 아래 「소요시간 계측」 describe 가 따로 고정한다.
    expect(typeof usage.durationMs).toBe("number");
  });

  it("과금 단위는 파싱 성공 수가 아니라 액터가 돌려준 결과 수다", async () => {
    process.env.APIFY_API_TOKENS = SECRET;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        // 3건을 받았지만 텍스트·URL 결손으로 그룹핑되는 건 1건뿐 — 그래도 3건 값을 냈다.
        new Response(
          JSON.stringify([
            { postUrl: "https://www.instagram.com/p/AAA/", text: "정상" },
            { postUrl: "https://www.instagram.com/p/AAA/", text: "   " },
            { text: "url 없음" },
          ]),
          { status: 200 },
        ),
      ),
    );

    const { usage } = await fetchCommentsByShortcode(["AAA"]);
    expect(usage.receivedComments).toBe(3);
    expect(usage.postsWithComments).toBe(1);
  });

  it("HTTP 실패는 throw 하지 않고 관측치로 돌려준다", async () => {
    process.env.APIFY_API_TOKENS = SECRET;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("monthly usage hard limit exceeded", { status: 402 })));

    const { byShortcode, usage } = await fetchCommentsByShortcode(["AAA"]);
    expect(byShortcode.size).toBe(0);
    expect(usage.ok).toBe(false);
    expect(usage.statusCode).toBe(402);
    expect(usage.errorMessage).toContain("hard limit");
  });

  it("네트워크 오류는 statusCode 0으로 기록된다", async () => {
    process.env.APIFY_API_TOKENS = SECRET;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    const { usage } = await fetchCommentsByShortcode(["AAA"]);
    expect(usage.ok).toBe(false);
    expect(usage.statusCode).toBe(NO_HTTP_RESPONSE);
    expect(usage.errorMessage).toBe("ECONNRESET");
  });

  it("토큰 미설정은 호출 전 실패로 구분된다", async () => {
    delete process.env.APIFY_API_TOKENS;
    delete process.env.APIFY_API_TOKEN;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { usage } = await fetchCommentsByShortcode(["AAA"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(usage.ok).toBe(false);
    expect(usage.statusCode).toBe(NO_HTTP_RESPONSE);
    expect(usage.tokenFingerprint).toBeNull();
  });

  it("타깃이 없으면 호출도 지출도 없다", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { usage } = await fetchCommentsByShortcode([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(usage).toMatchObject({ ok: true, targetPosts: 0, receivedComments: 0 });
  });
});

/**
 * `durationMs` 는 지출 리포트의 `durationTotal`(`apify-comment-usage-report.ts`)로 합산되는
 * 관측 신호다. 종전 단언은 `toBeGreaterThanOrEqual(0)` 하나뿐이라 **계측이 상수 `0` 으로
 * 죽어도 통과했다** — 유료 경로의 소요시간이 조용히 0이 되면 리포트가 과소계상된다.
 *
 * 하한을 "내가 주입한 지연"으로 잡는 처방은 쓰지 않는다(PR #336): `setTimeout` 은 요청보다
 * 최대 1ms 일찍 깨므로 그 전제 자체가 거짓이고, 임계값을 낮추면 플레이크가 뒤로 미뤄질 뿐이다.
 * 대신 **실제로 흐른 시간**으로 감싼다 — fetch 어댑터가 자기 구간을 스스로 재고, 테스트가
 * 전체 구간을 잰다. 구현의 계측 구간(`startedAt` = 함수 진입, `elapsed()` = 반환 직전)은
 * fetch 구간을 항상 포함하고 테스트 구간에 항상 포함되므로, 부하와 무관하게 성립한다.
 */
describe("fetchCommentsByShortcode — 소요시간 계측", () => {
  it("durationMs 는 실제 fetch 소요시간 이상이고 전체 호출시간 이하다(상수로 죽지 않았다)", async () => {
    process.env.APIFY_API_TOKENS = SECRET;
    let fetchElapsedMs = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        const fetchStartedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 20));
        fetchElapsedMs = Date.now() - fetchStartedAt;
        return new Response(
          JSON.stringify([{ postUrl: "https://www.instagram.com/p/AAA/", text: "얼마예요?" }]),
          { status: 200 },
        );
      }),
    );

    const outerStartedAt = Date.now();
    const { usage } = await fetchCommentsByShortcode(["AAA"]);
    const outerElapsedMs = Date.now() - outerStartedAt;

    // 하한이 0이면 상수 0을 하드코딩해도 통과한다 — 단언이 헛돌지 않게 먼저 고정한다.
    expect(fetchElapsedMs).toBeGreaterThan(0);
    expect(usage.durationMs).toBeGreaterThanOrEqual(fetchElapsedMs);
    expect(usage.durationMs).toBeLessThanOrEqual(outerElapsedMs);
  });
});
