// 주문 ↔ 캠페인 상품(productId) 귀속 판정의 단일 진실.
//
// 실사고(PR#106): 캠페인 productId는 네이버 **원상품번호(originalProductId)**로 저장되는데,
// 주문 스냅샷의 1차 필드 `order.productId`는 **채널상품번호**라 서로 다르다(실측: 캠페인
// 13596784327 = 주문 originalProductId, 주문 productId는 13656745519). 그래서 채널번호만
// `order.productId === campaign.productId`로 비교하면 게이트가 **전량 실패**해, 매칭이 캠페인명·
// 매핑 폴백에만 의존하게 된다(취약: 매핑이 조금만 어긋나도 귀속 실패). 주문의 productId·
// originalProductId를 **둘 다** 후보키로 삼아 캠페인 productId와 비교한다.
//
// claim-derive.ts의 resolveOrderCampaignName이 동일 비대칭을 이미 이렇게 처리한다 — 여러
// 집계·발주 경로가 제각각 재구현해 어긋나지 않도록 이 순수 헬퍼로 고립시킨다.

import { pickBestMapping, type MappingLike } from './mapping-match';
import { isSupplementProduct } from './product-class';

/**
 * 주문이 캠페인의 상품에 productId로 귀속되는지 판정한다.
 * 캠페인 productId가 비어 있으면 false(호출부가 상품명·매핑 폴백으로 처리).
 */
export function orderMatchesCampaignProductId(
  order: { productId?: unknown; originalProductId?: unknown } | null | undefined,
  campaignProductId: unknown,
): boolean {
  if (campaignProductId == null || String(campaignProductId).trim() === '') return false;
  const target = String(campaignProductId);
  return [order?.productId, order?.originalProductId]
    .filter((v) => v != null && String(v).trim() !== '')
    .some((v) => String(v) === target);
}

// ─────────────────────────────────────────────────────────────────────────────
// 같은 스토어 링크를 여러 캠페인이 순차로 쓰는 운영(오너 확정 2026-07-23)
//
// 실운영 패턴: **한 상품 링크의 상품명을 바꿔가며 셀러를 교체**해 회차를 이어 돌린다
// (예: "[셀러A X 브랜드] …" → "[셀러B X 브랜드] …"). 그래서 여러 캠페인이 같은
// `productId`를 가리키는 건 사고가 아니라 정상 상태다.
//
// ⚠️ 이때 **상품명은 소유권 신호가 될 수 없다.** 주문 스냅샷의 productName 은 그 라인이
// **마지막으로 동기화된 시점의 상품명**이라, 이름을 바꾸면 그 뒤 재싱크된 **과거 주문까지**
// 새 이름을 갖는다(실측 2026-07-23: 같은 날 안에서 결제 시각순으로 두 이름이 번갈아 등장).
// productId 도 같으므로 변별력이 0이다.
//
// ⇒ **분리 신호는 결제 시각 × 캠페인 판매기간(집계창)뿐이다.** 집계는 이미 캠페인별 창으로
//   주문을 먼저 거르므로(handler·closed-cache 공통), 창이 겹치지 않으면 분리는 자동으로 된다.
//   아래 헬퍼는 그 위에서 "매핑 폴백으로 주운 주문을 남에게 양보할지"를 판정한다.
// ─────────────────────────────────────────────────────────────────────────────

/** 교차 귀속 가드용 이웃 캠페인 — 이름과 집계창(ms). 창이 null 이면 미확정. */
export type PeerCampaignWindow = {
  id?: string | null;
  name: string;
  windowStartMs?: number | null;
  windowEndMs?: number | null;
};

/** 이 이웃 캠페인의 집계창이 해당 결제 시각을 담을 수 있는가(= 그 주문의 주인일 수 있는가). */
function peerWindowCanHold(peer: PeerCampaignWindow, orderTimeMs: number): boolean {
  // 결제 시각 불명 → 창으로 배제할 근거가 없으므로 담을 수 있다고 본다(보수적).
  if (!Number.isFinite(orderTimeMs) || orderTimeMs <= 0) return true;
  const start = peer.windowStartMs ?? null;
  const end = peer.windowEndMs ?? null;
  if (start === null && end === null) return true; // 창 미확정 → 보수적으로 양보 허용
  if (start !== null && orderTimeMs < start) return false;
  if (end !== null && orderTimeMs > end) return false;
  return true;
}

