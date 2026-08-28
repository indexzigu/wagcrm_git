import {
  INVALID_ORDER_STATUSES,
  resolveOrderCountKey,
} from "@/lib/order-converter/group-orders";
import { deriveOrderPipelineBucket } from "@/lib/order-converter/order-fulfillment";
import {
  attributeOrders,
  endOfDayKstMs,
  resolveOrderDateKey,
  resolveOrderRevenue,
  resolveOrderTimeMs,
  toDateKeyKst,
  type PulseOrderLike,
  type PulseSalesCampaignSource,
  type PulseTotals,
} from "@/lib/mobile-pulse-data";
import { startOfKstDayMs } from "@/lib/order-converter/sale-window";

/**
 * NaverOrderSnapshot.dailyAggregate — 스냅샷 1행(=KST 1일)의 판매캠페인별 사전 집계 (P7).
 *
 * 목적(2026-07-15 egress 절감): 모바일 매출 상세(live)가 매 조회마다 orders JSON
 * 블롭 전량(조회 1회당 1.5~5.2MB 실측)을 읽어 인메모리 집계하던 것을, 스냅샷을
 * **쓸 때**(주문 배열이 이미 메모리에 있음) 캠페인별 일별 집계로 함께 영속해
 * 읽기 경로가 소형 집계만 select 하게 만든다.
 *
 * SSOT 계약:
 * - 이 모듈의 computeSnapshotDailyAggregate 가 유일한 계산 함수다 — 쓰기 경로
 *   (naverOrderSnapshotRepository.upsertDaily)와 읽기 폴백(mobile-campaign-sales의
 *   집계 없는 행 인메모리 계산)이 **같은 함수**를 쓴다. 별도 재구현 금지.
 * - 집계 규칙은 computeCampaignSalesDetailForTargets(mobile-campaign-sales.ts)와
 *   정확히 동일 의미다: 유효주문 판정 INVALID_ORDER_STATUSES(SSOT), 주문건수 =
 *   resolveOrderCountKey 기준 distinct, 매출 resolveOrderRevenue, 상태 분포
 *   deriveOrderPipelineBucket, 귀속 attributeOrders(단일 출처).
 * - **불변식: 한 주문(orderId)은 정확히 하나의 일자(dateKey)에 귀속된다**
 *   (dateKey = 결제일 우선 KST — resolveOrderDateKey). 따라서 일별 distinct
 *   주문키 집합은 일자 간 서로소이고, 윈도우 distinct 주문건수 = 일별 distinct
 *   합이 성립한다. 반면 **캠페인 간에는 서로소가 아니다**(조합 캠페인에서 한
 *   결제가 여러 멤버 캠페인에 걸침) — 그래서 카운트가 아니라 orderKeys(배열)를
 *   영속해 그룹 합성 시 union 으로 중복 제거한다.
 * - statusBreakdown 은 poRequested=false 기준으로 저장한다. 발주요청(poRequestedAt)
 *   은 스냅샷을 다시 쓰지 않는 내부 상태 전이라, 여기 구워 넣으면 낡는다. 대신
 *   플래그에 따라 배송대기(pending)로 뒤집힐 수 있는 상품주문번호를
 *   poCandidates 로 실어, 읽기 시 OrderFulfillmentState 를 조회해
 *   applyPoRequestedSplit 으로 보정한다(현행 live 판정과 동치).
 * - 버전 v=1. 형태가 바뀌면 v 를 올린다 — 읽기는 v 불일치 행을 블롭 폴백으로
 *   처리한다(구버전 행 재작성 불요, 다음 동기화가 자연 갱신).
 * - **인트라데이 버킷(`bv`)은 v 와 별개 축이다** — 추가 필드라 구 행과 호환되고,
 *   마커가 없으면 블롭 폴백이 아니라 "인트라데이 없음"으로 degrade 한다.
 *   자세한 근거는 SNAPSHOT_INTRADAY_BUCKET_VERSION 주석.
 */

export const SNAPSHOT_DAILY_AGGREGATE_VERSION = 1 as const;

/**
 * 인트라데이 버킷 버전 — **`v` 와 별개 축이다(의도적)**.
 *
 * ⛔ **버킷을 추가하면서 `v` 를 올리지 말 것.** `v` 를 올리면 기존 행 전부가 버전
 * 불일치가 되어 **읽기마다 orders 블롭 폴백**(행당 최대 720KB 실측)을 타고, 그게 정확히
 * dailyAggregate 가 없애려던 egress 사고다. 버킷은 **선택적 추가 필드**이고, 계산 여부는
 * 이 마커(`bv`)가 알린다 — 마커가 없는 행은 "인트라데이 없음"으로 **degrade** 할 뿐
 * 블롭을 읽지 않는다. 버킷 **형태**가 바뀔 때만 이 숫자를 올린다.
 */
export const SNAPSHOT_INTRADAY_BUCKET_VERSION = 1 as const;

/** 버킷 폭(분) — 설계 확정본 2026-07-29(5분 대비 데이터 절반, 판독 손실 없음). */
export const INTRADAY_BUCKET_MINUTES = 10;

/** KST 하루의 버킷 수. */
export const INTRADAY_BUCKETS_PER_DAY = (24 * 60) / INTRADAY_BUCKET_MINUTES;

const INTRADAY_BUCKET_MS = INTRADAY_BUCKET_MINUTES * 60 * 1000;

/**
 * 주문 시각 → KST 일 기준 버킷 번호(0 ~ 143). 시각이 없으면 null(일자미상과 같은 취급).
 * 날짜키와 **같은 시각 원천**(`resolveOrderTimeMs`)을 쓰므로 버킷 합 = 그날 일별 값이다.
 */
export function resolveIntradayBucketIndex(order: PulseOrderLike): number | null {
  const t = resolveOrderTimeMs(order);
  if (t <= 0) return null;
  const idx = Math.floor((t - startOfKstDayMs(t)) / INTRADAY_BUCKET_MS);
  if (!Number.isFinite(idx)) return null;
  return Math.min(INTRADAY_BUCKETS_PER_DAY - 1, Math.max(0, idx));
}

