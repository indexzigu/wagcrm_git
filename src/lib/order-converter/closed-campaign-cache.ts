import { INVALID_ORDER_STATUSES, resolveOrderCountKey } from './group-orders';
import { resolveSalesReportOptionLabel } from './sales-report-options';
import { deriveOrderPipelineBucket } from './order-fulfillment';
import { orderMatchesCampaignProductId, orderBelongsToPeerCampaign, type PeerCampaignWindow } from './campaign-match';
import { createInsightAccumulator, trackOrderInsight, trackClaimInsight, buildCampaignInsights } from './campaign-insights';
import { pickBestMapping } from './mapping-match';
import { resolveSaleWindowStartMs, resolveSaleWindowEndMs } from './sale-window';
import { fetchAllProductOrderPages, PRODUCT_ORDER_RANGE_TYPE_PAYED } from './product-order-paging';
import {
  INTRADAY_BUCKETS_PER_DAY,
  INTRADAY_BUCKET_MINUTES,
  SNAPSHOT_INTRADAY_BUCKET_VERSION,
  resolveIntradayBucketIndex,
  type ComposedIntraday,
  type IntradayBucketEntry,
} from './daily-aggregate';

/**
 * 마감(비활성) 캠페인의 통계 캐시 계산 — 마감 처리 라우트(campaigns/[id] PATCH)와
 * 백필 스크립트(scripts/recalc-closed-campaign-cache.ts)가 공유하는 단일 구현(SSOT).
 *
 * 이 로직이 두 곳에 복제돼 있으면 유효주문 정의(INVALID_ORDER_STATUSES)나 매칭 규칙이
 * 어긋나 캐시가 라이브 집계와 달라진다. 순수 함수라 주문 배열만 주면 재현·유닛테스트 가능하다.
 */

export interface ClosedCampaignCacheResult {
  cachedNewOrderBeforeCount: number;
  cachedNewOrderAfterCount: number;
  cachedPendingCount: number;
  cachedShippingCount: number;
  cachedCompletedCount: number;
  cachedTotalOrders: number;
  cachedDistinctOrderCount: number;
  cachedProductOrderIds: string[];
  cachedTotalQuantity: number;
  cachedTotalRevenue: number;
  cachedDailyStats: string; // JSON.stringify(dailyStats)
  cachedInsights: string; // JSON.stringify(buildCampaignInsights(...)) — 마감 시 동결한 인사이트 스냅샷
  cachedIntradayBuckets: string; // JSON.stringify(FrozenIntradayBuckets) — 마감 시 동결한 10분 버킷
}

/**
 * 마감 시 동결하는 10분 인트라데이 버킷.
 *
 * **왜 동결인가:** 마감 캠페인의 읽기 경로(getCachedSalesDetail)는 스냅샷 집계
 * (`NaverOrderSnapshot.dailyAggregate.bv`)를 아예 타지 않는다 — live 경로 전용이다. 그래서
 * 읽기 시점 합성이 구조적으로 불가능하고, 네이버 조회창이 지나면 원천도 사라진다.
 * `cachedInsights` 와 정확히 같은 부류라 같은 처방(마감 시 1회 계산 후 영속)을 쓴다.
 * 비용은 0이다 — 마감 라우트가 이미 손에 든 `recentOrders` 를 **같은 분기 안에서** 한 번 더
 * 셀 뿐이라 추가 네이버 호출·egress 가 없다.
 *
 * ⛔ **"마감 캠페인을 모바일 귀속 우주에 넣어 live 경로로 태운다"는 해법을 쓰지 말 것**
 * (P7 「Mobile Sales Read = Aggregate Column Only」) — 귀속 우주는 `orderCampaign.isActive`
 * 게이트를 데스크톱과 공유하므로, 마감 캠페인을 넣으면 상품명이 겹치는 라인이 모바일에서만
 * 배제돼 과소집계된다. 마감 라우트는 네이버 원본 주문을 자기 창으로 직접 거르므로 그 우주를
 * 건드리지 않는다 — 이 설계를 택한 이유가 그것이다.
 *
 * **날짜별로 분해하는 이유:** 차트가 dateKey 단위로 「기록 없음」을 판정한다. 평평한 점 열로
 * 저장하면 "그 날 주문이 0이었다"와 "그 날 버킷이 안 채워졌다"를 사후에 구분할 수 없다.
 *
 * 버전 축은 `bv` 하나다 — 버킷 **형태**(`[건수, 매출]` × 번호)가 스냅샷 집계와 동일하므로
 * `SNAPSHOT_INTRADAY_BUCKET_VERSION` 을 그대로 쓴다. 두 경로가 서로 다른 버전을 들면 같은
 * 캠페인이 해상도에 따라 다른 그림이 되는 것을 사후에 진단할 수 없게 된다.
 */
