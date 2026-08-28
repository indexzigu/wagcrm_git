import { getPrisma } from "@/lib/prisma";
import { INVALID_ORDER_STATUSES, resolveOrderCountKey } from "@/lib/order-converter/group-orders";
import { deriveOrderPipelineBucket } from "@/lib/order-converter/order-fulfillment";
import { orderFulfillmentRepository } from "@/repositories/orderFulfillmentRepository";
import {
  attributeOrders,
  resolveOrderDateKey,
  resolveOrderRevenue,
  type PulseOrderLike,
  type PulseSalesCampaignSource,
  type PulseTotals,
} from "@/lib/mobile-pulse-data";
import {
  aggregateCoversCampaigns,
  applyPoRequestedSplit,
  composeIntradayFromAggregates,
  composeSalesDetailFromAggregates,
  loadWindowAggregates,
  parseSnapshotDailyAggregate,
  resolveLiveWindowKeys,
  UNDATED_DAY_KEY,
} from "@/lib/order-converter/daily-aggregate";
import type {
  CampaignClaims,
  CampaignDailyPoint,
  CampaignItemSales,
  CampaignSalesDetail,
  CampaignStatusBreakdown,
  ComposedIntraday,
} from "@/lib/order-converter/daily-aggregate";
import {
  composeIntradayFromFrozen,
  parseFrozenIntradayBuckets,
  type FrozenIntradayBuckets,
} from "@/lib/order-converter/closed-campaign-cache";

/**
 * 모바일 캠페인 상세 시트의 "매출상세현황" 데이터 (요청: 판매 진행중 캠페인의 매출 상세).
 *
 * 절대 게이트: 펄스와 동일하게 네이버 동기화를 트리거하지 않는다 — 진행중 캠페인은
 * 영속화된 NaverOrderSnapshot 만 읽고, 마감 캠페인은 OrderCampaign.cached* 컬럼만 읽는다.
 * 매칭·귀속 규칙은 mobile-pulse-data 의 attributeOrders 를 공유(단일 출처)한다.
 *
 * live 경로 데이터 소스(2026-07-15 egress 절감): 스냅샷의 사전 집계 컬럼
 * (NaverOrderSnapshot.dailyAggregate)만 select 한다 — orders 블롭(조회 1회당
 * 1.5~5.2MB 실측)은 집계가 없는 행에서만 폴백으로 읽는다(loadWindowAggregates).
 */

// 응답 형태 타입의 정의는 daily-aggregate.ts(쓰기·읽기 공용 SSOT)로 이동했다.
// 기존 소비자의 import 경로(@/lib/mobile-campaign-sales)를 보존하기 위해 여기서 re-export 한다.
export type {
  CampaignClaims,
  CampaignDailyPoint,
  CampaignItemSales,
  CampaignSalesDetail,
  CampaignStatusBreakdown,
};

export type MobileCampaignSalesResponse = {
  campaignId: string;
  /** live=활성 발주 캠페인 스냅샷, cached=마감 발주 캠페인 캐시, none=네이버 미연동 */
  source: "live" | "cached" | "none";
  /** 데이터 신선도(live=최신 스냅샷 lastCallTime, cached/none=null) */
  asOf: string | null;
  cumulative: PulseTotals;
  today: PulseTotals;
  statusBreakdown: CampaignStatusBreakdown;
  /** cached 모드는 클레임 미집계 → null(0건과 구분) */
  claims: CampaignClaims | null;
  daily: CampaignDailyPoint[];
  /** 품목별 매출(매출 내림차순). cached/none 모드는 빈 배열 */
  items: CampaignItemSales[];
  /**
   * 10분 인트라데이 분해 — **요청한 호출부에만** 실린다(`includeIntraday`).
   * 기본이 off 인 이유는 페이로드다: 30일 창이면 점이 수천 개까지 갈 수 있어
   * 이걸 안 쓰는 모바일 상세 시트에까지 태우면 그냥 낭비다.
   *
   * live 경로는 스냅샷 집계(dailyAggregate.bv)에서, cached(마감) 경로는 마감 시 동결한
   * `OrderCampaign.cachedIntradayBuckets` 에서 나온다 — 형태는 동형이다. 동결 이전에
   * 마감된 과거 캠페인은 컬럼이 null 이라 `null`(= 인트라데이 없음, 일별 해상도로 degrade).
   */
  intraday?: ComposedIntraday | null;
  /**
   * 이 응답이 **실제로 조회한 창**. 화면이 "주문 0건"과 "조회한 적 없음"을 구분하기 위한
   * 것이다(오너 원칙 2026-08-03). live 경로에만 실린다 — cached 는 마감 시 동결한 전 기간
   * 스냅샷이라 구조적으로 결손이 없다.
   * `truncated=true` 면 `startDate` 이전 구간을 못 읽은 것이므로 0으로 그리면 안 된다.
   */
  coverage?: { startDate: string; truncated: boolean };
};