/**
 * 매핑 폴백으로 주운 주문을 **다른 캠페인에 양보해야 하는가**(라이브 handler 의 belongsToOther).
 *
 * 이름이 다른 캠페인을 가리키더라도, **그 캠페인의 집계창이 이 주문의 결제 시각을 담지 못하면
 * 양보하지 않는다.** 이 창 조건이 없으면 위의 순차 전환 운영에서 침묵 누락이 난다 —
 * 셀러A 회차(창 A)의 옛 주문이 이름 변경 후 재싱크돼 셀러B 이름을 갖게 되면,
 * A 는 "B 것"이라며 양보하고 B 는 창 밖이라 거르므로 **아무도 세지 않는다**.
 * (2026-07-23 조사에서 확인. 창 조건은 그 구멍만 막고, 창이 겹치는 구간의 동작은 종전과 같다.)
 *
 * @param pName 주문 상품명(원문)
 * @param orderTimeMs 결제 시각(ms). 0/NaN 이면 시각 불명으로 취급.
 * @param peers 자기 자신을 제외한 이웃 캠페인들
 */
export function orderBelongsToPeerCampaign(
  pName: string,
  orderTimeMs: number,
  peers: PeerCampaignWindow[],
): boolean {
  const name = pName || '';
  return peers.some((peer) => {
    if (!peer?.name) return false;
    const nameHit = name.includes(peer.name) || peer.name.includes(name);
    if (!nameHit) return false;
    return peerWindowCanHold(peer, orderTimeMs);
  });
}

/**
 * 같은 상품 링크를 가리키면서 **집계창이 겹치는** 캠페인 쌍을 찾는다.
 *
 * 순차 전환이 정상 운영인 만큼, 링크 공유 자체는 경고 대상이 아니다. 문제는 **창까지 겹칠 때**다 —
 * 그 구간의 주문은 상품·옵션·상품명 어느 것으로도 셀러를 가릴 수 없어 두 캠페인이 같은 주문을
 * 각자 집계한다(2026-07-23 실사고: 두 캐시 합이 원천 실재 수량을 초과). 해소는 코드가 아니라
 * **운영자가 판매관리에서 회차 경계를 안 겹치게 잡는 것**이므로, 감지해서 알리는 데까지가 코드의 몫이다.
 */
export function findSharedLinkWindowConflicts(
  campaigns: Array<{ id: string; name?: string | null; productId?: string | null; windowStartMs?: number | null; windowEndMs?: number | null }>,
): Array<{ productId: string; aId: string; bId: string }> {
  const byProduct = new Map<string, typeof campaigns>();
  for (const c of campaigns) {
    const pid = c.productId == null ? '' : String(c.productId).trim();
    if (!pid) continue; // 링크 미지정 캠페인은 판정 불가
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid)!.push(c);
  }

  const conflicts: Array<{ productId: string; aId: string; bId: string }> = [];
  for (const [productId, group] of byProduct) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const aS = a.windowStartMs ?? Number.NEGATIVE_INFINITY, aE = a.windowEndMs ?? Number.POSITIVE_INFINITY;
        const bS = b.windowStartMs ?? Number.NEGATIVE_INFINITY, bE = b.windowEndMs ?? Number.POSITIVE_INFINITY;
        if (aS <= bE && bS <= aE) conflicts.push({ productId, aId: a.id, bId: b.id });
      }
    }
  }
  return conflicts;
}

// ─────────────────────────────────────────────────────────────────────────────
// 활성 주문캠페인 ↔ 주문 귀속(주문 관리 카드의 라이브 집계 규칙)
//
// 주문 관리 카드(`campaigns-handler.ts`)가 쓰는 귀속 술어를 여기 모았다 — 홈 「오늘 처리할 주문」
// 요약(`order-work-summary.ts`)이 **같은 주문을 같은 캠페인에** 붙이려면 같은 술어를 타야 한다.
// ⛔ 술어를 소비처에서 다시 쓰지 말 것. 이 레포에는 이미 귀속 엔진이 여럿이고(undispatched-orders ·
// claim-derive · mobile-pulse-data) 그것들은 **의도적으로 다른 규칙**을 쓴다 — 여기는 그중
// 「주문 관리 카드」의 규칙이다.
// ─────────────────────────────────────────────────────────────────────────────

/** 귀속 판정에 필요한 주문캠페인 최소 형태. */
export type AttributionCampaign<M extends MappingLike = MappingLike> = {
  name: string;
  productId?: string | null;
  mappings?: readonly M[] | null;
};

/**
 * 메인 품목(추가구성상품이 아닌 라인) 1건이 이 캠페인 소속인가.
 *
 * ① 캠페인명 매칭 — 캠페인 productId 가 있고 주문에 상품번호가 있으면 productId 일치일 때만
 *    상품명 포함을 인정한다. ② 아니면 매핑(mapping-match SSOT)이 맞되, 상품명이 **창이 이 결제를
 *    담을 수 있는** 다른 활성 캠페인을 가리키면 양보한다(`orderBelongsToPeerCampaign`).
 * 판매 기간(집계창) 필터와 추가구성상품 분리는 호출부 몫이다 — 순서는 `collectCampaignAttributedOrders`.
 */