/** 집계 계산 실패 시 기록하는 마커 — 읽기에서 v 불일치로 취급돼 블롭 폴백을 탄다. */
export const SNAPSHOT_DAILY_AGGREGATE_UNAVAILABLE = { v: 0 as const };

/** 일자 미상(paymentDate 등 부재) 주문의 days 키 — 누적/상태/품목에는 반영, daily/today 에는 미반영. */
export const UNDATED_DAY_KEY = "";

// ============================================================================
// 응답 형태 타입 — 모바일 매출 상세의 공개 계약(기존 mobile-campaign-sales 정의 이동).
// mobile-campaign-sales.ts 가 re-export 해 기존 소비자(import 경로)를 보존한다.
// ============================================================================

export type CampaignStatusBreakdown = {
  /** 주문확인 전 (PAYED & NOT_YET) */
  newOrderBefore: number;
  /** 주문확인 후 (PAYED placed | PRODUCT_ORDERED) */
  newOrderAfter: number;
  /** 배송대기 (발주요청 메일 발송됨 · order-fulfillment.ts) */
  pending: number;
  /** 배송중 (DELIVERING) */
  shipping: number;
  /** 배송완료 (DELIVERED | PURCHASE_DECIDED) */
  completed: number;
};

export type CampaignClaims = {
  canceled: number;
  returned: number;
  exchanged: number;
};

export type CampaignDailyPoint = {
  /** YYYY-MM-DD (KST) */
  date: string;
  /** distinct 주문건수 */
  orders: number;
  revenue: number;
};

/** 품목별(상품+옵션) 매출 집계 — 유효 주문만(클레임 제외) */
export type CampaignItemSales = {
  /** "상품명 · 옵션명" (옵션 없으면 상품명, 둘 다 없으면 "기타") */
  name: string;
  /** distinct 주문건수 */
  orders: number;
  quantity: number;
  revenue: number;
};

export type CampaignSalesDetail = {
  cumulative: PulseTotals;
  today: PulseTotals;
  statusBreakdown: CampaignStatusBreakdown;
  claims: CampaignClaims;
  daily: CampaignDailyPoint[];
  /** 품목별 매출(매출 내림차순). cached/none 모드는 빈 배열 */
  items: CampaignItemSales[];
};

// ============================================================================
// 영속 집계 형태(v1)
// ============================================================================

/** poRequested 플래그에 따라 pending 으로 뒤집힐 수 있는 상품주문번호(기저 버킷별). */
export type AggregatePoCandidates = {
  /** 기저 newBefore — 플래그 시 pending 으로 이동(newOrderBefore 감소) */
  newBefore: string[];
  /** 기저 newAfter — 플래그 시 pending 으로 이동(newOrderAfter 감소) */
  newAfter: string[];
  /** 기저 other(5버킷 미집계) — 플래그 시 pending 에 가산만 */
  other: string[];
};

export type AggregateItemEntry = {
  name: string;
  /** distinct 주문키 — 일자·캠페인 간 union 합성을 위해 카운트가 아니라 키를 영속 */
  orderKeys: string[];
  quantity: number;
  revenue: number;
};

/**
 * 인트라데이 버킷 1칸 — `[주문건수, 매출]`. 배열인 것은 크기 때문이다(키 이름 반복 제거).
 *
 * **건수를 세는 것이 안전한 이유:** 한 결제(`orderId`)의 상품주문 라인들은 `paymentDate`
 * 를 공유하므로 같은 버킷에 떨어진다 — 즉 버킷을 가로지르는 결제가 없어서 쓰기 시점에
 * distinct 를 확정할 수 있다. 그래도 **일 합계의 정본은 리프의 `orderKeys`** 다(버킷은
 * 분해 정보일 뿐) — 폴백 시각(orderDate/orderCreateDate)이 라인마다 다른 희귀 케이스에서
 * 버킷 합이 1~2건 어긋나도 일별·누적 수치는 흔들리지 않는다.
 */
export type IntradayBucketEntry = [orders: number, revenue: number];

/** 한 (일자 × 판매캠페인) 리프 집계. */
export type CampaignDayAggregate = {
  /** 유효 주문 distinct 키(resolveOrderCountKey). 키 없는 라인은 제외(카운트 불가). */
  orderKeys: string[];
  /** 유효 상품주문 라인 수 — daily 포인트 발행 여부 판정(클레임-only 리프 구분)용 */
  validLines: number;
  quantity: number;
  revenue: number;
  /** poRequested=false 기준 5버킷 — 읽기 시 applyPoRequestedSplit 으로 보정 */
  statusBreakdown: CampaignStatusBreakdown;
  poCandidates: AggregatePoCandidates;
  claims: CampaignClaims;
  items: AggregateItemEntry[];
  /**
   * 인트라데이 분해 — 버킷번호(문자열) → `[주문건수, 매출]`. **희소**(빈 칸 생략)라
   * 실제 키 수는 그날 주문이 찍힌 칸 수뿐이다(하루 최대 224건 실측 → 144칸에 흩어짐).
   * 상위 `bv` 마커가 없는 행에는 이 필드가 아예 없다(구 집계 — 인트라데이 미제공).
   */
  buckets?: Record<string, IntradayBucketEntry>;
};