/** 매출 로더 옵션 — 인트라데이는 opt-in(위 intraday 주석). */
export type MobileCampaignSalesOptions = {
  includeIntraday?: boolean;
};

function emptyTotals(): PulseTotals {
  return { orders: 0, quantity: 0, revenue: 0 };
}

function emptyStatusBreakdown(): CampaignStatusBreakdown {
  return { newOrderBefore: 0, newOrderAfter: 0, pending: 0, shipping: 0, completed: 0 };
}

/**
 * 순수 집계 — 한 판매캠페인(targetCampaignId)의 매출 상세를 계산한다.
 * campaigns 에는 대상 캠페인과 **같은 발주 캠페인을 공유하는 형제 회차 전부**를 넘겨야
 * 날짜 윈도우 귀속이 회차별로 정확히 갈린다(대상만 넘기면 형제 회차 주문이 과대집계).
 *
 * 규칙(mobile-pulse-data.computePulse / campaigns/route.ts 미러):
 * - 클레임(취소·반품·교환)은 유효 집계에서 제외하고 별도 카운트
 * - orders(주문 건수) = resolveOrderCountKey 기준 distinct 주문번호
 * - 상태 분포는 deriveOrderPipelineBucket으로 분류(데스크톱과 단일 판정). 배송대기 = 발주요청
 *   발송된 상품주문(poRequestedSet). 미주입 시 빈 집합 → 배송대기 0(보수적), 네이버 상태만 판정.
 */