export type FrozenIntradayBuckets = {
  bv: typeof SNAPSHOT_INTRADAY_BUCKET_VERSION;
  /** dateKey(YYYY-MM-DD KST) → 버킷번호(문자열) → [주문건수, 매출]. 희소(빈 칸 생략). */
  days: Record<string, Record<string, IntradayBucketEntry>>;
};

const INTRADAY_BUCKET_MS = INTRADAY_BUCKET_MINUTES * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * dateKey(YYYY-MM-DD KST) → 그 날 KST 자정의 UTC epoch ms.
 * daily-aggregate 의 동명 내부 헬퍼와 같은 산식이다(그쪽은 비공개라 여기서 재선언한다) —
 * 두 경로의 점 시각이 어긋나면 같은 캠페인이 해상도에 따라 다른 시간대에 봉우리를 그린다.
 */
function kstDayStartMs(dateKey: string): number | null {
  const parsed = Date.parse(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : parsed - KST_OFFSET_MS;
}

type DailyBucket = {
  orderKeys: Set<string>; quantity: number; revenue: number;
  newOrderBefore: number; newOrderAfter: number; pending: number; shipping: number; completed: number;
  options: Record<string, { price: number; orderKeys: Set<string>; quantity: number; revenue: number }>;
  /** 버킷번호 → 그 칸의 distinct 주문키·매출. 직렬화 시 [건수, 매출]로 접는다. */
  buckets: Map<number, { orderKeys: Set<string>; revenue: number }>;
};

/** 빈 일별 버킷 — 본 패스와 추가구성상품 2차 패스가 공유(형태가 갈리면 버킷만 빠진다). */
function newDailyBucket(): DailyBucket {
  return {
    orderKeys: new Set<string>(), quantity: 0, revenue: 0,
    newOrderBefore: 0, newOrderAfter: 0, pending: 0, shipping: 0, completed: 0,
    options: {},
    buckets: new Map(),
  };
}

/**
 * 유효주문 1건을 그 날의 10분 칸에 얹는다 — 본 패스·추가구성상품 패스 공용.
 * 버킷 인덱스는 반드시 `resolveIntradayBucketIndex`(daily-aggregate SSOT)로 구한다:
 * 직접 계산하면 live 경로와 버킷 경계가 갈려 같은 캠페인이 두 해상도에서 다른 그림이 된다.
 */
function trackIntradayBucket(day: DailyBucket, order: any, orderKey: string, revenue: number): void {
  const index = resolveIntradayBucketIndex(order);
  if (index === null) return;
  let slot = day.buckets.get(index);
  if (!slot) {
    slot = { orderKeys: new Set<string>(), revenue: 0 };
    day.buckets.set(index, slot);
  }
  if (orderKey) slot.orderKeys.add(orderKey);
  slot.revenue += revenue;
}

/**
 * 마감 캠페인의 판매기간(집계 window)을 도출한다 — 컷오프 해석은 sale-window SSOT에 위임해
 * 라이브 집계(campaigns-handler)와 정확히 같은 규칙을 쓴다. 종료는 KST 그 날 끝까지 포함하고,
 * 스토어 API 정밀 종료시각은 존중한다(과거 여기선 종료를 'T23:59:59Z'=UTC로 파싱해 KST 다음날
 * 오전까지 새어 라이브와 어긋났다 — 마감 시 동결되는 매출/수량이 라이브와 달라지던 위험 제거).
 * 백필 스크립트·admin 라우트가 공유해 기간 해석이 어긋나지 않게 한다.
 */
export function resolveClosedCampaignPeriod(camp: {
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  salePeriod?: string | null;
}): { start: Date | null; end: Date | null } {
  const startMs = resolveSaleWindowStartMs(camp);
  const endMs = resolveSaleWindowEndMs(camp);
  return {
    start: startMs === null ? null : new Date(startMs),
    end: endMs === null ? null : new Date(endMs),
  };
}

/**
 * 마감 캠페인 통계 캐시를 계산한다(쓰기 없음 — 결과 객체만 반환).
 * 주문 매칭·유효 판정·추가구성상품 2차 패스·파이프라인 버킷 규칙은 마감 라우트 기존 구현과 동일하다.
 *
 * peerCampaigns: 교차 귀속 가드용 다른 캠페인 목록. 라이브 핸들러(campaigns-handler)의
 * `belongsToOther` 와 같은 SSOT(`orderBelongsToPeerCampaign`)를 쓴다 — 매핑 폴백으로 주운
 * 주문이라도 **상품명이 다른 캠페인명을 포함하고 그 캠페인 창이 결제 시각을 담을 수 있으면**
 * 그쪽 것으로 넘긴다. 빈 배열이면 가드 없음(하위호환). 창은 각 peer 의 startDate/endDate/
 * salePeriod 에서 sale-window SSOT 로 파생하므로 호출부는 그 필드만 실어 보내면 된다.
 *
 * ⚠️ 라이브와 의도적으로 다른 점: 라이브는 peer 를 **활성 캠페인**으로만 잡는데(handler 는 활성만
 * 집계하므로 그걸로 충분), 마감 경로는 **활성·마감 무관 전 캠페인**을 넘겨야 한다. 마감 캠페인끼리
 * 충돌할 때 활성 목록만 보면 보호가 0이 되기 때문이다 — 매핑 집합이 같은 두 캠페인은 매핑만으로
 * 구별되지 않으므로, 스토어 상품이 하나뿐인 (날짜×옵션) 칸을 양쪽이 각자 전량 집계해 두 캐시의
 * 합이 원천 실재 수량을 초과하는 이중계상이 발생한다(2026-07-23 실데이터 대조로 확인).
 */
export function computeClosedCampaignCache(
  campaign: { id?: string | null; name: string; productId?: string | null; mappings: any[] },
  recentOrders: any[],
  poRequestedSet: Set<string>,
  window: { start: Date; end: Date | null },
  peerCampaigns: Array<{
    id?: string | null;
    name: string;
    startDate?: Date | string | null;
    endDate?: Date | string | null;
    salePeriod?: string | null;
  }> = [],
): ClosedCampaignCacheResult {
  // 자기 자신은 제외 — id 가 있으면 id 로, 없으면 이름으로 배제한다(핸들러의 otherCamp.id !== camp.id 대응).
  // 창은 라이브와 같은 sale-window SSOT 로 파생해 두 경로의 양보 판정이 어긋나지 않게 한다.
  const peers: PeerCampaignWindow[] = peerCampaigns
    .filter((p) => (campaign.id != null && p.id != null ? p.id !== campaign.id : p.name !== campaign.name))
    .map((p) => ({
      id: p.id,
      name: p.name,
      windowStartMs: resolveSaleWindowStartMs(p),
      windowEndMs: resolveSaleWindowEndMs(p),
    }));
  let newOrderBeforeCount = 0;
  let newOrderAfterCount = 0;
  let pendingCount = 0;
  let shippingCount = 0;
  let completedCount = 0;
  let totalOrders = 0;
  let totalQuantity = 0;
  let totalRevenue = 0;
  const dailyMap: Record<string, DailyBucket> = {};
  // 인사이트 스냅샷 누적기 — 라이브 핸들러(campaigns-handler)와 동일한 호출 지점·순서로 얹는다.
  // trackClaimInsight는 모든 캠페인 주문에 무조건(상태 판정 직후), trackOrderInsight는 유효주문 분기 안에서.
  const insightAcc = createInsightAccumulator();

  const campaignProductIds = new Set<string>();
  const deferredAddons: any[] = [];
  const validOrderKeys = new Set<string>();
  const matchedProductOrderIds = new Set<string>();

  const campStart = window.start.getTime();
  const campEnd = window.end ? new Date(window.end).getTime() : Number.MAX_SAFE_INTEGER;

  recentOrders.forEach((order) => {
    if (!order || !campaign.mappings) return;

    const orderTimeStr = order.paymentDate || order.orderDate || order.orderCreateDate;
    const orderTime = orderTimeStr ? new Date(orderTimeStr).getTime() : 0;
    if (orderTime > 0 && (orderTime < campStart || orderTime > campEnd)) return;

    if (order.productClass === '추가구성상품') {
      deferredAddons.push(order);
      return;
    }

    const pName = order.productName || '';
    const oName = order.productOption || order.productOptionName || '';

    // 매칭 판정은 mapping-match.ts SSOT(라이브 campaigns-handler와 공유) —
    // 마감 스냅샷이 라이브 집계와 같은 매칭 규칙을 쓰게 한다.
    const matchedMapping = pickBestMapping(campaign.mappings, pName, oName);

    let isCampaignOrder = false;
    let matchesCampName = false;

    if (campaign.productId && (order.productId != null || order.originalProductId != null)) {
      if (orderMatchesCampaignProductId(order, campaign.productId)) {
        if (pName.includes(campaign.name) || campaign.name.includes(pName)) {
          matchesCampName = true;
        }
      }
    } else {
      if (pName.includes(campaign.name) || campaign.name.includes(pName)) {
        matchesCampName = true;
      }
    }

    if (matchesCampName) {
      isCampaignOrder = true;
    } else if (matchedMapping) {
      // 매핑 룰에 맞더라도 상품명이 다른 캠페인을 가리키고 그 캠페인 창이 이 결제 시각을 담을 수
      // 있으면 그쪽 주문으로 간주(라이브 handler 와 같은 SSOT). 이름 매칭은 위에서 이미
      // short-circuit 됐으므로, 자기 이름이 박힌 주문은 이 가드에 걸리지 않는다.
      if (!orderBelongsToPeerCampaign(pName, orderTime, peers)) {
        isCampaignOrder = true;
      }
    }

    if (isCampaignOrder) {
      if (order.productId) campaignProductIds.add(String(order.productId));
      if (order.productOrderId) matchedProductOrderIds.add(String(order.productOrderId).trim());
      const effectiveMapping = matchedMapping || { productName: campaign.name, optionName: '', price: 0 };
      const status = order.productOrderStatus;

      let dateStr = '';
      if (orderTimeStr) {
        const d = new Date(orderTimeStr);
        const dKst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
        const yyyy = dKst.getUTCFullYear();
        const mm = String(dKst.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(dKst.getUTCDate()).padStart(2, '0');
        dateStr = `${yyyy}-${mm}-${dd}`;
      }

      // 인사이트: 클레임(취소/반품/교환)은 유효 집계에서 제외되므로 별도 카운트(결제 단위 dedup).
      trackClaimInsight(insightAcc, resolveOrderCountKey(order), status);

      if (!INVALID_ORDER_STATUSES.includes(status)) {
        totalOrders++;
        const _ok = resolveOrderCountKey(order);
        if (_ok) validOrderKeys.add(_ok);
        const qty = Number(order.quantity) || 1;
        totalQuantity += qty;
        const naverDiscount = Math.max(0, (order.productDiscountAmount || 0) - (order.sellerBurdenDiscountAmount || 0));
        const baseAmount = order.totalPaymentAmount + naverDiscount;
        const paymentAmount = baseAmount || ((effectiveMapping.price || 0) * qty);
        totalRevenue += paymentAmount;
        trackOrderInsight(insightAcc, order, qty, paymentAmount, orderTimeStr, _ok);

        if (dateStr) {
          if (!dailyMap[dateStr]) dailyMap[dateStr] = newDailyBucket();
          if (_ok) dailyMap[dateStr].orderKeys.add(_ok);
          dailyMap[dateStr].quantity += qty;
          dailyMap[dateStr].revenue += paymentAmount;
          // 인트라데이 — 일별과 **같은 분기 안**이라 유효주문 판정·교차 귀속 가드를 그대로 물려받는다.
          // 별도 루프를 새로 돌면 다른 셀러 회차의 주문이 버킷에 샌다(P7 Same-Link Campaign Handover).
          trackIntradayBucket(dailyMap[dateStr], order, _ok, paymentAmount);

          const optionKey = resolveSalesReportOptionLabel(pName, oName);
          const optionUnitPrice = effectiveMapping.price || (qty > 0 ? Math.round(paymentAmount / qty) : 0);
          if (!dailyMap[dateStr].options[optionKey]) {
            dailyMap[dateStr].options[optionKey] = { price: optionUnitPrice, orderKeys: new Set<string>(), quantity: 0, revenue: 0 };
          } else if (!dailyMap[dateStr].options[optionKey].price && optionUnitPrice) {
            dailyMap[dateStr].options[optionKey].price = optionUnitPrice;
          }
          if (_ok) dailyMap[dateStr].options[optionKey].orderKeys.add(_ok);
          dailyMap[dateStr].options[optionKey].quantity += qty;
          dailyMap[dateStr].options[optionKey].revenue += paymentAmount;
        }
      }

      const bucket = deriveOrderPipelineBucket(status, order.placeOrderStatus, poRequestedSet.has(String(order.productOrderId || '')));
      if (bucket === 'newBefore') {
        newOrderBeforeCount++;
        if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].newOrderBefore++;
      } else if (bucket === 'newAfter') {
        newOrderAfterCount++;
        if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].newOrderAfter++;
      } else if (bucket === 'pending') {
        pendingCount++;
        if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].pending++;
      } else if (bucket === 'shipping') {
        shippingCount++;
        if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].shipping++;
      } else if (bucket === 'completed') {
        completedCount++;
        if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].completed++;
      }
    }
  });

  // 2차 패스: 추가구성상품을 동일 productId 메인 품목이 귀속된 캠페인에 합산(가산만, 기존 수치 무회귀)
  deferredAddons.forEach((order: any) => {
    if (!order.productId || !campaignProductIds.has(String(order.productId))) return;
    if (order.productOrderId) matchedProductOrderIds.add(String(order.productOrderId).trim());

    const status = order.productOrderStatus;
    const pName = order.productName || '';
    const oName = order.productOption || order.productOptionName || '';
    const orderTimeStr = order.paymentDate || order.orderDate || order.orderCreateDate;
    let dateStr = '';
    if (orderTimeStr) {
      const d = new Date(orderTimeStr);
      const dKst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      dateStr = `${dKst.getUTCFullYear()}-${String(dKst.getUTCMonth() + 1).padStart(2, '0')}-${String(dKst.getUTCDate()).padStart(2, '0')}`;
    }

    // 인사이트: 추가구성상품도 메인 품목과 동일 기준으로 클레임 카운트(결제 단위 dedup).
    trackClaimInsight(insightAcc, resolveOrderCountKey(order), status);

    if (!INVALID_ORDER_STATUSES.includes(status)) {
      totalOrders++;
      const _ok = resolveOrderCountKey(order);
      if (_ok) validOrderKeys.add(_ok);
      const qty = Number(order.quantity) || 1;
      totalQuantity += qty;
      const naverDiscount = Math.max(0, (order.productDiscountAmount || 0) - (order.sellerBurdenDiscountAmount || 0));
      const baseAmount = order.totalPaymentAmount + naverDiscount;
      const paymentAmount = baseAmount || 0;
      totalRevenue += paymentAmount;
      trackOrderInsight(insightAcc, order, qty, paymentAmount, orderTimeStr, _ok);

      if (dateStr) {
        if (!dailyMap[dateStr]) dailyMap[dateStr] = newDailyBucket();
        if (_ok) dailyMap[dateStr].orderKeys.add(_ok);
        dailyMap[dateStr].quantity += qty;
        dailyMap[dateStr].revenue += paymentAmount;
        // 추가구성상품도 메인 품목과 동일 기준(일별에 합산되므로 버킷 합도 일별과 맞아야 한다).
        trackIntradayBucket(dailyMap[dateStr], order, _ok, paymentAmount);

        const optionKey = resolveSalesReportOptionLabel(pName, oName);
        const optionUnitPrice = qty > 0 ? Math.round(paymentAmount / qty) : 0;
        if (!dailyMap[dateStr].options[optionKey]) {
          dailyMap[dateStr].options[optionKey] = { price: optionUnitPrice, orderKeys: new Set<string>(), quantity: 0, revenue: 0 };
        } else if (!dailyMap[dateStr].options[optionKey].price && optionUnitPrice) {
          dailyMap[dateStr].options[optionKey].price = optionUnitPrice;
        }
        if (_ok) dailyMap[dateStr].options[optionKey].orderKeys.add(_ok);
        dailyMap[dateStr].options[optionKey].quantity += qty;
        dailyMap[dateStr].options[optionKey].revenue += paymentAmount;
      }
    }

    const bucket = deriveOrderPipelineBucket(status, order.placeOrderStatus, poRequestedSet.has(String(order.productOrderId || '')));
    if (bucket === 'newBefore') {
      newOrderBeforeCount++;
      if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].newOrderBefore++;
    } else if (bucket === 'newAfter') {
      newOrderAfterCount++;
      if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].newOrderAfter++;
    } else if (bucket === 'pending') {
      pendingCount++;
      if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].pending++;
    } else if (bucket === 'shipping') {
      shippingCount++;
      if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].shipping++;
    } else if (bucket === 'completed') {
      completedCount++;
      if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].completed++;
    }
  });

  const dailyStats = Object.keys(dailyMap)
    .sort((a, b) => b.localeCompare(a))
    .map((date) => {
      const dateData = dailyMap[date];
      const options = Object.entries(dateData.options).map(([name, option]) => ({
        name,
        price: option.price,
        orders: option.orderKeys.size,
        quantity: option.quantity,
        revenue: option.revenue,
        ratio: dateData.quantity > 0 ? (option.quantity / dateData.quantity) * 100 : 0,
      }));
      return {
        date,
        orders: dateData.orderKeys.size,
        quantity: dateData.quantity,
        revenue: dateData.revenue,
        newOrderBefore: dateData.newOrderBefore,
        newOrderAfter: dateData.newOrderAfter,
        pending: dateData.pending,
        shipping: dateData.shipping,
        completed: dateData.completed,
        options,
      };
    });

  // 인트라데이 동결 — 일별과 같은 dailyMap 에서 나오므로 "일별에 있는 날짜 = 버킷이 있는 날짜"가
  // 구조적으로 보장된다(시각이 없어 dateStr 이 빈 주문은 일별에도 안 들어간다).
  const frozenIntraday: FrozenIntradayBuckets = {
    bv: SNAPSHOT_INTRADAY_BUCKET_VERSION,
    days: Object.fromEntries(
      Object.keys(dailyMap)
        .sort()
        .map((date) => [date, serializeBuckets(dailyMap[date].buckets)] as const)
        .filter(([, buckets]) => Object.keys(buckets).length > 0),
    ),
  };

  return {
    cachedNewOrderBeforeCount: newOrderBeforeCount,
    cachedNewOrderAfterCount: newOrderAfterCount,
    cachedPendingCount: pendingCount,
    cachedShippingCount: shippingCount,
    cachedCompletedCount: completedCount,
    cachedTotalOrders: totalOrders,
    cachedDistinctOrderCount: validOrderKeys.size,
    cachedProductOrderIds: Array.from(matchedProductOrderIds),
    cachedTotalQuantity: totalQuantity,
    cachedTotalRevenue: totalRevenue,
    cachedDailyStats: JSON.stringify(dailyStats),
    // 인사이트 비율 분모는 결제 distinct 기준(validOrderKeys.size) — 라이브 핸들러와 동일.
    cachedInsights: JSON.stringify(buildCampaignInsights(insightAcc, validOrderKeys.size)),
    cachedIntradayBuckets: JSON.stringify(frozenIntraday),
  };
}