export type SnapshotDailyAggregate = {
  v: typeof SNAPSHOT_DAILY_AGGREGATE_VERSION;
  /**
   * 인트라데이 버킷 마커 — 이 행을 쓴 계산기가 버킷을 함께 넣었음을 뜻한다.
   * **없음 = 구 집계**(v 는 여전히 유효하므로 블롭 폴백이 아니라 인트라데이만 degrade).
   */
  bv?: typeof SNAPSHOT_INTRADAY_BUCKET_VERSION;
  /**
   * 집계 계산에 참여한(=쓰기 시점 존재·발주연동됐던) 판매캠페인 전수.
   * 읽기에서 "campaigns 에 없음 = 그날 주문 0"(신뢰)과 "쓰기 후 신설·연동된
   * 캠페인"(낡음 → 블롭 폴백)을 구분하는 멤버십 가드다.
   */
  campaignIds: string[];
  /** dateKey(YYYY-MM-DD KST, UNDATED_DAY_KEY=일자미상) → salesCampaignId → 리프 */
  days: Record<string, Record<string, CampaignDayAggregate>>;
};

// ============================================================================
// 쓰기측: 순수 집계 계산
// ============================================================================

function emptyStatusBreakdown(): CampaignStatusBreakdown {
  return { newOrderBefore: 0, newOrderAfter: 0, pending: 0, shipping: 0, completed: 0 };
}

function emptyClaims(): CampaignClaims {
  return { canceled: 0, returned: 0, exchanged: 0 };
}

type MutableLeaf = {
  orderKeys: Set<string>;
  validLines: number;
  quantity: number;
  revenue: number;
  statusBreakdown: CampaignStatusBreakdown;
  poCandidates: AggregatePoCandidates;
  claims: CampaignClaims;
  items: Map<string, { orderKeys: Set<string>; quantity: number; revenue: number }>;
  /** 버킷번호 → 그 칸의 distinct 주문키·매출. 직렬화 시 [건수, 매출] 로 접는다. */
  buckets: Map<number, { orderKeys: Set<string>; revenue: number }>;
};

function newLeaf(): MutableLeaf {
  return {
    orderKeys: new Set(),
    validLines: 0,
    quantity: 0,
    revenue: 0,
    statusBreakdown: emptyStatusBreakdown(),
    poCandidates: { newBefore: [], newAfter: [], other: [] },
    claims: emptyClaims(),
    items: new Map(),
    buckets: new Map(),
  };
}

/** 품목 표시명 — computeCampaignSalesDetailForTargets 와 동일 규칙("상품명 · 옵션명"). */
function resolveItemName(order: PulseOrderLike): string {
  const productName = (order.productName ?? "").trim();
  const optionName = (order.productOption || order.productOptionName || "").trim();
  return optionName
    ? productName
      ? `${productName} · ${optionName}`
      : optionName
    : productName || "기타";
}

/**
 * 스냅샷 1행의 orders 배열 → 캠페인별·일자별 집계(v1). 순수 함수 — DB/네트워크 없음.
 *
 * campaigns 에는 **발주 연동된 판매캠페인 전수**(loadAggregationCampaignSources)를
 * 넘긴다. attributeOrders 의 "타 발주캠페인 소속" 배제 판정이 전체 집합을 전제로
 * 하기 때문이다(형제만 넘기면 데스크톱 집계와 판정이 어긋날 수 있다).
 */
export function computeSnapshotDailyAggregate(
  campaigns: PulseSalesCampaignSource[],
  orders: PulseOrderLike[],
): SnapshotDailyAggregate {
  const days = new Map<string, Map<string, MutableLeaf>>();

  const leafFor = (dateKey: string, campaignId: string): MutableLeaf => {
    let byCampaign = days.get(dateKey);
    if (!byCampaign) {
      byCampaign = new Map();
      days.set(dateKey, byCampaign);
    }
    let leaf = byCampaign.get(campaignId);
    if (!leaf) {
      leaf = newLeaf();
      byCampaign.set(campaignId, leaf);
    }
    return leaf;
  };

  attributeOrders(campaigns, orders, (order, targetSc, mappingPrice) => {
    const status = order.productOrderStatus ?? "";
    const dateKey = resolveOrderDateKey(order) ?? UNDATED_DAY_KEY;

    // 클레임 — 유효 집계 제외, 별도 카운트(computeCampaignSalesDetailForTargets 동일)
    if (status === "CANCELED") {
      leafFor(dateKey, targetSc.id).claims.canceled += 1;
      return;
    }
    if (status === "RETURNED") {
      leafFor(dateKey, targetSc.id).claims.returned += 1;
      return;
    }
    if (status === "EXCHANGED") {
      leafFor(dateKey, targetSc.id).claims.exchanged += 1;
      return;
    }
    if (INVALID_ORDER_STATUSES.includes(status)) return; // PAYMENT_WAITING 등

    const leaf = leafFor(dateKey, targetSc.id);
    const key = resolveOrderCountKey(order);
    const qty = Number(order.quantity) || 1;
    const revenue = resolveOrderRevenue(order, qty, mappingPrice);

    if (key) leaf.orderKeys.add(key);
    leaf.validLines += 1;
    leaf.quantity += qty;
    leaf.revenue += revenue;

    // 상태 분포 — poRequested=false 기준(읽기 시 applyPoRequestedSplit 으로 보정).
    const bucket = deriveOrderPipelineBucket(status, order.placeOrderStatus, false);
    if (bucket === "newBefore") leaf.statusBreakdown.newOrderBefore += 1;
    else if (bucket === "newAfter") leaf.statusBreakdown.newOrderAfter += 1;
    else if (bucket === "pending") leaf.statusBreakdown.pending += 1;
    else if (bucket === "shipping") leaf.statusBreakdown.shipping += 1;
    else if (bucket === "completed") leaf.statusBreakdown.completed += 1;

    // poRequested=true 였다면 pending 으로 뒤집혔을 라인의 후보 등록.
    // deriveOrderPipelineBucket 순서상 completed/shipping/무효는 플래그와 무관하다.
    if (bucket === "newBefore" || bucket === "newAfter" || bucket === "other") {
      const productOrderId = order.productOrderId == null ? "" : String(order.productOrderId);
      if (productOrderId) leaf.poCandidates[bucket].push(productOrderId);
    }

    // 품목별 — distinct 주문키를 함께 영속(일자·캠페인 간 union 합성용)
    const itemName = resolveItemName(order);
    let item = leaf.items.get(itemName);
    if (!item) {
      item = { orderKeys: new Set(), quantity: 0, revenue: 0 };
      leaf.items.set(itemName, item);
    }
    if (key) item.orderKeys.add(key);
    item.quantity += qty;
    item.revenue += revenue;

    // 인트라데이 — 날짜키와 같은 시각 원천을 쓴다(위 resolveIntradayBucketIndex 주석).
    // 시각이 없는 주문(일자미상)은 버킷도 없다.
    const bucketIndex = resolveIntradayBucketIndex(order);
    if (bucketIndex !== null) {
      let slot = leaf.buckets.get(bucketIndex);
      if (!slot) {
        slot = { orderKeys: new Set(), revenue: 0 };
        leaf.buckets.set(bucketIndex, slot);
      }
      if (key) slot.orderKeys.add(key);
      slot.revenue += revenue;
    }
  });

  const serializedDays: SnapshotDailyAggregate["days"] = {};
  for (const [dateKey, byCampaign] of days) {
    const out: Record<string, CampaignDayAggregate> = {};
    for (const [campaignId, leaf] of byCampaign) {
      out[campaignId] = {
        orderKeys: [...leaf.orderKeys],
        validLines: leaf.validLines,
        quantity: leaf.quantity,
        revenue: leaf.revenue,
        statusBreakdown: leaf.statusBreakdown,
        poCandidates: leaf.poCandidates,
        claims: leaf.claims,
        items: [...leaf.items.entries()].map(([name, item]) => ({
          name,
          orderKeys: [...item.orderKeys],
          quantity: item.quantity,
          revenue: item.revenue,
        })),
        buckets: serializeBuckets(leaf.buckets),
      };
    }
    serializedDays[dateKey] = out;
  }

  return {
    v: SNAPSHOT_DAILY_AGGREGATE_VERSION,
    bv: SNAPSHOT_INTRADAY_BUCKET_VERSION,
    campaignIds: campaigns.map((sc) => sc.id),
    days: serializedDays,
  };
}

