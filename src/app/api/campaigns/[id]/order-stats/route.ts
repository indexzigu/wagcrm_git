import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/campaigns/[id]/order-stats — 성과 카드(R6)의 객단가 정합용 읽기 전용 스탯.
 *
 * 배경: 관리자 CampaignRow의 quantity 필드는 실제로 "합산 수량"(Σ campaignDeal.quantity)이고
 *       itemCount는 "딜 개수"라, 성과 카드가 진짜 "주문건수"를 갖지 못한다(메모리
 *       wagcrm-ordercount-field-stores-quantity). 진짜 주문건수(distinct)는 주문 인제스트가
 *       OrderCampaign 캐시에 적립한 cachedDistinctOrderCount에 있다. 객단가(=매출/주문건수)를
 *       올바르게 계산하려면 이 값이 필요하다.
 *
 * 이 라우트는 SalesCampaign→OrderCampaign 캐시만 읽어 반환한다(신규 집계·쓰기 없음).
 * 미연결/미채움이면 전부 null → 카드가 객단가를 "—"로 폴백.
 */
export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: campaignId } = await context.params;
  const prisma = getPrisma();

  try {
    const campaign = await prisma.salesCampaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        orderCampaign: {
          select: {
            cachedDistinctOrderCount: true,
            cachedTotalOrders: true,
            cachedTotalQuantity: true,
            cachedTotalRevenue: true,
          },
        },
      },
    });
    if (!campaign) {
      return NextResponse.json({ error: "캠페인을 찾을 수 없습니다." }, { status: 404 });
    }

    const oc = campaign.orderCampaign;
    // 진짜 주문건수(distinct). 이 캐시는 "마감(close) 시점"에만 채워지므로 진행 중(active)
    // 캠페인은 0(@default)이다 — 그때의 SSOT는 order-converter board의 라이브 집계지만, 그
    // 무거운 주문 매칭 로직을 여기서 재현하지 않는다(P0: 주문건수 임의 추정 금지). 따라서
    // "양의 신호가 있을 때만" 반환하고(0/미채움 → null), 카드는 null이면 객단가를 "—"로 둔다.
    const distinctOrderCount =
      oc?.cachedDistinctOrderCount || oc?.cachedTotalOrders || null;

    return NextResponse.json({
      distinctOrderCount,
      totalQuantity: oc?.cachedTotalQuantity || null,
      totalRevenue: oc?.cachedTotalRevenue || null,
    });
  } catch (error) {
    // P0: 실패를 삼키지 않는다.
    console.error("[/api/campaigns/[id]/order-stats] failed:", error);
    return NextResponse.json(
      { error: "주문 통계를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