/** 버킷 맵 → 희소 직렬화(번호 오름차순). 빈 칸은 넣지 않는다 — daily-aggregate 와 동일 규약. */
function serializeBuckets(
  buckets: Map<number, { orderKeys: Set<string>; revenue: number }>,
): Record<string, IntradayBucketEntry> {
  const out: Record<string, IntradayBucketEntry> = {};
  for (const index of [...buckets.keys()].sort((a, b) => a - b)) {
    const slot = buckets.get(index)!;
    out[String(index)] = [slot.orderKeys.size, slot.revenue];
  }
  return out;
}

/**
 * DB 값(Postgres Json 객체 | sqlite 문자열 | null) → 동결 버킷. 형식 방어적 —
 * 실패·버전 불일치는 null 이고, 호출부는 그걸 **"인트라데이 없음"으로 degrade** 시킨다
 * (블롭 폴백 같은 비싼 복구 경로가 없다 — 마감 캠페인의 원천은 이미 사라졌다).
 */
export function parseFrozenIntradayBuckets(raw: unknown): FrozenIntradayBuckets | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as { bv?: unknown; days?: unknown };
  if (candidate.bv !== SNAPSHOT_INTRADAY_BUCKET_VERSION) return null;
  if (!candidate.days || typeof candidate.days !== 'object') return null;
  return candidate as FrozenIntradayBuckets;
}