export function computeCampaignSalesDetailForTargets(
  campaigns: PulseSalesCampaignSource[],
  orders: PulseOrderLike[],
  todayKey: string,
  targetCampaignIds: Set<string>,
  poRequestedSet: Set<string> = new Set(),
): CampaignSalesDetail {
  const cumulative = { orderKeys: new Set<string>(), quantity: 0, revenue: 0 };
  const today = { orderKeys: new Set<string>(), quantity: 0, revenue: 0 };
  const statusBreakdown = emptyStatusBreakdown();
  const claims: CampaignClaims = { canceled: 0, returned: 0, exchanged: 0 };
  const dailyMap = new Map<string, { orderKeys: Set<string>; revenue: number }>();
  const itemMap = new Map<string, { orderKeys: Set<string>; quantity: number; revenue: number }>();

  attributeOrders(campaigns, orders, (order, targetSc, mappingPrice) => {
    if (!targetCampaignIds.has(targetSc.id)) return;

    const status = order.productOrderStatus ?? "";
    // 클레임 — 유효 집계 제외, 별도 카운트 (campaigns/route.ts:523-526)
    if (status === "CANCELED") {
      claims.canceled += 1;
      return;
    }
    if (status === "RETURNED") {
      claims.returned += 1;
      return;
    }
    if (status === "EXCHANGED") {
      claims.exchanged += 1;
      return;
    }
    if (INVALID_ORDER_STATUSES.includes(status)) return; // PAY_WAITING 등

    // 유효 주문
    const key = resolveOrderCountKey(order);
    const qty = Number(order.quantity) || 1;
    const revenue = resolveOrderRevenue(order, qty, mappingPrice);
    const dateKey = resolveOrderDateKey(order);

    if (key) cumulative.orderKeys.add(key);
    cumulative.quantity += qty;
    cumulative.revenue += revenue;

    if (dateKey === todayKey) {
      if (key) today.orderKeys.add(key);
      today.quantity += qty;
      today.revenue += revenue;
    }

    // 상태 분포 — 데스크톱과 동일 판정(deriveOrderPipelineBucket). 배송대기 = 발주요청 발송됨.
    const bucket = deriveOrderPipelineBucket(
      status,
      order.placeOrderStatus,
      poRequestedSet.has(String(order.productOrderId ?? "")),
    );
    if (bucket === "newBefore") statusBreakdown.newOrderBefore += 1;
    else if (bucket === "newAfter") statusBreakdown.newOrderAfter += 1;
    else if (bucket === "pending") statusBreakdown.pending += 1;
    else if (bucket === "shipping") statusBreakdown.shipping += 1;
    else if (bucket === "completed") statusBreakdown.completed += 1;

    // 일별 (distinct 주문건수/매출)
    if (dateKey) {
      let bucket = dailyMap.get(dateKey);
      if (!bucket) {
        bucket = { orderKeys: new Set<string>(), revenue: 0 };
        dailyMap.set(dateKey, bucket);
      }
      if (key) bucket.orderKeys.add(key);
      bucket.revenue += revenue;
    }

    // 품목별 (상품+옵션) — 유효 주문만. 표시명은 "상품명 · 옵션명".
    const productName = (order.productName ?? "").trim();
    const optionName = (order.productOption || order.productOptionName || "").trim();
    const itemName = optionName
      ? productName
        ? `${productName} · ${optionName}`
        : optionName
      : productName || "기타";
    let itemBucket = itemMap.get(itemName);
    if (!itemBucket) {
      itemBucket = { orderKeys: new Set<string>(), quantity: 0, revenue: 0 };
      itemMap.set(itemName, itemBucket);
    }
    if (key) itemBucket.orderKeys.add(key);
    itemBucket.quantity += qty;
    itemBucket.revenue += revenue;
  });

  const daily: CampaignDailyPoint[] = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => ({ date, orders: bucket.orderKeys.size, revenue: bucket.revenue }));

  const items: CampaignItemSales[] = [...itemMap.entries()]
    .map(([name, bucket]) => ({
      name,
      orders: bucket.orderKeys.size,
      quantity: bucket.quantity,
      revenue: bucket.revenue,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity || a.name.localeCompare(b.name, "ko"));

  return {
    cumulative: {
      orders: cumulative.orderKeys.size,
      quantity: cumulative.quantity,
      revenue: cumulative.revenue,
    },
    today: {
      orders: today.orderKeys.size,
      quantity: today.quantity,
      revenue: today.revenue,
    },
    statusBreakdown,
    claims,
    daily,
    items,
  };
}

export function computeCampaignSalesDetail(
  campaigns: PulseSalesCampaignSource[],
  orders: PulseOrderLike[],
  todayKey: string,
  targetCampaignId: string,
  poRequestedSet: Set<string> = new Set(),
): CampaignSalesDetail {
  return computeCampaignSalesDetailForTargets(
    campaigns,
    orders,
    todayKey,
    new Set([targetCampaignId]),
    poRequestedSet,
  );
}

/** 마감 캠페인 캐시(cachedDailyStats Json) → CampaignDailyPoint[]. 형식 방어적으로 파싱. */
function parseCachedDaily(raw: unknown): CampaignDailyPoint[] {
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((row) => {
      const r = row as { date?: unknown; orders?: unknown; revenue?: unknown };
      const date = typeof r.date === "string" ? r.date.slice(0, 10) : null;
      if (!date) return null;
      return {
        date,
        orders: Number(r.orders) || 0,
        revenue: Number(r.revenue) || 0,
      };
    })
    .filter((point): point is CampaignDailyPoint => point !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseCachedProductOrderIds(raw: unknown): string[] {
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((value) => (value == null ? null : String(value)))
    .filter((value): value is string => Boolean(value));
}

export function shouldReadLiveCampaignSales(campaign: {
  status: string;
  orderCampaign: { isActive: boolean } | null;
}): boolean {
  return campaign.status === "ACTIVE" || campaign.orderCampaign?.isActive === true;
}

/**
 * DB 로더 + 집계 진입점. 읽기 전용 — 어떤 쓰기/동기화도 트리거하지 않는다.
 * 반환 null = 존재하지 않는 캠페인(라우트가 404 로 변환).
 */
export async function getMobileCampaignSales(
  campaignId: string,
  now = new Date(),
  options: MobileCampaignSalesOptions = {},
): Promise<MobileCampaignSalesResponse | null> {
  const prisma = getPrisma();

  const campaign = await prisma.salesCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      status: true,
      startDate: true,
      orderCampaignId: true,
      orderCampaign: { select: { isActive: true } },
    },
  });
  if (!campaign) return null;

  const noneResponse: MobileCampaignSalesResponse = {
    campaignId,
    source: "none",
    asOf: null,
    cumulative: emptyTotals(),
    today: emptyTotals(),
    statusBreakdown: emptyStatusBreakdown(),
    claims: null,
    daily: [],
    items: [],
  };

  // 네이버 발주 연동이 없는 캠페인 → 매출 상세 데이터 소스 없음.
  if (!campaign.orderCampaignId) return noneResponse;

  const hasLiveOrderSource = shouldReadLiveCampaignSales(campaign);
  if (hasLiveOrderSource) {
    return getLiveSalesDetail(campaignId, campaign.orderCampaignId, now, noneResponse, options);
  }
  return getCachedSalesDetail(campaign.orderCampaignId, noneResponse, options);
}

