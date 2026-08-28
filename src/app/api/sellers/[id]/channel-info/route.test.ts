import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

const sellerFindUniqueMock = vi.fn();
const sellerUpdateMock = vi.fn();
const sellersHistoryUpsertMock = vi.fn();
const bioHistoryCreateMock = vi.fn();
const apiCallLogCreateMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    seller: {
      findUnique: sellerFindUniqueMock,
      update: sellerUpdateMock,
    },
    sellersHistory: {
      upsert: sellersHistoryUpsertMock,
    },
    sellerProfileBioHistory: {
      create: bioHistoryCreateMock,
    },
    apiCallLog: {
      create: apiCallLogCreateMock,
    },
  }),
}));

// Instagram `api` 모드는 DB 에 갱신된 토큰이 있으면 env 보다 우선 적용한다 — 테스트에서는 무동작.
vi.mock("@/lib/instagram-token", () => ({
  applyDbInstagramToken: vi.fn().mockResolvedValue(undefined),
}));

function createRequest(url: string, queryUrl?: string): NextRequest {
  const base = "http://localhost:3000";
  const searchParams = queryUrl
    ? `?url=${encodeURIComponent(queryUrl)}`
    : "";
  return new NextRequest(`${base}/api/sellers/test-id/channel-info${searchParams}`);
}

const mockContext = {
  params: Promise.resolve({ id: "test-id" }),
};