/**
 * 동결 버킷(여러 발주 캠페인 = 그룹) → 인트라데이 점 열. 형태 계약은 live 경로의
 * `composeIntradayFromAggregates` 와 **동형**이다 — 타임라인 라우트와 차트가 그 형태를
 * 그대로 소비하므로 갈라지면 화면이 두 갈래로 나뉜다.
 *
 * `dailyDateKeys` 는 그 캠페인들의 일별(cachedDailyStats)에 실제로 존재하는 날짜다.
 * 버킷이 없는 날짜를 `daysWithoutBuckets` 로 정직하게 고지하기 위해 필요하다 —
 * "주문이 0인 날"과 "동결 이전에 마감돼 버킷이 없는 날"을 삼키지 않는다(P0).
 */
export function composeIntradayFromFrozen(
  frozen: FrozenIntradayBuckets[],
  dailyDateKeys: Iterable<string>,
): ComposedIntraday {
  const byStartMs = new Map<number, { orders: number; revenue: number }>();
  const covered = new Set<string>();

  for (const one of frozen) {
    for (const [dateKey, buckets] of Object.entries(one.days)) {
      const dayStart = kstDayStartMs(dateKey);
      if (dayStart === null || !buckets || typeof buckets !== 'object') continue;
      let sawBucket = false;
      for (const [rawIndex, entry] of Object.entries(buckets)) {
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0 || index >= INTRADAY_BUCKETS_PER_DAY) continue;
        if (!Array.isArray(entry)) continue;
        sawBucket = true;
        const startMs = dayStart + index * INTRADAY_BUCKET_MS;
        const slot = byStartMs.get(startMs) ?? { orders: 0, revenue: 0 };
        slot.orders += Number(entry[0]) || 0;
        slot.revenue += Number(entry[1]) || 0;
        byStartMs.set(startMs, slot);
      }
      if (sawBucket) covered.add(dateKey);
    }
  }

  const daysWithoutBuckets = [...new Set(dailyDateKeys)].filter((date) => !covered.has(date)).sort();

  const points = [...byStartMs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([startMs, slot]) => ({ startMs, orders: slot.orders, revenue: slot.revenue }));

  return { points, daysWithoutBuckets };
}

