// 시장 최저가 원시 소스 호출(네이버 Apify / 쿠팡 파트너스 API / 카카오 선물하기) — 서버 전용.
// src/app/api/price-monitoring/route.ts(화면 모달)와 cron/price-monitoring/route.ts(배치)가
// 동일한 소스 호출 로직을 공유하도록 이 모듈로 추출했다("로직 일원화").
// (다나와는 공식 셀프서비스 API가 없고 스크래퍼도 깨져 제거함 — 네이버 쇼핑과 커버리지 중복.)
import crypto from "node:crypto";
import { fetchNaverApifyPrice, type NaverApifyResult } from "./naver-apify";
// 에러 형태의 타입 정본은 source-errors.ts 에 있다 — 이 모듈은 서버 전용(node:crypto)이라
// 클라이언트가 여기서 타입을 못 끌어온다. 방향을 뒤집어 한 곳에만 정의를 둔다.
import type { MarketSourceErrors } from "./source-errors";
import { createMarketSourceState, type MarketSourceState, type MarketSourceStatus, type MarketSourceStates } from "./source-status";

/** 본문 발췌 상한. 실측 사유는 100~150자면 충분하고(예: 쿠팡 401 ≈ 110자), 봇 차단 HTML 페이지가
 *  스냅샷 evidence 를 부풀리지 않게 자른다. */
const FAILURE_BODY_MAX = 200;

/**
 * 비-OK 응답의 사유를 `status + 본문 발췌`로 남긴다.
 *
 * 기존엔 status 만 기록해서, 같은 401 이라도 "키 미등록"인지 "HMAC 형식 오류"인지 "서명 만료"인지
 * 구분할 수 없었다 — 실제로 쿠팡이 16일간 401 이었는데 기록에는 숫자뿐이라 사유를 알아내려고
 * 별도 프로브를 짜야 했다. 본문 한 줄이면 다음 회차부터 사유가 저절로 쌓인다.
 *
 * ⚠️ 이 문자열은 `evidence.sourceErrors`(DB)와 모달 배너에 그대로 실린다. 소스 응답 본문에는
 * 우리 자격증명이 실리지 않지만(요청 헤더에만 있음), 새 소스를 붙일 때 그 전제를 다시 확인할 것.
 */
async function describeHttpFailure(prefix: string, res: Response): Promise<string> {
  const base = `${prefix} status ${res.status}`;
  try {
    // 본문은 한 번만 읽을 수 있다 — 호출부는 비-OK 경로에서 res.json() 을 하지 않으므로 안전하다.
    const detail = (await res.text()).replace(/\s+/g, " ").trim().slice(0, FAILURE_BODY_MAX);
    return detail ? `${base}: ${detail}` : base;
  } catch {
    // 본문 읽기 실패는 진단 부가정보가 없는 것일 뿐이다 — status 보고까지 같이 잃지 않는다.
    return base;
  }
}

export type RawMarketItem = {
  mall: string;
  price: number;
  shippingFee: number;
  totalPrice: number;
  url: string;
  isFreeShipping: boolean | null;
  productName: string;
  channel: "naver" | "coupang" | "kakao";
};

// 쿠팡 파트너스 OpenAPI HMAC(CEA) 서명 헤더.
// message = signed-date(UTC yyMMdd'T'HHmmss'Z') + method + path + query(쿼리스트링, ?제외).
// signature = HMAC-SHA256(secretKey, message) hex. 서명에 쓴 query와 실제 요청 URL의 query가
// 문자 단위로 같아야 하므로(인코딩 포함) 호출부에서 동일 문자열을 넘긴다.
function coupangAuthHeader(method: string, path: string, query: string, accessKey: string, secretKey: string): string {
  const signedDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "").slice(2);
  const message = signedDate + method + path + query;
  const signature = crypto.createHmac("sha256", secretKey).update(message, "utf8").digest("hex");
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

type MarketItems = Omit<RawMarketItem, "channel">[];
type MarketSourceResult = {
  items: MarketItems;
  error?: string | null;
  status?: MarketSourceStatus;
  state?: MarketSourceState;
};

