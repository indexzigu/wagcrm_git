import {
  INVALID_ORDER_STATUSES,
  resolveOrderCountKey,
} from "@/lib/order-converter/group-orders";
import { computeSimilarityScore } from "@/lib/order-converter/similarity";
import { orderMatchesCampaignProductId } from "@/lib/order-converter/campaign-match";
import { deriveOrderPipelineBucket } from "@/lib/order-converter/order-fulfillment";

/**
 * 모바일 판매 펄스 데이터 (MOBILE_UX_PLAN §3-2 · Phase 2).
 *
 * 절대 게이트: 이 모듈(과 이를 소비하는 /api/mobile/pulse)은 네이버 동기화를
 * 트리거하지 않는다. DB에 이미 영속화된 NaverOrderSnapshot 만 읽는다.
 * - runSync / after() 백그라운드 sync / 네이버 API fetch 일절 없음.
 * - 그래서 naver-order-sync.ts(모듈이 naver-commerce-client 를 import)를 import 하지
 *   않고, KST 날짜키 등 작은 순수 헬퍼는 여기 로컬로 재구현한다(동일 규칙 주석 명시).
 *
 * 데이터 소스 결정:
 * - OrderCampaign.cached* 컬럼은 마감(isActive=false) 캠페인 전용 캐시라
 *   진행중 캠페인의 오늘/누적 집계에 쓸 수 없다(campaigns/route.ts:330-355).
 * - 따라서 스냅샷 orders Json 을 읽기 전용으로 파싱해, 데스크탑 집계
 *   (order-converter/api/campaigns/route.ts)의 유효주문·매출·주문건수 규칙을
 *   순수 함수로 미러링한다. 공유 가능한 순수 유틸(INVALID_ORDER_STATUSES,
 *   resolveOrderCountKey, computeSimilarityScore)은 그대로 재사용한다.
 * - 주문 건수는 반드시 distinct 주문번호(resolveOrderCountKey) 기준 —
 *   quantity 필드(구 orderCount 컬럼)는 "수량"이므로 주문 건수로 사용 금지.
 */

export type PulseTotals = {
  orders: number;
  quantity: number;
  revenue: number;
};

export type PulseCampaignEntry = {
  /** SalesCampaign.id */
  campaignId: string;
  dealName: string;
  /** 셀러 alias 우선(P2 규칙), 없으면 name */
  sellerName: string;
  todayOrders: number;
  todayRevenue: number;
};

/**
 * 진행중(ACTIVE) 전 캠페인의 배송 진행 상태 — 배타 3단계 퍼널(소유자 결정 2026-07-08).
 * 5단계 파이프라인(deriveOrderPipelineBucket)을 상단바용으로 접는다:
 * - ordered   = 배송 전 (newBefore + newAfter + pending)
 * - shipping  = 배송중
 * - completed = 배송완료/구매확정
 * 세 값은 배타적이라 합이 곧 집계 대상 전체 유효 주문(상품주문 라인 기준).
 */
export type PulseFulfillment = {
  ordered: number;
  shipping: number;
  completed: number;
};

export type MobilePulseResponse = {
  /** 최신 스냅샷 lastCallTime ISO — 스냅샷이 전무하면 null */
  asOf: string | null;
  today: PulseTotals;
  cumulative: PulseTotals;
  /** 진행중(ACTIVE) 캠페인만, 오늘 주문 내림차순 최대 8개 */
  byCampaign: PulseCampaignEntry[];
  /** 진행중 전 캠페인 배송 진행 상태 합계(배타 3단계) — 상단바 요약용 */
  fulfillment: PulseFulfillment;
};

/** computePulse 입력용 매핑 행 (ProductMapping 부분집합) */
export type PulseMappingSource = {
  productName: string | null;
  optionName: string | null;
  price: number | null;
  campaignDealId: string | null;
};

/** computePulse 입력용 발주 캠페인 (OrderCampaign 부분집합) */
export type PulseOrderCampaignSource = {
  id: string;
  name: string;
  productId: string | null;
  mappings: PulseMappingSource[];
};

/** computePulse 입력용 진행중 판매캠페인 */
export type PulseSalesCampaignSource = {
  id: string;
  dealName: string;
  sellerName: string;
  /** 캠페인 시작(ms) */
  startMs: number;
  /** 캠페인 종료 — KST 그 날의 23:59:59.999 로 확장한 ms (아래 endOfDayKstMs 참고) */
  endMs: number;
  /** 이 판매캠페인 소속 CampaignDeal.id 목록 — 매핑(campaignDealId) 기반 회차 귀속용 */
  campaignDealIds: string[];
  orderCampaign: PulseOrderCampaignSource | null;
};