/**
 * 마감 캠페인 통계용 주문을 네이버 상품주문 API에서 [start ~ now] 구간을 24h 청크로 스크래핑한다.
 * apiRequest는 주입받아(라우트=서버 클라이언트, 스크립트=동일 클라이언트) 테스트/재사용을 쉽게 한다.
 */
export async function fetchClosedCampaignOrders(
  start: Date,
  apiRequest: (method: string, path: string, body: undefined, query: Record<string, string>) => Promise<any>,
  opts: { now?: Date; sleepMs?: number } = {},
): Promise<any[]> {
  const now = opts.now ?? new Date();
  const sleepMs = opts.sleepMs ?? 100;
  const chunkMs = 23.9 * 60 * 60 * 1000;
  let currentFrom = new Date(start);
  const recentOrders: any[] = [];
  let attempted = 0;
  let failed = 0;

  while (currentFrom < now) {
    let currentTo = new Date(currentFrom.getTime() + chunkMs);
    if (currentTo > now) currentTo = now;

    attempted++;
    try {
      // 페이징은 product-order-paging SSOT 에 위임 — 종전엔 page 미전송으로 창당 300건
      // 초과분이 유실됐고, 그 값이 마감 캠페인 매출·수량 캐시에 그대로 굳었다(P0).
      const paged = await fetchAllProductOrderPages(
        { fromIso: currentFrom.toISOString(), toIso: currentTo.toISOString() },
        {
          apiRequest: (m, path, body, q) => apiRequest(m, path, body, q),
          interPageDelayMs: sleepMs,
          // **결제일 기준 명시**(2단계 = 스냅샷 경로, 오너 결정 2026-07-30). 마감 캐시는 이
          // 조회 결과를 매출·수량으로 굳히므로 창의 술어가 매출 정의(결제 기준)와 같아야 한다.
          // 기본값이 이미 `PAYED_DATETIME` 임은 실측 확정 — 동작 변화 없이 전제를 계약으로 바꾼다.
          rangeType: PRODUCT_ORDER_RANGE_TYPE_PAYED,
        },
      );
      if (paged.contents.length > 0) {
        const flattened = paged.contents
          .map((wrapper: any) => {
            if (!wrapper.content?.productOrder) return null;
            return { ...(wrapper.content.order || {}), ...wrapper.content.productOrder };
          })
          .filter(Boolean);
        recentOrders.push(...flattened);
      }
    } catch (err: any) {
      failed++;
      console.warn(`[closed-campaign-cache] fetch error ${currentFrom.toISOString()}~${currentTo.toISOString()}:`, err?.message || err);
    }

    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
    currentFrom = new Date(currentTo.getTime() + 1000);
  }

  // 전체 청크가 실패했다면 "판매 0"이 아니라 인프라/크레덴셜 장애다. 빈 배열을 반환해 호출부가
  // 캐시를 0으로 덮어쓰는 참사를 막기 위해 throw한다(마감 라우트·백필 스크립트 양쪽 보호).
  if (attempted > 0 && failed === attempted) {
    throw new Error(`네이버 주문 조회 전체 실패(${failed}/${attempted} 청크): 크레덴셜/네트워크 확인 필요. 캐시를 갱신하지 않는다.`);
  }

  return recentOrders;
}
