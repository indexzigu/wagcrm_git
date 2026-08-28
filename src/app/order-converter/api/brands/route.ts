import { NextResponse } from 'next/server';
import { listOrderBrands } from '@/lib/order-converter/order-brand';

// F4-② 딜 온보딩 제로코드화: 캠페인 생성/편집 모달의 "거래처 양식" 드롭다운 소스.
// 발주 브랜드로 설정된 거래처(Partner.orderTemplateSlug != null)를 반환한다.
export async function GET() {
  try {
    const brands = await listOrderBrands();
    return NextResponse.json({ brands });
  } catch (error: any) {
    console.error('Failed to list order brands:', error);
    return NextResponse.json({ error: error.message || '발주 브랜드 목록 조회에 실패했습니다.' }, { status: 500 });
  }
}