/**
 * 마감 캐시들의 동결 버킷 → ComposedIntraday. 동결분이 하나도 없으면 null 을 돌려
 * 종전대로 인트라데이 없음(일별 해상도)으로 degrade 한다 — 빈 점 열을 주면 화면이
 * "10분 모드인데 주문이 0"으로 오독한다.
 */
function composeCachedIntraday(
  rows: Array<{ cachedIntradayBuckets: unknown }>,
  daily: CampaignDailyPoint[],
): ComposedIntraday | null {
  const frozen = rows
    .map((row) => parseFrozenIntradayBuckets(row.cachedIntradayBuckets))
    .filter((value): value is FrozenIntradayBuckets => value !== null);
  if (frozen.length === 0) return null;
  return composeIntradayFromFrozen(frozen, daily.map((point) => point.date));
}

export async function getMobileCampaignGroupSales(
  groupId: string,
  now = new Date(),
  options: MobileCampaignSalesOptions = {},
): Promise<MobileCampaignSalesResponse | null> {
  const prisma = getPrisma();
  const responseId = `group:${groupId}`;
  const noneResponse: MobileCampaignSalesResponse = {
    campaignId: responseId,
    source: "none",
    asOf: null,
    cumulative: emptyTotals(),
    today: emptyTotals(),
    statusBreakdown: emptyStatusBreakdown(),
    claims: null,
    daily: [],
    items: [],
  };

  const members = await prisma.salesCampaign.findMany({
    where: { groupId },
    select: {
      id: true,
      status: true,
      orderCampaignId: true,
      orderCampaign: { select: { isActive: true } },
    },
  });
  if (members.length === 0) return null;

  const linkedMembers = members.filter((member) => member.orderCampaignId);
  if (linkedMembers.length === 0) return noneResponse;

  const orderCampaignIds = [
    ...new Set(linkedMembers.map((member) => member.orderCampaignId).filter((id): id is string => id != null)),
  ];
  const targetCampaignIds = new Set(linkedMembers.map((member) => member.id));

  if (linkedMembers.some(shouldReadLiveCampaignSales)) {
    return getLiveSalesDetailForTargets(
      orderCampaignIds,
      targetCampaignIds,
      now,
      noneResponse,
      responseId,
      options,
    );
  }

  return getCachedGroupSalesDetail(orderCampaignIds, noneResponse, targetCampaignIds, options);
}

