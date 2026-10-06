// 「이 주문에 오늘 손이 가야 하는가」 판정의 단일 진실(순수 · client-safe · DB·네트워크 없음).
//
// 두 표면이 같은 판정을 쓴다 — ⛔ 어느 쪽에서도 다시 쓰지 말 것:
//  · 주문 관리 카드(`campaigns-handler.ts`)의 지연 경고 배지·팝오버(주문확인·배송대기·배송중)
//  · 홈 「오늘 처리할 주문」 카드 + 사이드바 「주문 관리」 배지(`order-work-summary.ts`)
// 종전에는 임계값 3개와 경과일 계산이 핸들러 안에 **본품·추가구성 두 갈래로 손 복사**돼 있었다.
// 홈 카드가 생기면서 세 번째 사본이 생길 자리였다 — 화면마다 같은 판정을 손으로 다시 쓰다
// 갈라지는 것이 이 레포의 반복 결함 유형이라(codebase-map 「SSOT 통합 PR 이 새 사본을 만든다」)
// 판정을 여기 하나로 모은다.
//
// 버킷 자체(신규·주문확인·배송대기·배송중·배송완료)는 `deriveOrderPipelineBucket`(order-fulfillment)
// 가 소유한다. 이 모듈은 그 위에 「경고할 만큼 묵었는가」 하나만 얹는다.

import { deriveOrderPipelineBucket, type OrderPipelineBucket } from './order-fulfillment';

/** 주문확인됐지만 발주요청·송장 전(newAfter)에서 결제 후 이 일수 이상 묵으면 경고(오너 확정 2026-07-12). */
export const CONFIRM_DELAY_WARN_DAYS = 2;
/** 배송대기(발주요청 메일 발송됨)에서 발주요청 후 이 일수 이상 송장 미회신이면 경고(송장 독촉). */
export const PENDING_DELAY_WARN_DAYS = 2;
/** 배송중에서 결제 후 이 일수 이상이면 경고(배송 지연 점검). 발송 시각 필드가 스냅샷에 없어 결제 시각 기준. */
export const SHIPPING_DELAY_WARN_DAYS = 5;

const DAY_MS = 86_400_000;

export type OrderWorkInput = {
  productOrderStatus: string | null | undefined;
  placeOrderStatus: string | null | undefined;
  /** OrderFulfillmentState.poRequestedAt — 발주요청 메일을 보낸 시각. 없으면 null. */
  poRequestedAt: Date | null;
  /** 결제 시각(ms, paymentDate → orderDate → orderCreateDate). 모르면 0. */
  orderTimeMs: number;
  nowMs: number;
};

export type OrderWorkClassification = {
  bucket: OrderPipelineBucket;
  /**
   * 지연 경고 대상이면 그 경과일(정수 일), 아니면 null.
   * 시계는 버킷마다 다르다 — 주문확인·배송중 = 결제 시각, 배송대기 = 발주요청 시각.
   */
  delayDays: number | null;
};

function elapsedDays(fromMs: number, nowMs: number): number {
  return Math.floor((nowMs - fromMs) / DAY_MS);
}

/** 상품주문 1건의 파이프라인 버킷 + 지연 경고 여부. */
export function classifyOrderWork(input: OrderWorkInput): OrderWorkClassification {
  const bucket = deriveOrderPipelineBucket(
    input.productOrderStatus,
    input.placeOrderStatus,
    input.poRequestedAt != null,
  );

  let delayDays: number | null = null;
  if (bucket === 'newAfter' && input.orderTimeMs > 0) {
    const days = elapsedDays(input.orderTimeMs, input.nowMs);
    if (days >= CONFIRM_DELAY_WARN_DAYS) delayDays = days;
  } else if (bucket === 'pending' && input.poRequestedAt) {
    const days = elapsedDays(input.poRequestedAt.getTime(), input.nowMs);
    if (days >= PENDING_DELAY_WARN_DAYS) delayDays = days;
  } else if (bucket === 'shipping' && input.orderTimeMs > 0) {
    const days = elapsedDays(input.orderTimeMs, input.nowMs);
    if (days >= SHIPPING_DELAY_WARN_DAYS) delayDays = days;
  }

  return { bucket, delayDays };
}

