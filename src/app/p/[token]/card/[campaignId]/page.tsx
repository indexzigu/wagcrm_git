// 셀러 성과 카드(레거시 토큰 경로) — 접근 자격 = 추측 불가 토큰. 본문은 공용 컴포넌트.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPrisma } from "@/lib/prisma";
import { SellerPerformanceCard } from "@/components/portal/seller-performance-card";

export const metadata: Metadata = {
  title: "성과 카드",
  robots: { index: false, follow: false },
};

type Params = { params: Promise<{ token: string; campaignId: string }> };

export default async function SellerPerformanceCardPage({ params }: Params) {
  const { token, campaignId } = await params;
  // 토큰 형식 사전 검증 — 포털 본문과 동일 패턴
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) notFound();

  const seller = await getPrisma().seller.findUnique({
    where: { portalToken: token },
    select: { id: true, name: true, alias: true, currentFollowers: true },
  });
  if (!seller) notFound();

  return <SellerPerformanceCard seller={seller} campaignId={campaignId} basePath={`/p/${token}`} />;
}
