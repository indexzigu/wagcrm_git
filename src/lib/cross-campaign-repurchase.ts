import { getPrisma } from "@/lib/prisma";
import { INVALID_ORDER_STATUSES } from "@/lib/order-converter/group-orders";
import { collectCampaignBuyerHashes, hashedBuyerKeyOf } from "@/lib/buyer-fingerprint";
import {
  attributeOrders,
  endOfDayKstMs,
  toDateKeyKst,
  type PulseOrderLike,
  type PulseSalesCampaignSource,
} from "@/lib/mobile-pulse-data";

/**
 * 회차간(크로스캠페인) 재구매 집계 — 셀러 재계약 근거("충성 구매자층").
 *
 * 정의(소유자 확정 2026-07-08): 한 구매자(ordererNo)가 셀러의 **서로 다른 회차(이벤트)
 * 2개+**에서 구매하면 회차간 재구매자다. 캠페인 내 다회 구매(within-campaign)는 기존
 * campaign-insights.buyers.repeat 가 담당 — 이건 다른 축(회차 간, 시간 넘어).
 *
 * ⚠ "회차(이벤트)"의 단위 (실데이터 교훈):
 * 이 CRM은 **딜(상품)마다 SalesCampaign 행을 따로** 만든다. 한 공구 마켓이 여러 상품을 팔면
 * 같은 발주(orderCampaignId)·같은 날짜창·round=1 인 SalesCampaign 행이 여러 개 생긴다
 * (예: 할인광녀 "이너뷰티 마켓" = 애사비·질유산균·콜라겐… 5행). 따라서 SalesCampaign 행을
 * 그대로 세면 "한 마켓에서 2개 상품 산 사람"이 회차간 재구매로 오집계된다(실측: 42명 전원 0일 간격).
 * → **날짜창이 겹치는 캠페인을 한 회차로 클러스터링**해, "시간 분리된 회차 2개+"에서 산
 * 구매자만 센다. 1차(6월)·2차(8월)처럼 창이 분리되면 다른 회차 = 진짜 재구매로 잡힌다.
 *
 * 구매자 식별 (Phase 0 진단): buyerKey = ordererNo(네이버 회원 9자리, per-person·실증) ?? ordererId.
 * 유효주문만(INVALID_ORDER_STATUSES 제외). 응답엔 개수만(PII 미노출).
 *
 * 한계(라벨 명시): 네이버스토어 주문만=하한값(타 채널 제외). 스냅샷 보관 밖 과거 회차는
 * CampaignBuyerFingerprint(영구 지문)로 보완한다 — 지문 저장 시작(2026-07-11) 이전에 스냅샷이
 * 만료된 회차는 소급 불가(포워드 전용).
 * 절대 게이트: 네이버 동기화 트리거 없음. 집계(getSellerCrossCampaignRepurchase)는 읽기 전용,
 * 쓰기는 sweepBuyerFingerprints(cron naver-order-sync 전용) 하나뿐이다.
 */

export type CrossCampaignRepurchase = {
  /** 유효주문이 귀속된 회차(이벤트) 수 */
  eventsWithOrders: number;
  /** 네이버스토어 유효주문 기준 순 구매자 수(식별키 dedup) */
  totalBuyers: number;
  /** 서로 다른 회차 2개+에서 구매한 구매자 수 */
  crossCampaignBuyers: number;
  /** crossCampaignBuyers / totalBuyers × 100 (구매자 없으면 0) */
  crossCampaignRatio: number;
};

// 구매자 식별키는 buyer-fingerprint.ts의 hashedBuyerKeyOf로 통일 — 스냅샷 유래 키와
// 영구 지문(CampaignBuyerFingerprint.buyerHash)이 같은 키공간이어야 합집합 dedup이 성립한다.

/**
 * 캠페인을 시간 분리된 회차(이벤트)로 클러스터링한다. 시작일 순으로 훑으며 날짜창이 겹치면
 * (다음 시작 ≤ 현재 회차 끝) 같은 회차로 병합, 아니면 새 회차. 반환: Map<campaignId, eventIndex>.
 * → 같은 공구의 여러 상품행은 한 회차로, 시간 분리된 1차·2차는 다른 회차로 갈린다.
 */
