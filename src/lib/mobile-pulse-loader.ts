import { getPrisma } from "@/lib/prisma";
import { orderFulfillmentRepository } from "@/repositories/orderFulfillmentRepository";
import {
  type MobilePulseResponse,
  type PulseCampaignEntry,
  type PulseFulfillment,
  type PulseTotals,
} from "@/lib/mobile-pulse-data";
import {
  applyPoRequestedSplit,
  collectTodayByCampaign,
  composeSalesDetailFromAggregates,
  loadWindowAggregates,
  resolveLiveWindowKeys,
} from "@/lib/order-converter/daily-aggregate";

/**
 * 모바일 펄스 DB 로더 (2026-07-15 egress 절감으로 mobile-pulse-data.ts 에서 분리).
 *
 * 절대 게이트(원본 동일): 네이버 동기화를 트리거하지 않는다 — 영속 스냅샷만 읽는다.
 *
 * 데이터 소스 전환: 종전에는 매 조회마다 조회 창(최대 30일)의 NaverOrderSnapshot
 * orders 블롭 전량(행당 1.5~5.2MB 실측)을 읽어 computePulse 로 인메모리 집계했다 —
 * 홈 표면이라 조회 빈도가 가장 높아 DB 풀러 egress 의 주 원인이었다. 이제 매출
 * 상세(#163)와 동일하게 스냅샷의 사전 집계 컬럼(dailyAggregate)만 select 하고,
 * 집계가 없는 행만 행 단위로 블롭 폴백한다(loadWindowAggregates 공용 로더).
 *
 * 파일 분리 이유: daily-aggregate.ts 가 mobile-pulse-data.ts(귀속 순수 함수)를
 * import 하므로, 펄스 로더가 daily-aggregate 를 다시 import 하면 순환이 된다 —
 * 로더를 별도 모듈로 두어 의존 그래프를 DAG 로 유지한다.
 * (computePulse 순수 집계는 mobile-pulse-data.ts 에 그대로 있다 — 집계 규칙의
 * 정의·테스트 기준점이며, 폴백 재계산은 같은 규칙의 computeSnapshotDailyAggregate 를 쓴다.)
 */

type PulseCampaignIdentity = {
  id: string;
  dealName: string;
  sellerName: string;
  startMs: number;
  /**
   * 발주(OrderCampaign)에 연동됐고 그 OrderCampaign이 활성인가.
   * dailyAggregate.campaignIds(=loadAggregationCampaignSources, orderCampaign.isActive
   * 이너조인)에 담기는 캠페인과 정확히 일치하는 집합이다 — 커버리지 가드의 대상은
   * 이 집합이어야 한다. 미연동/마감연동 ACTIVE 캠페인을 대상에 넣으면
   * aggregateCoversCampaigns가 매 요청 false를 반환해 전 창이 블롭 폴백된다.
   */
  aggregateLinked: boolean;
};

/**
 * DB 로더 + 집계 진입점. 읽기 전용 — 어떤 쓰기/동기화도 트리거하지 않는다.
 */