describe("GET /api/sellers/[id]/channel-info", () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    // 수집 모드는 명시 opt-in 이다(fail-closed) — 미설정이면 라우트가 500 을 낸다.
    // 이 파일의 대부분은 URL 파싱·응답 형태를 보는 테스트라 mock 을 기본으로 깔아준다.
    // 미설정 자체를 검증하는 테스트는 아래에서 개별적으로 지운다.
    process.env.INSTAGRAM_COLLECT_MODE = "mock";
    process.env.YOUTUBE_COLLECT_MODE = "mock";
    process.env.X_COLLECT_MODE = "mock";
    sellerFindUniqueMock.mockResolvedValue({
      id: "test-id",
      name: "테스트셀러",
      channelUrl: null,
      snsType: null,
      snsHandle: null,
      currentFollowers: null,
      histories: [],
    });
    sellerUpdateMock.mockResolvedValue({});
    sellersHistoryUpsertMock.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns 400 when url parameter is missing", async () => {
    const request = createRequest("/api/sellers/test-id/channel-info");
    const response = await GET(request, mockContext);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("url 파라미터가 필요하며 셀러의 채널 URL 정보도 없습니다.");
  });

  it("returns 400 for invalid URL format (no http/https)", async () => {
    const request = createRequest(
      "/api/sellers/test-id/channel-info",
      "ftp://instagram.com/handle",
    );
    const response = await GET(request, mockContext);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("유효한 URL 형식이 아닙니다.");
  });

  it("returns 400 for unsupported platform URL", async () => {
    const request = createRequest(
      "/api/sellers/test-id/channel-info",
      "https://example.com/someuser",
    );
    const response = await GET(request, mockContext);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("지원하지 않는 채널 URL 형식입니다.");
  });

  describe("Instagram URL parsing", () => {
    it("extracts handle from instagram.com/{handle}", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://instagram.com/myhandle",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsType).toBe("INSTAGRAM");
      expect(body.snsHandle).toBe("myhandle");
    });

    it("extracts handle from www.instagram.com/{handle}", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://www.instagram.com/beauty_creator",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsType).toBe("INSTAGRAM");
      expect(body.snsHandle).toBe("beauty_creator");
    });

    it("handles trailing slash in instagram URL", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://instagram.com/handle123/",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsType).toBe("INSTAGRAM");
      expect(body.snsHandle).toBe("handle123");
    });

    it("returns 400 for instagram.com with no path", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://instagram.com/",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(400);
    });
  });

  describe("YouTube URL parsing", () => {
    it("extracts handle from youtube.com/@handle", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://www.youtube.com/@mychannel",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsType).toBe("YOUTUBE");
      expect(body.snsHandle).toBe("mychannel");
    });

    it("extracts channel ID from youtube.com/channel/{id}", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://www.youtube.com/channel/UC1234567890",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsType).toBe("YOUTUBE");
      expect(body.snsHandle).toBe("UC1234567890");
    });

    it("extracts name from youtube.com/c/{name}", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://www.youtube.com/c/MyChannel",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsType).toBe("YOUTUBE");
      expect(body.snsHandle).toBe("MyChannel");
    });

    it("extracts username from youtube.com/user/{username}", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://www.youtube.com/user/someuser",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsType).toBe("YOUTUBE");
      expect(body.snsHandle).toBe("someuser");
    });

    it("handles youtu.be domain", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://youtu.be/somechannel",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsType).toBe("YOUTUBE");
      expect(body.snsHandle).toBe("somechannel");
    });
  });

  describe("X URL parsing", () => {
    it("extracts handle from x.com/{handle}", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://x.com/myxhandle",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsType).toBe("X");
      expect(body.snsHandle).toBe("myxhandle");
    });

    it("extracts handle from twitter.com/{handle}", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://twitter.com/mytwitterhandle",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsType).toBe("X");
      expect(body.snsHandle).toBe("mytwitterhandle");
    });

    it("handles leading @ symbol in X handle during parsing", async () => {
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://x.com/@elonmusk",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsType).toBe("X");
      expect(body.snsHandle).toBe("elonmusk");
    });
  });

  it("returns response with mock collector details when in mock mode", async () => {
    // mock 은 명시 opt-in 이다 — 예전에는 이 줄 없이 기본값(fail-open)에 기대고 있었다.
    process.env.INSTAGRAM_COLLECT_MODE = "mock";
    const request = createRequest(
      "/api/sellers/test-id/channel-info",
      "https://instagram.com/testuser",
    );
    const response = await GET(request, mockContext);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.snsType).toBe("INSTAGRAM");
    expect(body.snsHandle).toBe("testuser");
    expect(body.name).toBe("테스트셀러");
    expect(typeof body.currentFollowers).toBe("number");
  });

  // fail-closed 회귀 가드: 미설정은 mock 으로 떨어지지 않는다.
  // 예전에는 `|| "mock"` 이라 변수가 없을 때 난수 팔로워를 만들어 prod DB 에 저장했다
  // (실측 오염 SellersHistory.source="MOCK" 14건). 이 테스트가 그 복귀를 막는다.
  describe("수집 모드 미설정(fail-closed)", () => {
    it.each([
      ["INSTAGRAM_COLLECT_MODE", "https://instagram.com/testuser"],
      ["YOUTUBE_COLLECT_MODE", "https://youtube.com/@testchannel"],
      ["X_COLLECT_MODE", "https://x.com/@elonmusk"],
    ])("%s 가 없으면 500 을 반환하고 저장하지 않는다", async (envKey, url) => {
      delete process.env[envKey];
      const request = createRequest("/api/sellers/test-id/channel-info", url);
      const response = await GET(request, mockContext);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain(envKey);
      expect(body.error).toContain("미설정");
    });

    it("빈 문자열도 미설정으로 취급한다", async () => {
      process.env.INSTAGRAM_COLLECT_MODE = "   ";
      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://instagram.com/testuser",
      );
      const response = await GET(request, mockContext);
      expect(response.status).toBe(500);
    });
  });

  it("generates correct mock name for X channel in mock mode", async () => {
    process.env.X_COLLECT_MODE = "mock";
    const request = createRequest(
      "/api/sellers/test-id/channel-info",
      "https://x.com/@elonmusk"
    );
    const response = await GET(request, mockContext);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.snsType).toBe("X");
    expect(body.snsHandle).toBe("elonmusk");
    expect(body.name).toBe("elonmusk");
  });

  describe("X API mode", () => {
    beforeEach(() => {
      process.env.X_COLLECT_MODE = "api";
      // 이전에는 라우트가 키 리터럴을 소스에 폴백으로 갖고 있어 env 없이도 이 분기가
      // 동작했다(그래서 설정 누락이 테스트에 드러나지 않았다). 이제는 명시 주입이 필요하다.
      process.env.RAPIDAPI_KEY = "test-rapidapi-key";
    });

    it("fetches and parses X profile successfully from RapidAPI", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: "active",
          name: "Elon Musk",
          sub_count: 240000000,
        })
      });
      global.fetch = mockFetch;

      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://x.com/elonmusk"
      );

      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe("Elon Musk");
      expect(body.currentFollowers).toBe(240000000);
      expect(body.snsType).toBe("X");
      expect(body.snsHandle).toBe("elonmusk");
    });

    it("fetches X profile by stripping leading @ symbol", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: "active",
          name: "Elon Musk",
          sub_count: 240000000,
        })
      });
      global.fetch = mockFetch;

      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://x.com/@elonmusk"
      );

      const response = await GET(request, mockContext);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snsHandle).toBe("elonmusk");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("screenname=elonmusk"),
        expect.anything()
      );
    });

    it("returns error when RapidAPI returns error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Missing required params" })
      });
      global.fetch = mockFetch;

      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://x.com/elonmusk"
      );

      const response = await GET(request, mockContext);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("X API 오류: Missing required params");
    });

    it("없는 핸들(HTTP 200 + status:notfound)을 404 로 거르고 DB 에 쓰지 않는다", async () => {
      // twitter-api45 는 없는 핸들에도 200 을 주고 본문 전 필드를 null 로 채운다.
      // res.ok 만 보면 name=null·팔로워 0 이 셀러 레코드에 그대로 기록된다.
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: "notfound",
          name: null,
          sub_count: null,
          profile: null,
        })
      });

      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://x.com/zzq_nonexistent_handle"
      );

      const response = await GET(request, mockContext);
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("X 프로필 정보를 찾을 수 없습니다.");
      expect(sellerUpdateMock).not.toHaveBeenCalled();
      expect(sellersHistoryUpsertMock).not.toHaveBeenCalled();
    });

    it("RAPIDAPI_KEY 가 없으면 외부 호출 없이 500 으로 실패한다", async () => {
      delete process.env.RAPIDAPI_KEY;
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      const request = createRequest(
        "/api/sellers/test-id/channel-info",
        "https://x.com/elonmusk"
      );

      const response = await GET(request, mockContext);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("RAPIDAPI_KEY 환경 변수가 누락되었습니다.");
      // 키 없이 조용히 폴백하지 않는다 — 외부 호출 자체가 일어나면 안 된다.
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // 수동 갱신의 **지출 경로** 고정.
  //
  // `api` 모드는 무료 공식 API(Graph business_discovery)를 1순위로 쓰고, 그게 구조적으로
  // 못 하는 계정(BD 는 비즈니스·크리에이터만 조회 가능 — 개인계정은 에러)만 유료 Apify 로
  // 폴백한다. 회귀가 조용히 통과하기 가장 쉬운 지점이라 세 가지를 기계로 못 박는다.
  describe("Instagram api 모드 — Graph 1순위 / Apify 폴백", () => {
    const HANDLE = "sample_shop";
    const IG_URL = `https://instagram.com/${HANDLE}`;
    const GRAPH_HOST = "graph.facebook.com";
    const APIFY_HOST = "api.apify.com";

    /** graph / apify 를 호스트로 갈라 주는 fetch 목. 어떤 호스트가 불렸는가 = 돈이 나갔는가. */
    function stubFetch(handlers: { graph?: () => Response; apify?: () => Response }) {
      const fetchMock = vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes(GRAPH_HOST)) {
          if (!handlers.graph) throw new Error(`예상하지 못한 Graph 호출: ${url}`);
          return handlers.graph();
        }
        if (url.includes(APIFY_HOST)) {
          if (!handlers.apify) throw new Error(`예상하지 못한 Apify 호출(유료): ${url}`);
          return handlers.apify();
        }
        throw new Error(`예상하지 못한 외부 호출: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    const hitHost = (fetchMock: ReturnType<typeof vi.fn>, host: string) =>
      fetchMock.mock.calls.some((call) => String(call[0]).includes(host));

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

    const graphError = (code: number, subcode: number, message: string) =>
      json({ error: { message, type: "OAuthException", code, error_subcode: subcode } }, 400);

    beforeEach(() => {
      process.env.INSTAGRAM_COLLECT_MODE = "api";
      process.env.INSTAGRAM_ACCESS_TOKEN = "test-graph-token";
      process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = "17841400000000000";
      process.env.APIFY_API_TOKEN = "test-apify-token";
      sellerFindUniqueMock.mockResolvedValue({
        id: "test-id",
        name: "테스트셀러",
        channelUrl: null,
        snsType: "INSTAGRAM",
        snsHandle: HANDLE,
        currentFollowers: 1000,
        currentPostsCount: 10,
        profileBio: null,
        profilePicUrl: null,
        profileExternalUrls: null,
        histories: [],
      });
      sellerUpdateMock.mockResolvedValue({});
      sellersHistoryUpsertMock.mockResolvedValue({});
      bioHistoryCreateMock.mockResolvedValue({});
      apiCallLogCreateMock.mockResolvedValue({});
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("Graph 성공이면 Apify를 부르지 않는다", async () => {
      const fetchMock = stubFetch({
        graph: () =>
          json({
            business_discovery: {
              username: HANDLE,
              name: "샘플 상점",
              biography: "소개글",
              followers_count: 12345,
              media_count: 77,
              website: "https://example.com",
            },
          }),
      });

      const response = await GET(createRequest("/api/sellers/test-id/channel-info", IG_URL), mockContext);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.currentFollowers).toBe(12345);
      expect(body.currentPostsCount).toBe(77);
      expect(body.profileBio).toBe("소개글");
      expect(body.pending).toBeUndefined();

      // 핵심: 유료 호스트가 한 번도 안 불렸다 — 공짜로 되는 걸 돈 주고 사지 않는다.
      expect(hitHost(fetchMock, APIFY_HOST)).toBe(false);
      // 성공은 계측 대상이 아니다(실패만 1행) — 수동 갱신 1회마다 행이 쌓이지 않게.
      expect(apiCallLogCreateMock).not.toHaveBeenCalled();
      expect(sellersHistoryUpsertMock).toHaveBeenCalled();
    });

    it("Graph가 계정유형 에러(code 100)면 Apify로 폴백하고 계측 1행을 남긴다", async () => {
      const fetchMock = stubFetch({
        graph: () => graphError(100, 33, "Unsupported get request."),
        apify: () => json({ data: { id: "run-abc" } }, 201),
      });

      const response = await GET(createRequest("/api/sellers/test-id/channel-info", IG_URL), mockContext);
      const body = await response.json();

      // 응답 형태가 동기 → 비동기(pending)로 바뀐다. 프론트는 `pending && runId` 로 분기하므로
      // 기존 폴링 경로를 그대로 타고, fallbackFrom 은 안내 문구를 가르는 데 쓴다.
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        pending: true,
        runId: "run-abc",
        platform: "instagram",
        collectMode: "apify",
        fallbackFrom: "api",
      });
      expect(hitHost(fetchMock, APIFY_HOST)).toBe(true);

      // 조용한 유료 전환 금지 — 지출 사실이 DB 에 남는다(P0 No Silent Failure).
      expect(apiCallLogCreateMock).toHaveBeenCalledTimes(1);
      const logged = apiCallLogCreateMock.mock.calls[0][0].data;
      expect(logged.permissionScope).toBe("instagram_bd_fallback");
      expect(logged.success).toBe(false);
      expect(JSON.parse(logged.metadata)).toMatchObject({
        kind: "account",
        code: 100,
        shouldFallback: true,
        fellBack: true,
        apifyRunId: "run-abc",
      });

      // 폴백 경로는 여기서 저장하지 않는다 — poll 라우트가 결과를 받아 "APIFY_API" 로 기록한다.
      expect(sellerUpdateMock).not.toHaveBeenCalled();
      expect(sellersHistoryUpsertMock).not.toHaveBeenCalled();
    });

    it("Graph가 토큰 에러(code 190)면 폴백하지 않고 에러를 표면화한다", async () => {
      // HTTP 만 보면 400 이라 계정 문제와 구분되지 않는다 — 오인하면 전 셀러에서 유료 호출이 샌다.
      // apify 핸들러를 빼 두었으므로 폴백이 발동하면 목이 throw 해 테스트가 깨진다(이중 안전장치).
      const fetchMock = stubFetch({
        graph: () => graphError(190, 463, "Error validating access token: Session has expired"),
      });

      const response = await GET(createRequest("/api/sellers/test-id/channel-info", IG_URL), mockContext);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.graphFailureKind).toBe("auth");
      expect(body.error).toContain("토큰을 갱신");
      expect(hitHost(fetchMock, APIFY_HOST)).toBe(false);
      expect(sellerUpdateMock).not.toHaveBeenCalled();

      // 폴백은 안 했어도 실패 사실은 남긴다 — 토큰이 죽은 걸 사후에 알 수 있어야 한다.
      expect(apiCallLogCreateMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(apiCallLogCreateMock.mock.calls[0][0].data.metadata)).toMatchObject({
        kind: "auth",
        code: 190,
        shouldFallback: false,
        fellBack: false,
      });
    });

    it("apify 모드는 그대로 1순위 Apify — 폴백 대상으로 계속 필요하다", async () => {
      process.env.INSTAGRAM_COLLECT_MODE = "apify";
      const fetchMock = stubFetch({ apify: () => json({ data: { id: "run-direct" } }, 201) });

      const response = await GET(createRequest("/api/sellers/test-id/channel-info", IG_URL), mockContext);
      const body = await response.json();

      expect(body).toMatchObject({ pending: true, runId: "run-direct", collectMode: "apify" });
      expect(body.fallbackFrom).toBeUndefined();
      expect(hitHost(fetchMock, GRAPH_HOST)).toBe(false);
    });
  });
});
