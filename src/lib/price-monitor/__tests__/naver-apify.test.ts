import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACTOR_RUN_URL =
  "https://api.apify.com/v2/actors/topapi~naver-shopping-scraper/runs?build=0.1.9&timeoutSecs=30&maxTotalChargeUsd=0.02";
const RUN_SUMMARY_URL =
  "https://api.apify.com/v2/key-value-stores/store-success/records/RUN_SUMMARY";
const REQUEST_TIMEOUT_MS_FOR_TEST = 45_001;
const RECENT_SCRAPED_AT = new Date(Date.now() - 60 * 1000).toISOString();

const PRODUCT = {
  type: "product",
  keyword: "홍삼정 120g",
  productName: "홍삼정 120g",
  salePrice: 21_000,
  discountedSalePrice: 19_900,
  deliveryFee: 0,
  freeDelivery: true,
  productPageUrl: "https://shopping.example/products/1",
  scrapedAt: RECENT_SCRAPED_AT,
};

const VALID_SUMMARY = {
  targets: 1,
  delivered: 1,
  budgetStopped: false,
  deadlineStopped: false,
  extrasStoppedForCost: false,
  perTarget: [{ label: "홍삼정 120g", total: 1, delivered: 1, blocked: null }],
  notReadable: [],
  skippedInputs: [],
  searchCalls: { calls: 1, ok: 1, blocked: 0, captcha: 0, http: { "200": 1 } },
};

const EMPTY_SUMMARY = {
  ...VALID_SUMMARY,
  delivered: 0,
  perTarget: [{ label: "empty-case", total: 0, delivered: 0, blocked: null }],
};

const recordUsageMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../naver-apify-usage", () => ({ recordNaverApifyUsage: recordUsageMock }));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

type FetchNaverApifyPrice = typeof import("../naver-apify").fetchNaverApifyPrice;

let fetchNaverApifyPrice: FetchNaverApifyPrice;