export function clusterCampaignEvents(campaigns: PulseSalesCampaignSource[]): Map<string, number> {
  const sorted = [...campaigns].sort((a, b) => a.startMs - b.startMs);
  const map = new Map<string, number>();
  let event = -1;
  let currentEnd = -Infinity;
  for (const c of sorted) {
    if (c.startMs > currentEnd) {
      event += 1; // 겹치지 않음 → 새 회차
      currentEnd = c.endMs;
    } else {
      currentEnd = Math.max(currentEnd, c.endMs); // 겹침 → 현재 회차에 병합
    }
    map.set(c.id, event);
  }
  return map;
}

/** 셀러 캠페인들이 몇 개의 시간 분리된 회차(이벤트)를 이루는지 */
export function countCampaignEvents(campaigns: PulseSalesCampaignSource[]): number {
  return new Set(clusterCampaignEvents(campaigns).values()).size;
}

// 주문 귀속의 공통 1패스 — buyerKey별 등장 회차 집합. 아래 두 집계(셀러 전체 회차간 재구매,
// 회차별 재구매 고객 비율)가 이 결과를 공유해 attributeOrders를 두 번 돌리지 않는다.
export type BuyerEventCollection = {
  /** buyerKey(해시) -> 등장한 회차(eventId) 집합 */
  buyerEvents: Map<string, Set<number>>;
  eventsWithOrders: Set<number>;
};

function collectBuyerEvents(
  campaigns: PulseSalesCampaignSource[],
  orders: PulseOrderLike[],
): BuyerEventCollection {
  const eventOf = clusterCampaignEvents(campaigns);
  const buyerEvents = new Map<string, Set<number>>();
  const eventsWithOrders = new Set<number>();

  attributeOrders(campaigns, orders, (order, targetSc) => {
    const status = order.productOrderStatus ?? "";
    if (INVALID_ORDER_STATUSES.includes(status)) return; // 결제대기·취소·반품·교환 제외

    const key = hashedBuyerKeyOf(order);
    if (!key) return; // 식별 불가 주문(비회원 등)은 제외

    const event = eventOf.get(targetSc.id);
    if (event === undefined) return;
    eventsWithOrders.add(event);

    let set = buyerEvents.get(key);
    if (!set) {
      set = new Set<number>();
      buyerEvents.set(key, set);
    }
    set.add(event);
  });

  return { buyerEvents, eventsWithOrders };
}

/** 영구 지문 한 행 — CampaignBuyerFingerprint(salesCampaignId, buyerHash)의 최소 투영 */
export type BuyerFingerprintRow = { salesCampaignId: string; buyerHash: string };

/**
 * 영구 지문을 스냅샷 유래 컬렉션에 병합한다(순수, in-place). 스냅샷이 만료된 과거 회차의
 * 구매자를 지문으로 되살려, 수개월 간격 회차간 재구매가 다시 대조되게 하는 핵심 단계.
 * 키공간이 동일(해시)하므로 스냅샷과 지문에 모두 있는 구매자는 Set이 자연 dedup한다.
 */
export function mergeFingerprintRows(
  collection: BuyerEventCollection,
  rows: BuyerFingerprintRow[],
  eventOf: Map<string, number>,
): void {
  for (const row of rows) {
    const event = eventOf.get(row.salesCampaignId);
    if (event === undefined) continue; // 집계 대상 캠페인 밖(방어)
    collection.eventsWithOrders.add(event);
    let set = collection.buyerEvents.get(row.buyerHash);
    if (!set) {
      set = new Set<number>();
      collection.buyerEvents.set(row.buyerHash, set);
    }
    set.add(event);
  }
}

function summarizeCrossCampaign({ buyerEvents, eventsWithOrders }: BuyerEventCollection): CrossCampaignRepurchase {
  let crossCampaignBuyers = 0;
  for (const set of buyerEvents.values()) {
    if (set.size >= 2) crossCampaignBuyers += 1;
  }
  const totalBuyers = buyerEvents.size;

  return {
    eventsWithOrders: eventsWithOrders.size,
    totalBuyers,
    crossCampaignBuyers,
    crossCampaignRatio: totalBuyers > 0 ? (crossCampaignBuyers / totalBuyers) * 100 : 0,
  };
}

