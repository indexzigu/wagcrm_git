import { NextResponse } from 'next/server';
import { generateOrderExcelBuffer } from '@/lib/order-converter/excel-generator';
import { loadOrderTemplateBuffer, resolveOrderBrand } from '@/lib/order-converter/order-brand';

export async function POST(req: Request) {
  try {
    const { brandOrders, selectedTemplate: templateId, sellerName, mappings } = await req.json();

    // F4 Phase 2: 이 라우트도 브랜드 설정을 해석한다 — 기존엔 templateId 문자열 추론에만
    // 의존해 신규 브랜드(slug=거래처 id)의 확정 규칙·양식이 반영되지 않았다.
    const orderBrand = await resolveOrderBrand(templateId);
    const outputBuffer = await generateOrderExcelBuffer({
      orders: brandOrders,
      templateId,
      formatAdapter: orderBrand?.formatAdapter,
      excelRules: orderBrand?.excelRules,
      templateBuffer: await loadOrderTemplateBuffer(orderBrand),
      sellerName,
      mappings
    });
    return new NextResponse(outputBuffer as any, {
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    });
  } catch (error: any) {
    console.error('Excel generation error:', error);
    return NextResponse.json({ error: error.message || '엑셀 변환 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
