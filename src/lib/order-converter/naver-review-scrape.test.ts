import { describe, it, expect } from "vitest";
import {
  parseReviewItem,
  parseReviewSummary,
  buildSmartstoreProductUrl,
  extractChannelNoFromProductUrl,
  parseProxyForPlaywright,
} from "./naver-review-scrape";

// 실측(2026-07-17) query-pages 응답 item의 실제 형태 — PII 필드 포함(저장되면 안 됨).
const realItem = {
  id: 5021751411,
  reviewType: "NORMAL",
  reviewScore: 5,
  reviewContent: "충전 잘 되고 가벼워요",
  createDate: "2026-07-15T01:59:07.449+00:00",
  repurchase: false,
  maskedWriterId: "xhrl****",
  productOptionContent: "색상: 아이보리 / 용량: 10000mAh",
  reviewAttaches: [{ imageUrl: "https://phinf.pstatic.net/a.jpg" }],
  originProductNo: 13583224998,
  // ↓ PII·내부 식별자 — parseReviewItem이 버려야 한다(D4)
  writerId: "realuser01",
  writerMemberNo: 123456789,
  writerIdNo: "abcdef",
  orderNo: "2026071512345",
  productOrderNo: "2026071512345001",
  writerProfileImageUrl: "https://ssl.pstatic.net/p.jpg",
};

describe("parseReviewItem — 실측 응답 매핑", () => {
  it("실측 item을 VocReview로 변환한다", () => {
    const out = parseReviewItem(realItem);
    expect(out).toMatchObject({
      externalId: "naver:5021751411",
      rating: 5,
      content: "충전 잘 되고 가벼워요",
      writerMasked: "xhrl****",
      optionText: "색상: 아이보리 / 용량: 10000mAh",
      isRepurchase: false,
      imageUrls: ["https://phinf.pstatic.net/a.jpg"],
    });
    expect(out?.writtenAt).toBe("2026-07-15T01:59:07.449Z");
  });

  it("🔒 PII·내부 식별자를 저장 대상에서 전부 버린다(D4 — 화이트리스트)", () => {
    const out = parseReviewItem(realItem) as unknown as Record<string, unknown>;
    for (const forbidden of ["writerId", "writerMemberNo", "writerIdNo", "orderNo", "productOrderNo", "writerProfileImageUrl"]) {
      expect(out, `${forbidden} 가 저장 객체에 새어나감(D4 위반)`).not.toHaveProperty(forbidden);
    }
    // 직렬화 결과에도 원문 PII 값이 없어야 한다(중첩 유출 방지)
    const json = JSON.stringify(out);
    expect(json).not.toContain("realuser01");
    expect(json).not.toContain("2026071512345");
  });

  it("externalId에 naver: 접두를 붙인다(수동 임포트 해시 id와 충돌 방지)", () => {
    expect(parseReviewItem(realItem)?.externalId).toMatch(/^naver:\d+$/);
  });

  it("필수 결측(id·평점범위·본문·작성일)은 null로 스킵", () => {
    expect(parseReviewItem({ ...realItem, id: null })).toBeNull();
    expect(parseReviewItem({ ...realItem, reviewScore: 0 })).toBeNull();
    expect(parseReviewItem({ ...realItem, reviewScore: 6 })).toBeNull();
    expect(parseReviewItem({ ...realItem, reviewContent: "   " })).toBeNull(); // 포토 전용 리뷰
    expect(parseReviewItem({ ...realItem, createDate: "not-a-date" })).toBeNull();
    expect(parseReviewItem(null)).toBeNull();
  });

  it("reviewAttaches의 URL 문자열만 추출(형태 변형 허용·비문자열 배제)", () => {
    const out = parseReviewItem({
      ...realItem,
      reviewAttaches: [
        { imageUrl: "u1" },
        { thumbnailImageUrl: "u2" },
        { nope: 123 },
        null,
      ],
    });
    expect(out?.imageUrls).toEqual(["u1", "u2"]);
  });

  it("첨부 없으면 빈 배열(포토리뷰 판정이 false가 되도록)", () => {
    expect(parseReviewItem({ ...realItem, reviewAttaches: [] })?.imageUrls).toEqual([]);
    expect(parseReviewItem({ ...realItem, reviewAttaches: undefined })?.imageUrls).toEqual([]);
  });
});

