import { describe, expect, it } from "vitest";
import { buildSellerShareMetadata, type SellerShareProfile } from "./seller-share-metadata";

const seller: SellerShareProfile = {
  name: "본명",
  alias: "셀러별칭",
  snsHandle: "seller_handle",
  currentFollowers: 12_345,
  category: "리빙",
  profileBio: "생활을 더 편하게 만드는 제품을 소개합니다.\n공동구매 문의는 DM으로 주세요.",
  profilePicUrl: "https://cdn.example.com/seller.jpg",
};

describe("buildSellerShareMetadata", () => {
  it("별칭을 우선한 채널 분석 리포트 제목과 셀러 이미지·설명을 만든다", () => {
    const metadata = buildSellerShareMetadata("channel", seller);

    expect(metadata.title).toBe("셀러별칭 채널 분석 리포트");
    expect(metadata.description).toBe(
      "생활을 더 편하게 만드는 제품을 소개합니다. 공동구매 문의는 DM으로 주세요.",
    );
    expect(metadata.openGraph).toMatchObject({
      title: "셀러별칭 채널 분석 리포트",
      description: "생활을 더 편하게 만드는 제품을 소개합니다. 공동구매 문의는 DM으로 주세요.",
      images: [{ url: "https://cdn.example.com/seller.jpg", alt: "셀러별칭 프로필 이미지" }],
    });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("프로필 소개가 없으면 채널 정보 기반 설명을 만들고 이미지는 생략한다", () => {
    const metadata = buildSellerShareMetadata("campaign", {
      ...seller,
      alias: null,
      profileBio: null,
      profilePicUrl: null,
    });

    expect(metadata.title).toBe("본명 캠페인 리포트");
    expect(metadata.description).toBe(
      "@seller_handle · 팔로워 12,345명 · 리빙 채널의 캠페인 성과를 확인하세요.",
    );
    expect(metadata.openGraph).not.toHaveProperty("images");
  });
});
