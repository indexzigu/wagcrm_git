import { describe, it, expect } from "vitest";
import {
  pickShortLink,
  buildChannelToOrigin,
  dealsNeedingResolution,
  buildOriginToDeals,
  buildReviewTargets,
  prioritizeTargets,
  filterRecentlyCollected,
  REVIEW_RECOLLECT_MIN_DAYS,
  normalizeProductText,
  matchDealNameToStoreOrigin,
  toProductOrderIds,
  buildDealResolveInputs,
  RESOLVE_FAILED_RETRY_MS,
  REVIEW_MAX_ORIGINS_PER_RUN,
  REVIEW_RESOLVE_MAX_PER_RUN,
  type ReviewTarget,
} from "./review-collect";
import type { ProductNumberPair } from "./naver-qna-sync";

const pair = (originProductNo: string, name: string, channels: string[] = []): ProductNumberPair => ({
  originProductNo,
  channelProductNos: channels,
  name,
});

describe("pickShortLink", () => {
  it("mkt.shopping.naver.com/link/ 형태만 고른다", () => {
    expect(pickShortLink(["https://mkt.shopping.naver.com/link/abc"])).toBe("https://mkt.shopping.naver.com/link/abc");
  });
  it("직접 스토어 URL·도메인만·null은 제외", () => {
    expect(pickShortLink(["https://smartstore.naver.com/ygrd/products/1", "https://smartstore.naver.com", null])).toBeNull();
    expect(pickShortLink([])).toBeNull();
  });
});

describe("buildChannelToOrigin", () => {
  it("채널번호 → 원상품번호 맵(리뷰 API 키 복원)", () => {
    const m = buildChannelToOrigin([
      { originProductNo: "1000", channelProductNos: ["2000", "2001"] },
      { originProductNo: "1001", channelProductNos: ["3000"] },
    ]);
    expect(m.get("2000")).toBe("1000");
    expect(m.get("2001")).toBe("1000");
    expect(m.get("3000")).toBe("1001");
  });
  it("빈 채널·중복은 무시(첫 매핑 우선)", () => {
    const m = buildChannelToOrigin([
      { originProductNo: "1000", channelProductNos: ["2000", ""] },
      { originProductNo: "9999", channelProductNos: ["2000"] }, // 중복 채널 — 첫 매핑 유지
    ]);
    expect(m.get("2000")).toBe("1000");
    expect(m.has("")).toBe(false);
  });
});

describe("dealsNeedingResolution", () => {
  const now = new Date("2026-07-18T00:00:00Z");
  const dl = (id: string) => ({ dealId: id, shortLink: `https://mkt.shopping.naver.com/link/${id}` });

  it("캐시에 없는 딜은 해석 대상", () => {
    const out = dealsNeedingResolution([dl("a"), dl("b")], new Map(), now);
    expect(out.map((x) => x.dealId)).toEqual(["a", "b"]);
  });
  it("RESOLVED 캐시는 재해석 안 함", () => {
    const cache = new Map([["a", { dealId: "a", status: "RESOLVED", resolvedAt: now }]]);
    expect(dealsNeedingResolution([dl("a"), dl("b")], cache, now).map((x) => x.dealId)).toEqual(["b"]);
  });
  it("FAILED은 TTL 경과 후에만 재해석", () => {
    const fresh = new Map([["a", { dealId: "a", status: "FAILED", resolvedAt: new Date(now.getTime() - 1000) }]]);
    expect(dealsNeedingResolution([dl("a")], fresh, now)).toEqual([]);
    const stale = new Map([["a", { dealId: "a", status: "FAILED", resolvedAt: new Date(now.getTime() - RESOLVE_FAILED_RETRY_MS - 1) }]]);
    expect(dealsNeedingResolution([dl("a")], stale, now).map((x) => x.dealId)).toEqual(["a"]);
  });
  it("딜당 첫 링크만·상한 적용", () => {
    const many = Array.from({ length: 20 }, (_, i) => dl(`d${i}`));
    expect(dealsNeedingResolution(many, new Map(), now)).toHaveLength(REVIEW_RESOLVE_MAX_PER_RUN);
    expect(dealsNeedingResolution([dl("a"), dl("a")], new Map(), now)).toHaveLength(1); // dedup
  });
});