/**
 * 순수 집계 — 넘겨받은 셀러 캠페인들을 회차(이벤트)로 묶고, 스냅샷 주문을 귀속시켜 서로 다른
 * 회차 2개+에 등장하는 구매자 수를 센다. campaigns 에는 **그 셀러의 모든 (귀속 가능) 캠페인**을
 * 넘긴다(한 공구의 상품행 전부 + 서로 다른 시기 캠페인).
 *
 * dedup: 같은 회차에서 여러 번/여러 상품을 사도 그 회차 1개로 접힌다(Set<eventId>). 따라서
 * within-event(같은 마켓 다상품·다회) 구매는 회차간으로 오인되지 않는다.
 */
export function computeCrossCampaignRepurchase(
  campaigns: PulseSalesCampaignSource[],
  orders: PulseOrderLike[],
  fingerprints: BuyerFingerprintRow[] = [],
): CrossCampaignRepurchase {
  const collection = collectBuyerEvents(campaigns, orders);
  if (fingerprints.length > 0) {
    mergeFingerprintRows(collection, fingerprints, clusterCampaignEvents(campaigns));
  }
  return summarizeCrossCampaign(collection);
}

export type EventReturningBuyers = {
  /** 이 회차의 순 구매자 수(식별키 dedup) */
  buyers: number;
  /** 그중 이 셀러의 **앞선 회차**(시간상 이전 이벤트)에서도 구매한 이력이 있는 사람 수 */
  returningBuyers: number;
  /** returningBuyers / buyers × 100 (구매자 없으면 0) */
  returningRatio: number;
};

function summarizeEventReturning({ buyerEvents, eventsWithOrders }: BuyerEventCollection): Map<number, EventReturningBuyers> {
  const per = new Map<number, { buyers: number; returningBuyers: number }>();
  for (const event of eventsWithOrders) per.set(event, { buyers: 0, returningBuyers: 0 });
  for (const set of buyerEvents.values()) {
    for (const event of set) {
      const stat = per.get(event);
      if (!stat) continue;
      stat.buyers += 1;
      // 회차 인덱스는 시작일 순 증가 — "이력" = 더 작은 인덱스의 회차에서 구매한 적 있음
      for (const other of set) {
        if (other < event) {
          stat.returningBuyers += 1;
          break;
        }
      }
    }
  }
  const out = new Map<number, EventReturningBuyers>();
  for (const [event, s] of per) {
    out.set(event, {
      ...s,
      returningRatio: s.buyers > 0 ? (s.returningBuyers / s.buyers) * 100 : 0,
    });
  }
  return out;
}

/**
 * 회차(이벤트)별 "재구매 고객" 비율 — 이번 회차 구매자 중, 이 셀러의 앞선 회차(다른 시기의
 * 캠페인)에서 구매한 이력이 있는 사람의 비율. 캠페인 내 2회+ 구매(campaign-insights의
 * buyers.repeat)와는 다른 축 — 셀러 포털/성과 카드의 "재구매 고객" 스탯이 이 값을 쓴다.
 * 반환 키는 clusterCampaignEvents의 이벤트 인덱스. 개수·비율만 담는다(PII 미노출).
 */
export function computeEventReturningBuyers(
  campaigns: PulseSalesCampaignSource[],
  orders: PulseOrderLike[],
  fingerprints: BuyerFingerprintRow[] = [],
): Map<number, EventReturningBuyers> {
  const collection = collectBuyerEvents(campaigns, orders);
  if (fingerprints.length > 0) {
    mergeFingerprintRows(collection, fingerprints, clusterCampaignEvents(campaigns));
  }
  return summarizeEventReturning(collection);
}

export type SellerCrossCampaignRepurchase = CrossCampaignRepurchase & {
  /** 이 셀러의 네이버 연동 캠페인이 이루는 시간 분리된 회차(이벤트) 수 — 2 미만이면 회차간 정의상 불가 */
  eligibleEvents: number;
  /**
   * OrderCampaign id → 그 캠페인이 속한 회차의 재구매 고객(앞선 회차 구매이력자) 비율.
   * 회차 2개 미만(첫 캠페인)이면 빈 객체 — 재구매 정의 자체가 성립하지 않으므로 표시하지 말 것.
   */
  returningByOrderCampaign: Record<string, EventReturningBuyers>;
};

