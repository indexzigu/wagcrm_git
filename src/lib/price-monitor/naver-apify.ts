import { createMarketSourceState, type MarketSourceState } from "./source-status";
import { recordNaverApifyUsage } from "./naver-apify-usage";

const APIFY_ORIGIN = "https://api.apify.com";
const ACTOR_ID = "topapi~naver-shopping-scraper";
const ACTOR_BUILD = "0.1.9";
const ACTOR_TIMEOUT_SECONDS = 30;
const MAX_TOTAL_CHARGE_USD = 0.02;
const MAX_ITEMS = 10;
const MAX_PRODUCTS_PER_KEYWORD = 10;
const REQUEST_TIMEOUT_MS = 45_000;
const USAGE_WRITE_TIMEOUT_MS = 2_000;
const MAX_STATUS_POLLS = 3;
const MAX_CONCURRENT_RUNS = 2;
const MAX_PENDING_RUNS = 100;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_SIZE = 100;
const MAX_SCRAPED_AGE_MS = 5 * 60 * 1000;
const FUTURE_SCRAPED_TOLERANCE_MS = 5 * 60 * 1000;
const RETIRED_NAVER_API_ERROR =
  "공식 네이버 가격 API는 2026-07-31 종료되었습니다. Apify 외부 연결이 필요합니다";

const RUN_URL =
  `${APIFY_ORIGIN}/v2/actors/${ACTOR_ID}/runs` +
  `?build=${ACTOR_BUILD}&timeoutSecs=${ACTOR_TIMEOUT_SECONDS}&maxTotalChargeUsd=${MAX_TOTAL_CHARGE_USD}`;

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);

export type NaverApifyPriceItem = {
  mall: string;
  price: number;
  shippingFee: number;
  totalPrice: number;
  url: string;
  isFreeShipping: boolean | null;
  productName: string;
  scrapedAt: string;
};

export type NaverApifyResult = {
  items: NaverApifyPriceItem[];
  error: string | null;
  state: MarketSourceState;
};

export type NaverApifyFetchOptions = {
  deadlineAt?: number;
};

type JsonObject = Record<string, unknown>;
type FetchImplementation = typeof fetch;

class DeadlineExceededError extends Error {
  constructor() {
    super("deadline");
  }
}

class InvalidProviderResponseError extends Error {
  constructor() {
    super("invalid-provider-response");
  }
}

class InvalidRunSummaryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super("provider-http-error");
  }
}

class ProviderRunError extends Error {
  constructor(readonly status: string, readonly budgetStopped: boolean) {
    super("provider-run-error");
  }
}

class UsageWriteTimeoutError extends Error {
  constructor() {
    super("usage-write-timeout");
  }
}

type CachedResult = {
  expiresAt: number;
  result: NaverApifyResult;
};

const successfulCache = new Map<string, CachedResult>();
const inFlight = new Map<string, Promise<NaverApifyResult>>();

const pendingRuns: Array<{
  deadlineAt: number;
  execute: () => Promise<NaverApifyResult>;
  resolve: (result: NaverApifyResult) => void;
}> = [];
let activeRuns = 0;

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeResult(items: NaverApifyPriceItem[], error: string | null, status: MarketSourceState["status"]): NaverApifyResult {
  return {
    items,
    error,
    state: createMarketSourceState(status, items.length, nowIso()),
  };
}

function cloneResult(result: NaverApifyResult): NaverApifyResult {
  return {
    items: result.items.map((item) => ({ ...item })),
    error: result.error,
    state: { ...result.state },
  };
}

function errorResult(error: string): NaverApifyResult {
  return makeResult([], error, "error");
}

