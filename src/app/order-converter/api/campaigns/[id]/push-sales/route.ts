import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/order-converter/prisma';
import { fetchAndSyncCampaigns, type SalesPushOutcome } from '../../campaigns-handler';
import { isSalesCampaignLocked } from '@/lib/order-converter/mapping-service';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const campaign = await prisma.orderCampaign.findUnique({
      where: { id },
      include: {
        mappings: true,
      },
    });

    if (!campaign) {
      return NextResponse.json({ error: '주문관리 캠페인을 찾지 못했습니다.' }, { status: 404 });
    }

    const linkedMappings = campaign.mappings.filter((mapping) => mapping.campaignDealId);
    if (linkedMappings.length === 0) {
      return NextResponse.json({ error: '판매관리 캠페인에 연결된 매핑이 없습니다.' }, { status: 409 });
    }

    const linkedDealIds = Array.from(new Set(linkedMappings.flatMap((mapping) => (
      mapping.campaignDealId ? [mapping.campaignDealId] : []
    ))));
    const linkedDeals = await prisma.campaignDeal.findMany({
      where: { id: { in: linkedDealIds } },
      include: {
        campaign: {
          select: {
            id: true,
            campaignName: true,
            status: true,
          },
        },
      },
    });
    const lockedCampaign = (linkedDeals as Array<{ campaign: { campaignName: string; status: string } }>).find((deal) =>
      isSalesCampaignLocked(deal.campaign.status)
    );
    if (lockedCampaign) {
      return NextResponse.json({
        error: `판매관리 캠페인 '${lockedCampaign.campaign.campaignName}'은(는) 확정/정산 상태라 푸시할 수 없습니다.`,
      }, { status: 409 });
    }

    const salesPushOutcome: SalesPushOutcome = { pushedDealIds: [], unmatchedDealIds: [] };
    const syncResponse = await fetchAndSyncCampaigns(false, {
      salesPushOrderCampaignId: id,
      awaitSalesPush: true,
      salesPushOutcome,
    });
    if (!syncResponse.ok) {
      return NextResponse.json({ error: '주문 집계 재계산에 실패했습니다.' }, { status: 500 });
    }

    const refreshed = await prisma.orderCampaign.findUnique({
      where: { id },
      include: {
        salesCampaigns: {
          include: {
            campaignDeals: {
              select: {
                id: true,
                quantity: true,
                actualSales: true,
                sellingPrice: true,
              },
            },
          },
        },
      },
    });

    const salesCampaigns = refreshed?.salesCampaigns ?? [];

    return NextResponse.json({
      success: true,
      pushedCampaigns: salesCampaigns.length,
      // 실제 매칭 주문이 있어 반영된 딜 수(매칭 0건 딜은 제외 — 아래 unmatchedDeals로 보고).
      pushedDeals: salesPushOutcome.pushedDealIds.length,
      // 딜은 연결됐으나 판매기간 내 매칭 주문이 0건이라 덮어쓰기를 건너뛴(기존값 보존) 딜 수·목록.
      // >0이면 운영자에게 "옵션명 매핑 확인 필요"를 알린다.
      linkedDeals: linkedDealIds.length,
      unmatchedDeals: salesPushOutcome.unmatchedDealIds.length,
      unmatchedDealIds: salesPushOutcome.unmatchedDealIds,
      salesCampaigns: salesCampaigns.map((salesCampaign) => ({
        id: salesCampaign.id,
        campaignName: salesCampaign.campaignName,
        quantity: salesCampaign.quantity,
        actualSales: Number(salesCampaign.actualSales ?? 0),
        campaignDeals: salesCampaign.campaignDeals.map((deal) => ({
          id: deal.id,
          quantity: deal.quantity,
          actualSales: Number(deal.actualSales ?? 0),
          sellingPrice: deal.sellingPrice == null ? null : Number(deal.sellingPrice),
        })),
      })),
    });
  } catch (error) {
    console.error('Push sales stats failed:', error);
    return NextResponse.json({ error: '판매관리 푸시에 실패했습니다.' }, { status: 500 });
  }
}
