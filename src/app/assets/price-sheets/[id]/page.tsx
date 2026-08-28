import { PriceSheetDetail } from "@/components/crm/price-sheet/price-sheet-detail";

// 이 앱 최초의 동적 params 라우트 — 업로드된 가격표 id는 빌드 타임에 알 수 없다.
// Next.js 16 cacheComponents 모드는 generateStaticParams가 최소 1개 결과를 반환해야
// build-time validation을 수행할 수 있다(빈 배열이면 EmptyGenerateStaticParamsError).
// placeholder id로 빌드 시점 검증만 통과시키고, 실제 트래픽은 전부 on-demand 렌더링된다
// (존재하지 않는 id로의 요청은 PriceSheetDetail 내부에서 404 처리).
export async function generateStaticParams() {
  return [{ id: "__build_placeholder__" }];
}

export default async function PriceSheetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PriceSheetDetail priceSheetId={id} />;
}