function getToken(): string | null {
  const configured = process.env.NAVER_PRICE_APIFY_TOKEN?.trim() || process.env.APIFY_API_TOKEN?.trim();
  return configured || null;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function unwrapData(value: unknown): JsonObject | null {
  const object = asObject(value);
  const data = object?.data;
  return asObject(data) ?? object;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : null;
}

function remainingMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

async function requestJson(
  fetchImplementation: FetchImplementation,
  url: string,
  init: RequestInit,
  deadlineAt: number,
): Promise<{ value: unknown; status: number }> {
  const remaining = remainingMs(deadlineAt);
  if (remaining <= 0) throw new DeadlineExceededError();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineExceededError());
    }, remaining);
  });
  try {
    const response = await Promise.race([
      fetchImplementation(url, { ...init, signal: controller.signal }),
      deadline,
    ]);
    if (controller.signal.aborted) throw new DeadlineExceededError();
    if (!response.ok) throw new ProviderHttpError(response.status);
    let value: unknown;
    try {
      value = await Promise.race([response.json(), deadline]);
    } catch (error) {
      if (error instanceof DeadlineExceededError) throw error;
      throw new InvalidProviderResponseError();
    }
    if (controller.signal.aborted) throw new DeadlineExceededError();
    return { value, status: response.status };
  } catch (error) {
    if (controller.signal.aborted) throw new DeadlineExceededError();
    if (error instanceof ProviderHttpError) throw error;
    if (error instanceof DeadlineExceededError) throw error;
    if (error instanceof InvalidProviderResponseError) throw error;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function publicError(error: unknown): string {
  if (error instanceof DeadlineExceededError) return "Apify 요청 시간 제한";
  if (error instanceof ProviderHttpError) return `Apify API HTTP ${error.status}`;
  if (error instanceof InvalidProviderResponseError) return "Apify 응답 형식 오류";
  if (error instanceof InvalidRunSummaryError) return error.reason;
  if (error instanceof ProviderRunError) {
    if (error.budgetStopped) return `Apify 실행이 예산 상한으로 중단되었습니다(${error.status})`;
    return `Apify Actor 실행 실패(${error.status})`;
  }
  return "Apify 연결 실패";
}

function providerStatusCode(error: unknown): number {
  if (error instanceof ProviderHttpError) return error.status;
  if (
    error instanceof InvalidProviderResponseError ||
    error instanceof InvalidRunSummaryError ||
    error instanceof ProviderRunError
  ) {
    return 200;
  }
  return 0;
}

function isBudgetMessage(value: unknown): boolean {
  return typeof value === "string" && /budget|charge|spend|limit|cost|예산|비용/i.test(value);
}

function statusFromRun(run: JsonObject): string {
  return stringValue(run.status)?.toUpperCase() ?? "";
}

function summaryUrlFromRun(run: JsonObject): string | null {
  const output = asObject(run.output);
  const summaryUrl = stringValue(output?.summary);
  if (summaryUrl) return summaryUrl;
  const keyValueStoreId = stringValue(run.defaultKeyValueStoreId);
  return keyValueStoreId
    ? `${APIFY_ORIGIN}/v2/key-value-stores/${encodeURIComponent(keyValueStoreId)}/records/RUN_SUMMARY`
    : null;
}

function startedAtFromRun(run: JsonObject): number | null {
  const startedAt = stringValue(run.startedAt);
  if (!startedAt) return null;
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateRun(run: JsonObject): {
  status: string;
  datasetId: string | null;
  summaryUrl: string | null;
  startedAt: number | null;
} {
  const status = statusFromRun(run);
  return {
    status,
    datasetId: stringValue(run.defaultDatasetId),
    summaryUrl: summaryUrlFromRun(run),
    startedAt: startedAtFromRun(run),
  };
}

async function waitForRun(
  fetchImplementation: FetchImplementation,
  initialRun: JsonObject,
  deadlineAt: number,
  token: string,
  requestedAt: number,
): Promise<{ status: string; datasetId: string; summaryUrl: string; startedAt: number }> {
  let run = initialRun;
  let datasetId = stringValue(run.defaultDatasetId);
  let summaryUrl = summaryUrlFromRun(run);
  let startedAt = startedAtFromRun(run) ?? requestedAt;

  for (let poll = 0; poll <= MAX_STATUS_POLLS; poll += 1) {
    const current = validateRun(run);
    if (!current.status && poll > 0) throw new InvalidProviderResponseError();
    if (TERMINAL_STATUSES.has(current.status)) {
      if (current.status !== "SUCCEEDED") {
        throw new ProviderRunError(current.status, isBudgetMessage(run.statusMessage));
      }
      if (current.datasetId) datasetId = current.datasetId;
      if (current.summaryUrl) summaryUrl = current.summaryUrl;
      if (current.startedAt) startedAt = current.startedAt;
      if (!datasetId || !summaryUrl) throw new InvalidProviderResponseError();
      return { status: current.status, datasetId, summaryUrl, startedAt };
    }

    if (poll === MAX_STATUS_POLLS) throw new DeadlineExceededError();
    const waitSeconds = Math.min(30, Math.max(1, Math.floor(remainingMs(deadlineAt) / 1000)));
    const runId = stringValue(run.id);
    if (!runId) throw new InvalidProviderResponseError();
    const url = `${APIFY_ORIGIN}/v2/actor-runs/${encodeURIComponent(runId)}?waitForFinish=${waitSeconds}`;
    const response = await requestJson(
      fetchImplementation,
      url,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      deadlineAt,
    );
    const nextRun = unwrapData(response.value);
    if (!nextRun) throw new InvalidProviderResponseError();
    run = nextRun;
    if (stringValue(run.defaultDatasetId)) datasetId = stringValue(run.defaultDatasetId);
    if (summaryUrlFromRun(run)) summaryUrl = summaryUrlFromRun(run);
    if (startedAtFromRun(run)) startedAt = startedAtFromRun(run) ?? startedAt;
  }

  throw new DeadlineExceededError();
}

function normalizeKeyword(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");
}

function isProviderSummaryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === APIFY_ORIGIN && url.pathname.endsWith("/records/RUN_SUMMARY") && url.search === "";
  } catch {
    return false;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasSuccessfulHttpResponse(value: unknown): boolean {
  const http = asObject(value);
  if (!http) return false;
  return Object.entries(http).some(([status, count]) => /^2\d\d$/.test(status) && isNonNegativeInteger(count) && count > 0);
}

function validateRunSummary(value: unknown, datasetLength: number): string | null {
  const summary = asObject(value);
  if (!summary) return "RUN_SUMMARY 형식 오류";

  for (const flag of ["budgetStopped", "deadlineStopped", "extrasStoppedForCost"]) {
    if (summary[flag] !== false) return `RUN_SUMMARY ${flag} 확인 실패`;
  }

  const targets = summary.targets;
  const delivered = summary.delivered;
  const perTarget = summary.perTarget;
  const skippedInputs = summary.skippedInputs;
  const notReadable = summary.notReadable;
  const searchCalls = asObject(summary.searchCalls);
  if (!isNonNegativeInteger(targets) || targets < 1 || !isNonNegativeInteger(delivered)) {
    return "RUN_SUMMARY 대상/결과 수 오류";
  }
  if (!Array.isArray(perTarget) || perTarget.length !== targets) return "RUN_SUMMARY 대상별 결과 오류";
  if (!Array.isArray(skippedInputs) || skippedInputs.length > 0) return "RUN_SUMMARY 입력 누락";
  if (!Array.isArray(notReadable) || notReadable.length > 0) return "RUN_SUMMARY 읽을 수 없는 입력";
  if (
    !searchCalls ||
    !isNonNegativeInteger(searchCalls.calls) ||
    searchCalls.calls < 1 ||
    !isNonNegativeInteger(searchCalls.ok) ||
    searchCalls.ok < 1 ||
    searchCalls.blocked !== 0 ||
    searchCalls.captcha !== 0 ||
    !hasSuccessfulHttpResponse(searchCalls.http)
  ) {
    return "RUN_SUMMARY 검색 호출 확인 실패";
  }

  let perTargetDelivered = 0;
  for (const targetValue of perTarget) {
    const target = asObject(targetValue);
    if (
      !target ||
      !isNonNegativeInteger(target.total) ||
      !isNonNegativeInteger(target.delivered) ||
      target.delivered > target.total ||
      target.blocked !== null
    ) {
      return "RUN_SUMMARY 대상별 차단/결과 오류";
    }
    perTargetDelivered += target.delivered;
  }
  if (perTargetDelivered !== delivered) return "RUN_SUMMARY 결과 합계 오류";

  if (datasetLength === 0) {
    if (delivered !== 0 || perTarget.some((targetValue) => asObject(targetValue)?.total !== 0)) {
      return "RUN_SUMMARY 0건 증명 실패";
    }
  } else if (delivered === 0) {
    return "RUN_SUMMARY dataset 결과 불일치";
  }

  return null;
}

function convertItem(
  raw: unknown,
  query: string,
  runStartedAt: number,
): { item: NaverApifyPriceItem | null; reason: string | null } {
  const item = asObject(raw);
  if (!item || item.type !== "product") return { item: null, reason: "응답 형태" };

  const keyword = stringValue(item.keyword);
  const productName = stringValue(item.productName);
  const scrapedAt = stringValue(item.scrapedAt);
  if (!keyword || normalizeKeyword(keyword) !== normalizeKeyword(query)) return { item: null, reason: "키워드" };
  if (!productName) return { item: null, reason: "상품명" };
  const scrapedAtMs = scrapedAt ? Date.parse(scrapedAt) : Number.NaN;
  if (
    !scrapedAt ||
    !Number.isFinite(scrapedAtMs) ||
    scrapedAtMs < runStartedAt - MAX_SCRAPED_AGE_MS ||
    scrapedAtMs > runStartedAt + FUTURE_SCRAPED_TOLERANCE_MS
  ) {
    return { item: null, reason: "시간" };
  }

  const discountedPrice = finiteNumber(item.discountedSalePrice);
  const salePrice = finiteNumber(item.salePrice);
  if (
    (item.salePrice !== undefined && (salePrice === null || salePrice <= 0)) ||
    (item.discountedSalePrice !== undefined &&
      (discountedPrice === null || discountedPrice <= 0))
  ) {
    return { item: null, reason: "가격" };
  }
  if (discountedPrice !== null && salePrice !== null && discountedPrice > salePrice) {
    return { item: null, reason: "할인" };
  }
  const price = discountedPrice !== null && discountedPrice > 0 ? discountedPrice : salePrice;
  if (price === null || price <= 0 || price > Number.MAX_SAFE_INTEGER) return { item: null, reason: "가격" };

  const deliveryFee = finiteNumber(item.deliveryFee);
  const freeDelivery = typeof item.freeDelivery === "boolean" ? item.freeDelivery : null;
  if (item.deliveryFee !== undefined && deliveryFee === null) return { item: null, reason: "배송" };
  if (deliveryFee === null && freeDelivery !== true) return { item: null, reason: "배송" };
  const shippingFee = deliveryFee !== null && deliveryFee >= 0 ? deliveryFee : 0;
  if (deliveryFee !== null && (deliveryFee < 0 || deliveryFee > Number.MAX_SAFE_INTEGER)) return { item: null, reason: "배송" };
  const totalPrice = price + shippingFee;
  if (!Number.isSafeInteger(totalPrice)) return { item: null, reason: "가격" };

  const url = [item.productPageUrl, item.mobileProductUrl, item.productUrl].find((value) => typeof value === "string" && value.trim());
  if (typeof url !== "string") return { item: null, reason: "URL" };
  try {
    if (new URL(url).protocol !== "https:") return { item: null, reason: "URL" };
  } catch {
    return { item: null, reason: "URL" };
  }

  return {
    item: {
      mall: stringValue(item.mallName) ?? "네이버쇼핑",
      price,
      shippingFee,
      totalPrice,
      url,
      isFreeShipping: freeDelivery ?? shippingFee === 0,
      productName,
      scrapedAt,
    },
    reason: null,
  };
}

function parseDataset(value: unknown, query: string, runStartedAt: number): NaverApifyResult {
  if (!Array.isArray(value)) throw new InvalidProviderResponseError();

  const items: NaverApifyPriceItem[] = [];
  const reasons = new Set<string>();
  for (const raw of value.slice(0, MAX_ITEMS)) {
    const converted = convertItem(raw, query, runStartedAt);
    if (converted.item) items.push(converted.item);
    if (converted.reason) reasons.add(converted.reason);
  }

  if (reasons.size > 0) {
    return makeResult(items, `Apify dataset 항목 검증 실패(${Array.from(reasons).join(",")})`, "error");
  }
  return makeResult(items, null, items.length > 0 ? "ok" : "empty");
}

async function executeRun(query: string, deadlineAt: number, token: string): Promise<NaverApifyResult> {
  const requestedAt = Date.now();
  const fetchImplementation = fetch;
  const input = {
    keywords: [query],
    sort: "REL",
    maxProductsPerKeyword: MAX_PRODUCTS_PER_KEYWORD,
    maxItems: MAX_ITEMS,
    includeDetail: false,
    includeSellers: false,
    includeReviewStats: false,
    includeReviews: false,
    monitorMode: false,
  };
  const startResponse = await requestJson(
    fetchImplementation,
    RUN_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
    deadlineAt,
  );
  const startedRun = unwrapData(startResponse.value);
  if (!startedRun) throw new InvalidProviderResponseError();

  const { datasetId, summaryUrl, startedAt } = await waitForRun(
    fetchImplementation,
    startedRun,
    deadlineAt,
    token,
    requestedAt,
  );
  const datasetResponse = await requestJson(
    fetchImplementation,
    `${APIFY_ORIGIN}/v2/datasets/${encodeURIComponent(datasetId)}/items?format=json&limit=${MAX_ITEMS}&clean=1`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    deadlineAt,
  );
  if (!Array.isArray(datasetResponse.value)) throw new InvalidProviderResponseError();
  if (!isProviderSummaryUrl(summaryUrl)) throw new InvalidProviderResponseError();
  const summaryResponse = await requestJson(
    fetchImplementation,
    summaryUrl,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    deadlineAt,
  );
  const summaryError = validateRunSummary(summaryResponse.value, datasetResponse.value.length);
  if (summaryError) throw new InvalidRunSummaryError(summaryError);
  return parseDataset(datasetResponse.value, query, startedAt);
}

async function recordUsageWithinTimeout(usage: Parameters<typeof recordNaverApifyUsage>[0]): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new UsageWriteTimeoutError()), USAGE_WRITE_TIMEOUT_MS);
  });

  try {
    const recorded = await Promise.race([recordNaverApifyUsage(usage), timeout]);
    if (!recorded) {
      console.error("[naver-apify] ApiCallLog 계측 기록이 실패했습니다");
      return false;
    }
    return true;
  } catch (error) {
    if (error instanceof UsageWriteTimeoutError) {
      console.error("[naver-apify] ApiCallLog 계측 기록 시간이 제한을 초과했습니다");
    } else {
      console.error("[naver-apify] ApiCallLog 계측 기록 중 예외가 발생했습니다");
    }
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pumpQueue(): void {
  while (activeRuns < MAX_CONCURRENT_RUNS && pendingRuns.length > 0) {
    const pending = pendingRuns.shift();
    if (!pending) return;
    if (remainingMs(pending.deadlineAt) <= 0) {
      pending.resolve(errorResult("Apify 요청 시간 제한"));
      continue;
    }

    activeRuns += 1;
    void pending.execute()
      .then(pending.resolve)
      .catch((error) => pending.resolve(errorResult(publicError(error))))
      .finally(() => {
        activeRuns -= 1;
        pumpQueue();
      });
  }
}

function enqueueRun(query: string, deadlineAt: number, token: string): Promise<NaverApifyResult> {
  if (pendingRuns.length >= MAX_PENDING_RUNS) {
    return Promise.resolve(errorResult("Apify 대기열 상한에 도달했습니다"));
  }

  const executeAttempt = async (): Promise<NaverApifyResult> => {
    const startedAt = Date.now();
    try {
      const result = await executeRun(query, deadlineAt, token);
      const usageRecorded = await recordUsageWithinTimeout({
        statusCode: 200,
        ok: result.state.status === "ok" || result.state.status === "empty",
        durationMs: Date.now() - startedAt,
        errorMessage: result.error,
      });
      if (!usageRecorded) return errorResult("Apify 사용량 계측 기록 실패");
      return result;
    } catch (error) {
      await recordUsageWithinTimeout({
        statusCode: providerStatusCode(error),
        ok: false,
        durationMs: Date.now() - startedAt,
        errorMessage: publicError(error),
      });
      throw error;
    }
  };

  return new Promise((resolve) => {
    pendingRuns.push({ deadlineAt, execute: executeAttempt, resolve });
    pumpQueue();
  });
}

function cacheGet(query: string): NaverApifyResult | null {
  const cached = successfulCache.get(query);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    successfulCache.delete(query);
    return null;
  }
  return cloneResult(cached.result);
}