/** 버킷 맵 → 희소 직렬화(번호 오름차순). 빈 칸은 넣지 않는다. */
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
 * **버킷만 이식한다** — 과거 행 백필 전용 병합(2026-08-02).
 *
 * 백필은 `computeSnapshotDailyAggregate` 로 과거 스냅샷을 재계산하는데, 귀속 우주
 * (`loadAggregationCampaignSources`)가 `orderCampaign.isActive` 게이트를 쓰므로 **그 사이
 * 마감된 캠페인의 리프가 재계산 결과에서 통째로 사라진다.** 그대로 쓰면 멀쩡히 저장돼
 * 있던 집계가 파괴된다.
 *
 * 종전 백필은 이를 "주문키가 줄면 **행 전체**를 건너뛴다"로 막았는데, 그 대가로 **같은 행에
 * 들어 있던 활성 캠페인까지 영구히 버킷을 못 받았다** — 마감 캠페인 하나가 섞여 있다는
 * 이유만으로 행이 통째로 스킵됐기 때문이다. 실측: 한 활성 그룹에서 **주문이 가장 몰린
 * 캠페인 초반 구간**이 이 이유로 화면에 「기록 없음」 회색 밴드로 남았다.
 *
 * ⛔ **우주를 넓혀 마감 캠페인을 넣는 방향으로 고치지 말 것** — P7 계약이 명시적으로
 * 금지한다("마감 캠페인을 넣으면 상품명이 겹치는 라인이 모바일에서만 배제돼 과소집계된다").
 * 마감 캠페인의 인트라데이는 별도 경로(마감 시점 동결)가 담당한다.
 *
 * 그래서 이 함수의 계약은 **순수 가산**이다 — 기존 수치를 한 글자도 바꾸지 않는다:
 * - 리프를 추가하지도 제거하지도 않는다(`orderKeys`·`revenue`·`statusBreakdown` 전부 보존).
 * - `orderKeys` 집합이 **정확히 같은** 리프에만 `buckets` 를 붙인다. 귀속이 달라진 리프는
 *   버킷 합 ≠ 일별 값이 되어 "보이는 막대의 합 = 그 구간 주문 합" 불변식이 깨지므로 건너뛴다.
 * - `campaignIds` 는 **건드리지 않는다.** 재계산 우주와 합집합하면 그 사이 신설·연동된
 *   캠페인까지 커버로 선언돼, 멤버십 가드가 블롭 폴백 대신 집계를 신뢰하고 그 캠페인의
 *   실주문을 **0 으로 보고**하게 된다(가산이 아니라 은폐가 된다).
 * - `bv` 는 **한 리프라도 이식됐을 때만** 켠다 — 아무것도 못 받은 행은 백필 대상으로 남아야
 *   다음 실행이 다시 시도한다.
 */
export function graftIntradayBuckets(
  previous: SnapshotDailyAggregate,
  recomputed: SnapshotDailyAggregate,
): { merged: SnapshotDailyAggregate; grafted: number; mismatched: number } {
  let grafted = 0;
  let mismatched = 0;
  const days: SnapshotDailyAggregate["days"] = {};

  for (const [dateKey, byCampaign] of Object.entries(previous.days)) {
    const recomputedDay = recomputed.days[dateKey];
    const out: Record<string, CampaignDayAggregate> = {};
    for (const [campaignId, leaf] of Object.entries(byCampaign)) {
      const nextLeaf = recomputedDay?.[campaignId];
      if (nextLeaf?.buckets && sameOrderKeySet(leaf.orderKeys, nextLeaf.orderKeys)) {
        out[campaignId] = { ...leaf, buckets: nextLeaf.buckets };
        grafted += 1;
        continue;
      }
      // 재계산에 없는 리프(마감 캠페인)는 정상이고, 있는데 키가 다르면 귀속이 달라진 것이다.
      if (nextLeaf) mismatched += 1;
      out[campaignId] = leaf;
    }
    days[dateKey] = out;
  }

  return {
    merged: {
      ...previous,
      ...(grafted > 0 ? { bv: SNAPSHOT_INTRADAY_BUCKET_VERSION } : {}),
      days,
    },
    grafted,
    mismatched,
  };
}

