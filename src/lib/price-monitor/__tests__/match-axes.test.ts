import { describe, it, expect } from "vitest";
import {
  stripUrls,
  brandAxis,
  productCoreWords,
  productScore,
  candidateNameKey,
  candidateUrlKey,
} from "../match-axes";

// Owner-reported calibration case (2026-11-13). Names are anonymized-shape replicas of the
// screen the owner shared; brand/company names are not P0 (owner-confirmed).
const QUERY = "비비랩 올리브레몬 듀얼 올레샷 2박스";
const IDENTITIES = ["비비랩", "뉴트리원"];

describe("stripUrls", () => {
  it("removes a URL glued to the end of a keyword", () => {
    expect(stripUrls("비비랩 올리브레몬 듀얼 올레샷 2박스https://gift.kakao.com/product/123")).toBe(
      "비비랩 올리브레몬 듀얼 올레샷 2박스",
    );
  });
  it("removes standalone and www URLs and collapses spaces", () => {
    expect(stripUrls("a http://x.com/y  b www.z.co.kr/p c")).toBe("a b c");
  });
  it("leaves text without URLs unchanged", () => {
    expect(stripUrls("종근당 락토핏 골드")).toBe("종근당 락토핏 골드");
  });
});

describe("brandAxis", () => {
  it("matches when the brand appears in the product name", () => {
    expect(brandAxis({ productName: "비비랩 유기농 올리브 레몬 골든 듀얼샷", mall: "어떤몰" }, IDENTITIES)).toBe("match");
  });
  it("matches when only the company appears, including in the seller name", () => {
    expect(brandAxis({ productName: "유기농 올리브 레몬 듀얼샷", mall: "뉴트리원공식스토어" }, IDENTITIES)).toBe("match");
  });
  it("ignores spacing differences", () => {
    expect(brandAxis({ productName: "비 비 랩 듀얼샷", mall: "" }, IDENTITIES)).toBe("match");
  });
  it("is missing for another company's product even when product words overlap", () => {
    expect(brandAxis({ productName: "순 유기농 올레샷 올리브 오일 레몬즙 2박스", mall: "메디트리" }, IDENTITIES)).toBe("missing");
    expect(brandAxis({ productName: "듀얼 2in1 올레샷 옵티젠 듀얼슬로", mall: "옵티젠" }, IDENTITIES)).toBe("missing");
  });
  it("is unknown when no identity names are configured", () => {
    expect(brandAxis({ productName: "anything", mall: "x" }, [])).toBe("unknown");
    expect(brandAxis({ productName: "anything", mall: "x" }, [" ", "a"])).toBe("unknown");
  });
});

describe("productCoreWords", () => {
  it("drops identity names, quantity tokens, pure numbers and URLs", () => {
    expect(productCoreWords(`${QUERY}https://gift.kakao.com/product/1`, { identities: IDENTITIES, unit: "박스" })).toEqual([
      "올리브레몬",
      "듀얼",
      "올레샷",
    ]);
  });
  it("falls back to identity words when the query has nothing else", () => {
    expect(productCoreWords("비비랩 2박스", { identities: IDENTITIES, unit: "박스" })).toEqual(["비비랩"]);
  });
  it("keeps the whole query when no identities are given", () => {
    expect(productCoreWords("종근당 락토핏 골드 4박스", { identities: [], unit: "박스" })).toEqual(["종근당", "락토핏", "골드"]);
  });
});

describe("productScore", () => {
  const words = productCoreWords(QUERY, { identities: IDENTITIES, unit: "박스" });

  it("scores owner-confirmed same products high", () => {
    expect(productScore(words, "비비랩 유기농 올리브 레몬 골든 듀얼샷")).toBeGreaterThanOrEqual(60);
    expect(productScore(words, "뉴트리원 비비랩 유기농 올리브 엔 레몬 듀얼샷 올레샷")).toBeGreaterThanOrEqual(80);
  });
  it("scores a sibling product line (different product) low", () => {
    expect(productScore(words, "[뉴트리원] 비비랩 올리브 레몬 밸런스샷 (1박스)")).toBeLessThan(40);
  });
  it("separates a different variant from the core product", () => {
    const w = productCoreWords("종근당 락토핏 골드 파워", { identities: ["종근당"], unit: null });
    expect(productScore(w, "종근당 락토핏 사과즙")).toBeLessThan(40);
    expect(productScore(w, "종근당 락토핏 골드 파워 60포")).toBe(100);
  });
  it("gives no partial credit to short words, so a sibling variant does not pass", () => {
    const w = productCoreWords("비타민c", { identities: [], unit: null });
    expect(productScore(w, "비타민d 1000")).toBeLessThan(40);
  });
  it("is 0 when there are no core words or no name", () => {
    expect(productScore([], "x")).toBe(0);
    expect(productScore(["듀얼"], "")).toBe(0);
  });
});

describe("candidate keys", () => {
  it("name key normalizes spacing and case", () => {
    expect(candidateNameKey("메디 트리", "순 유기농 올레샷")).toBe(candidateNameKey("메디트리", "순유기농 올레샷"));
  });
  it("url key drops query string and fragment", () => {
    expect(candidateUrlKey("https://Smartstore.naver.com/a/products/1?NaPm=ct&x=1#top")).toBe(
      "smartstore.naver.com/a/products/1",
    );
  });
  it("url key is null for empty or invalid urls", () => {
    expect(candidateUrlKey("")).toBeNull();
    expect(candidateUrlKey("not a url")).toBeNull();
  });
});