export function resolveMainOrderAttribution<M extends MappingLike>(
  order: { productName?: string | null; productOption?: string | null; productOptionName?: string | null; productId?: unknown; originalProductId?: unknown },
  campaign: AttributionCampaign<M> & { mappings: readonly M[] },
  orderTimeMs: number,
  peers: PeerCampaignWindow[],
): { isCampaignOrder: boolean; matchedMapping: M | null } {
  const pName = order.productName || '';
  const oName = order.productOption || order.productOptionName || '';
  const matchedMapping = pickBestMapping<M>(campaign.mappings, pName, oName);

  let matchesCampName = false;
  if (campaign.productId && (order.productId != null || order.originalProductId != null)) {
    // 원상품/채널 번호 어느 쪽이든 캠페인 productId와 맞을 때만 캠페인명 매칭 인정
    if (orderMatchesCampaignProductId(order, campaign.productId)) {
      matchesCampName = pName.includes(campaign.name) || campaign.name.includes(pName);
    }
  } else {
    matchesCampName = pName.includes(campaign.name) || campaign.name.includes(pName);
  }

  if (matchesCampName) return { isCampaignOrder: true, matchedMapping };
  if (matchedMapping && !orderBelongsToPeerCampaign(pName, orderTimeMs, peers)) {
    return { isCampaignOrder: true, matchedMapping };
  }
  return { isCampaignOrder: false, matchedMapping };
}

/**
 * 추가구성상품 라인이 이 캠페인 소속인가 — 같은 productId 의 메인 품목이 이 캠페인에 귀속됐을 때만.
 * (네이버는 추가구성상품을 메인 상품 리스팅 하위 = 동일 productId 로 등록한다.)
 */
export function addonBelongsToCampaign(
  order: { productId?: unknown },
  campaignProductIds: ReadonlySet<string>,
): boolean {
  return !!order.productId && campaignProductIds.has(String(order.productId));
}

/**
 * 주문의 결제 시각 — 주문 관리 카드의 집계창 판정과 같은 식(paymentDate → orderDate → orderCreateDate).
 * 시각이 없으면 0, 파싱 불가면 NaN 이다(둘 다 「창으로 거르지 않는다」로 읽힌다).
 */
export function resolveOrderPaymentTime(order: { paymentDate?: unknown; orderDate?: unknown; orderCreateDate?: unknown }): {
  /** 원문 그대로(없으면 undefined) — 호출부가 표시·인사이트에 그대로 넘긴다. */
  orderTimeStr: string | undefined;
  orderTimeMs: number;
} {
  const raw = (order.paymentDate || order.orderDate || order.orderCreateDate) as string | undefined;
  return { orderTimeStr: raw, orderTimeMs: raw ? new Date(raw).getTime() : 0 };
}

/**
 * 한 활성 주문캠페인에 귀속되는 주문 라인 전부(메인 → 추가구성 순). 주문 관리 카드의 1·2차 패스와
 * 같은 순서·같은 술어다: 집계창 밖 제외 → 추가구성상품 보류 → 메인 귀속 → 보류분 2차 귀속.
 *
 * @param windowStartMs·windowEndMs `resolveSaleWindowStartMs/EndMs` 결과(미확정이면 0 · MAX 로 폴백한 값)
 */
export function collectCampaignAttributedOrders<O extends Record<string, any>, M extends MappingLike>(
  orders: readonly O[],
  campaign: AttributionCampaign<M>,
  windowStartMs: number,
  windowEndMs: number,
  peers: PeerCampaignWindow[],
): Array<{ order: O; orderTimeMs: number }> {
  const mappings = campaign.mappings;
  if (!mappings) return [];
  const main: Array<{ order: O; orderTimeMs: number }> = [];
  const deferredAddons: Array<{ order: O; orderTimeMs: number }> = [];
  const campaignProductIds = new Set<string>();

  for (const order of orders) {
    if (!order) continue;
    const { orderTimeMs } = resolveOrderPaymentTime(order);
    if (orderTimeMs > 0 && (orderTimeMs < windowStartMs || orderTimeMs > windowEndMs)) continue;
    if (isSupplementProduct(order)) {
      deferredAddons.push({ order, orderTimeMs });
      continue;
    }
    const { isCampaignOrder } = resolveMainOrderAttribution(order, { ...campaign, mappings }, orderTimeMs, peers);
    if (!isCampaignOrder) continue;
    if (order.productId) campaignProductIds.add(String(order.productId));
    main.push({ order, orderTimeMs });
  }

  return [...main, ...deferredAddons.filter(({ order }) => addonBelongsToCampaign(order, campaignProductIds))];
}
