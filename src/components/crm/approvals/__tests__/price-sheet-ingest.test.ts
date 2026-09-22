import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPriceSheetRows,
  categorizePriceSheetRows,
  ingestPriceSheetFile,
  mapAndCategorize,
  PRICE_SHEET_ACCEPT,
  validatePriceSheetFile,
} from "../price-sheet-ingest";
import { MAX_FILE_SIZE_BYTES } from "@/lib/price-sheet/types";

function makeFile(name: string, size = 1024): File {
  const file = new File(["x"], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

describe("validatePriceSheetFile", () => {
  it("허용 확장자는 통과한다", () => {
    expect(validatePriceSheetFile(makeFile("가격표.xlsx"))).toBeNull();
    expect(validatePriceSheetFile(makeFile("sheet.PNG"))).toBeNull();
  });

  it("허용 밖 확장자는 서버와 동일 문구로 거부한다", () => {
    expect(validatePriceSheetFile(makeFile("문서.hwp"))).toContain("지원하지 않는 파일 형식");
  });

  it("20MB 초과는 거부한다", () => {
    expect(validatePriceSheetFile(makeFile("big.pdf", MAX_FILE_SIZE_BYTES + 1))).toContain(
      "20MB를 초과",
    );
  });

  it("accept 문자열은 확장자 allowlist에서 파생된다", () => {
    expect(PRICE_SHEET_ACCEPT).toContain(".xlsx");
    expect(PRICE_SHEET_ACCEPT).toContain(".webp");
  });
});

describe("ingestPriceSheetFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("업로드 → 추출 순차 호출 후 요약을 반환한다 (거래처 동봉)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/price-sheets") {
        return jsonResponse({ priceSheet: { id: "ps-1" } }, true);
      }
      if (url === "/api/price-sheets/ps-1/extract") {
        return jsonResponse({ priceSheet: { detectedTables: 2 }, rowCount: 12 }, true);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const phases: string[] = [];
    const result = await ingestPriceSheetFile(makeFile("가격표.png"), "partner-1", (phase) =>
      phases.push(phase),
    );

    expect(result).toEqual({
      ok: true,
      priceSheetId: "ps-1",
      fileName: "가격표.png",
      rowCount: 12,
      detectedTables: 2,
    });
    expect(phases).toEqual(["uploading", "extracting"]);

    const uploadCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const uploadBody = uploadCall[1].body as FormData;
    expect(uploadBody.get("partnerId")).toBe("partner-1");
    expect((uploadBody.get("file") as File).name).toBe("가격표.png");
  });

  it("거래처 미지정이면 partnerId를 동봉하지 않는다", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/price-sheets") return jsonResponse({ priceSheet: { id: "ps-2" } });
      return jsonResponse({ priceSheet: { detectedTables: 1 }, rowCount: 3 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await ingestPriceSheetFile(makeFile("a.pdf"), null);
    const uploadCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const uploadBody = uploadCall[1].body as FormData;
    expect(uploadBody.get("partnerId")).toBeNull();
  });

  it("업로드 실패 시 서버 error 원문을 그대로 반환하고 추출을 호출하지 않는다", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "존재하지 않는 거래처입니다." }, false));
    vi.stubGlobal("fetch", fetchMock);

    const result = await ingestPriceSheetFile(makeFile("a.pdf"), "ghost");
    expect(result).toEqual({
      ok: false,
      error: "존재하지 않는 거래처입니다.",
      priceSheetId: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("네트워크 예외(fetch reject)는 고정 문구의 실패 결과로 흡수한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network down"))));

    const result = await ingestPriceSheetFile(makeFile("a.png"), null);
    expect(result).toEqual({
      ok: false,
      error: "업로드 중 오류가 발생했습니다.",
      priceSheetId: null,
    });
  });

  it("추출 실패 시 priceSheetId를 보존한다 (상세 재시도 링크용)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/price-sheets") return jsonResponse({ priceSheet: { id: "ps-3" } });
      return jsonResponse({ error: "가격표 추출 중 오류가 발생했습니다." }, false);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await ingestPriceSheetFile(makeFile("a.jpg"), null);
    expect(result).toEqual({
      ok: false,
      error: "가격표 추출 중 오류가 발생했습니다.",
      priceSheetId: "ps-3",
    });
  });
});

