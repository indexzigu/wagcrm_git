// 셀러 포털(레거시 토큰 경로) — 로그인 없는 토큰 URL. 접근 자격 = 추측 불가 토큰(Seller.portalToken).
// 이미 공유된 링크를 깨지 않기 위해 유지한다. 신규 발급은 전용 주소(/<slug> + 비밀번호)가 기본.
// 본문 렌더는 SellerPortalReport 공용 컴포넌트(화이트리스트·§0-1 규칙 포함).
import { notFound } from "next/navigation";
import { getPrisma } from "@/lib/prisma";
import { SellerPortalReport } from "@/components/portal/seller-portal-report";

type Params = { params: Promise<{ token: string }> };

export default async function SellerPortalPage({ params }: Params) {
  const { token } = await params;
  // 토큰 형식 사전 검증(base64url 24바이트=32자) — 임의 문자열로 DB 조회 낭비 방지
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) notFound();

  const seller = await getPrisma().seller.findUnique({
    where: { portalToken: token },
    select: { id: true, name: true, alias: true, currentFollowers: true },
  });
  if (!seller) notFound();

  return <SellerPortalReport seller={seller} basePath={`/p/${token}`} />;
}