async function getLiveSalesDetail(
  campaignId: string,
  orderCampaignId: string,
  now: Date,
  noneResponse: MobileCampaignSalesResponse,
  options: MobileCampaignSalesOptions,
): Promise<MobileCampaignSalesResponse> {
  return getLiveSalesDetailForTargets(
    [orderCampaignId],
    new Set([campaignId]),
    now,
    noneResponse,
    campaignId,
    options,
  );
}

async function getLiveSalesDetailForTargets(
  orderCampaignIds: string[],
  targetCampaignIds: Set<string>,
  now: Date,
  noneResponse: MobileCampaignSalesResponse,
  responseCampaignId: string,
  options: MobileCampaignSalesOptions = {},
): Promise<MobileCampaignSalesResponse> {
  const prisma = getPrisma();

  // 형제 회차는 조회 창(최초 시작일)을 정하는 데만 쓴다 — 귀속 계산은 스냅샷에 구워진
  // 집계(또는 폴백 시 loadAggregationCampaignSources 우주)가 담당하므로 매핑·셀러 조인 불요.
  const siblings = await prisma.salesCampaign.findMany({
    where: { orderCampaignId: { in: orderCampaignIds } },
    select: { id: true, startDate: true },
  });
  if (siblings.length === 0) return noneResponse;

  const latestMeta = await prisma.naverOrderSnapshot.findFirst({
    orderBy: { lastCallTime: "desc" },
    select: { lastCallTime: true },
  });
  const asOf = latestMeta ? new Date(latestMeta.lastCallTime).toISOString() : null;

  // 조회 범위: 형제 회차 최초 시작일 ~ 오늘(KST). 창의 시작은 **캠페인 창**이 정한다 —
  // 종전엔 `now − 30일`로 하한해 캠페인 초반 날짜가 매일 하나씩 조회 밖으로 밀려났다
  // (resolveLiveWindowKeys 주석의 침묵형 결함). 절대 상한은 폭주 가드로만 남는다.
  const earliestStartMs = Math.min(...siblings.map((sc) => new Date(sc.startDate).getTime()));
  const { startKey, todayKey, truncated } = resolveLiveWindowKeys(
    earliestStartMs,
    now,
    "mobile-campaign-sales",
  );

  const aggregates = await loadWindowAggregates(
    prisma,
    startKey,
    todayKey,
    targetCampaignIds,
    "mobile-campaign-sales",
  );
  const { detail, poCandidates } = composeSalesDetailFromAggregates(
    aggregates,
    todayKey,
    targetCampaignIds,
  );

  // 배송대기 재정의(order-fulfillment.ts): 발주요청 발송된 상품주문(poRequestedAt) 배치 로드.
  // 조회 대상은 poRequested 플래그로 버킷이 뒤집힐 수 있는 후보뿐이다(전체 주문 아님).
  // 실패 시 빈 집합 폴백 → 보정 없이 네이버 상태만으로 판정(읽기전용 게이트 유지).
  let poRequestedSet = new Set<string>();
  try {
    poRequestedSet = await orderFulfillmentRepository.getPoRequestedSet([
      ...poCandidates.newBefore,
      ...poCandidates.newAfter,
      ...poCandidates.other,
    ]);
  } catch (err) {
    console.warn("[mobile-campaign-sales] poRequested 집합 로드 실패 — 네이버 상태만으로 판정:", err);
  }

  return {
    campaignId: responseCampaignId,
    source: "live",
    asOf,
    ...detail,
    statusBreakdown: applyPoRequestedSplit(detail.statusBreakdown, poCandidates, poRequestedSet),
    coverage: { startDate: startKey, truncated },
    // 이미 로드된 집계에서 파생 — 추가 IO 0. 요청하지 않았으면 필드 자체를 넣지 않는다.
    ...(options.includeIntraday
      ? { intraday: composeIntradayFromAggregates(aggregates, targetCampaignIds) }
      : {}),
  };
}