type MarketFetchOptions = {
  deadlineAt?: number;
};

function sourceSignal(deadlineAt: number | undefined, maxMs: number): AbortSignal | null {
  const remaining = deadlineAt === undefined ? maxMs : Math.min(maxMs, deadlineAt - Date.now());
  return remaining > 0 ? AbortSignal.timeout(remaining) : null;
}

function deadlineResult(deadlineAt: number | undefined): MarketSourceResult | null {
  return deadlineAt !== undefined && deadlineAt <= Date.now()
    ? { items: [], error: "시장 소스 요청 시간 제한", status: "error" }
    : null;
}

async function fetchCoupangPrice(query: string, options: MarketFetchOptions = {}): Promise<MarketSourceResult> {
  const accessKey = process.env.COUPANG_ACCESS_KEY;
  const secretKey = process.env.COUPANG_SECRET_KEY;
  // 쿠팡 [2026-07-08 미도입 파킹]: 키가 없으면 조용히 skip하고 에러를 UI에 노출하지 않는다(error: null).
  // 네이버와 마찬가지로 미연결 상태를 source status로 구분하되, 쿠팡은 의도적 미설정이므로 오류는 침묵시킨다.
  // 재도입 = COUPANG_ACCESS_KEY/SECRET_KEY를 채우면 이 가드를 지나 정상 호출·표시된다.
  // (쿠팡은 Akamai Bot Manager 차단으로 스크래핑 불가 → 공식 파트너스 API/HMAC만 가능.)
  if (!accessKey || !secretKey) {
    return { items: [], error: null, status: "disabled" };
  }
  const expired = deadlineResult(options.deadlineAt);
  if (expired) return expired;
  try {
    const path = "/v2/providers/affiliate_open_api/apis/openapi/v1/products/search";
    const qs = `keyword=${encodeURIComponent(query)}&limit=10`;
    const auth = coupangAuthHeader("GET", path, qs, accessKey, secretKey);
    const signal = sourceSignal(options.deadlineAt, 6000);
    if (!signal) return { items: [], error: "시장 소스 요청 시간 제한", status: "error" };
    const res = await fetch(`https://api-gateway.coupang.com${path}?${qs}`, {
      headers: { Authorization: auth },
      signal,
    });
    if (!res.ok) return { items: [], error: await describeHttpFailure("Coupang", res) };
    const data = await res.json();
    // 파트너스는 성공 시 rCode="0". 그 외(인증 실패 등)는 rMessage를 그대로 노출해 디버깅을 돕는다.
    if (data?.rCode != null && String(data.rCode) !== "0") {
      return { items: [], error: `Coupang rCode ${data.rCode}: ${data.rMessage ?? ""}`.trim() };
    }
    const products: any[] = data?.data?.productData ?? [];
    return {
      items: products
        .map((p: any) => ({
          mall: "쿠팡",
          price: Number(p.productPrice),
          shippingFee: 0,
          totalPrice: Number(p.productPrice),
          url: p.productUrl,
          isFreeShipping: typeof p.isFreeShipping === "boolean" ? p.isFreeShipping : p.isRocket ? true : null,
          productName: p.productName || "",
        }))
        .filter((i) => Number.isFinite(i.price) && i.price > 0),
      error: null,
      status: products.length > 0 ? "ok" : "empty",
    };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "Coupang fetch failed" };
  }
}