describe("filterRecentlyCollected — 최근 수집 스킵 게이트(#42)", () => {
  const now = new Date("2026-07-18T00:00:00Z");
  const t = (origin: string): ReviewTarget => ({ originProductNo: origin, channelProductNo: "c", entryUrl: null, dealIds: ["d"] });
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  it("최근(minDays 이내) 수집 origin은 제외, 오래된 것은 통과", () => {
    const last = new Map<string, Date | null>([
      ["fresh", daysAgo(1)],
      ["old", daysAgo(REVIEW_RECOLLECT_MIN_DAYS + 1)],
    ]);
    expect(filterRecentlyCollected([t("fresh"), t("old")], last, now).map((x) => x.originProductNo)).toEqual(["old"]);
  });
  it("미수집(null·미등재)은 통과", () => {
    const last = new Map<string, Date | null>([["never", null]]);
    expect(filterRecentlyCollected([t("never"), t("unknown")], last, now)).toHaveLength(2);
  });
  it("전부 최근이면 빈 배열(정상 스킵)", () => {
    const last = new Map<string, Date | null>([["a", daysAgo(0)], ["b", daysAgo(2)]]);
    expect(filterRecentlyCollected([t("a"), t("b")], last, now)).toEqual([]);
  });
  it("경계: 정확히 minDays 경과는 통과", () => {
    const last = new Map<string, Date | null>([["edge", daysAgo(REVIEW_RECOLLECT_MIN_DAYS)]]);
    expect(filterRecentlyCollected([t("edge")], last, now)).toHaveLength(1);
  });
});

describe("matchDealNameToStoreOrigin — Tier-2 상품명 단일매칭", () => {
  const pairs = [
    pair("13575800466", "[미르 X 뉴트리원] 고순도 오메가3"),
    pair("13596784327", "[라온 X 비타슈넬] 이노시톨 / 철분"),
    pair("13583224998", "[한별 X 보바] 보조 배터리"),
  ];
  it("딜명이 정확히 한 리스팅명에 포함되면 origin 반환(태그·공백 무시)", () => {
    expect(matchDealNameToStoreOrigin("오메가3", pairs)).toBe("13575800466");
    expect(matchDealNameToStoreOrigin("보조배터리", pairs)).toBe("13583224998");
    expect(matchDealNameToStoreOrigin("이노시톨", pairs)).toBe("13596784327");
  });
  it("복수 후보면 null(오귀속 방지 — #33 교훈)", () => {
    const multi = [pair("1", "칼마디 세트"), pair("2", "칼마디 리필")];
    expect(matchDealNameToStoreOrigin("칼마디", multi)).toBeNull();
  });
  it("매칭 없음·2자 미만·이름 없는 pair는 null", () => {
    expect(matchDealNameToStoreOrigin("존재안함", pairs)).toBeNull();
    expect(matchDealNameToStoreOrigin("a", pairs)).toBeNull();
    expect(matchDealNameToStoreOrigin("오메가3", [pair("9", "")])).toBeNull();
  });
  it("normalizeProductText: 대괄호 태그·공백·구분자 제거", () => {
    expect(normalizeProductText("[라온 X 비타슈넬] 이노시톨 / 철분")).toBe("이노시톨철분");
  });
});

describe("toProductOrderIds", () => {
  it("Json 배열을 문자열 배열로(dedup·상한)", () => {
    expect(toProductOrderIds([111, "222", 111, null, "333"])).toEqual(["111", "222", "333"]);
    expect(toProductOrderIds(Array.from({ length: 20 }, (_, i) => i + 1), 5)).toHaveLength(5);
  });
  it("배열 아니면 빈 배열", () => {
    expect(toProductOrderIds(null)).toEqual([]);
    expect(toProductOrderIds("x")).toEqual([]);
  });
});

describe("buildDealResolveInputs — 딜당 병합", () => {
  it("여러 회차 행을 딜당 이름·단축링크·주문번호로 접는다", () => {
    const rows = [
      { dealId: "a", dealName: "오메가3", baseNaverLink: "https://smartstore.naver.com", productOrderIds: ["111"] },
      { dealId: "a", dealName: "", baseNaverLink: "https://mkt.shopping.naver.com/link/abc", productOrderIds: ["222"] },
    ];
    const out = buildDealResolveInputs(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ dealId: "a", name: "오메가3", shortLink: "https://mkt.shopping.naver.com/link/abc" });
    expect(out[0].productOrderIds).toEqual(["111", "222"]);
  });
  it("단축링크·주문번호 없으면 null·빈배열", () => {
    const out = buildDealResolveInputs([{ dealId: "b", dealName: "x", baseNaverLink: "https://smartstore.naver.com" }]);
    expect(out[0].shortLink).toBeNull();
    expect(out[0].productOrderIds).toEqual([]);
  });
});

