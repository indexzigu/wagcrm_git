import { prisma } from './prisma';
import { apiRequest } from './naver-commerce-client';
import { fetchAllProductOrderPages, PRODUCT_ORDER_RANGE_TYPE_PAYED } from './product-order-paging';
import { orderMatchesCampaignProductId } from './campaign-match';

/**
 * 수동 첨부 발송의 "캠페인 대조" 전용 — 이 캠페인에 귀속되는 네이버 상품주문번호 집합을
 * 라이브로 재조회한다. execute 라우트의 fetch+필터와 동일한 귀속 규칙을 쓰되,
 * 발주확인(confirm) API·엑셀 생성·스냅샷 쓰기는 하지 않는 순수 읽기 경로다
 * (검증이 부작용을 일으키면 안 되므로 — 소유자 결정 2026-07-10).
 *
 * 주의: execute/route.ts와 달리 poRequested(기발송) 필터를 적용하지 않는다.
 * 수동 첨부 파일은 이미 발송한 건을 포함할 수 있으므로, 대조 기준 집합은
 * 캠페인의 "전체 유효 주문(PAYED/PRODUCT_ORDERED)"이어야 오탐(외부 주문)이 없다.
 */

export interface CampaignOrderResolution {
  /** 이 캠페인에 귀속되는 상품주문번호 전체 집합 */
  orderIds: Set<string>;
  count: number;
}

const normalize = (str: string) => (str || '').replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();

type CampaignForMatch = {
  id: string;
  name: string;
  productId: string | null;
  mappings: { productName: string; optionName: string }[];
};

/** execute/route.ts(운영 자동 경로)와 동일한 캠페인 귀속 판정 — 대조 일관성 보장. */
function orderMatchesCampaign(
  order: any,
  campaign: CampaignForMatch,
  activeCampaigns: { id: string; name: string }[],
): boolean {
  const pName = order.productName || '';
  const oName = order.productOption || '';
  const normPName = normalize(pName);
  const normOName = normalize(oName);

  const matchedMapping = campaign.mappings.find((m) => {
    const hasProduct = !!m.productName;
    const hasOption = !!m.optionName;
    if (!hasProduct && !hasOption) return false;

    let productMatches = false;
    if (hasProduct) {
      const normMProd = normalize(m.productName);
      if (normMProd.length > 0) {
        productMatches =
          (normPName.length > 0 && (normPName.includes(normMProd) || normMProd.includes(normPName))) ||
          (normOName.length > 0 && (normOName.includes(normMProd) || normMProd.includes(normOName)));
      }
    }

    let optionMatches = false;
    if (hasOption) {
      const normMOpt = normalize(m.optionName);
      if (normMOpt.length > 0) {
        optionMatches =
          (normOName.length > 0 && (normOName.includes(normMOpt) || normMOpt.includes(normOName))) ||
          (normPName.length > 0 && (normPName.includes(normMOpt) || normMOpt.includes(normPName)));
      }
    }

    if (hasOption && optionMatches) return true;
    if (hasProduct && !hasOption && productMatches) return true;
    return productMatches || optionMatches;
  });

  let matchesCampName = false;
  if (campaign.productId && (order.productId != null || order.originalProductId != null)) {
    if (orderMatchesCampaignProductId(order, campaign.productId)) {
      if (pName.includes(campaign.name) || campaign.name.includes(pName)) matchesCampName = true;
    }
  } else if (pName.includes(campaign.name) || campaign.name.includes(pName)) {
    matchesCampName = true;
  }

  if (matchesCampName) return true;

  if (matchedMapping) {
    const belongsToOther = activeCampaigns.some(
      (otherCamp) => otherCamp.id !== campaign.id && (pName.includes(otherCamp.name) || otherCamp.name.includes(pName)),
    );
    if (!belongsToOther) return true;
  }

  return false;
}