function cacheSet(query: string, result: NaverApifyResult): void {
  if (result.state.status !== "ok" && result.state.status !== "empty") return;
  if (successfulCache.size >= CACHE_MAX_SIZE && !successfulCache.has(query)) {
    const oldest = successfulCache.keys().next().value;
    if (typeof oldest === "string") successfulCache.delete(oldest);
  }
  successfulCache.set(query, { expiresAt: Date.now() + CACHE_TTL_MS, result: cloneResult(result) });
}

async function awaitWithinDeadline(result: Promise<NaverApifyResult>, deadlineAt: number): Promise<NaverApifyResult> {
  const remaining = remainingMs(deadlineAt);
  if (remaining <= 0) throw new DeadlineExceededError();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<NaverApifyResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceededError()), remaining);
      result.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchNaverApifyPrice(query: string, options: NaverApifyFetchOptions = {}): Promise<NaverApifyResult> {
  const normalizedQuery = normalizeQuery(query);
  const checkedAt = nowIso();
  if (process.env.NAVER_PRICE_APIFY_ENABLED !== "1") {
    return {
      items: [],
      error: RETIRED_NAVER_API_ERROR,
      state: createMarketSourceState("disabled", 0, checkedAt),
    };
  }
  if (!normalizedQuery) return errorResult("네이버 가격 수집 검색어가 비어 있습니다");

  const token = getToken();
  if (!token) return errorResult(`${RETIRED_NAVER_API_ERROR}: 토큰이 설정되지 않았습니다`);

  const maximumDeadlineAt = Date.now() + REQUEST_TIMEOUT_MS;
  const requestedDeadlineAt =
    typeof options.deadlineAt === "number" && Number.isFinite(options.deadlineAt)
      ? options.deadlineAt
      : maximumDeadlineAt;
  const deadlineAt = Math.min(requestedDeadlineAt, maximumDeadlineAt);
  if (remainingMs(deadlineAt) <= 0) return errorResult("Apify 요청 시간 제한");

  const cached = cacheGet(normalizedQuery);
  if (cached) return cached;

  const previous = inFlight.get(normalizedQuery);
  if (previous) {
    try {
      return cloneResult(await awaitWithinDeadline(previous, deadlineAt));
    } catch (error) {
      return errorResult(publicError(error));
    }
  }

  const operation = enqueueRun(normalizedQuery, deadlineAt, token);
  inFlight.set(normalizedQuery, operation);
  try {
    try {
      const result = await awaitWithinDeadline(operation, deadlineAt);
      cacheSet(normalizedQuery, result);
      return cloneResult(result);
    } catch (error) {
      return errorResult(publicError(error));
    }
  } finally {
    if (inFlight.get(normalizedQuery) === operation) inFlight.delete(normalizedQuery);
  }
}
