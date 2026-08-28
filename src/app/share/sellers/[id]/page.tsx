import type { Metadata } from "next";
import { buildSellerShareMetadata } from "@/lib/seller-share-metadata";
import { findSellerShareProfileById } from "@/lib/seller-share-profile";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const seller = await findSellerShareProfileById(id);

  return seller
    ? buildSellerShareMetadata("channel", seller)
    : { title: "채널 분석 리포트", robots: { index: false, follow: false } };
}

export default function SellerSharePreviewPage() {
  return null;
}