async function getCachedSalesDetail(
  orderCampaignId: string,
  noneResponse: MobileCampaignSalesResponse,
  options: MobileCampaignSalesOptions = {},
): Promise<MobileCampaignSalesResponse> {
  const prisma = getPrisma();
  const oc = await prisma.orderCampaign.findUnique({
    where: { id: orderCampaignId },
    select: {
      cachedNewOrderBeforeCount: true,
      cachedNewOrderAfterCount: true,
      cachedPendingCount: true,
      cachedShippingCount: true,
      cachedCompletedCount: true,
      cachedTotalOrders: true,
      cachedDistinctOrderCount: true,
      cachedTotalQuantity: true,
      cachedTotalRevenue: true,
      cachedDailyStats: true,
      // 마감 시 동결한 10분 버킷. 요청한 호출부에만 실린다(live 경로의 includeIntraday 와 동일 규약).
      ...(options.includeIntraday ? { cachedIntradayBuckets: true as const } : {}),
    },
  });

  // 마감 캠페인이지만 결산 캐시가 아직 없으면(마감취소→재마감 전) 소스 없음.
  if (!oc || (oc.cachedTotalOrders == null && oc.cachedDailyStats == null)) {
    return { ...noneResponse, source: "none" };
  }

  const daily = parseCachedDaily(oc.cachedDailyStats);

  return {
    campaignId: noneResponse.campaignId,
    source: "cached",
    asOf: null,
    cumulative: {
      // distinct 우선, 미백필 과거 마감은 라인수(cachedTotalOrders)로 폴백(campaigns/route.ts:340 동일)
      orders: oc.cachedDistinctOrderCount ?? oc.cachedTotalOrders ?? 0,
      quantity: oc.cachedTotalQuantity ?? 0,
      revenue: oc.cachedTotalRevenue ?? 0,
    },
    today: emptyTotals(),
    statusBreakdown: {
      newOrderBefore: oc.cachedNewOrderBeforeCount ?? 0,
      newOrderAfter: oc.cachedNewOrderAfterCount ?? 0,
      pending: oc.cachedPendingCount ?? 0,
      shipping: oc.cachedShippingCount ?? 0,
      completed: oc.cachedCompletedCount ?? 0,
    },
    claims: null, // 캐시는 클레임 미집계
    daily,
    items: [], // 캐시는 품목별 미집계
    // 요청하지 않았으면 필드 자체를 넣지 않는다(live 경로와 동일).
    ...(options.includeIntraday
      ? { intraday: composeCachedIntraday([{ cachedIntradayBuckets: (oc as { cachedIntradayBuckets?: unknown }).cachedIntradayBuckets }], daily) }
      : {}),
  };
}