/** 두 리프가 같은 주문 집합인가 — 버킷 이식의 전제(버킷 합이 일별 값과 일치해야 한다). */
function sameOrderKeySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const known = new Set(a);
  return b.every((key) => known.has(key));
}

// ============================================================================
// 읽기측: 파싱·멤버십 가드·윈도우 합성·poRequested 보정
// ============================================================================

/** DB 값(Postgres Json 객체 | sqlite 문자열 | null) → v1 집계. 형식 방어적 — 실패 시 null(블롭 폴백). */
export function parseSnapshotDailyAggregate(raw: unknown): SnapshotDailyAggregate | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as { v?: unknown; campaignIds?: unknown; days?: unknown };
  if (candidate.v !== SNAPSHOT_DAILY_AGGREGATE_VERSION) return null;
  if (!Array.isArray(candidate.campaignIds)) return null;
  if (!candidate.days || typeof candidate.days !== "object") return null;
  return candidate as SnapshotDailyAggregate;
}

/**
 * 이 집계 행이 대상 캠페인 전부를 커버하는가 — campaignIds 멤버십 가드.
 * false = 쓰기 이후 신설·연동된 캠페인이 있다 → 그 행은 블롭 폴백으로 재계산한다.
 */
export function aggregateCoversCampaigns(
  aggregate: SnapshotDailyAggregate,
  targetCampaignIds: Set<string>,
): boolean {
  const known = new Set(aggregate.campaignIds);
  for (const id of targetCampaignIds) {
    if (!known.has(id)) return false;
  }
  return true;
}

export type ComposedSalesDetail = {
  /** statusBreakdown 은 poRequested=false 기준 — applyPoRequestedSplit 로 보정할 것 */
  detail: CampaignSalesDetail;
  /** 대상 캠페인들의 pending 후보(중복 = 다중 귀속 라인, 현행 라인 단위 집계와 동치) */
  poCandidates: AggregatePoCandidates;
};

/** 인트라데이 1점 — 버킷 시작 시각(ms, UTC epoch)과 그 10분의 주문·매출. */
export type IntradayPoint = {
  /** 버킷 시작 시각(ms). KST 일 경계 + 버킷번호 × 10분. */
  startMs: number;
  orders: number;
  revenue: number;
};

export type ComposedIntraday = {
  points: IntradayPoint[];
  /**
   * 버킷이 없어 인트라데이를 만들 수 없었던 날짜(구 집계 행). 화면이 "데이터 없음"과
   * "아직 안 채워짐"을 구분해 정직하게 고지하기 위한 것 — 삼키지 않는다(P0).
   */
  daysWithoutBuckets: string[];
};

