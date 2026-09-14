
import { NextRequest, NextResponse } from 'next/server';
import { searchNaverProducts } from '@/lib/order-converter/naver-commerce-api';

/** 판매중 상품 우선, 그 다음 판매 종료일이 빠른 상품 우선(종료일 없으면 맨 뒤). */
function sortNaverProductsForSelection(products: any[]): any[] {
  const saleEndTime = (product: any): number => {
    const endDate = product.channelProducts?.[0]?.saleEndDate;
    if (!endDate) return Infinity;
    const time = new Date(endDate).getTime();
    return Number.isNaN(time) ? Infinity : time;
  };
  const onSaleRank = (product: any): number =>
    product.channelProducts?.[0]?.statusType === 'SALE' ? 0 : 1;

  return [...products].sort((a, b) => {
    const rankDiff = onSaleRank(a) - onSaleRank(b);
    if (rankDiff !== 0) return rankDiff;
    return saleEndTime(a) - saleEndTime(b);
  });
}

export async function GET(request: NextRequest) {
  void request.url;
  try {
    const data = await searchNaverProducts();
    const contents = data.contents || [];

    return NextResponse.json({
      success: true,
      products: sortNaverProductsForSelection(contents)
    });
  } catch (error: any) {
    console.error('Failed to fetch Naver products:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