async function getCachedGroupSalesDetail(
  orderCampaignIds: string[],
  noneResponse: MobileCampaignSalesResponse,
  targetCampaignIds: Set<string>,
  options: MobileCampaignSalesOptions = {},
): Promise<MobileCampaignSalesResponse> {
  const prisma = getPrisma();
  const campaigns = await prisma.orderCampaign.findMany({
    where: { id: { in: orderCampaignIds } },
    select: {
      cachedNewOrderBeforeCount: true,
      cachedNewOrderAfterCount: true,
      cachedPendingCount: true,
      cachedShippingCount: true,
      cachedCompletedCount: true,
      cachedTotalOrders: true,
      cachedDistinctOrderCount: true,
      cachedTotalQuantity: true,
      cachedTotalRevenue: true,
      cachedDailyStats: true,
      cachedProductOrderIds: true,
      ...(options.includeIntraday ? { cachedIntradayBuckets: true as const } : {}),
    },
  });

  const cached = campaigns.filter((campaign) => (
    campaign.cachedTotalOrders != null || campaign.cachedDailyStats != null
  ));
  if (cached.length === 0) return { ...noneResponse, source: "none" };

  const resolvedOrderCounts = cached.length > 1
    ? await resolveCachedGroupOrderCounts(cached, targetCampaignIds)
    : null;
  if (cached.length > 1 && !resolvedOrderCounts) {
    return { ...noneResponse, source: "none" };
  }

  const dailyMap = new Map<string, { orders: number; revenue: number }>();
  for (const campaign of cached) {
    for (const point of parseCachedDaily(campaign.cachedDailyStats)) {
      const bucket = dailyMap.get(point.date) ?? { orders: 0, revenue: 0 };
      bucket.orders += point.orders;
      bucket.revenue += point.revenue;
      dailyMap.set(point.date, bucket);
    }
  }

  const daily: CampaignDailyPoint[] = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, point]) => ({
      date,
      orders: resolvedOrderCounts?.dailyOrders.get(date) ?? point.orders,
      revenue: point.revenue,
    }));

  return {
    campaignId: noneResponse.campaignId,
    source: "cached",
    asOf: null,
    cumulative: {
      orders: resolvedOrderCounts?.cumulativeOrders
        ?? cached.reduce(
          (sum, campaign) => sum + (campaign.cachedDistinctOrderCount ?? campaign.cachedTotalOrders ?? 0),
          0,
        ),
      quantity: cached.reduce((sum, campaign) => sum + (campaign.cachedTotalQuantity ?? 0), 0),
      revenue: cached.reduce((sum, campaign) => sum + (campaign.cachedTotalRevenue ?? 0), 0),
    },
    today: emptyTotals(),
    statusBreakdown: {
      newOrderBefore: cached.reduce((sum, campaign) => sum + (campaign.cachedNewOrderBeforeCount ?? 0), 0),
      newOrderAfter: cached.reduce((sum, campaign) => sum + (campaign.cachedNewOrderAfterCount ?? 0), 0),
      pending: cached.reduce((sum, campaign) => sum + (campaign.cachedPendingCount ?? 0), 0),
      shipping: cached.reduce((sum, campaign) => sum + (campaign.cachedShippingCount ?? 0), 0),
      completed: cached.reduce((sum, campaign) => sum + (campaign.cachedCompletedCount ?? 0), 0),
    },
    claims: null,
    daily,
    items: [],
    // 그룹은 멤버 발주 캠페인들의 동결 버킷을 같은 시각 칸에서 **합산**한다 — live 경로의
    // composeIntradayFromAggregates 와 같은 규약이다(점 열은 모양 판독용, 정확한 건수의
    // 정본은 계속 daily 다). 동결분이 있는 멤버와 없는 멤버가 섞이면 없는 쪽의 날짜가
    // daysWithoutBuckets 로 정직하게 드러난다.
    ...(options.includeIntraday
      ? {
          intraday: composeCachedIntraday(
            cached.map((campaign) => ({
              cachedIntradayBuckets: (campaign as { cachedIntradayBuckets?: unknown }).cachedIntradayBuckets,
            })),
            daily,
          ),
        }
      : {}),
  };
}