function toCampaignSource(sc: {
  id: string;
  startDate: Date;
  endDate: Date;
  deal: { dealName: string };
  seller: { name: string; alias: string | null };
  campaignDeals: { id: string }[];
  orderCampaign:
    | {
        id: string;
        name: string;
        productId: string | null;
        mappings: { productName: string | null; optionName: string | null; price: number | null; campaignDealId: string | null }[];
      }
    | null;
}): PulseSalesCampaignSource {
  return {
    id: sc.id,
    dealName: sc.deal.dealName,
    sellerName: sc.seller.alias || sc.seller.name,
    startMs: new Date(sc.startDate).getTime(),
    endMs: endOfDayKstMs(new Date(sc.endDate)),
    campaignDealIds: sc.campaignDeals.map((cd) => cd.id),
    orderCampaign: sc.orderCampaign
      ? {
          id: sc.orderCampaign.id,
          name: sc.orderCampaign.name,
          productId: sc.orderCampaign.productId,
          mappings: sc.orderCampaign.mappings.map((m) => ({
            productName: m.productName,
            optionName: m.optionName,
            price: m.price,
            campaignDealId: m.campaignDealId,
          })),
        }
      : null,
  };
}

/**
 * DB 로더 + 집계 진입점. 읽기 전용 — 어떤 쓰기/동기화도 트리거하지 않는다.
 * 한 셀러의 네이버 연동 캠페인 전부를 모아 회차(이벤트)로 묶고, 셀러 최초 캠페인 시작~오늘의
 * 스냅샷 전범위를 통합 집계한다(30일 캡 없음 — 회차간은 장기 통합 필요).
 */
export async function getSellerCrossCampaignRepurchase(
  sellerId: string,
  now = new Date(),
): Promise<SellerCrossCampaignRepurchase> {
  const prisma = getPrisma();

  // 이 셀러의 귀속 가능(네이버 발주 연동) 캠페인 전부 — 회차·딜 무관(교차구매 정의)
  const campaigns = await prisma.salesCampaign.findMany({
    where: { sellerId, orderCampaignId: { not: null } },
    include: {
      deal: { select: { dealName: true } },
      seller: { select: { name: true, alias: true } },
      campaignDeals: { select: { id: true } },
      orderCampaign: { include: { mappings: true } },
    },
  });

  const sources = campaigns.map(toCampaignSource);
  const eligibleEvents = countCampaignEvents(sources);

  const empty: SellerCrossCampaignRepurchase = {
    eventsWithOrders: 0,
    totalBuyers: 0,
    crossCampaignBuyers: 0,
    crossCampaignRatio: 0,
    eligibleEvents,
    returningByOrderCampaign: {},
  };
  // 회차간 재구매는 시간 분리된 회차 2개+ 필요 — 1개 이하면 집계 불필요(주문 로딩도 생략)
  if (eligibleEvents < 2) return empty;

  // 스냅샷 조회 범위: 셀러 최초 캠페인 시작 ~ 오늘(KST). 상한(30일 캡) 없음.
  const earliestStartMs = Math.min(...sources.map((s) => s.startMs));
  const startKey = toDateKeyKst(new Date(earliestStartMs));
  const todayKey = toDateKeyKst(now);

  const snapshots = await prisma.naverOrderSnapshot.findMany({
    where: { snapshotDate: { gte: startKey, lte: todayKey } },
    orderBy: { snapshotDate: "asc" },
    select: { orders: true },
  });

  // 스냅샷 orders 는 postgres JSONB(파싱됨) / sqlite 문자열 둘 다 대비(mobile-pulse-data 와 동일 규칙)
  const orders: PulseOrderLike[] = snapshots.flatMap((row) => {
    const parsed = typeof row.orders === "string" ? JSON.parse(row.orders) : (row.orders as unknown);
    return Array.isArray(parsed) ? (parsed as PulseOrderLike[]) : [];
  });

  // 영구 지문 — 스냅샷 보관(≈30일) 밖으로 밀려난 과거 회차의 구매자를 되살린다.
  // 스냅샷과 지문의 키공간이 동일(해시)하므로 합집합 dedup이 성립한다.
  const fingerprintRows: BuyerFingerprintRow[] = await prisma.campaignBuyerFingerprint.findMany({
    where: { salesCampaignId: { in: sources.map((s) => s.id) } },
    select: { salesCampaignId: true, buyerHash: true },
  });

  // 귀속 1패스를 공유해 셀러 전체 집계와 회차별 재구매 비율을 함께 낸다
  const eventOf = clusterCampaignEvents(sources);
  const collection = collectBuyerEvents(sources, orders);
  mergeFingerprintRows(collection, fingerprintRows, eventOf);
  const core = summarizeCrossCampaign(collection);
  const perEvent = summarizeEventReturning(collection);

  const returningByOrderCampaign: Record<string, EventReturningBuyers> = {};
  for (const s of sources) {
    if (!s.orderCampaign) continue;
    const event = eventOf.get(s.id);
    if (event === undefined) continue;
    const stat = perEvent.get(event);
    if (stat) returningByOrderCampaign[s.orderCampaign.id] = stat;
  }

  return { ...core, eligibleEvents, returningByOrderCampaign };
}