beforeEach(async () => {
  vi.resetModules();
  recordUsageMock.mockReset().mockResolvedValue(true);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  ({ fetchNaverApifyPrice } = await import("../naver-apify"));
  vi.stubEnv("NAVER_PRICE_APIFY_ENABLED", "1");
  vi.stubEnv("NAVER_PRICE_APIFY_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchNaverApifyPrice", () => {
  it("opt-in이 아니면 외부 호출 없이 disabled 상태를 반환한다", async () => {
    vi.stubEnv("NAVER_PRICE_APIFY_ENABLED", "0");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchNaverApifyPrice("disabled-case");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/2026-07-31|Apify|외부 연결/i);
    expect(result.state.status).toBe("disabled");
    expect(result.state.itemCount).toBe(0);
    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  it("활성화됐지만 토큰이 없으면 연결 필요 오류를 명시한다", async () => {
    vi.stubEnv("NAVER_PRICE_APIFY_TOKEN", "");
    vi.stubEnv("APIFY_API_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchNaverApifyPrice("missing-token-case");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.state.status).toBe("error");
    expect(result.error).toMatch(/Apify|연결|토큰/i);
    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  it("Actor를 시작하고 완료 후 dataset을 읽어 허용 필드만 가격 아이템으로 변환한다", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url) === ACTOR_RUN_URL) {
        return jsonResponse({ data: { id: "run-success", defaultDatasetId: "dataset-success" } });
      }
      if (String(url).includes("/v2/actor-runs/run-success")) {
        return jsonResponse({ data: { id: "run-success", status: "SUCCEEDED", defaultDatasetId: "dataset-success", output: { summary: RUN_SUMMARY_URL } } });
      }
      if (String(url) === RUN_SUMMARY_URL) {
        return jsonResponse(VALID_SUMMARY);
      }
      if (String(url).includes("/v2/datasets/dataset-success/items")) {
        return jsonResponse([PRODUCT]);
      }
      throw new Error(`unexpected test URL: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchNaverApifyPrice("홍삼정 120g");
    const startRequest = requests[0];
    const startBody = JSON.parse(String(startRequest.init?.body));

    expect(result.error).toBeNull();
    expect(result.state.status).toBe("ok");
    expect(result.state.itemCount).toBe(1);
    expect(result.items).toEqual([
      {
        mall: "네이버쇼핑",
        price: 19_900,
        shippingFee: 0,
        totalPrice: 19_900,
        url: PRODUCT.productPageUrl,
        isFreeShipping: true,
        productName: PRODUCT.productName,
        scrapedAt: PRODUCT.scrapedAt,
      },
    ]);
    expect(startRequest.url).toBe(ACTOR_RUN_URL);
    expect(startRequest.url).not.toContain("test-token");
    expect(startRequest.init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(startBody).toMatchObject({
      keywords: ["홍삼정 120g"],
      sort: "REL",
      maxProductsPerKeyword: 10,
      maxItems: 10,
      includeDetail: false,
      includeSellers: false,
      monitorMode: false,
    });
    expect(startBody).toEqual({
      keywords: ["홍삼정 120g"],
      sort: "REL",
      maxProductsPerKeyword: 10,
      maxItems: 10,
      includeDetail: false,
      includeSellers: false,
      includeReviewStats: false,
      includeReviews: false,
      monitorMode: false,
    });
    expect(startRequest.url).toContain("timeoutSecs=30");
    expect(startRequest.url).toContain("maxTotalChargeUsd=0.02");
    expect(startBody).not.toHaveProperty("token");
    expect(result.items[0]?.scrapedAt).toBe(PRODUCT.scrapedAt);
    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({ ok: true, statusCode: 200 }));
  });

  it("RUN_SUMMARY가 정상 0건을 증명하면 SUCCEEDED 빈 dataset을 empty로 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const value = String(url);
        if (value === ACTOR_RUN_URL) return jsonResponse({ data: { id: "run-empty", defaultDatasetId: "dataset-empty" } });
        if (value.includes("/v2/actor-runs/run-empty")) {
          return jsonResponse({ data: { status: "SUCCEEDED", defaultDatasetId: "dataset-empty", output: { summary: RUN_SUMMARY_URL } } });
        }
        if (value === RUN_SUMMARY_URL) return jsonResponse(EMPTY_SUMMARY);
        return jsonResponse([]);
      }),
    );

    const result = await fetchNaverApifyPrice("empty-case");

    expect(result.items).toEqual([]);
    expect(result.error).toBeNull();
    expect(result.state.status).toBe("empty");
    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("SUCCEEDED 빈 dataset이라도 summary가 검색 미수행·차단·예산중단을 보이면 실패한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const value = String(url);
        if (value === ACTOR_RUN_URL) {
          return jsonResponse({ data: { id: "run-empty-invalid-summary", defaultDatasetId: "dataset-empty-invalid-summary" } });
        }
        if (value.includes("/v2/actor-runs/run-empty-invalid-summary")) {
          return jsonResponse({ data: { status: "SUCCEEDED", defaultDatasetId: "dataset-empty-invalid-summary", output: { summary: RUN_SUMMARY_URL } } });
        }
        if (value === RUN_SUMMARY_URL) {
          return jsonResponse({
            ...EMPTY_SUMMARY,
            budgetStopped: true,
            searchCalls: { calls: 0, ok: 0, blocked: 1, captcha: 0, http: {} },
          });
        }
        return jsonResponse([]);
      }),
    );

    const result = await fetchNaverApifyPrice("empty-invalid-summary");

    expect(result.items).toEqual([]);
    expect(result.state.status).toBe("error");
    expect(result.error).toMatch(/RUN_SUMMARY|예산|검색|차단/i);
    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it.each(["FAILED", "TIMED-OUT", "ABORTED"])("%s run은 dataset을 성공으로 기록하지 않는다", async (status) => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value === ACTOR_RUN_URL) return jsonResponse({ data: { id: `run-${status}`, defaultDatasetId: "dataset-failed" } });
      if (value.includes(`/v2/actor-runs/run-${status}`)) {
        return jsonResponse({ data: { status, statusMessage: status === "FAILED" ? "actor error" : undefined } });
      }
      return jsonResponse([{ ...PRODUCT, keyword: "dedupe-case" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchNaverApifyPrice(`failure-${status}`);

    expect(result.items).toEqual([]);
    expect(result.state.status).toBe("error");
    expect(result.error).toContain(status);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("예산 상한으로 중단된 run은 budget 오류로 분류한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const value = String(url);
        if (value === ACTOR_RUN_URL) return jsonResponse({ data: { id: "run-budget", defaultDatasetId: "dataset-budget" } });
        return jsonResponse({ data: { status: "FAILED", statusMessage: "maxTotalChargeUsd exceeded" } });
      }),
    );

    const result = await fetchNaverApifyPrice("budget-case");

    expect(result.items).toEqual([]);
    expect(result.state.status).toBe("error");
    expect(result.error).toMatch(/예산|budget/i);
  });

  it("잘못된 JSON은 원문 없이 응답 형식 오류로 남긴다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const value = String(url);
        if (value === ACTOR_RUN_URL) return jsonResponse({ data: { id: "run-json", defaultDatasetId: "dataset-json" } });
        if (value.includes("/v2/actor-runs/run-json")) return jsonResponse({ data: { status: "SUCCEEDED", defaultDatasetId: "dataset-json", output: { summary: RUN_SUMMARY_URL } } });
        if (value === RUN_SUMMARY_URL) return jsonResponse(VALID_SUMMARY);
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("provider raw payload");
          },
        } as unknown as Response;
      }),
    );

    const result = await fetchNaverApifyPrice("invalid-json-case");

    expect(result.state.status).toBe("error");
    expect(result.error).toBe("Apify 응답 형식 오류");
    expect(result.error).not.toContain("provider raw payload");
  });

  it("nonterminal run이 계속되면 bounded poll 뒤 시간 제한 오류로 끝낸다", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value === ACTOR_RUN_URL) return jsonResponse({ data: { id: "run-poll", defaultDatasetId: "dataset-poll" } });
      return jsonResponse({ data: { id: "run-poll", status: "RUNNING", defaultDatasetId: "dataset-poll" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchNaverApifyPrice("nonterminal-case");

    expect(result.state.status).toBe("error");
    expect(result.error).toMatch(/시간|제한/i);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("가격·URL·배송·키워드·시간이 불량한 row는 제외하고 오류를 남긴다", async () => {
    const invalidRows = [
      { ...PRODUCT, productName: "", productPageUrl: "https://shopping.example/products/2" },
      { ...PRODUCT, discountedSalePrice: 0, salePrice: 0, productPageUrl: "https://shopping.example/products/3" },
      { ...PRODUCT, productPageUrl: "http://shopping.example/products/4" },
      { ...PRODUCT, deliveryFee: undefined, freeDelivery: undefined, productPageUrl: "https://shopping.example/products/5" },
      { ...PRODUCT, keyword: "다른 검색어", productPageUrl: "https://shopping.example/products/6" },
      { ...PRODUCT, scrapedAt: "not-a-date", productPageUrl: "https://shopping.example/products/7" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const value = String(url);
        if (value === ACTOR_RUN_URL) return jsonResponse({ data: { id: "run-invalid", defaultDatasetId: "dataset-invalid" } });
        if (value.includes("/v2/actor-runs/run-invalid")) return jsonResponse({ data: { status: "SUCCEEDED", defaultDatasetId: "dataset-invalid", output: { summary: RUN_SUMMARY_URL } } });
        if (value === RUN_SUMMARY_URL) return jsonResponse(VALID_SUMMARY);
        return jsonResponse(invalidRows);
      }),
    );

    const result = await fetchNaverApifyPrice("invalid-row-case");

    expect(result.items).toEqual([]);
    expect(result.state.status).toBe("error");
    expect(result.error).toMatch(/유효|검증|배송|URL|가격/i);
  });

  it("deadline이 이미 지났으면 Actor를 시작하지 않는다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchNaverApifyPrice("expired-case", { deadlineAt: Date.now() - 1 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.state.status).toBe("error");
    expect(result.error).toMatch(/시간|deadline|기한/i);
  });

  it("같은 query의 동시 호출을 합치고 성공 결과를 5분 동안 재사용한다", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value === ACTOR_RUN_URL) return jsonResponse({ data: { id: "run-cache", defaultDatasetId: "dataset-cache" } });
      if (value.includes("/v2/actor-runs/run-cache")) return jsonResponse({ data: { status: "SUCCEEDED", defaultDatasetId: "dataset-cache", output: { summary: RUN_SUMMARY_URL } } });
      if (value === RUN_SUMMARY_URL) return jsonResponse(VALID_SUMMARY);
      return jsonResponse([{ ...PRODUCT, keyword: "dedupe-case" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      fetchNaverApifyPrice("dedupe-case"),
      fetchNaverApifyPrice("dedupe-case"),
    ]);
    const third = await fetchNaverApifyPrice("dedupe-case");

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(third.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(recordUsageMock).toHaveBeenCalledTimes(1);
  });

  it("성공 캐시는 5분 후 만료되어 새 run을 시작한다", async () => {
    vi.useFakeTimers();
    let runNumber = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value === ACTOR_RUN_URL) {
        runNumber += 1;
        return jsonResponse({ data: { id: `run-stale-${runNumber}`, defaultDatasetId: `dataset-stale-${runNumber}` } });
      }
      if (value.includes("/v2/actor-runs/")) {
        const number = value.split("run-stale-")[1]?.split("?")[0];
        return jsonResponse({ data: { status: "SUCCEEDED", defaultDatasetId: `dataset-stale-${number}`, output: { summary: RUN_SUMMARY_URL } } });
      }
      if (value === RUN_SUMMARY_URL) return jsonResponse(VALID_SUMMARY);
      const number = value.split("dataset-stale-")[1]?.split("/")[0];
      return jsonResponse([{ ...PRODUCT, keyword: "stale-case", productPageUrl: `https://shopping.example/products/${number}` }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchNaverApifyPrice("stale-case");
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await fetchNaverApifyPrice("stale-case");

    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("provider 동시 실행 수를 2개로 제한한다", async () => {
    let activeDatasets = 0;
    let maxActiveDatasets = 0;
    let runNumber = 0;
    const queryByRun = new Map<string, string>();
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value === ACTOR_RUN_URL) {
        runNumber += 1;
        const runId = `run-concurrency-${runNumber}`;
        queryByRun.set(runId, JSON.parse(String(init?.body)).keywords[0]);
        return jsonResponse({ data: { id: runId, defaultDatasetId: `dataset-concurrency-${runNumber}` } });
      }
      if (value.includes("/v2/actor-runs/")) {
        const runId = value.split("/v2/actor-runs/")[1]?.split("?")[0] ?? "";
        const number = runId.split("-").at(-1);
        return jsonResponse({ data: { status: "SUCCEEDED", defaultDatasetId: `dataset-concurrency-${number}`, output: { summary: RUN_SUMMARY_URL } } });
      }
      if (value === RUN_SUMMARY_URL) return jsonResponse(VALID_SUMMARY);
      activeDatasets += 1;
      maxActiveDatasets = Math.max(maxActiveDatasets, activeDatasets);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDatasets -= 1;
      const datasetNumber = value.split("dataset-concurrency-")[1]?.split("/")[0];
      const runId = `run-concurrency-${datasetNumber}`;
      return jsonResponse([{ ...PRODUCT, keyword: queryByRun.get(runId) }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all([
      fetchNaverApifyPrice("concurrency-1"),
      fetchNaverApifyPrice("concurrency-2"),
      fetchNaverApifyPrice("concurrency-3"),
    ]);

    expect(results.every((result) => result.state.status === "ok")).toBe(true);
    expect(maxActiveDatasets).toBeLessThanOrEqual(2);
  });

  it("응답 body가 멈춰도 45초 상한 안에 body timeout 오류를 반환한다", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url) === ACTOR_RUN_URL) {
          return {
            ok: true,
            status: 200,
            json: () => new Promise<never>(() => {}),
          } as unknown as Response;
        }
        throw new Error(`unexpected test URL: ${String(url)}`);
      }),
    );

    const pending = fetchNaverApifyPrice("body-stall");
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS_FOR_TEST);
    const result = await pending;

    expect(result.state.status).toBe("error");
    expect(result.error).toMatch(/시간|제한/i);
  });

  it("동일 query의 짧은 caller deadline은 긴 in-flight 요청을 기다리지 않는다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = fetchNaverApifyPrice("caller-deadline", { deadlineAt: Date.now() + 30_000 });
    const second = fetchNaverApifyPrice("caller-deadline", { deadlineAt: Date.now() + 25 });
    await vi.advanceTimersByTimeAsync(26);
    const secondResult = await second;

    expect(secondResult.state.status).toBe("error");
    expect(secondResult.error).toMatch(/시간|제한/i);
    await vi.advanceTimersByTimeAsync(30_000);
    const firstResult = await first;
    expect(firstResult.state.status).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("대기열에서 caller deadline이 만료된 작업은 provider 호출 없이 제거한다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = fetchNaverApifyPrice("queue-1");
    const second = fetchNaverApifyPrice("queue-2");
    const queued = fetchNaverApifyPrice("queue-3", { deadlineAt: Date.now() + 25 });
    await vi.advanceTimersByTimeAsync(26);
    const queuedResult = await queued;

    expect(queuedResult.state.status).toBe("error");
    expect(queuedResult.error).toMatch(/시간|제한/i);
    await vi.advanceTimersByTimeAsync(45_000);
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "오래된", scrapedAt: new Date(Date.now() - 37 * 60 * 60 * 1000).toISOString() },
    { name: "전날의", scrapedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
    { name: "미래의", scrapedAt: new Date(Date.now() + 6 * 60 * 1000).toISOString() },
  ])("$name scrapedAt은 가격 후보에서 제외한다", async ({ scrapedAt }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const value = String(url);
        if (value === ACTOR_RUN_URL) return jsonResponse({ data: { id: "run-time-invalid", defaultDatasetId: "dataset-time-invalid" } });
        if (value.includes("/v2/actor-runs/run-time-invalid")) return jsonResponse({ data: { status: "SUCCEEDED", defaultDatasetId: "dataset-time-invalid", output: { summary: RUN_SUMMARY_URL } } });
        if (value === RUN_SUMMARY_URL) return jsonResponse(VALID_SUMMARY);
        return jsonResponse([{ ...PRODUCT, scrapedAt }]);
      }),
    );

    const result = await fetchNaverApifyPrice("홍삼정 120g");

    expect(result.items).toEqual([]);
    expect(result.state.status).toBe("error");
    expect(result.error).toMatch(/시간|검증/i);
  });

  it("사용량 기록 실패를 안전한 수집 오류로 표면화한다", async () => {
    recordUsageMock.mockResolvedValueOnce(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const value = String(url);
        if (value === ACTOR_RUN_URL) return jsonResponse({ data: { id: "run-usage-failure", defaultDatasetId: "dataset-usage-failure" } });
        if (value.includes("/v2/actor-runs/run-usage-failure")) {
          return jsonResponse({ data: { status: "SUCCEEDED", defaultDatasetId: "dataset-usage-failure", output: { summary: RUN_SUMMARY_URL } } });
        }
        if (value === RUN_SUMMARY_URL) return jsonResponse(VALID_SUMMARY);
        return jsonResponse([{ ...PRODUCT, keyword: "usage-failure-safe-query" }]);
      }),
    );

    const result = await fetchNaverApifyPrice("usage-failure-safe-query");

    expect(result.items).toEqual([]);
    expect(result.state.status).toBe("error");
    expect(result.error).toMatch(/계측|사용량|기록/i);
    expect(JSON.stringify(result)).not.toContain("test-token");
    expect(JSON.stringify(result)).not.toContain("usage-failure-safe-query");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("멈춘 사용량 기록이 2초 뒤 실행 슬롯을 놓아 후속 run을 시작한다", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    recordUsageMock.mockImplementation(() =>
      recordUsageMock.mock.calls.length <= 2 ? new Promise<boolean>(() => {}) : Promise.resolve(true),
    );
    let runNumber = 0;
    const queryByRun = new Map<string, string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const value = String(url);
        if (value === ACTOR_RUN_URL) {
          runNumber += 1;
          const runId = `run-stalled-usage-${runNumber}`;
          queryByRun.set(runId, JSON.parse(String(init?.body)).keywords[0]);
          return jsonResponse({ data: { id: runId, defaultDatasetId: `dataset-stalled-usage-${runNumber}` } });
        }
        if (value.includes("/v2/actor-runs/")) {
          const runId = value.split("/v2/actor-runs/")[1]?.split("?")[0] ?? "";
          const number = runId.split("-").at(-1);
          return jsonResponse({
            data: {
              status: "SUCCEEDED",
              defaultDatasetId: `dataset-stalled-usage-${number}`,
              output: { summary: RUN_SUMMARY_URL },
            },
          });
        }
        if (value === RUN_SUMMARY_URL) return jsonResponse(VALID_SUMMARY);
        const runId = `run-stalled-usage-${value.split("dataset-stalled-usage-")[1]?.split("/")[0]}`;
        return jsonResponse([{ ...PRODUCT, keyword: queryByRun.get(runId) }]);
      }),
    );

    const first = fetchNaverApifyPrice("stalled-usage-1");
    const second = fetchNaverApifyPrice("stalled-usage-2");
    const third = fetchNaverApifyPrice("stalled-usage-3");

    await vi.advanceTimersByTimeAsync(2_000);
    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);

    expect(firstResult.state.status).toBe("error");
    expect(secondResult.state.status).toBe("error");
    expect(thirdResult.state.status).toBe("ok");
    expect(runNumber).toBe(3);
    expect(recordUsageMock).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("빈 문자열 배송비·할인 가격이 무료/정상 가격으로 조용히 변환되지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const value = String(url);
        if (value === ACTOR_RUN_URL) return jsonResponse({ data: { id: "run-number-invalid", defaultDatasetId: "dataset-number-invalid" } });
        if (value.includes("/v2/actor-runs/run-number-invalid")) return jsonResponse({ data: { status: "SUCCEEDED", defaultDatasetId: "dataset-number-invalid", output: { summary: RUN_SUMMARY_URL } } });
        if (value === RUN_SUMMARY_URL) return jsonResponse(VALID_SUMMARY);
        return jsonResponse([
          { ...PRODUCT, deliveryFee: "", freeDelivery: false },
          { ...PRODUCT, discountedSalePrice: "", salePrice: 20_000, productPageUrl: "https://shopping.example/products/empty-discount" },
          { ...PRODUCT, discountedSalePrice: 30_000, salePrice: 20_000, productPageUrl: "https://shopping.example/products/large-discount" },
          { ...PRODUCT, deliveryFee: "1e309", productPageUrl: "https://shopping.example/products/overflow-shipping" },
        ]);
      }),
    );

    const result = await fetchNaverApifyPrice("홍삼정 120g");

    expect(result.items).toEqual([]);
    expect(result.state.status).toBe("error");
    expect(result.error).toMatch(/배송|가격|할인|검증/i);
  });
});
