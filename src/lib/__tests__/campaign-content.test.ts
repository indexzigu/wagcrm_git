import { describe, it, expect } from "vitest";
import {
  isSellerPostAsset,
  selectPromoteCopyFields,
  formatCampaignPerformanceSummary,
} from "../campaign-content";

describe("isSellerPostAsset", () => {
  const base = {
    entityType: "CAMPAIGN",
    provider: "EXTERNAL_LINK",
    externalUrl: "https://www.instagram.com/reel/ABC123/",
    archivedAt: null,
  };

  it("캠페인 외부링크 자산(미보관)은 셀러 게시물이다", () => {
    expect(isSellerPostAsset(base)).toBe(true);
  });

  it("entityType이 DEAL이면 제외한다(딜 레퍼런스와 자연 구분)", () => {
    expect(isSellerPostAsset({ ...base, entityType: "DEAL" })).toBe(false);
  });

  it("provider가 EXTERNAL_LINK가 아니면 제외한다(파일 업로드·Drive 링크)", () => {
    expect(isSellerPostAsset({ ...base, provider: "SUPABASE" })).toBe(false);
    expect(isSellerPostAsset({ ...base, provider: "GOOGLE_DRIVE" })).toBe(false);
  });

  it("externalUrl이 없거나 빈 문자열이면 제외한다", () => {
    expect(isSellerPostAsset({ ...base, externalUrl: null })).toBe(false);
    expect(isSellerPostAsset({ ...base, externalUrl: undefined })).toBe(false);
    expect(isSellerPostAsset({ ...base, externalUrl: "" })).toBe(false);
  });

  it("보관된 자산은 제외한다(문자열·Date 모두)", () => {
    expect(isSellerPostAsset({ ...base, archivedAt: "2026-07-01T00:00:00Z" })).toBe(false);
    expect(isSellerPostAsset({ ...base, archivedAt: new Date() })).toBe(false);
  });
});

describe("selectPromoteCopyFields", () => {
  it("externalUrl 있는 자산의 복사 필드(fileName·externalUrl·thumbnailUrl·notes)를 고른다", () => {
    expect(
      selectPromoteCopyFields({
        fileName: "instagram.com/reel/ABC123",
        externalUrl: "https://www.instagram.com/reel/ABC123/",
        thumbnailUrl: "https://cdn.example.com/refs/abc.jpg",
        notes: "캡션: 여름 세일 · 좋아요 1,234",
      }),
    ).toEqual({
      fileName: "instagram.com/reel/ABC123",
      externalUrl: "https://www.instagram.com/reel/ABC123/",
      thumbnailUrl: "https://cdn.example.com/refs/abc.jpg",
      notes: "캡션: 여름 세일 · 좋아요 1,234",
    });
  });

  it("thumbnailUrl·notes가 없으면 null로 정규화한다", () => {
    expect(
      selectPromoteCopyFields({
        fileName: "youtu.be/xyz",
        externalUrl: "https://youtu.be/xyz",
      }),
    ).toEqual({
      fileName: "youtu.be/xyz",
      externalUrl: "https://youtu.be/xyz",
      thumbnailUrl: null,
      notes: null,
    });
  });

  it("externalUrl이 없으면(파일 업로드 자산) null을 반환한다", () => {
    expect(selectPromoteCopyFields({ fileName: "제품소개.pdf" })).toBeNull();
    expect(selectPromoteCopyFields({ fileName: "제품소개.pdf", externalUrl: null })).toBeNull();
    expect(selectPromoteCopyFields({ fileName: "제품소개.pdf", externalUrl: "" })).toBeNull();
  });
});

describe("formatCampaignPerformanceSummary", () => {
  it("실매출·판매수량이 모두 있으면 한 줄로 합친다", () => {
    expect(
      formatCampaignPerformanceSummary({ actualSales: 1234567, itemCount: 42 }),
    ).toBe("실매출 1,234,567원 · 판매수량 42개");
  });

  it("실매출만 있으면 실매출만 표시한다", () => {
    expect(formatCampaignPerformanceSummary({ actualSales: 500000, itemCount: null })).toBe(
      "실매출 500,000원",
    );
  });

  it("판매수량만 있으면 판매수량만 표시한다", () => {
    expect(formatCampaignPerformanceSummary({ actualSales: null, itemCount: 7 })).toBe(
      "판매수량 7개",
    );
  });

  it("0도 유효한 실적으로 표시한다(집계 전과 구분)", () => {
    expect(formatCampaignPerformanceSummary({ actualSales: 0, itemCount: 0 })).toBe(
      "실매출 0원 · 판매수량 0개",
    );
  });

  it("소수 매출은 반올림해 원 단위로 표시한다", () => {
    expect(
      formatCampaignPerformanceSummary({ actualSales: 999.6, itemCount: undefined }),
    ).toBe("실매출 1,000원");
  });

  it("둘 다 없으면 '실적 집계 전'을 반환한다", () => {
    expect(formatCampaignPerformanceSummary({ actualSales: null, itemCount: undefined })).toBe(
      "실적 집계 전",
    );
    expect(formatCampaignPerformanceSummary({ actualSales: NaN, itemCount: null })).toBe(
      "실적 집계 전",
    );
  });
});
