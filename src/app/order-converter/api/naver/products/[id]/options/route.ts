import { NextRequest, NextResponse } from 'next/server';
import { apiRequest } from '@/lib/order-converter/naver-commerce-client';
import { buildStoreMappingRows } from '@/lib/order-converter/store-option-rows';

/**
 * GET /order-converter/api/naver/products/[id]/options
 * [id] = channelProductNo. 스토어 상품 상세에서 캠페인 매핑 표 행(옵션명·가격, 추가구성 포함)을 생성해 반환.
 * 코드표 없는 거래처의 매핑 자동 로드 용도 — brandCode는 빈 값(미기입 운영).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !/^\d+$/.test(id)) {
    return NextResponse.json({ success: false, error: '유효한 채널상품번호가 필요합니다.' }, { status: 400 });
  }

  try {
    const res: any = await apiRequest('GET', `/v2/products/channel-products/${id}`, undefined, undefined);
    const body = res?.data ?? res;
    const { productName, rows } = buildStoreMappingRows(body);

    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: '상품에서 옵션 정보를 찾지 못했습니다.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, productName, channelProductNo: id, rows });
  } catch (error: any) {
    console.error('Failed to load store product options:', error?.message || error);
    return NextResponse.json({ success: false, error: error?.message || '옵션 조회에 실패했습니다.' }, { status: 500 });
  }
}
