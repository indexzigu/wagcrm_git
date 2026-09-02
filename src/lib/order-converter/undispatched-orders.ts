// 발송지연 안내 대상(미발송 주문) 판정의 순수 로직.
//
// undispatched-orders 라우트가 스냅샷(NaverOrderSnapshot) 주문 배열을 넘기면, 캠페인 귀속 →
// 파이프라인 버킷(newBefore/newAfter/pending) 필터 → 지연안내·클레임 상태 파생을 거쳐
// 모달이 그릴 행(UndispatchedOrderRow)으로 정규화한다.
//
// 캠페인 귀속 판정은 캠페인 상세 라우트(campaigns/[id]/route.ts 마감 집계)와 동일 규칙을 쓴다:
//  - 매핑(productName/optionName) 정규화 포함(containment) 매칭
//  - 캠페인명 ↔ 상품명 포함 매칭(campaign.productId가 있으면 productId 일치 시에만)
//  - 추가구성상품은 동일 productId의 메인 품목 귀속 여부로 2차 판단
//
// 이 모듈은 순수 함수만 담는다(fetch·DB 없음) — 유닛테스트 대상.

import { deriveOrderPipelineBucket, type OrderPipelineBucket } from './order-fulfillment';
import { deriveClaimsFromOrder, isFinalCompletedStatus } from './claim-derive';
import { orderMatchesCampaignProductId } from './campaign-match';
import { isSupplementProduct } from './product-class';

export type UndispatchedBucket = Extract<OrderPipelineBucket, 'newBefore' | 'newAfter' | 'pending'>;

export interface UndispatchedOrderRow {
  productOrderId: string;
  /** 구매자명(order.ordererName) */
  ordererName: string | null;
  /** 수령인명(productOrder.shippingAddress.name) */
  receiverName: string | null;
  productName: string | null;
  productOption: string | null;
  quantity: number;
  /** 결제일(KST ISO) — paymentDate 우선, orderDate/orderCreateDate 폴백 */
  paymentDate: string | null;
  /** 발송기한(KST ISO) — 스냅샷 productOrder.shippingDueDate 실측 필드 */
  shippingDueDate: string | null;
  bucket: UndispatchedBucket;
  /** 이미 발송지연 안내가 등록된 건(재알림 리스크 대상) */
  alreadyDelayed: boolean;
  /** 기존 지연 사유(enum, 있을 때만) */
  delayedDispatchReason: string | null;
  /** 미완료 클레임 진행 중 — 하드룰: 지연 안내 대상에서 제외(체크박스 disabled) */
  claimInProgress: boolean;
}

export interface CampaignForUndispatched {
  name: string;
  productId?: string | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  salePeriod?: string | null;
  mappings?: Array<{ productName?: string | null; optionName?: string | null }> | null;
}

const normalize = (str: string) => (str || '').replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();

/**
 * 발송지연 안내 이력 필드 후보. 2026-07-10 스냅샷 실측(29일치 1,355건)에는 지연 처리된
 * 주문이 없어 필드명을 확정하지 못했다 → 네이버 문서 필드명(delayedDispatch*)을 1순위로,
 * 요청 바디 계열 표기(dispatchDelayed*)를 폴백으로 방어적으로 함께 체크한다.
 */
const DELAY_REASON_FIELD_CANDIDATES = ['delayedDispatchReason', 'dispatchDelayedReason'] as const;
const DELAY_DETAIL_FIELD_CANDIDATES = [
  'delayedDispatchDetailedReason',
  'dispatchDelayedDetailedReason',
] as const;

/** 스냅샷 평면 주문에서 "이미 발송지연 안내됨" 여부와 기존 사유를 파생한다. */
export function deriveAlreadyDelayed(order: any): { alreadyDelayed: boolean; reason: string | null } {
  if (!order || typeof order !== 'object') return { alreadyDelayed: false, reason: null };
  let reason: string | null = null;
  for (const key of DELAY_REASON_FIELD_CANDIDATES) {
    const v = order[key];
    if (typeof v === 'string' && v.trim()) {
      reason = v.trim();
      break;
    }
  }
  const hasDetail = DELAY_DETAIL_FIELD_CANDIDATES.some((key) => {
    const v = order[key];
    return typeof v === 'string' && v.trim();
  });
  return { alreadyDelayed: !!reason || hasDetail, reason };
}

/**
 * 미완료 클레임 진행 여부. __claim(query 동기화 경로)은 claim-derive의 기존 판정을 재사용하고,
 * __claim이 없는 FULL 동기화 경로 스냅샷은 top-level claimStatus로 폴백한다(리스트 API 평면 필드).
 */
export function hasClaimInProgress(order: any): boolean {
  const derived = deriveClaimsFromOrder(order);
  if (derived.length > 0) return derived.some((c) => !c.isCompleted);
  const flatStatus = order?.claimStatus;
  if (typeof flatStatus === 'string' && flatStatus.trim()) {
    return !isFinalCompletedStatus(flatStatus);
  }
  return false;
}

/**
 * 캠페인 판매기간(ms). startDate/endDate 우선, 없으면 salePeriod("2026.07.01 ~ 2026.07.15")를
 * KST 자정~말일로 파싱한다. 판정 불가면 [0, MAX]로 개방(기간으로 배제하지 않음).
 */