describe("buildOriginToDeals — 1:N 묶음", () => {
  it("한 origin에 여러 딜(묶음 리스팅 공유)", () => {
    const m = buildOriginToDeals([
      { dealId: "이노시톨", origin: "1000" },
      { dealId: "철분", origin: "1000" },
      { dealId: "칼마디", origin: "1000" },
      { dealId: "보조배터리", origin: "2000" },
    ]);
    expect(m.get("1000")).toEqual(["이노시톨", "철분", "칼마디"]);
    expect(m.get("2000")).toEqual(["보조배터리"]);
  });
  it("(origin,deal) 중복은 dedup(주문검증+캐시 합집합 대비)", () => {
    const m = buildOriginToDeals([
      { dealId: "a", origin: "1000" },
      { dealId: "a", origin: "1000" }, // 두 소스에서 같은 매칭
    ]);
    expect(m.get("1000")).toEqual(["a"]);
  });
  it("동일 딜이 서로 다른 origin에 걸리면 첫 origin만(HIGH#2 오염 차단)", () => {
    // 주문검증(1000)을 먼저 push하면 링크해석(2000)이 덮지 못한다 — 다른 상품 리뷰 혼입 방지.
    const m = buildOriginToDeals([
      { dealId: "a", origin: "1000" }, // 주문검증(우선)
      { dealId: "a", origin: "2000" }, // 링크해석(다른 상품) — 무시돼야
    ]);
    expect(m.get("1000")).toEqual(["a"]);
    expect(m.has("2000")).toBe(false);
  });
  it("빈 origin·dealId는 스킵", () => {
    const m = buildOriginToDeals([{ dealId: "", origin: "1000" }, { dealId: "a", origin: "" }]);
    expect(m.size).toBe(0);
  });
});

describe("buildReviewTargets — origin 중심", () => {
  const pairs = [
    { originProductNo: "1000", channelProductNos: ["2000"] },
    { originProductNo: "1001", channelProductNos: ["2001"] },
  ];
  it("스토어에 있는 origin(채널 보유)만 대상·공유 딜 포함", () => {
    const originToDeals = new Map([["1000", ["a", "b"]]]);
    const out = buildReviewTargets(originToDeals, pairs, new Map([["1000", "https://mkt.shopping.naver.com/link/x"]]));
    expect(out).toEqual([
      { originProductNo: "1000", channelProductNo: "2000", entryUrl: "https://mkt.shopping.naver.com/link/x", dealIds: ["a", "b"] },
    ]);
  });
  it("스토어에 없는 origin(현재 미판매)은 제외", () => {
    const out = buildReviewTargets(new Map([["9999", ["a"]]]), pairs);
    expect(out).toEqual([]);
  });
  it("딜 없는 origin·entryUrl 없으면 null", () => {
    expect(buildReviewTargets(new Map([["1000", []]]), pairs)).toEqual([]);
    expect(buildReviewTargets(new Map([["1001", ["a"]]]), pairs)[0].entryUrl).toBeNull();
  });
});

describe("prioritizeTargets", () => {
  const t = (origin: string): ReviewTarget => ({ originProductNo: origin, channelProductNo: "c", entryUrl: null, dealIds: ["d"] });
  it("미수집(null) 최우선, 그다음 오래된 순, 상한 적용", () => {
    const targets = [t("recent"), t("never"), t("old")];
    const last = new Map<string, Date | null>([
      ["recent", new Date("2026-07-18T00:00:00Z")],
      ["never", null],
      ["old", new Date("2026-01-01T00:00:00Z")],
    ]);
    expect(prioritizeTargets(targets, last).map((x) => x.originProductNo)).toEqual(["never", "old", "recent"]);
  });
  it("상한 초과분 절단", () => {
    const many = Array.from({ length: 20 }, (_, i) => t(`o${i}`));
    expect(prioritizeTargets(many, new Map())).toHaveLength(REVIEW_MAX_ORIGINS_PER_RUN);
  });
  it("입력을 변형하지 않는다(순수)", () => {
    const targets = [t("b"), t("a")];
    const copy = [...targets];
    prioritizeTargets(targets, new Map());
    expect(targets).toEqual(copy);
  });
});