describe("categorizePriceSheetRows", () => {
  it("NEW_DEAL + 판매가 있음 + needsReview 아님 = 깨끗", () => {
    const { clean, ambiguousCount } = categorizePriceSheetRows([
      { productName: "비비랩 콜라겐", optionName: "3통", sellingPrice: 26000, mappingStatus: "NEW_DEAL" },
    ]);
    expect(clean).toEqual([{ productName: "비비랩 콜라겐", optionName: "3통", sellingPrice: 26000 }]);
    expect(ambiguousCount).toBe(0);
  });

  it("SUGGESTED(기존 딜과 유사)는 애매로 분류한다", () => {
    const { clean, ambiguousCount } = categorizePriceSheetRows([
      { productName: "A", optionName: null, sellingPrice: 1000, mappingStatus: "SUGGESTED" },
    ]);
    expect(clean).toHaveLength(0);
    expect(ambiguousCount).toBe(1);
  });

  it("NEW_DEAL이라도 판매가 누락·needsReview면 애매로 분류한다", () => {
    const { clean, ambiguousCount } = categorizePriceSheetRows([
      { productName: "A", optionName: null, sellingPrice: null, mappingStatus: "NEW_DEAL" },
      { productName: "B", optionName: null, sellingPrice: 5000, mappingStatus: "NEW_DEAL", flags: { needsReview: true } },
    ]);
    expect(clean).toHaveLength(0);
    expect(ambiguousCount).toBe(2);
  });

  it("검토 화면이 경고하는 위험 플래그(음수마진·증정·단독구매불가)는 전부 애매로 분류한다", () => {
    // 교차검증 HIGH 회귀 가드: 채팅 원클릭 적용의 안전망이 review-table FlagBadges보다 좁으면 안 된다.
    const { clean, ambiguousCount } = categorizePriceSheetRows([
      { productName: "역마진", optionName: null, sellingPrice: 5000, mappingStatus: "NEW_DEAL", flags: { negativeMargin: true } },
      { productName: "사은품", optionName: null, sellingPrice: 5000, mappingStatus: "NEW_DEAL", flags: { giftOrBundle: true } },
      { productName: "묶음전용", optionName: null, sellingPrice: 5000, mappingStatus: "NEW_DEAL", flags: { singlePurchaseBlocked: true } },
    ]);
    expect(clean).toHaveLength(0);
    expect(ambiguousCount).toBe(3);
  });

  it("문자열 판매가(Decimal 직렬화)도 숫자로 받아 깨끗으로 분류한다", () => {
    const { clean } = categorizePriceSheetRows([
      { productName: "A", optionName: null, sellingPrice: "18000", mappingStatus: "NEW_DEAL" },
    ]);
    expect(clean[0]?.sellingPrice).toBe(18000);
  });
});

describe("mapAndCategorize", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("/map 호출 후 상세 조회로 행을 분류한다", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/price-sheets/ps-1/map") {
        expect(init?.method).toBe("POST");
        return jsonResponse({ mappingCount: 3 });
      }
      if (url === "/api/price-sheets/ps-1") {
        return jsonResponse({
          priceSheet: {
            rows: [
              { productName: "새 상품", optionName: null, sellingPrice: 9000, mappingStatus: "NEW_DEAL" },
              { productName: "겹치는 상품", optionName: null, sellingPrice: 8000, mappingStatus: "SUGGESTED" },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const review = await mapAndCategorize("ps-1", 2);
    expect(review).toEqual({
      priceSheetId: "ps-1",
      total: 2,
      clean: [{ productName: "새 상품", optionName: null, sellingPrice: 9000 }],
      ambiguousCount: 1,
    });
  });

  it("상세 조회 실패 시 전량 애매로 안전 저하한다 (추출 행수 폴백)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/price-sheets/ps-2/map") return jsonResponse({});
      return jsonResponse({}, false); // GET 실패
    });
    vi.stubGlobal("fetch", fetchMock);

    const review = await mapAndCategorize("ps-2", 7);
    expect(review).toEqual({ priceSheetId: "ps-2", total: 7, clean: [], ambiguousCount: 7 });
  });

  it("네트워크 예외도 전량 애매로 흡수한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    const review = await mapAndCategorize("ps-3", 4);
    expect(review).toEqual({ priceSheetId: "ps-3", total: 4, clean: [], ambiguousCount: 4 });
  });

  it("200이지만 rows가 없는 비정상 본문도 전량 애매로 저하한다 (품목 0개 오표시 방지)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/price-sheets/ps-4/map") return jsonResponse({});
      return jsonResponse({}); // 200 이지만 priceSheet.rows 부재
    });
    vi.stubGlobal("fetch", fetchMock);
    const review = await mapAndCategorize("ps-4", 6);
    expect(review).toEqual({ priceSheetId: "ps-4", total: 6, clean: [], ambiguousCount: 6 });
  });
});

describe("applyPriceSheetRows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("반영 성공 시 반영 행수·딜수를 반환한다", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/price-sheets/ps-1/apply");
      expect(init?.method).toBe("POST");
      return jsonResponse({ rowCount: 3, results: [{}, {}, {}, {}] });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await applyPriceSheetRows("ps-1")).toEqual({ ok: true, appliedRowCount: 3, dealCount: 4 });
  });

  it("반영 실패 시 서버 error 원문을 반환한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "이미 반영된 가격표입니다" }, false)));
    expect(await applyPriceSheetRows("ps-1")).toEqual({ ok: false, error: "이미 반영된 가격표입니다" });
  });

  it("네트워크 예외는 고정 문구 실패로 흡수한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect(await applyPriceSheetRows("ps-1")).toEqual({
      ok: false,
      error: "가격표 반영 중 오류가 발생했습니다.",
    });
  });
});
