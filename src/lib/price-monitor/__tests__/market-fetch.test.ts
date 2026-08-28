import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAllMarketPrices } from "../market-fetch";

// 실측 응답(2026-07-06, gift.kakao.com/a/gift-explorer/v1/search/products?query=홍삼정)을 축약한 픽스처.
const KAKAO_FIXTURE = {
  products: {
    totalCount: 3,
    contents: [
      {
        id: 999487,
        name: "[정관장] 홍삼정 120g",
        productType: "Shipping",
        ticket: false,
        price: { basicPrice: 114000, sellingPrice: 114000, discountRate: 0 },
        brand: { id: 1, name: "정관장" },
        displayDeliveryFee: { type: "FREE" },
      },
      {
        id: 11683125,
        name: "6년근 홍삼정 에버타임 스탠다드 100포",
        productType: "Shipping",
        ticket: false,
        price: { basicPrice: 37800, sellingPrice: 35800, discountRate: 5 },
        brand: { id: 2, name: "려원담" },
        displayDeliveryFee: { type: "CHARGED" },
      },
      {
        // 가격 정보가 없는(0) 상품 — 거짓 최저가 방지 필터 대상.
        id: 777,
        name: "가격없는 상품",
        price: { basicPrice: 0, sellingPrice: 0, discountRate: 0 },
        brand: null,
        displayDeliveryFee: null,
      },
    ],
  },
};

const NAVER_FIXTURE = {
  items: [
    { title: "<b>홍삼정</b> 120g", lprice: "99000", mallName: "G마켓", link: "https://gmarket.example/1" },
  ],
};

const COUPANG_FIXTURE = {
  rCode: "0",
  data: {
    productData: [
      { productName: "홍삼정 120g", productPrice: 101000, productUrl: "https://coupang.example/1", isRocket: true },
    ],
  },
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    // 비-OK 경로는 json()이 아니라 text()로 사유 본문을 읽는다(describeHttpFailure).
    text: async () => JSON.stringify(body),
  } as Response;
}

/** 본문이 JSON이 아닐 때(봇 차단 HTML 등)나 읽기가 실패할 때를 흉내내는 응답. */
function rawResponse(text: string | (() => Promise<never>), status: number) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error("not json");
    },
    text: typeof text === "string" ? async () => text : text,
  } as unknown as Response;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fetchAllMarketPrices — 카카오 선물하기 채널", () => {
  it("gift-explorer 응답을 RawMarketItem으로 매핑한다(가격0 필터·URL 조합·무배 플래그)", async () => {
    // 네이버/쿠팡 키를 비워 카카오 경로만 실호출되게 격리한다(둘 다 키 미설정 시 fetch 없이 조기 반환).
    vi.stubEnv("NAVER_SEARCH_CLIENT_ID", "");
    vi.stubEnv("NAVER_SEARCH_CLIENT_SECRET", "");
    vi.stubEnv("COUPANG_ACCESS_KEY", "");
    vi.stubEnv("COUPANG_SECRET_KEY", "");
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toContain("gift.kakao.com/a/gift-explorer/v1/search/products");
      return jsonResponse(KAKAO_FIXTURE);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { allItems, minItem, errors } = await fetchAllMarketPrices("홍삼정 120g");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 가격 0 상품은 제외되고 2건만 남는다.
    expect(allItems).toHaveLength(2);
    expect(allItems.every((i) => i.channel === "kakao")).toBe(true);
    // totalPrice 오름차순 정렬 → 할인가(sellingPrice) 35800이 최저.
    expect(minItem?.totalPrice).toBe(35800);
    expect(minItem?.mall).toBe("려원담");
    expect(minItem?.url).toBe("https://gift.kakao.com/product/11683125");
    // FREE만 무배 확정, 그 외는 null(미상).
    expect(allItems.find((i) => i.mall === "정관장")?.isFreeShipping).toBe(true);
    expect(minItem?.isFreeShipping).toBeNull();
    expect(errors.kakao).toBeNull();
    // 네이버는 미설정 시 경고를 표면화하지만, 쿠팡은 미도입 파킹이라 침묵(error: null).
    expect(errors.naver).toContain("미설정");
    expect(errors.coupang).toBeNull();
  });

  it("비정상 status는 items 없이 errors.kakao로 표면화한다 — 사유 본문까지 함께", async () => {
    vi.stubEnv("NAVER_SEARCH_CLIENT_ID", "");
    vi.stubEnv("NAVER_SEARCH_CLIENT_SECRET", "");
    vi.stubEnv("COUPANG_ACCESS_KEY", "");
    vi.stubEnv("COUPANG_SECRET_KEY", "");
    vi.stubGlobal("fetch", vi.fn(async () => rawResponse("service temporarily unavailable", 503)));

    const { allItems, errors } = await fetchAllMarketPrices("홍삼정");

    expect(allItems).toHaveLength(0);
    // status 만 남기던 기존 동작을 의도적으로 바꿨다 — 숫자만으로는 같은 코드의 서로 다른 사유를
    // 구분할 수 없어 사후 규명이 막힌다(쿠팡 401 16일 사례).
    expect(errors.kakao).toBe("KakaoGift status 503: service temporarily unavailable");
  });
});