// ─────────────────────────────────────────────────────────────────────────────
// 홈 「오늘 처리할 주문」 요약
// ─────────────────────────────────────────────────────────────────────────────

/** 한 주문캠페인에 귀속된 주문들의 판정 결과. */
export type CampaignOrderWork = {
  campaignId: string;
  classifications: OrderWorkClassification[];
};

/** 진행 중 클레임 1건 — 귀속 캠페인 이름(없으면 미매칭)만 쓴다. */
export type OpenClaimLike = { matchedCampaignName?: string | null };

export type OrderWorkSummaryCounts = {
  /**
   * 발주 대기 = 주문 관리 카드의 「주문확인」 칸(미확인 + 발주확인 후 발주요청 전).
   * 단위는 상품주문 라인(주문 관리 카드와 같은 단위).
   */
  awaitingPo: { lines: number; campaigns: number; /** 그중 결제 후 2일↑ 묵은 라인 */ delayedLines: number };
  /** 배송 지연 = 송장 미회신(배송대기 2일↑) + 배송중 5일↑. 발주 대기와 서로소다. */
  delayed: { lines: number; campaigns: number; invoiceLines: number; shippingLines: number };
  /** 진행 중 클레임(반품·교환·취소) — 주문 관리 「반품/교환」 버튼과 같은 판정(`isCompleted` 아닌 것). */
  openClaims: { lines: number; campaigns: number; unmatchedLines: number };
  /** 세 칸의 합 — 사이드바 배지 숫자. 클레임 주문이 발주 대기에도 있으면 양쪽에 센다(카드 숫자와 같은 합). */
  total: number;
};

/** `/api/order-work` 응답 — 홈 카드·사이드바 배지가 읽는 모양(client-safe 라 여기 둔다). */
export type OrderWorkSummary = OrderWorkSummaryCounts & {
  /** 주문 데이터의 기준 시각(마지막 주문 동기화) — 주문 관리 툴바 「마지막 동기화」와 같은 값. */
  lastSyncAt: string | null;
  /** 활성 주문캠페인 수(0 이면 발주·배송 칸은 볼 대상이 없다). */
  activeCampaignCount: number;
  /** 조회 범위에 스냅샷 행이 하나라도 있었는가 — false 면 「아직 동기화된 주문이 없음」이지 「할 일 0」이 아니다. */
  hasSnapshot: boolean;
};

/** 캠페인별 판정 + 진행 중 클레임 → 홈 카드 숫자. */
export function summarizeOrderWork(
  campaigns: CampaignOrderWork[],
  openClaims: OpenClaimLike[],
): OrderWorkSummaryCounts {
  let awaitingLines = 0;
  let awaitingDelayed = 0;
  const awaitingCampaigns = new Set<string>();
  let invoiceLines = 0;
  let shippingLines = 0;
  const delayedCampaigns = new Set<string>();

  for (const campaign of campaigns) {
    for (const work of campaign.classifications) {
      if (work.bucket === 'newBefore' || work.bucket === 'newAfter') {
        awaitingLines += 1;
        awaitingCampaigns.add(campaign.campaignId);
        if (work.delayDays != null) awaitingDelayed += 1;
      } else if (work.bucket === 'pending' && work.delayDays != null) {
        invoiceLines += 1;
        delayedCampaigns.add(campaign.campaignId);
      } else if (work.bucket === 'shipping' && work.delayDays != null) {
        shippingLines += 1;
        delayedCampaigns.add(campaign.campaignId);
      }
    }
  }

  const claimCampaigns = new Set<string>();
  let unmatchedClaims = 0;
  for (const claim of openClaims) {
    if (claim.matchedCampaignName) claimCampaigns.add(claim.matchedCampaignName);
    else unmatchedClaims += 1;
  }

  const delayedLines = invoiceLines + shippingLines;
  return {
    awaitingPo: { lines: awaitingLines, campaigns: awaitingCampaigns.size, delayedLines: awaitingDelayed },
    delayed: { lines: delayedLines, campaigns: delayedCampaigns.size, invoiceLines, shippingLines },
    openClaims: { lines: openClaims.length, campaigns: claimCampaigns.size, unmatchedLines: unmatchedClaims },
    total: awaitingLines + delayedLines + openClaims.length,
  };
}