export type BuyerFingerprintSweepResult = {
  /** 귀속 대상(네이버 연동) SalesCampaign 수 */
  campaigns: number;
  /** 파싱한 스냅샷 일수 */
  snapshotDays: number;
  /** 이번 스위프에서 새로 저장된 지문 수(중복 스킵 제외) */
  inserted: number;
};

/**
 * 구매자 지문 스위프 — 이 모듈의 유일한 쓰기 경로(cron naver-order-sync 전용).
 * 보관 중인 NaverOrderSnapshot 주문을 전 셀러의 네이버 연동 SalesCampaign에 귀속시켜
 * 회차별 구매자 해시를 CampaignBuyerFingerprint에 영구 저장한다(스냅샷 만료 대비).
 * 멱등: (salesCampaignId, buyerHash) unique + skipDuplicates — 반복 실행 무해(at-least-once).
 * dateKeys를 주면 그 날짜 스냅샷만(크론 증분), 생략하면 보관 전범위(백필/시드).
 */
export async function sweepBuyerFingerprints(dateKeys?: string[]): Promise<BuyerFingerprintSweepResult> {
  const prisma = getPrisma();

  const campaigns = await prisma.salesCampaign.findMany({
    where: { orderCampaignId: { not: null } },
    include: {
      deal: { select: { dealName: true } },
      seller: { select: { name: true, alias: true } },
      campaignDeals: { select: { id: true } },
      orderCampaign: { include: { mappings: true } },
    },
  });
  const sources = campaigns.map(toCampaignSource);
  if (sources.length === 0) return { campaigns: 0, snapshotDays: 0, inserted: 0 };

  const snapshots = await prisma.naverOrderSnapshot.findMany({
    where: dateKeys && dateKeys.length > 0 ? { snapshotDate: { in: dateKeys } } : {},
    orderBy: { snapshotDate: "asc" },
    select: { orders: true },
  });
  const orders: PulseOrderLike[] = snapshots.flatMap((row) => {
    const parsed = typeof row.orders === "string" ? JSON.parse(row.orders) : (row.orders as unknown);
    return Array.isArray(parsed) ? (parsed as PulseOrderLike[]) : [];
  });

  const byCampaign = collectCampaignBuyerHashes(sources, orders);
  const data: BuyerFingerprintRow[] = [];
  for (const [salesCampaignId, hashes] of byCampaign) {
    for (const buyerHash of hashes) data.push({ salesCampaignId, buyerHash });
  }
  if (data.length === 0) return { campaigns: sources.length, snapshotDays: snapshots.length, inserted: 0 };

  // skipDuplicates는 postgres 전용 — dev:local(sqlite)에서는 스위프를 돌리지 않는다
  // (크론/백필 스크립트만 호출하며 둘 다 Supabase/prod 대상. order-converter postgres-lock과 동일 기조).
  const res = await prisma.campaignBuyerFingerprint.createMany({ data, skipDuplicates: true });
  return { campaigns: sources.length, snapshotDays: snapshots.length, inserted: res.count };
}