export async function getMobilePulse(now = new Date()): Promise<MobilePulseResponse> {
  const prisma = getPrisma();

  // byCampaign 표시용 신원 + 조회 창 시작일 + 집계 연동 여부만 필요하다 — 주문 귀속(매핑
  // 조인)은 스냅샷에 구워진 dailyAggregate 가 담당하므로 mappings include 를 걷어냈다.
  // orderCampaign.isActive 는 커버리지 가드 대상 집합을 dailyAggregate.campaignIds 와
  // 일치시키기 위해 select 한다(연동 안 된 ACTIVE 캠페인이 대상에 섞이면 전 창 블롭 폴백).
  const activeCampaigns = await prisma.salesCampaign.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      startDate: true,
      orderCampaignId: true,
      orderCampaign: { select: { isActive: true } },
      deal: { select: { dealName: true } },
      seller: { select: { name: true, alias: true } },
    },
  });

  // asOf: 최신 스냅샷 lastCallTime (스냅샷 전무 시 null)
  const latestMeta = await prisma.naverOrderSnapshot.findFirst({
    orderBy: { lastCallTime: "desc" },
    select: { lastCallTime: true },
  });
  const asOf = latestMeta ? new Date(latestMeta.lastCallTime).toISOString() : null;

  const emptyTotals: PulseTotals = { orders: 0, quantity: 0, revenue: 0 };
  const emptyFulfillment: PulseFulfillment = { ordered: 0, shipping: 0, completed: 0 };

  const identities: PulseCampaignIdentity[] = activeCampaigns.map((sc) => ({
    id: sc.id,
    dealName: sc.deal.dealName,
    sellerName: sc.seller.alias || sc.seller.name,
    startMs: new Date(sc.startDate).getTime(),
    aggregateLinked: Boolean(sc.orderCampaignId) && sc.orderCampaign?.isActive === true,
  }));

  // byCampaign 은 표시용이라 전 ACTIVE 캠페인(연동 여부 무관, 0 기본값)으로 만든다.
  const emptyByCampaign = () =>
    identities
      .map((sc) => ({
        campaignId: sc.id,
        dealName: sc.dealName,
        sellerName: sc.sellerName,
        todayOrders: 0,
        todayRevenue: 0,
      }))
      .slice(0, 8);

  // 집계·귀속 대상은 발주연동(active)된 캠페인뿐 — dailyAggregate.campaignIds 와 일치.
  // 미연동 ACTIVE 캠페인은 어차피 매핑이 없어 어떤 주문도 귀속되지 않으므로(구 computePulse
  // 동작 동일) 대상에서 빼도 수치는 불변이고, 커버리지 가드가 전 창 블롭 폴백으로
  // 미끄러지는 것만 막는다.
  const linkedIdentities = identities.filter((sc) => sc.aggregateLinked);

  if (asOf === null || linkedIdentities.length === 0) {
    return {
      asOf,
      today: emptyTotals,
      cumulative: { ...emptyTotals },
      byCampaign: emptyByCampaign(),
      fulfillment: emptyFulfillment,
    };
  }

  // 조회 범위: 연동 진행중 캠페인의 최초 시작일 ~ 오늘(KST). 창의 시작은 **캠페인 창**이
  // 정한다 — 종전엔 `now − 30일`로 하한해 캠페인 초반 날짜가 매일 하나씩 조회 밖으로
  // 밀려났다(resolveLiveWindowKeys 주석의 침묵형 결함). 상세(mobile-campaign-sales)와
  // **같은 SSOT** 를 쓴다 — 각자 계산하면 같은 캠페인이 홈과 상세에서 다른 숫자를 낸다.
  const earliestStartMs = Math.min(...linkedIdentities.map((sc) => sc.startMs));
  const { startKey, todayKey } = resolveLiveWindowKeys(earliestStartMs, now, "mobile-pulse");
  const targetCampaignIds = new Set(linkedIdentities.map((sc) => sc.id));

  const aggregates = await loadWindowAggregates(
    prisma,
    startKey,
    todayKey,
    targetCampaignIds,
    "mobile-pulse",
  );
  const { detail, poCandidates } = composeSalesDetailFromAggregates(
    aggregates,
    todayKey,
    targetCampaignIds,
  );

  // 배송대기 재정의(order-fulfillment.ts): 발주요청 발송된 상품주문(poRequestedAt) 배치 로드.
  // 실패 시 빈 집합 폴백 → 배송대기 보수적 0(ordered로 합산), 판정은 네이버 상태만으로 계속.
  let poRequestedSet = new Set<string>();
  try {
    poRequestedSet = await orderFulfillmentRepository.getPoRequestedSet([
      ...poCandidates.newBefore,
      ...poCandidates.newAfter,
      ...poCandidates.other,
    ]);
  } catch (err) {
    console.warn("[mobile-pulse] poRequested 집합 로드 실패 — 네이버 상태만으로 판정:", err);
  }

  // 배타 3단계 퍼널 — 5버킷(statusBreakdown)을 poRequested 보정 후 접는다(computePulse 동일 규칙).
  const split = applyPoRequestedSplit(detail.statusBreakdown, poCandidates, poRequestedSet);
  const fulfillment: PulseFulfillment = {
    ordered: split.newOrderBefore + split.newOrderAfter + split.pending,
    shipping: split.shipping,
    completed: split.completed,
  };

  const todayByCampaign = collectTodayByCampaign(aggregates, todayKey, targetCampaignIds);
  const byCampaign: PulseCampaignEntry[] = identities
    .map((sc) => {
      const stats = todayByCampaign.get(sc.id);
      return {
        campaignId: sc.id,
        dealName: sc.dealName,
        sellerName: sc.sellerName,
        todayOrders: stats?.orders ?? 0,
        todayRevenue: stats?.revenue ?? 0,
      };
    })
    .sort(
      (a, b) =>
        b.todayOrders - a.todayOrders ||
        b.todayRevenue - a.todayRevenue ||
        a.dealName.localeCompare(b.dealName, "ko"),
    )
    .slice(0, 8);

  return { asOf, today: detail.today, cumulative: detail.cumulative, byCampaign, fulfillment };
}
