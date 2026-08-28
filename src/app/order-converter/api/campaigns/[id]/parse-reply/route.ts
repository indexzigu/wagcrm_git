import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/order-converter/prisma';
import { resolveOrderBrand, resolveReplyRule } from '@/lib/order-converter/order-brand';
import { extractTrackingMapByReply } from '@/lib/order-converter/order-parser';

// F4 Phase 2 §5단계 (설계 D6) — 회신(송장) 파싱을 서버로 이동.
// 클라이언트는 formatAdapter를 전달하지 못해 신규 브랜드(slug=거래처 id) 회신이 항상
// lenient로만 파싱되던 버그가 있었다. 서버가 campaign.template→브랜드→reply 규칙을
// 해석하므로, 규칙 스냅샷이 신뢰경계 밖(클라 번들)으로 나가지 않고 DB 변경도 즉시 반영된다.
// 수동 업로드 경로(order-dashboard handleInvoiceUpload)가 이 라우트를 쓴다.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: campaignId } = await params;
    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '회신 파일이 첨부되지 않았습니다.' }, { status: 400 });
    }

    const campaign = await prisma.orderCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, template: true },
    });
    if (!campaign) {
      return NextResponse.json({ error: '캠페인을 찾을 수 없습니다.' }, { status: 404 });
    }

    const brand = await resolveOrderBrand(campaign.template);
    const reply = resolveReplyRule(brand);

    const arrayBuffer = await file.arrayBuffer();
    const trackingMap = extractTrackingMapByReply(arrayBuffer, reply);

    return NextResponse.json({ trackingMap, count: Object.keys(trackingMap).length });
  } catch (error: any) {
    // 암호 걸린 파일 등 사용자에게 알릴 메시지는 그대로 전달
    const status = error?.message?.includes('암호가 설정되어') ? 400 : 500;
    console.error('parse-reply API Error:', error);
    return NextResponse.json({ error: error?.message || '회신 파일 분석 중 오류가 발생했습니다.' }, { status });
  }
}