describe("fetchAllMarketPrices — 실패 사유 기록(describeHttpFailure)", () => {
  const silenceOthers = () => {
    vi.stubEnv("NAVER_SEARCH_CLIENT_ID", "");
    vi.stubEnv("NAVER_SEARCH_CLIENT_SECRET", "");
  };

  it("쿠팡 401의 실측 본문이 사유에 그대로 실린다(같은 401의 세 사유를 가른다)", async () => {
    // api-gateway.coupang.com 실호출로 확인한 응답(2026-07-23). 키 미등록/HMAC 형식오류/서명만료가
    // 전부 401 이라 status 만으로는 구분 불가 — 이 본문이 유일한 판별자다.
    silenceOthers();
    vi.stubEnv("COUPANG_ACCESS_KEY", "ak");
    vi.stubEnv("COUPANG_SECRET_KEY", "sk");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).includes("api-gateway.coupang.com")
          ? rawResponse('{\n  "code" : "ERROR",\n  "message" : "Specified key is not registered."\n}', 401)
          : jsonResponse(KAKAO_FIXTURE),
      ),
    );

    const { errors } = await fetchAllMarketPrices("홍삼정");

    expect(errors.coupang).toContain("Coupang status 401");
    expect(errors.coupang).toContain("Specified key is not registered.");
    // 줄바꿈·들여쓰기는 한 줄로 접는다(스냅샷 evidence·배너 한 줄 표시).
    expect(errors.coupang).not.toContain("\n");
  });

  it("긴 본문(봇 차단 HTML 등)은 잘라 스냅샷을 부풀리지 않는다", async () => {
    silenceOthers();
    vi.stubEnv("COUPANG_ACCESS_KEY", "");
    vi.stubEnv("COUPANG_SECRET_KEY", "");
    vi.stubGlobal("fetch", vi.fn(async () => rawResponse("<html>" + "x".repeat(5000) + "</html>", 403)));

    const { errors } = await fetchAllMarketPrices("홍삼정");

    const detail = errors.kakao!.replace("KakaoGift status 403: ", "");
    expect(detail).toHaveLength(200);
  });

  it("본문 읽기가 실패해도 status 보고까지 같이 잃지 않는다", async () => {
    silenceOthers();
    vi.stubEnv("COUPANG_ACCESS_KEY", "");
    vi.stubEnv("COUPANG_SECRET_KEY", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        rawResponse(async () => {
          throw new Error("body already consumed");
        }, 500),
      ),
    );

    const { errors } = await fetchAllMarketPrices("홍삼정");

    expect(errors.kakao).toBe("KakaoGift status 500");
  });

  it("빈 본문이면 콜론 없이 status 만 남긴다", async () => {
    silenceOthers();
    vi.stubEnv("COUPANG_ACCESS_KEY", "");
    vi.stubEnv("COUPANG_SECRET_KEY", "");
    vi.stubGlobal("fetch", vi.fn(async () => rawResponse("   ", 502)));

    const { errors } = await fetchAllMarketPrices("홍삼정");

    expect(errors.kakao).toBe("KakaoGift status 502");
  });

  it("3채널 결과를 하나의 목록으로 합쳐 최종가 오름차순 정렬한다", async () => {
    vi.stubEnv("NAVER_SEARCH_CLIENT_ID", "id");
    vi.stubEnv("NAVER_SEARCH_CLIENT_SECRET", "secret");
    vi.stubEnv("COUPANG_ACCESS_KEY", "ak");
    vi.stubEnv("COUPANG_SECRET_KEY", "sk");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("openapi.naver.com")) return jsonResponse(NAVER_FIXTURE);
        if (u.includes("api-gateway.coupang.com")) return jsonResponse(COUPANG_FIXTURE);
        if (u.includes("gift.kakao.com")) return jsonResponse(KAKAO_FIXTURE);
        throw new Error(`unexpected url: ${u}`);
      }),
    );

    const { allItems, minItem } = await fetchAllMarketPrices("홍삼정 120g");

    expect(allItems.map((i) => i.channel).sort()).toEqual(["coupang", "kakao", "kakao", "naver"]);
    expect(allItems.map((i) => i.totalPrice)).toEqual([35800, 99000, 101000, 114000]);
    expect(minItem?.channel).toBe("kakao");
  });
});