describe("parseReviewSummary — 스토어 제공 집계", () => {
  it("productReviewInfo에서 집계를 뽑는다(실측 형태)", () => {
    const out = parseReviewSummary({
      productReviewInfo: {
        reviewCount: 32,
        averageReviewScore: 4.94,
        photoReviewCount: 24,
        score5ReviewCount: 30,
        score4ReviewCount: 2,
      },
    });
    expect(out).toEqual({ reviewCount: 32, averageScore: 4.94, photoReviewCount: 24 });
  });

  it("형태가 어긋나면 null(집계는 보조 — 목록 수집은 계속)", () => {
    expect(parseReviewSummary(null)).toBeNull();
    expect(parseReviewSummary({})).toBeNull();
    expect(parseReviewSummary({ productReviewInfo: { reviewCount: "x" } })).toBeNull();
  });
});

describe("buildSmartstoreProductUrl", () => {
  it("자사몰 슬러그로 공개 상품 URL을 만든다(실측 착지 형태)", () => {
    expect(buildSmartstoreProductUrl("13643025431")).toBe("https://smartstore.naver.com/ygrd/products/13643025431");
  });
  it("브랜드몰 등 다른 슬러그를 받는다", () => {
    expect(buildSmartstoreProductUrl("999", "otherstore")).toBe("https://smartstore.naver.com/otherstore/products/999");
  });
});

describe("extractChannelNoFromProductUrl — 단축링크 해석 결과 파싱", () => {
  it("스토어 상품 URL에서 channelProductNo를 뽑는다(NaPm 파라미터 포함 실측 형태)", () => {
    expect(extractChannelNoFromProductUrl("https://smartstore.naver.com/ygrd/products/13643025431?NaPm=ct%3D1jto")).toBe("13643025431");
  });
  it("파라미터 없는 형태·다른 슬러그도 추출", () => {
    expect(extractChannelNoFromProductUrl("https://smartstore.naver.com/other/products/999")).toBe("999");
  });
  it("상품 URL이 아니면 null(로그인 리다이렉트·단축링크 미정착)", () => {
    expect(extractChannelNoFromProductUrl("https://nid.naver.com/nidlogin.login")).toBeNull();
    expect(extractChannelNoFromProductUrl("https://mkt.shopping.naver.com/link/abc")).toBeNull();
    expect(extractChannelNoFromProductUrl(null)).toBeNull();
  });
});

describe("parseProxyForPlaywright — 깨끗한 IP 라우팅(회피 아님)", () => {
  it("인증 포함 Fixie URL을 server/username/password로 분해한다(기본 포트 80은 정규화 — Playwright가 http 기본 80 사용)", () => {
    expect(parseProxyForPlaywright("http://user:pass@proxy.fixie.com:80")).toEqual({
      server: "http://proxy.fixie.com",
      username: "user",
      password: "pass",
    });
  });
  it("비기본 포트는 server에 보존한다", () => {
    expect(parseProxyForPlaywright("http://proxy.example.com:8080")).toEqual({ server: "http://proxy.example.com:8080" });
  });
  it("콤마 목록이면 첫 번째만 쓴다(proxyFetch와 동일 순서)", () => {
    expect(parseProxyForPlaywright("http://a:1@p1:8080,http://b:2@p2:8080")?.server).toBe("http://p1:8080");
  });
  it("url-encoded 자격증명을 디코드한다", () => {
    expect(parseProxyForPlaywright("http://u:p%40ss@p:8080")?.password).toBe("p@ss");
  });
  it("미설정·파싱불가는 null(직결 폴백)", () => {
    expect(parseProxyForPlaywright(null)).toBeNull();
    expect(parseProxyForPlaywright("")).toBeNull();
    expect(parseProxyForPlaywright("not a url")).toBeNull();
  });
});