// 카카오톡 선물하기 — 최저가 위반 리스크가 실존하는 채널(상시 할인·쿠폰 노출)이라 감시 대상에 포함.
// 공식 셀프서비스 검색 API가 없어, gift.kakao.com 웹 프론트가 쓰는 공개 검색 JSON(gift-explorer)을
// 서버-투-서버로 호출한다(무인증·무쿠키로 200 확인, 2026-07-06 실측). 비공식 엔드포인트라 스키마
// 변경 시 깨질 수 있으므로 keyless 소스들과 동일하게 실패를 error로 표면화하고 조용히 skip한다.
async function fetchKakaoGiftPrice(query: string, options: MarketFetchOptions = {}): Promise<MarketSourceResult> {
  const expired = deadlineResult(options.deadlineAt);
  if (expired) return expired;
  try {
    // 정렬 파라미터 없는 기본 호출 = 연관도순(웹 검색 기본값). 네이버 sort=sim과 같은 이유로
    // 가격순 정렬을 쓰지 않는다(미끼/샘플 상품의 거짓 최저가 방지). size=10은 쿠팡 limit과 동일.
    const url = `https://gift.kakao.com/a/gift-explorer/v1/search/products?query=${encodeURIComponent(query)}&page=0&size=10`;
    const signal = sourceSignal(options.deadlineAt, 6000);
    if (!signal) return { items: [], error: "시장 소스 요청 시간 제한", status: "error" };
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        // 서버 기본 UA(undici)가 봇 필터에 걸리지 않도록 브라우저 UA를 명시(방어적 — 현재는 무헤더도 통과).
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      signal,
    });
    if (!res.ok) return { items: [], error: await describeHttpFailure("KakaoGift", res) };
    const data = await res.json();
    const products: any[] = data?.products?.contents ?? [];
    return {
      items: products
        .map((p: any) => ({
          // 선물하기는 마켓플레이스라 실제 판매 주체는 브랜드(스토어) — 네이버의 mallName과 같은 위상.
          mall: p.brand?.name || "카카오 선물하기",
          price: Number(p.price?.sellingPrice),
          shippingFee: 0,
          totalPrice: Number(p.price?.sellingPrice),
          url: `https://gift.kakao.com/product/${p.id}`,
          isFreeShipping: p.displayDeliveryFee?.type === "FREE" ? true : null,
          productName: p.name || "",
        }))
        .filter((i) => Number.isFinite(i.price) && i.price > 0),
      error: null,
      status: products.length > 0 ? "ok" : "empty",
    };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "KakaoGift fetch failed" };
  }
}

export type MarketFetchResult = {
  allItems: RawMarketItem[];
  minItem: RawMarketItem | null;
  errors: MarketSourceErrors;
  sources: MarketSourceStates;
};

function resultState(result: MarketSourceResult, fallbackStatus: MarketSourceStatus): MarketSourceState {
  if (result.state) return result.state;
  const status = result.status ?? (result.error ? "error" : result.items.length > 0 ? "ok" : fallbackStatus);
  return createMarketSourceState(status, result.items.length);
}

function rejectedSourceResult(): MarketSourceResult {
  return { items: [], error: "시장 소스 실행 실패", status: "error" };
}

/** Apify 네이버·쿠팡 파트너스 API·카카오 선물하기 3소스를 동시 호출해 하나의 정렬된 목록으로 합친다. */
export async function fetchAllMarketPrices(query: string, options: { deadlineAt?: number } = {}): Promise<MarketFetchResult> {
  const [naver, coupang, kakao] = await Promise.allSettled([
    fetchNaverApifyPrice(query, options),
    fetchCoupangPrice(query, options),
    fetchKakaoGiftPrice(query, options),
  ]);

  const getValue = (result: PromiseSettledResult<MarketSourceResult | NaverApifyResult>): MarketSourceResult =>
    result.status === "fulfilled" ? result.value : rejectedSourceResult();

  const nRes = getValue(naver);
  const cRes = getValue(coupang);
  const kRes = getValue(kakao);

  const allItems: RawMarketItem[] = [
    ...(nRes.items || []).map((i) => ({ ...i, channel: "naver" as const })),
    ...(cRes.items || []).map((i) => ({ ...i, channel: "coupang" as const })),
    ...(kRes.items || []).map((i) => ({ ...i, channel: "kakao" as const })),
  ];

  allItems.sort((a, b) => a.totalPrice - b.totalPrice);

  return {
    allItems,
    minItem: allItems[0] || null,
    errors: { naver: nRes.error, coupang: cRes.error, kakao: kRes.error },
    sources: {
      naver: resultState(nRes, "empty"),
      coupang: resultState(cRes, "empty"),
      kakao: resultState(kRes, "empty"),
    },
  };
}
