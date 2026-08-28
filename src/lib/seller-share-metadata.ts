import type { Metadata } from "next";

export type SellerShareKind = "campaign" | "channel";

export type SellerShareProfile = Readonly<{
  name: string;
  alias: string | null;
  snsHandle: string;
  currentFollowers: number;
  category: string | null;
  profileBio: string | null;
  profilePicUrl: string | null;
}>;

export function buildSellerShareMetadata(
  kind: SellerShareKind,
  seller: SellerShareProfile,
): Metadata {
  const displayName = seller.alias?.trim() || seller.name.trim();
  const reportLabel = kind === "campaign" ? "캠페인 리포트" : "채널 분석 리포트";
  const title = `${displayName} ${reportLabel}`;
  const normalizedBio = seller.profileBio?.replace(/\s+/g, " ").trim();
  const channelFocus = kind === "campaign" ? "캠페인 성과" : "채널 성과와 콘텐츠 분석";
  const category = seller.category?.trim() ? ` · ${seller.category.trim()}` : "";
  const description = normalizedBio
    ? normalizedBio.slice(0, 160)
    : `@${seller.snsHandle} · 팔로워 ${seller.currentFollowers.toLocaleString("ko-KR")}명${category} 채널의 ${channelFocus}를 확인하세요.`;
  const images = seller.profilePicUrl?.trim()
    ? [{ url: seller.profilePicUrl.trim(), alt: `${displayName} 프로필 이미지` }]
    : undefined;

  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      type: "website",
      siteName: "WAG CRM",
      title,
      description,
      ...(images ? { images } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      ...(images ? { images: images.map((image) => image.url) } : {}),
    },
  };
}