/** 스냅샷 orders Json 의 한 행 — 집계에 쓰는 필드만 명시(나머지는 통과) */
export type PulseOrderLike = {
  orderId?: string | number | null;
  /**
   * 구매자 식별키(서버 내부 dedup 전용 — 응답엔 개수만 노출). ordererNo(네이버 회원
   * 9자리 번호, 실데이터 100% 채움·비마스킹) 우선, 폴백 ordererId(마스킹 로그인ID).
   * 회차간 재구매(cross-campaign-repurchase) 집계가 사용. PII이므로 절대 응답에 담지 않는다.
   */
  ordererNo?: string | number | null;
  ordererId?: string | number | null;
  productOrderId?: string | number | null;
  productOrderStatus?: string;
  /** PAYED 세분화(주문확인 전/후) 판정용 — NOT_YET 이면 발주 전 */
  placeOrderStatus?: string;
  productClass?: string;
  productId?: string | number | null;
  /** 네이버 원상품번호 — 캠페인 productId(원상품 저장)와의 매칭에 productId와 함께 후보키로 씀 */
  originalProductId?: string | number | null;
  productName?: string;
  productOption?: string;
  productOptionName?: string;
  quantity?: number | string;
  totalPaymentAmount?: number;
  productDiscountAmount?: number;
  sellerBurdenDiscountAmount?: number;
  paymentDate?: string;
  orderDate?: string;
  orderCreateDate?: string;
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * KST 기준 YYYY-MM-DD 날짜키.
 * naver-order-sync.ts 의 toDateKeyKst 와 동일 규칙 — 해당 모듈은 네이버 API 클라이언트를
 * import 하므로(게이트 위반 소지) 여기 순수 재구현한다.
 */
export function toDateKeyKst(date: Date): string {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 주어진 시각이 속한 KST 날짜의 23:59:59.999 를 ms 로 반환.
 * 캠페인 endDate 가 자정으로 저장돼 있어도 마감일 당일 주문이 기간 밖으로
 * 밀려나지 않게 한다(데스크탑도 salePeriod 파싱 시 종료일을 23:59:59.999+09:00 로 취급).
 */
export function endOfDayKstMs(date: Date): number {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  kst.setUTCHours(23, 59, 59, 999);
  return kst.getTime() - KST_OFFSET_MS;
}

/**
 * 주문 시각(ms) — 결제일 우선, 없으면 0 (campaigns/route.ts 와 동일 규칙).
 * export 인 이유: 인트라데이 버킷(daily-aggregate)이 **날짜키와 같은 시각 원천**을 써야
 * "버킷 합 = 그날 일별 값"이 성립한다. 시각 파싱을 다시 쓰면 그 등식이 조용히 깨진다.
 */
export function resolveOrderTimeMs(order: PulseOrderLike): number {
  const raw = order.paymentDate || order.orderDate || order.orderCreateDate;
  if (!raw) return 0;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** 주문의 KST 날짜키 — 시각이 없으면 null */
export function resolveOrderDateKey(order: PulseOrderLike): string | null {
  const t = resolveOrderTimeMs(order);
  return t > 0 ? toDateKeyKst(new Date(t)) : null;
}

const normalizeStr = (str: string) =>
  (str || "").replace(/[^a-zA-Z0-9가-힣]/g, "").toLowerCase();

/**
 * 주문 1행 ↔ 발주 캠페인 매핑 후보 중 최고점 매핑 (campaigns/route.ts:428-475 미러).
 */
function findBestMapping(
  pName: string,
  oName: string,
  mappings: PulseMappingSource[],
): PulseMappingSource | null {
  const normPName = normalizeStr(pName);
  const normOName = normalizeStr(oName);

  let bestMapping: PulseMappingSource | null = null;
  let highestScore = -1;

  for (const m of mappings) {
    const hasProduct = !!m.productName;
    const hasOption = !!m.optionName;
    if (!hasProduct && !hasOption) continue;

    let productMatches = false;
    let pScore = 0;
    if (hasProduct) {
      pScore = computeSimilarityScore(m.productName!, pName);
      const normMProd = normalizeStr(m.productName!);
      const exactIncludes =
        normMProd.length > 0 &&
        ((normPName.length > 0 && normPName.includes(normMProd)) ||
          normMProd.includes(normPName));
      if (pScore > 0.5 || exactIncludes) productMatches = true;
    }

    let optionMatches = false;
    let oScore = 0;
    if (hasOption) {
      oScore = computeSimilarityScore(m.optionName!, oName);
      const normMOpt = normalizeStr(m.optionName!);
      const exactIncludes =
        normMOpt.length > 0 &&
        ((normOName.length > 0 && normOName.includes(normMOpt)) ||
          normMOpt.includes(normOName));
      if (oScore > 0.5 || exactIncludes) optionMatches = true;
    }

    let isMatch = false;
    if (hasProduct && hasOption) isMatch = productMatches && optionMatches;
    else if (hasProduct) isMatch = productMatches;
    else if (hasOption) isMatch = optionMatches;

    if (isMatch) {
      const totalScore = (hasProduct ? pScore : 0) + (hasOption ? oScore : 0);
      if (totalScore > highestScore) {
        highestScore = totalScore;
        bestMapping = m;
      }
    }
  }
  return bestMapping;
}

/**
 * 추가구성상품(추가옵션) 귀속용 옵션명 단독 매칭 (campaigns/route.ts:15-34 미러).
 */
function findMappingByOptionName(
  oName: string,
  mappings: PulseMappingSource[],
): PulseMappingSource | null {
  const normOName = normalizeStr(oName);
  if (!normOName) return null;
  let bestMapping: PulseMappingSource | null = null;
  let highestScore = -1;
  for (const m of mappings) {
    if (!m.optionName) continue;
    const normMOpt = normalizeStr(m.optionName);
    if (!normMOpt) continue;
    const oScore = computeSimilarityScore(m.optionName, oName);
    const exactIncludes = normOName.includes(normMOpt) || normMOpt.includes(normOName);
    if (oScore > 0.5 || exactIncludes) {
      const score = oScore + (exactIncludes ? 1 : 0);
      if (score > highestScore) {
        highestScore = score;
        bestMapping = m;
      }
    }
  }
  return bestMapping;
}

/** 유효 주문 매출액 (campaigns/route.ts:537-541 미러 — 네이버 부담 할인 가산 포함) */
export function resolveOrderRevenue(
  order: PulseOrderLike,
  qty: number,
  mappingPrice: number,
): number {
  const naverDiscount = Math.max(
    0,
    (order.productDiscountAmount || 0) - (order.sellerBurdenDiscountAmount || 0),
  );
  const baseAmount = (Number(order.totalPaymentAmount) || 0) + naverDiscount;
  return baseAmount || mappingPrice * qty;
}

type OcGroup = {
  oc: PulseOrderCampaignSource;
  campaigns: PulseSalesCampaignSource[];
};

type ScAccumulator = {
  campaign: PulseSalesCampaignSource;
  todayOrderKeys: Set<string>;
  todayRevenue: number;
};

/**
 * 매칭된 발주 캠페인 그룹 안에서 이 주문이 귀속될 판매캠페인을 고른다.
 * 1) 매칭 매핑의 campaignDealId 가 가리키는 진행중 캠페인(기간 내이거나 시각 미상)
 * 2) 기간 포함 캠페인 중 시작일이 가장 늦은 것(회차 중복 대비 결정적 선택)
 * 3) 시각 미상 + 그룹에 캠페인이 1개뿐이면 그 캠페인
 */
function resolveTargetCampaign(
  group: OcGroup,
  orderTimeMs: number,
  mapping: PulseMappingSource | null,
  dealIdToCampaignId: Map<string, string>,
): PulseSalesCampaignSource | null {
  const inWindow = (sc: PulseSalesCampaignSource) =>
    orderTimeMs > 0 && orderTimeMs >= sc.startMs && orderTimeMs <= sc.endMs;

  const candidates = group.campaigns.filter(inWindow);

  if (mapping?.campaignDealId) {
    const mappedId = dealIdToCampaignId.get(mapping.campaignDealId);
    const mappedSc = mappedId
      ? group.campaigns.find((sc) => sc.id === mappedId)
      : undefined;
    if (mappedSc && (orderTimeMs === 0 || candidates.some((sc) => sc.id === mappedSc.id))) {
      return mappedSc;
    }
  }

  if (candidates.length > 0) {
    return candidates.reduce((latest, sc) => (sc.startMs > latest.startMs ? sc : latest));
  }

  if (orderTimeMs === 0 && group.campaigns.length === 1) {
    return group.campaigns[0];
  }

  return null;
}

/** 한 주문이 어떤 판매캠페인에 귀속됐는지 통지하는 콜백 (유효/무효 필터 없음 — 호출자 판단) */
export type AttributeCallback = (
  order: PulseOrderLike,
  targetSc: PulseSalesCampaignSource,
  mappingPrice: number,
) => void;

/**
 * 공유 귀속 이터레이터 — 스냅샷 주문을 발주 캠페인 그룹에 매칭해 각 주문이 귀속될
 * 판매캠페인을 정하고 onAttribute 를 호출한다. 매칭 규칙(campaigns/route.ts 미러)의
 * 단일 출처 — computePulse(오늘/누적)와 computeCampaignSalesDetail(캠페인 매출 상세)이 공유한다.
 * 유효/무효(취소·반품 등) 필터는 하지 않는다 — 콜백이 상태별로 판단한다(클레임 집계 등).
 */
export function attributeOrders(
  campaigns: PulseSalesCampaignSource[],
  orders: PulseOrderLike[],
  onAttribute: AttributeCallback,
): void {
  // 발주 캠페인(OrderCampaign) 단위 그룹 — 회차(1차/2차)가 같은 OC 를 공유한다.
  const ocGroups = new Map<string, OcGroup>();
  const dealIdToCampaignId = new Map<string, string>();

  for (const sc of campaigns) {
    // CampaignDeal 은 정확히 한 SalesCampaign 소속 — 매핑의 campaignDealId 를 회차 귀속 키로 쓴다.
    for (const dealId of sc.campaignDealIds) {
      dealIdToCampaignId.set(dealId, sc.id);
    }
    if (!sc.orderCampaign) continue;
    const existing = ocGroups.get(sc.orderCampaign.id);
    if (existing) {
      existing.campaigns.push(sc);
    } else {
      ocGroups.set(sc.orderCampaign.id, { oc: sc.orderCampaign, campaigns: [sc] });
    }
  }

  const groups = [...ocGroups.values()];

  // 이 캠페인(OC)에 귀속된 메인 품목 productId — 추가구성상품 2차 귀속용
  const matchedProductIdsByOc = new Map<string, Set<string>>();
  const deferredAddons: PulseOrderLike[] = [];

  // 1차 패스: 메인 품목 매칭 (campaigns/route.ts:403-616 의 매칭 규칙 미러)
  for (const order of orders) {
    if (!order) continue;

    if (order.productClass === "추가구성상품") {
      deferredAddons.push(order);
      continue;
    }

    const pName = order.productName || "";
    const oName = order.productOption || order.productOptionName || "";
    const orderTimeMs = resolveOrderTimeMs(order);

    for (const group of groups) {
      const { oc } = group;
      const bestMapping = findBestMapping(pName, oName, oc.mappings);

      let matchesCampName = false;
      if (oc.productId && (order.productId != null || order.originalProductId != null)) {
        if (orderMatchesCampaignProductId(order, oc.productId)) {
          if (pName.includes(oc.name) || oc.name.includes(pName)) matchesCampName = true;
        }
      } else if (pName.includes(oc.name) || oc.name.includes(pName)) {
        matchesCampName = true;
      }

      let isCampaignOrder = false;
      if (matchesCampName) {
        isCampaignOrder = true;
      } else if (bestMapping) {
        // 상품명이 다른 진행중 발주 캠페인명을 명시적으로 포함하면 그쪽 주문으로 간주
        const belongsToOther = groups.some(
          (other) =>
            other.oc.id !== oc.id &&
            (pName.includes(other.oc.name) || other.oc.name.includes(pName)),
        );
        if (!belongsToOther) isCampaignOrder = true;
      }

      if (!isCampaignOrder) continue;

      // 유효/무효와 무관하게 메인 귀속 productId 는 기록(데스크탑과 동일) —
      // 취소된 메인의 유효 추가옵션도 출고 대상이라 귀속이 필요하다.
      if (order.productId != null) {
        let set = matchedProductIdsByOc.get(oc.id);
        if (!set) {
          set = new Set<string>();
          matchedProductIdsByOc.set(oc.id, set);
        }
        set.add(String(order.productId));
      }

      const targetSc = resolveTargetCampaign(group, orderTimeMs, bestMapping, dealIdToCampaignId);
      if (targetSc) {
        onAttribute(order, targetSc, bestMapping?.price || 0);
      }
    }
  }

  // 2차 패스: 추가구성상품 — 같은 productId 의 메인이 귀속된 캠페인에 합산
  for (const order of deferredAddons) {
    if (order.productId == null) continue;
    const pid = String(order.productId);
    const oName = order.productOption || order.productOptionName || "";
    const orderTimeMs = resolveOrderTimeMs(order);

    for (const group of groups) {
      if (!matchedProductIdsByOc.get(group.oc.id)?.has(pid)) continue;
      const addonMapping = findMappingByOptionName(oName, group.oc.mappings);
      const targetSc = resolveTargetCampaign(group, orderTimeMs, addonMapping, dealIdToCampaignId);
      // 추가옵션은 매핑 단가 폴백 없음(데스크탑과 동일: baseAmount || 0)
      if (targetSc) onAttribute(order, targetSc, 0);
    }
  }
}

export function computePulse(
  campaigns: PulseSalesCampaignSource[],
  orders: PulseOrderLike[],
  todayKey: string,
  poRequestedSet: Set<string> = new Set(),
): Pick<MobilePulseResponse, "today" | "cumulative" | "byCampaign" | "fulfillment"> {
  const scAccumulators = new Map<string, ScAccumulator>();
  for (const sc of campaigns) {
    scAccumulators.set(sc.id, { campaign: sc, todayOrderKeys: new Set(), todayRevenue: 0 });
  }

  const totals = {
    today: { orderKeys: new Set<string>(), quantity: 0, revenue: 0 },
    cumulative: { orderKeys: new Set<string>(), quantity: 0, revenue: 0 },
  };
  // 배타 3단계 퍼널(item 2) — 상품주문 라인 단위로 deriveOrderPipelineBucket 판정 후 접기.
  const fulfillment: PulseFulfillment = { ordered: 0, shipping: 0, completed: 0 };

  attributeOrders(campaigns, orders, (order, targetSc, mappingPrice) => {
    const status = order.productOrderStatus ?? "";
    if (INVALID_ORDER_STATUSES.includes(status)) return;

    const key = resolveOrderCountKey(order);
    const qty = Number(order.quantity) || 1;
    const revenue = resolveOrderRevenue(order, qty, mappingPrice);
    const dateKey = resolveOrderDateKey(order);

    if (key) totals.cumulative.orderKeys.add(key);
    totals.cumulative.quantity += qty;
    totals.cumulative.revenue += revenue;

    // 배송 진행 상태(누적) — 오늘/기간과 무관하게 현 스냅샷의 진행 상태를 집계.
    const bucket = deriveOrderPipelineBucket(
      status,
      order.placeOrderStatus,
      poRequestedSet.has(String(order.productOrderId ?? "")),
    );
    if (bucket === "newBefore" || bucket === "newAfter" || bucket === "pending") {
      fulfillment.ordered += 1;
    } else if (bucket === "shipping") {
      fulfillment.shipping += 1;
    } else if (bucket === "completed") {
      fulfillment.completed += 1;
    }

    if (dateKey === todayKey) {
      if (key) totals.today.orderKeys.add(key);
      totals.today.quantity += qty;
      totals.today.revenue += revenue;

      const acc = scAccumulators.get(targetSc.id);
      if (acc) {
        if (key) acc.todayOrderKeys.add(key);
        acc.todayRevenue += revenue;
      }
    }
  });

  const byCampaign: PulseCampaignEntry[] = [...scAccumulators.values()]
    .map((acc) => ({
      campaignId: acc.campaign.id,
      dealName: acc.campaign.dealName,
      sellerName: acc.campaign.sellerName,
      todayOrders: acc.todayOrderKeys.size,
      todayRevenue: acc.todayRevenue,
    }))
    .sort(
      (a, b) =>
        b.todayOrders - a.todayOrders ||
        b.todayRevenue - a.todayRevenue ||
        a.dealName.localeCompare(b.dealName, "ko"),
    )
    .slice(0, 8);

  return {
    today: {
      orders: totals.today.orderKeys.size,
      quantity: totals.today.quantity,
      revenue: totals.today.revenue,
    },
    cumulative: {
      orders: totals.cumulative.orderKeys.size,
      quantity: totals.cumulative.quantity,
      revenue: totals.cumulative.revenue,
    },
    byCampaign,
    fulfillment,
  };
}

// getMobilePulse(DB 로더)는 mobile-pulse-loader.ts 로 이동했다(2026-07-15 egress 절감 —
// 스냅샷 orders 블롭 대신 dailyAggregate 를 읽는다). 이 모듈은 순수 집계·귀속 함수만
// 유지한다: daily-aggregate.ts 가 이 모듈을 import 하므로, 로더까지 여기 두면 순환이 된다.
