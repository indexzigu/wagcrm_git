import type { Metadata } from "next";
import { buildSellerShareMetadata } from "@/lib/seller-share-metadata";
import { findSellerShareProfileByToken } from "@/lib/seller-share-profile";

type Props = Readonly<{
  children: React.ReactNode;
  params: Promise<{ token: string }>;
}>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const seller = /^[A-Za-z0-9_-]{20,64}$/.test(token)
    ? await findSellerShareProfileByToken(token)
    : null;

  return seller
    ? buildSellerShareMetadata("campaign", seller)
    : { title: "캠페인 리포트", robots: { index: false, follow: false } };
}

export default function SellerPortalLayout({ children }: Props) {
  return children;
}