export function resolveCampaignWindowMs(campaign: CampaignForUndispatched): { startMs: number; endMs: number } {
  let startMs = campaign.startDate ? new Date(campaign.startDate).getTime() : 0;
  let endMs = campaign.endDate ? new Date(campaign.endDate).getTime() : Number.MAX_SAFE_INTEGER;

  if (!campaign.startDate && campaign.salePeriod && campaign.salePeriod !== '기간 미정' && campaign.salePeriod !== '미등록') {
    const parts = campaign.salePeriod.split('~').map((s) => s.trim());
    if (parts.length >= 1 && parts[0]) {
      const t = new Date(`${parts[0].replace(/\./g, '-')}T00:00:00+09:00`).getTime();
      if (!isNaN(t)) startMs = t;
    }
    if (parts.length >= 2 && parts[1] && parts[1] !== '계속') {
      const t = new Date(`${parts[1].replace(/\./g, '-')}T23:59:59.999+09:00`).getTime();
      if (!isNaN(t)) endMs = t;
    }
  }

  if (isNaN(startMs)) startMs = 0;
  if (isNaN(endMs)) endMs = Number.MAX_SAFE_INTEGER;
  return { startMs, endMs };
}

/** 캠페인 상세 라우트(마감 집계)와 동일한 캠페인 귀속 판정. */
export function orderMatchesCampaign(order: any, campaign: CampaignForUndispatched): boolean {
  const pName = order.productName || '';
  const oName = order.productOption || order.productOptionName || '';
  const normPName = normalize(pName);
  const normOName = normalize(oName);
  const mappings = campaign.mappings || [];

  const matchedMapping = mappings.find((m) => {
    const hasProduct = !!m.productName;
    const hasOption = !!m.optionName;
    if (!hasProduct && !hasOption) return false;

    let productMatches = false;
    if (hasProduct) {
      const normMProd = normalize(m.productName || '');
      if (normMProd.length > 0) {
        productMatches =
          (normPName.length > 0 && (normPName.includes(normMProd) || normMProd.includes(normPName))) ||
          (normOName.length > 0 && (normOName.includes(normMProd) || normMProd.includes(normOName)));
      }
    }

    let optionMatches = false;
    if (hasOption) {
      const normMOpt = normalize(m.optionName || '');
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

  return matchesCampName || !!matchedMapping;
}

function orderTimeMs(order: any): number {
  const timeStr = order?.paymentDate || order?.orderDate || order?.orderCreateDate;
  if (!timeStr) return 0;
  const t = new Date(timeStr).getTime();
  return isNaN(t) ? 0 : t;
}

function toRow(order: any, bucket: UndispatchedBucket): UndispatchedOrderRow {
  const { alreadyDelayed, reason } = deriveAlreadyDelayed(order);
  return {
    productOrderId: String(order.productOrderId).trim(),
    ordererName: order.ordererName ?? null,
    receiverName: order.shippingAddress?.name ?? null,
    productName: order.productName ?? null,
    productOption: order.productOption || order.productOptionName || null,
    quantity: Number(order.quantity) || 1,
    paymentDate: order.paymentDate || order.orderDate || order.orderCreateDate || null,
    shippingDueDate: order.shippingDueDate ?? null,
    bucket,
    alreadyDelayed,
    delayedDispatchReason: reason,
    claimInProgress: hasClaimInProgress(order),
  };
}

/**
 * 스냅샷 주문 배열에서 이 캠페인의 미발송 주문 행을 만든다.
 * 미발송 = deriveOrderPipelineBucket 결과가 newBefore/newAfter/pending인 건
 * (배송중·배송완료·취소/반품/교환은 제외).
 */
export function buildUndispatchedRows(
  orders: any[],
  campaign: CampaignForUndispatched,
  poRequestedSet: Set<string>,
): UndispatchedOrderRow[] {
  if (!Array.isArray(orders)) return [];
  const { startMs, endMs } = resolveCampaignWindowMs(campaign);

  const campaignProductIds = new Set<string>();
  const deferredAddons: any[] = [];
  const rows = new Map<string, UndispatchedOrderRow>();

  const pushIfUndispatched = (order: any) => {
    const id = order?.productOrderId ? String(order.productOrderId).trim() : '';
    if (!id || rows.has(id)) return;
    const bucket = deriveOrderPipelineBucket(
      order.productOrderStatus,
      order.placeOrderStatus,
      poRequestedSet.has(id),
    );
    if (bucket !== 'newBefore' && bucket !== 'newAfter' && bucket !== 'pending') return;
    rows.set(id, toRow(order, bucket));
  };

  for (const order of orders) {
    if (!order) continue;
    const t = orderTimeMs(order);
    if (t > 0 && (t < startMs || t > endMs)) continue;

    // 추가구성상품은 동일 productId의 메인 품목 귀속 여부로 2차 판단 → 보류
    if (isSupplementProduct(order)) {
      deferredAddons.push(order);
      continue;
    }

    if (orderMatchesCampaign(order, campaign)) {
      if (order.productId) campaignProductIds.add(String(order.productId));
      pushIfUndispatched(order);
    }
  }

  for (const addon of deferredAddons) {
    if (!addon.productId || !campaignProductIds.has(String(addon.productId))) continue;
    pushIfUndispatched(addon);
  }

  return Array.from(rows.values());
}
