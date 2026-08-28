// 셀러 성과 카드(전용 주소 경로) — 미인증이면 리포트 루트(비밀번호 게이트)로 보낸다.
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { SellerPerformanceCard } from "@/components/portal/seller-performance-card";
import { resolvePortalSeller, isPortalAuthorized } from "@/lib/portal-gate";

export const metadata: Metadata = {
  title: "성과 카드",
  robots: { index: false, follow: false },
};

type Params = { params: Promise<{ slug: string; campaignId: string }> };

export default async function SellerSlugCardPage({ params }: Params) {
  const { slug, campaignId } = await params;
  const seller = await resolvePortalSeller(slug);
  if (!seller) notFound();
  if (!(await isPortalAuthorized(seller))) redirect(`/${slug}`);

  return <SellerPerformanceCard seller={seller} campaignId={campaignId} basePath={`/${slug}`} />;
}