const KST_DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** dateKey(YYYY-MM-DD KST) → 그 날 KST 자정의 UTC epoch ms. */
function kstDayStartMs(dateKey: string): number | null {
  const parsed = Date.parse(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : parsed - KST_OFFSET_MS;
}

/**
 * 집계 행들 → 대상 캠페인의 인트라데이 점 열(버킷 시각 오름차순).
 *
 * 조합 캠페인에서 한 결제가 멤버 여럿에 걸치면 **버킷 단계에서는 중복 제거가 불가능하다**
 * (버킷은 키가 아니라 카운트를 담는다 — IntradayBucketEntry 주석). 그래서 같은 버킷의
 * 멤버별 값을 **합산**하며, 이 점 열은 **모양(봉우리 위치·상대 크기) 판독용**이고
 * 정확한 건수의 정본은 계속 일별 `composeSalesDetailFromAggregates` 다. 화면에서 두 수치를
 * 나란히 "같은 값"으로 제시하지 말 것.
 */
export function composeIntradayFromAggregates(
  aggregates: SnapshotDailyAggregate[],
  targetCampaignIds: Set<string>,
): ComposedIntraday {
  const byStartMs = new Map<number, { orders: number; revenue: number }>();
  const daysWithoutBuckets = new Set<string>();

  for (const aggregate of aggregates) {
    for (const [dateKey, byCampaign] of Object.entries(aggregate.days)) {
      if (dateKey === UNDATED_DAY_KEY) continue; // 일자미상은 시각도 없다
      const dayStart = kstDayStartMs(dateKey);
      if (dayStart === null) continue;

      let sawTargetLeaf = false;
      let sawBuckets = false;
      for (const [campaignId, leaf] of Object.entries(byCampaign)) {
        if (!targetCampaignIds.has(campaignId)) continue;
        sawTargetLeaf = true;
        if (!leaf.buckets) continue;
        sawBuckets = true;
        for (const [rawIndex, entry] of Object.entries(leaf.buckets)) {
          const index = Number(rawIndex);
          if (!Number.isInteger(index) || index < 0 || index >= INTRADAY_BUCKETS_PER_DAY) continue;
          if (!Array.isArray(entry)) continue;
          const startMs = dayStart + index * INTRADAY_BUCKET_MS;
          const slot = byStartMs.get(startMs) ?? { orders: 0, revenue: 0 };
          slot.orders += Number(entry[0]) || 0;
          slot.revenue += Number(entry[1]) || 0;
          byStartMs.set(startMs, slot);
        }
      }
      // 주문이 있었던 날인데 버킷이 하나도 없으면 그 날은 구 집계다(주문 0인 날과 구분).
      if (sawTargetLeaf && !sawBuckets) daysWithoutBuckets.add(dateKey);
    }
  }

  const points = [...byStartMs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([startMs, slot]) => ({ startMs, orders: slot.orders, revenue: slot.revenue }));

  return { points, daysWithoutBuckets: [...daysWithoutBuckets].sort() };
}

/** 하루가 몇 ms 인지 — 버킷 열거·창 계산의 공용 상수(KST 는 DST 가 없다). */
export const KST_DAY_LENGTH_MS = KST_DAY_MS;

/**
 * 집계 행들 → 대상 캠페인 창 합성(CampaignSalesDetail).
 *
 * - daily[] = 일별 리프 그대로(orders = 그날 대상 캠페인 orderKeys **union** 크기 —
 *   조합 캠페인에서 한 결제가 멤버 여럿에 걸쳐도 1건).
 * - cumulative.orders = 일별 union 합 (+ 일자미상 union). 주문은 일자 귀속이
 *   유일하므로(모듈 헤더 불변식) 일별 distinct 합 = 윈도우 distinct 다.
 * - statusBreakdown/claims/quantity/revenue = 일별 합산. items = name 병합
 *   (orderKeys union → distinct 유지).
 */
export function composeSalesDetailFromAggregates(
  aggregates: SnapshotDailyAggregate[],
  todayKey: string,
  targetCampaignIds: Set<string>,
): ComposedSalesDetail {
  const dayBuckets = new Map<
    string,
    { orderKeys: Set<string>; validLines: number; quantity: number; revenue: number }
  >();
  const statusBreakdown = emptyStatusBreakdown();
  const claims = emptyClaims();
  const poCandidates: AggregatePoCandidates = { newBefore: [], newAfter: [], other: [] };
  const itemMap = new Map<string, { orderKeys: Set<string>; quantity: number; revenue: number }>();

  for (const aggregate of aggregates) {
    for (const [dateKey, byCampaign] of Object.entries(aggregate.days)) {
      for (const campaignId of targetCampaignIds) {
        const leaf = byCampaign[campaignId];
        if (!leaf) continue;

        let day = dayBuckets.get(dateKey);
        if (!day) {
          day = { orderKeys: new Set(), validLines: 0, quantity: 0, revenue: 0 };
          dayBuckets.set(dateKey, day);
        }
        for (const key of leaf.orderKeys) day.orderKeys.add(key);
        day.validLines += leaf.validLines;
        day.quantity += leaf.quantity;
        day.revenue += leaf.revenue;

        statusBreakdown.newOrderBefore += leaf.statusBreakdown.newOrderBefore;
        statusBreakdown.newOrderAfter += leaf.statusBreakdown.newOrderAfter;
        statusBreakdown.pending += leaf.statusBreakdown.pending;
        statusBreakdown.shipping += leaf.statusBreakdown.shipping;
        statusBreakdown.completed += leaf.statusBreakdown.completed;

        claims.canceled += leaf.claims.canceled;
        claims.returned += leaf.claims.returned;
        claims.exchanged += leaf.claims.exchanged;

        poCandidates.newBefore.push(...leaf.poCandidates.newBefore);
        poCandidates.newAfter.push(...leaf.poCandidates.newAfter);
        poCandidates.other.push(...leaf.poCandidates.other);

        for (const item of leaf.items) {
          let merged = itemMap.get(item.name);
          if (!merged) {
            merged = { orderKeys: new Set(), quantity: 0, revenue: 0 };
            itemMap.set(item.name, merged);
          }
          for (const key of item.orderKeys) merged.orderKeys.add(key);
          merged.quantity += item.quantity;
          merged.revenue += item.revenue;
        }
      }
    }
  }

  const cumulative = { orders: 0, quantity: 0, revenue: 0 };
  const today = { orders: 0, quantity: 0, revenue: 0 };
  const daily: CampaignDailyPoint[] = [];

  for (const [dateKey, day] of dayBuckets) {
    cumulative.orders += day.orderKeys.size;
    cumulative.quantity += day.quantity;
    cumulative.revenue += day.revenue;
    if (dateKey === UNDATED_DAY_KEY) continue; // 일자미상 — 누적에만 반영
    if (day.validLines === 0) continue; // 클레임-only 일자는 daily 포인트 미발행(현행 동일)
    if (dateKey === todayKey) {
      today.orders = day.orderKeys.size;
      today.quantity = day.quantity;
      today.revenue = day.revenue;
    }
    daily.push({ date: dateKey, orders: day.orderKeys.size, revenue: day.revenue });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  const items: CampaignItemSales[] = [...itemMap.entries()]
    .map(([name, bucket]) => ({
      name,
      orders: bucket.orderKeys.size,
      quantity: bucket.quantity,
      revenue: bucket.revenue,
    }))
    .sort(
      (a, b) =>
        b.revenue - a.revenue || b.quantity - a.quantity || a.name.localeCompare(b.name, "ko"),
    );

  return {
    detail: { cumulative, today, statusBreakdown, claims, daily, items },
    poCandidates,
  };
}

/**
 * poRequested 보정 — 발주요청 발송된 상품주문(poRequestedSet)을 배송대기로 이동한다.
 * deriveOrderPipelineBucket(…, poRequested=true) 와 동치: 기저 newBefore/newAfter
 * 라인은 pending 으로 이동(감산), 기저 other 라인은 pending 에 가산만 한다.
 * 순수 함수 — 입력 breakdown 을 변형하지 않고 새 객체를 돌려준다.
 */
export function applyPoRequestedSplit(
  statusBreakdown: CampaignStatusBreakdown,
  poCandidates: AggregatePoCandidates,
  poRequestedSet: Set<string>,
): CampaignStatusBreakdown {
  const result = { ...statusBreakdown };
  for (const id of poCandidates.newBefore) {
    if (poRequestedSet.has(id)) {
      result.newOrderBefore -= 1;
      result.pending += 1;
    }
  }
  for (const id of poCandidates.newAfter) {
    if (poRequestedSet.has(id)) {
      result.newOrderAfter -= 1;
      result.pending += 1;
    }
  }
  for (const id of poCandidates.other) {
    if (poRequestedSet.has(id)) result.pending += 1;
  }
  return result;
}

/**
 * 집계 행들 → todayKey 의 캠페인별 (distinct 주문건수·매출). 펄스 byCampaign 용.
 * 캠페인 간 union 이 아니라 **캠페인별** 집계다 — 조합 캠페인에서 한 결제가 멤버
 * 여럿에 걸치면 각 캠페인 행에 각각 1건으로 잡힌다(현행 computePulse 동일).
 */
export function collectTodayByCampaign(
  aggregates: SnapshotDailyAggregate[],
  todayKey: string,
  targetCampaignIds: Set<string>,
): Map<string, { orders: number; revenue: number }> {
  const buckets = new Map<string, { orderKeys: Set<string>; revenue: number }>();
  for (const aggregate of aggregates) {
    const byCampaign = aggregate.days[todayKey];
    if (!byCampaign) continue;
    for (const campaignId of targetCampaignIds) {
      const leaf = byCampaign[campaignId];
      if (!leaf) continue;
      let bucket = buckets.get(campaignId);
      if (!bucket) {
        bucket = { orderKeys: new Set(), revenue: 0 };
        buckets.set(campaignId, bucket);
      }
      for (const key of leaf.orderKeys) bucket.orderKeys.add(key);
      bucket.revenue += leaf.revenue;
    }
  }
  return new Map(
    [...buckets.entries()].map(([campaignId, bucket]) => [
      campaignId,
      { orders: bucket.orderKeys.size, revenue: bucket.revenue },
    ]),
  );
}

// ============================================================================
// 윈도우 로더 — 집계 컬럼만 select, 못 쓰는 행만 블롭 폴백 (읽기 표면 공용)
// ============================================================================

/** 로더가 요구하는 최소 스냅샷 조회 표면 — postgres/sqlite 클라이언트 모두 만족. */
export type PrismaLikeForWindowAggregates = PrismaLikeForAggregation & {
  naverOrderSnapshot: {
    findMany(args: {
      where: { snapshotDate: { gte?: string; lte?: string; in?: string[] } };
      orderBy?: { snapshotDate: "asc" };
      select: Record<string, true>;
    }): Promise<Array<{ snapshotDate?: string; dailyAggregate?: unknown; orders?: unknown }>>;
  };
};

function safeJsonParseLocal(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 조회 창의 스냅샷 집계 로드 — 신규 dailyAggregate 컬럼만 읽고, 못 쓰는 행만 블롭으로 폴백한다.
 *
 * 행 단위 판정(전부-아니면-전무가 아니다):
 * - 파싱 성공 + 버전 일치 + campaignIds가 대상 캠페인 전부를 커버 → 집계 사용(블롭 미조회).
 * - null(레거시 행) · {v:0}(쓰기 시 계산 실패) · 버전 불일치 · 멤버십 미커버(스냅샷을 쓴
 *   뒤 신설·연동된 캠페인) → 그 행만 orders 블롭을 읽어 **같은 함수**로 인메모리 재계산.
 *
 * 폴백도 쓰기 경로와 동일한 캠페인 우주(loadAggregationCampaignSources)를 쓴다 —
 * 그래야 집계 행과 폴백 행이 섞여도 귀속 판정이 한 규칙으로 일관된다.
 */
/**
 * live 조회 창의 **절대 상한(일)** — ⛔ **도메인 규칙이 아니라 폭주 가드다.**
 *
 * 막는 것은 단 하나: 발주 마감(`isActive=false`)을 영영 누르지 않은 캠페인에서 조회 창이
 * 무한히 자라는 것. 캠페인 자체는 최대 30일 안쪽으로 운영되므로(오너) 정상 운영에서는
 * 여기에 걸리지 않는다.
 *
 * ⛔ **이 숫자를 "N일보다 오래된 건 안 본다"는 규칙으로 읽지 말 것** — 그 오독이 정확히
 * 아래 실사고의 원인이었다. 창을 `now − N일`로 **하한**하면 캠페인 시작일은 고정인데
 * 하한은 매일 전진하므로, 시작 후 N일이 지나는 순간부터 캠페인 **초반 날짜가 하루에 하나씩
 * 조회 밖으로 밀려나 집계가 조용히 줄어든다.** 차트 표시가 아니라 **주문 건수·매출 숫자
 * 자체**가 주는 침묵형 결함이고, 노출 구간은 *캠페인 종료 ~ 발주 마감 사이*라
 * **"마감을 늦게 누를수록 수치가 줄어드는"** 형태로 나타난다(마감하면 cached 경로가 전 기간
 * 동결본을 읽어 자연 치유되므로 사후 재현도 어렵다).
 *
 * ⛔ **숫자만 키우는 수정을 하지 말 것** — 같은 결함이 뒤로 미뤄질 뿐 구조가 그대로다.
 * 창의 시작은 **캠페인 창**이 정해야 한다(P7 Campaign Period SSOT = 판매관리 일정).
 */
export const MAX_LIVE_WINDOW_DAYS = 90;

export type LiveWindowKeys = {
  /** 실제 조회 시작 dateKey(KST) */
  startKey: string;
  /** 조회 종료 dateKey(KST) = 오늘 */
  todayKey: string;
  /**
   * 절대 상한에 걸려 캠페인 시작 이후 일부 날짜를 못 읽었는가. 삼키지 않는다(P0) —
   * true 면 그 구간은 "주문 0"이 아니라 **"조회한 적 없음"**이다.
   */
  truncated: boolean;
};

/**
 * live 스냅샷 조회 창 결정 SSOT — 모바일 매출 상세·펄스가 공유한다.
 *
 * 시작은 **캠페인 창**(형제 회차 최초 시작일)이 정하고, `MAX_LIVE_WINDOW_DAYS` 는 폭주
 * 가드로만 쓴다. 두 로더가 각자 계산하면 같은 캠페인이 홈과 상세에서 다른 숫자를 낸다.
 */
export function resolveLiveWindowKeys(
  earliestStartMs: number,
  now: Date,
  logTag = "daily-aggregate",
): LiveWindowKeys {
  const todayKey = toDateKeyKst(now);
  const guardMs = now.getTime() - MAX_LIVE_WINDOW_DAYS * KST_DAY_MS;
  const hasStart = Number.isFinite(earliestStartMs);
  const truncated = hasStart && earliestStartMs < guardMs;
  const startMs = hasStart ? Math.max(earliestStartMs, guardMs) : guardMs;

  if (truncated) {
    // 폴백·결손은 조용히 넘어가지 않는다(loadWindowAggregates 의 블롭 폴백 경고와 같은 규율).
    console.warn(
      `[${logTag}] 조회 창이 절대 상한(${MAX_LIVE_WINDOW_DAYS}일)에 걸려 잘렸습니다 — ` +
        `캠페인 시작 ${toDateKeyKst(new Date(earliestStartMs))} 이전 구간은 조회되지 않습니다. ` +
        `해당 발주 캠페인이 마감되지 않은 채 오래 열려 있는지 확인하세요.`,
    );
  }

  return { startKey: toDateKeyKst(new Date(startMs)), todayKey, truncated };
}

export async function loadWindowAggregates(
  prisma: PrismaLikeForWindowAggregates,
  startKey: string,
  todayKey: string,
  targetCampaignIds: Set<string>,
  logTag = "daily-aggregate",
): Promise<SnapshotDailyAggregate[]> {
  const rows = await prisma.naverOrderSnapshot.findMany({
    where: { snapshotDate: { gte: startKey, lte: todayKey } },
    orderBy: { snapshotDate: "asc" },
    select: { snapshotDate: true, dailyAggregate: true },
  });

  const aggregates: SnapshotDailyAggregate[] = [];
  const fallbackDateKeys: string[] = [];
  for (const row of rows) {
    const parsed = parseSnapshotDailyAggregate(row.dailyAggregate);
    if (parsed && aggregateCoversCampaigns(parsed, targetCampaignIds)) {
      aggregates.push(parsed);
    } else if (row.snapshotDate) {
      fallbackDateKeys.push(row.snapshotDate);
    }
  }

  if (fallbackDateKeys.length === 0) return aggregates;

  // 폴백은 조용히 넘어가지 않는다 — 절감이 적용되지 않은 행을 관측 가능하게 남긴다.
  console.warn(
    `[${logTag}] dailyAggregate 미가용 ${fallbackDateKeys.length}행 — orders 블롭 폴백:`,
    fallbackDateKeys.join(","),
  );

  const [legacyRows, universe] = await Promise.all([
    prisma.naverOrderSnapshot.findMany({
      where: { snapshotDate: { in: fallbackDateKeys } },
      select: { orders: true },
    }),
    loadAggregationCampaignSources(prisma),
  ]);

  for (const row of legacyRows) {
    const parsed = typeof row.orders === "string" ? safeJsonParseLocal(row.orders) : row.orders;
    const orders = Array.isArray(parsed) ? (parsed as PulseOrderLike[]) : [];
    aggregates.push(computeSnapshotDailyAggregate(universe, orders));
  }
  return aggregates;
}

// ============================================================================
// 캠페인 소스 로더 — 쓰기 경로(repository)와 읽기 폴백이 같은 우주를 쓴다
// ============================================================================

type SalesCampaignRowForAggregation = {
  id: string;
  startDate: Date | string;
  endDate: Date | string;
  campaignDeals: Array<{ id: string }>;
  orderCampaign: {
    id: string;
    name: string;
    productId: string | null;
    mappings: Array<{
      productName: string | null;
      optionName: string | null;
      price: number | null;
      campaignDealId: string | null;
    }>;
  } | null;
};

/** 로더가 요구하는 최소 prisma 표면 — postgres/sqlite 클라이언트 모두 만족. */
export type PrismaLikeForAggregation = {
  salesCampaign: {
    findMany(args: {
      where: { orderCampaign: { isActive: true } };
      select: Record<string, unknown>;
    }): Promise<unknown[]>;
  };
};

/**
 * 진행중(isActive) 발주 캠페인에 연동된 판매캠페인 → attributeOrders 입력 소스.
 * dealName/sellerName 은 귀속 판정에 쓰이지 않으므로 빈 문자열로 채운다(조인 절약).
 *
 * **isActive 게이트는 데스크톱과의 수치 정합 조건이다(제거 금지).** attributeOrders 의
 * belongsToOther(mobile-pulse-data.ts)는 "상품명이 다른 발주 캠페인명을 포함하면 그쪽
 * 주문으로 간주"해 라인을 배제하는데, 그 배제 우주가 데스크톱(campaigns-handler 의
 * activeCampaigns = isActive 필터)과 달라지면 같은 주문이 두 화면에서 다르게 집계된다.
 * 마감 캠페인까지 우주에 넣으면, 반년 전 마감 캠페인명과 상품명이 겹치는 라인이
 * 모바일에서만 조용히 누락된다(에러 없이 과소집계 — P7 수치 정합성 위반).
 * `orderCampaignId: { not: null }` 전수로 되돌리지 말 것.
 */
export async function loadAggregationCampaignSources(
  prisma: PrismaLikeForAggregation,
): Promise<PulseSalesCampaignSource[]> {
  const rows = (await prisma.salesCampaign.findMany({
    // orderCampaign 관계 필터는 orderCampaignId not-null 도 함께 만족시킨다(inner join).
    where: { orderCampaign: { isActive: true } },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      campaignDeals: { select: { id: true } },
      orderCampaign: {
        select: {
          id: true,
          name: true,
          productId: true,
          mappings: {
            select: {
              productName: true,
              optionName: true,
              price: true,
              campaignDealId: true,
            },
          },
        },
      },
    },
  })) as SalesCampaignRowForAggregation[];

  return rows.map((sc) => ({
    id: sc.id,
    dealName: "",
    sellerName: "",
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
  }));
}