export async function resolveCampaignExpectedOrderIds(campaignId: string): Promise<CampaignOrderResolution> {
  const campaign = await prisma.orderCampaign.findUnique({
    where: { id: campaignId },
    include: { mappings: true },
  });
  if (!campaign) throw new Error('캠페인을 찾을 수 없습니다.');
  if (!campaign.template) throw new Error('캠페인에 지정된 베이스 템플릿이 없습니다.');

  const activeCampaigns = await prisma.orderCampaign.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  });

  // 조회 기간: 캠페인 시작일부터 현재까지 (execute/route.ts와 동일 규칙)
  const now = new Date();
  let earliestStart = now.getTime() - 14 * 24 * 60 * 60 * 1000;
  if (campaign.startDate) {
    earliestStart = new Date(campaign.startDate).getTime();
  } else if (campaign.salePeriod && campaign.salePeriod !== '기간 미정' && campaign.salePeriod !== '미등록') {
    const parts = campaign.salePeriod.split('~').map((s) => s.trim());
    if (parts.length >= 1 && parts[0]) {
      const parsedStart = new Date(parts[0].replace(/\./g, '-')).getTime();
      if (!isNaN(parsedStart)) earliestStart = parsedStart;
    }
  }

  const detailsData: any[] = [];
  const chunkMs = 23.9 * 60 * 60 * 1000; // 24시간 이내 분할
  let currentFrom = new Date(earliestStart);
  while (currentFrom < now) {
    let currentTo = new Date(currentFrom.getTime() + chunkMs);
    if (currentTo > now) currentTo = now;

    // 페이징은 product-order-paging SSOT 에 위임한다 — 종전엔 page 를 안 보내 창당 300건
    // 초과분이 조용히 유실됐다(공식 Discussion #2476 으로 page 파라미터 실존 확정).
    let fetched = false;
    let lastErr: any = null;
    try {
      const paged = await fetchAllProductOrderPages(
        { fromIso: currentFrom.toISOString(), toIso: currentTo.toISOString() },
        {
          apiRequest: (m, path, body, q) => apiRequest(m, path, body, q),
          // **결제일 기준 명시**(2단계 = 스냅샷 경로, 오너 결정 2026-07-30). 이 경로는 수동
          // 첨부 발송의 **대조 기준 집합**을 만든다 — execute 라우트(발주서 경로, 1단계에서
          // 이미 명시)와 같은 술어여야 "발주서엔 있는데 대조엔 없는" 오탐이 생기지 않는다.
          rangeType: PRODUCT_ORDER_RANGE_TYPE_PAYED,
        },
      );
      detailsData.push(
        ...paged.contents
          .map((wrapper: any) => {
            if (!wrapper?.content?.productOrder) return null;
            return { productOrder: wrapper.content.productOrder, order: wrapper.content.order };
          })
          .filter(Boolean),
      );
      fetched = true;
    } catch (apiErr: any) {
      lastErr = apiErr;
    }
    // 청크 실패를 삼키면 그 기간 주문이 대조 기준에서 통째로 빠져 오탐(외부 주문)이 발생한다 → 중단.
    if (!fetched) {
      throw new Error(`주문 조회 실패: ${lastErr?.message || '네이버 API 오류'}. 대조 기준을 확정할 수 없어 중단했습니다.`);
    }

    currentFrom = new Date(currentTo.getTime() + 1000);
    await new Promise((r) => setTimeout(r, 300)); // Rate limit 방지
  }

  const campaignForMatch: CampaignForMatch = {
    id: campaign.id,
    name: campaign.name,
    productId: campaign.productId,
    mappings: campaign.mappings.map((m) => ({ productName: m.productName, optionName: m.optionName })),
  };

  const orderIds = new Set<string>();
  const campaignProductIds = new Set<string>();
  const deferredAddons: any[] = [];

  detailsData.forEach((wrapper) => {
    const order = wrapper.productOrder;
    if (!order) return;
    if (order.productOrderStatus !== 'PAYED' && order.productOrderStatus !== 'PRODUCT_ORDERED') return;

    // 추가구성상품은 2차 귀속(동일 productId 메인 매칭 시 포함)으로 미룬다.
    if (order.productClass === '추가구성상품') {
      deferredAddons.push(wrapper);
      return;
    }

    if (orderMatchesCampaign(order, campaignForMatch, activeCampaigns)) {
      if (order.productId) campaignProductIds.add(String(order.productId));
      if (order.productOrderId) orderIds.add(String(order.productOrderId));
    }
  });

  deferredAddons.forEach((wrapper) => {
    const order = wrapper.productOrder;
    if (!order?.productId || !campaignProductIds.has(String(order.productId))) return;
    if (order.productOrderId) orderIds.add(String(order.productOrderId));
  });

  return { orderIds, count: orderIds.size };
}