async function resolveCachedGroupOrderCounts(
  cached: Array<{
    cachedDailyStats: unknown;
    cachedProductOrderIds: unknown;
  }>,
  targetCampaignIds: Set<string>,
): Promise<{ cumulativeOrders: number; dailyOrders: Map<string, number> } | null> {
  const dateKeys = cached
    .flatMap((campaign) => parseCachedDaily(campaign.cachedDailyStats).map((point) => point.date))
    .sort((a, b) => a.localeCompare(b));
  if (dateKeys.length === 0) return null;

  const prisma = getPrisma();
  // 1단계: 집계 컬럼만 select — orders 블롭(행당 수 MB, 그룹 기간 전체면 수십 MB egress)은
  // 싣지 않는다. 멤버 캠페인 리프의 orderKeys union이 곧 그룹 distinct 주문건수다.
  const rows = await prisma.naverOrderSnapshot.findMany({
    where: {
      snapshotDate: {
        gte: dateKeys[0],
        lte: dateKeys[dateKeys.length - 1],
      },
    },
    select: { snapshotDate: true, dailyAggregate: true },
  });

  const cumulativeKeys = new Set<string>();
  const dailyKeys = new Map<string, Set<string>>();
  const addKey = (dateKey: string, key: string) => {
    cumulativeKeys.add(key);
    const bucket = dailyKeys.get(dateKey) ?? new Set<string>();
    bucket.add(key);
    dailyKeys.set(dateKey, bucket);
  };

  const fallbackDateKeys: string[] = [];
  for (const row of rows) {
    const parsed = parseSnapshotDailyAggregate(row.dailyAggregate);
    // 마감 캠페인은 이후에 쓰인 스냅샷의 campaignIds(활성 우주)에 없을 수 있다 — 커버 못 하는
    // 행은 아래 블롭 폴백(레거시 로직)으로 넘긴다. loadWindowAggregates 식 재계산 폴백(활성
    // 우주)은 마감 캠페인에 항상 0을 주므로 이 경로에서는 쓰지 않는다.
    if (parsed && aggregateCoversCampaigns(parsed, targetCampaignIds)) {
      for (const [dateKey, byCampaign] of Object.entries(parsed.days)) {
        if (dateKey === UNDATED_DAY_KEY) continue; // 일자미상 — 기존 블롭 경로도 제외했다
        for (const campaignId of targetCampaignIds) {
          const leaf = byCampaign[campaignId];
          if (!leaf) continue;
          for (const key of leaf.orderKeys) addKey(dateKey, key);
        }
      }
    } else {
      fallbackDateKeys.push(row.snapshotDate);
    }
  }

  if (fallbackDateKeys.length > 0) {
    // 2단계(집계 미가용 행만): 마감 시점에 영속된 cachedProductOrderIds로 그룹 소속 라인을
    // 걸러 distinct 주문키를 재산출한다 — 기존 로직 그대로, 블롭 비용은 레거시 행에서만 발생.
    console.warn(
      `[mobile-campaign-sales] 그룹 distinct 재산출 dailyAggregate 미가용 ${fallbackDateKeys.length}행 — orders 블롭 폴백:`,
      fallbackDateKeys.join(","),
    );
    const productOrderIds = new Set(
      cached.flatMap((campaign) => parseCachedProductOrderIds(campaign.cachedProductOrderIds)),
    );
    if (productOrderIds.size === 0) return null;

    const snapshots = await prisma.naverOrderSnapshot.findMany({
      where: { snapshotDate: { in: fallbackDateKeys } },
      select: { orders: true },
    });
    for (const snapshot of snapshots) {
      const parsed = typeof snapshot.orders === "string" ? safeJsonParse(snapshot.orders) : snapshot.orders;
      if (!Array.isArray(parsed)) continue;
      for (const rawOrder of parsed) {
        const order = rawOrder as PulseOrderLike;
        const productOrderId = order.productOrderId == null ? null : String(order.productOrderId);
        if (!productOrderId || !productOrderIds.has(productOrderId)) continue;
        const key = resolveOrderCountKey(order);
        const dateKey = resolveOrderDateKey(order);
        if (!key || !dateKey) continue;
        addKey(dateKey, key);
      }
    }
  }

  if (cumulativeKeys.size === 0) return null;

  return {
    cumulativeOrders: cumulativeKeys.size,
    dailyOrders: new Map([...dailyKeys.entries()].map(([date, keys]) => [date, keys.size])),
  };
}
