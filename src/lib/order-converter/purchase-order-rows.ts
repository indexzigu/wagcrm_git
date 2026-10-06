import { orderMatchesCampaignProductId } from './campaign-match';
import { interleaveAddonRows } from './group-orders';
import { PENDING_FULFILLMENT_STATUSES } from './order-fetch-window';
import { isSupplementProduct } from './product-class';
import { resolveShippingMemo } from './shipping-memo';

/**
 * 발주서에 실을 주문을 고르고 행으로 만드는 **판정 SSOT**(발주 자동화 2단계, 2026-10-06).
 *
 * 종전에는 같은 귀속 판정·행 생성이 세 곳에 글자 단위로 복사돼 있었다 — 주문확인
 * (`execute/stream`) · 발주요청(구 `execute`) · 수동 첨부 대조(`campaign-orders.ts`). 2단계가
 * 발주서를 **저장된 주문 사본(스냅샷)** 에서도 만들게 되면서 네 번째 사본이 생길 자리였다.
 * 사본이 갈리면 같은 캠페인에서 「주문확인 파일」과 「보낸 발주서」가 달라지는데 타입도 테스트도
 * 못 잡는다(종전 두 라우트의 상태 필터가 이미 한 번 갈렸었다 — order-fetch-window 헤더).
 *
 * 이 모듈은 네이버를 부르지 않는다(순수). 입력은 네이버 조회 응답 모양의 래퍼
 * `{ order, productOrder }` 이고, 스냅샷·query-by-id 의 평평한 주문은 `wrapFlatOrder` 로 맞춘다.
 */

/** 네이버 조회 응답 한 줄(`GET product-orders` 의 data 원소)과 같은 모양. */
export type OrderWrapper = { order?: any; productOrder?: any };

export type CampaignForMatch = {
  id: string;
  name: string;
  productId: string | null;
  mappings: { productName: string; optionName: string }[];
};

/** 발주서 한 행. 한글 키는 엑셀 규칙(`excel-rules.ts` NAVER_ORDER_FIELDS)이 읽는 이름 그대로다. */
export type PurchaseOrderRow = {
  _orderId: string;
  주문일: string;
  상품주문번호: string;
  구매자명: string;
  구매자연락처: string;
  수취인명: string;
  수취인연락처1: string;
  수취인연락처2: string;
  우편번호: string;
  배송지: string;
  옵션정보: string;
  수량: number;
  배송비: string;
  배송메시지: string;
  사은품: string;
  _placeOrderStatus: string | undefined;
};

const normalize = (str: string) => (str || '').replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();

/**
 * 이 주문(메인 상품 라인)이 캠페인에 귀속되는가 — 상품번호·캠페인명 일치가 1순위, 매핑 룰 일치는
 * **다른 활성 캠페인명을 가리키지 않을 때만** 인정한다. 추가구성상품은 여기서 판정하지 않는다
 * (`buildPurchaseOrderRows` 의 2차 귀속).
 */
export function orderMatchesCampaign(
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
    // 매핑 룰에 맞더라도 상품명이 '다른 캠페인명'을 명시적으로 포함하고 있으면 무시
    const belongsToOther = activeCampaigns.some(
      (otherCamp) => otherCamp.id !== campaign.id && (pName.includes(otherCamp.name) || otherCamp.name.includes(pName)),
    );
    if (!belongsToOther) return true;
  }

  return false;
}

/** 래퍼 한 줄 → 발주서 행. 주문일은 `YYYY-MM-DD HH:MM`. */
export function buildPurchaseOrderRow(orderWrapper: OrderWrapper): PurchaseOrderRow {
  const order = orderWrapper.productOrder ?? {};
  const rawDate: string =
    orderWrapper.order?.orderDate || order.paymentDate || order.orderDate || order.placeOrderStatusDate || '';
  const formattedDate = rawDate && rawDate.includes('T') ? rawDate.replace('T', ' ').slice(0, 16) : rawDate;

  return {
    _orderId: orderWrapper.order?.orderId || order.orderId || '',
    주문일: formattedDate,
    상품주문번호: order.productOrderId || '',
    구매자명: orderWrapper.order?.ordererName || order.shippingAddress?.name || '',
    구매자연락처: orderWrapper.order?.ordererTel || '',
    수취인명: order.shippingAddress?.name || '',
    수취인연락처1: order.shippingAddress?.tel1 || '',
    수취인연락처2: order.shippingAddress?.tel2 || '',
    우편번호: order.shippingAddress?.zipCode || '',
    // 기본 주소가 없으면 종전엔 문자열 'undefined' 가 발주서에 실렸다 — 빈 칸으로 둔다(미리보기가 「주소 없음」으로 드러낸다).
    배송지: (order.shippingAddress?.baseAddress || '') + ' ' + (order.shippingAddress?.detailedAddress || ''),
    옵션정보: order.productOption || '',
    수량: order.quantity || 1,
    배송비: order.shippingFee || '0',
    배송메시지: resolveShippingMemo(order, orderWrapper.order),
    사은품: '',
    _placeOrderStatus: order.placeOrderStatus,
  };
}

const isPendingFulfillment = (status: unknown) =>
  (PENDING_FULFILLMENT_STATUSES as readonly string[]).includes(String(status));

/**
 * 발주 대상 주문을 골라 발주서 행으로 만든다.
 *
 * - 발주 대상 상태(`PENDING_FULFILLMENT_STATUSES`)만 싣는다.
 * - `excludeProductOrderIds` 에 든 주문은 뺀다 — 발주요청은 이미 발주요청한(배송대기) 건을,
 *   주문확인은 아무것도 빼지 않는다(호출부가 정한다).
 * - 추가구성상품은 같은 상품번호의 메인 라인이 이 캠페인에 귀속됐을 때만 따라 싣고(2차 귀속),
 *   같은 주문의 메인 행 바로 뒤에 붙인다(브랜드사가 합포장 묶음을 인지하게).
 *
 * @returns pendingLineCount — 캠페인과 무관하게 받은 래퍼 중 발주 대상 상태인 라인 수.
 *   행이 0건일 때 「할 일 없음」과 「매핑 불일치」를 가르는 근거다(`describeEmptyPurchaseOrder`).
 */
export function buildPurchaseOrderRows(args: {
  wrappers: OrderWrapper[];
  campaign: CampaignForMatch;
  activeCampaigns: { id: string; name: string }[];
  excludeProductOrderIds?: ReadonlySet<string>;
}): { rows: PurchaseOrderRow[]; pendingLineCount: number } {
  const { wrappers, campaign, activeCampaigns, excludeProductOrderIds } = args;
  const mainRows: PurchaseOrderRow[] = [];
  const addonRows: PurchaseOrderRow[] = [];
  const campaignProductIds = new Set<string>();
  const deferredAddonWrappers: OrderWrapper[] = [];
  const isExcluded = (order: any) =>
    !!excludeProductOrderIds && excludeProductOrderIds.has(String(order.productOrderId || ''));

  for (const orderWrapper of wrappers) {
    const order = orderWrapper.productOrder;
    if (!order || !isPendingFulfillment(order.productOrderStatus)) continue;
    if (isExcluded(order)) continue;

    if (isSupplementProduct(order)) {
      deferredAddonWrappers.push(orderWrapper);
      continue;
    }

    if (orderMatchesCampaign(order, campaign, activeCampaigns)) {
      if (order.productId) campaignProductIds.add(String(order.productId));
      mainRows.push(buildPurchaseOrderRow(orderWrapper));
    }
  }

  for (const orderWrapper of deferredAddonWrappers) {
    const order = orderWrapper.productOrder;
    if (!order?.productId || !campaignProductIds.has(String(order.productId))) continue;
    addonRows.push(buildPurchaseOrderRow(orderWrapper));
  }

  const pendingLineCount = wrappers.filter(
    (w) => w?.productOrder && isPendingFulfillment(w.productOrder.productOrderStatus),
  ).length;

  return { rows: interleaveAddonRows(mainRows, addonRows) as PurchaseOrderRow[], pendingLineCount };
}

/**
 * 발주서 행이 0건일 때의 안내. 「발주 대상 0건」과 「매핑 불일치」는 처방이 정반대라 문구를 가른다
 * (종전 단일 문구가 전자에서도 매핑이 깨진 것처럼 읽혔다 — baseline 2026-07-30).
 */
export function describeEmptyPurchaseOrder(pendingLineCount: number): { message: string; noWork: boolean } {
  return pendingLineCount === 0
    ? {
        message: '지금 발주할 주문이 없습니다. 발주 대상(결제완료·상품준비중) 주문이 0건입니다. 매핑 설정 문제가 아닙니다.',
        noWork: true,
      }
    : {
        message: `발주 대상 주문 ${pendingLineCount}건이 있으나 이 캠페인의 매핑 룰에 맞는 건이 없습니다. 매핑 설정을 확인하세요.`,
        noWork: false,
      };
}

/**
 * 스냅샷·query-by-id 가 저장하는 평평한 주문(`{...order, ...productOrder}`, `normalizeQueriedOrder`)을
 * 조회 응답 모양으로 맞춘다. 같은 객체를 양쪽에 꽂는다 — 평평하게 합칠 때 productOrder 키가 order
 * 키를 덮었으므로, 행 생성이 `order.orderDate` 를 먼저 읽어도 같은 값을 본다.
 */
export function wrapFlatOrder(flat: any): OrderWrapper {
  return { order: flat, productOrder: flat };
}

/** 미리보기가 「비었다」고 드러내는 필수 칸 — 브랜드사가 배송할 수 없게 되는 값들. */
export type PurchaseOrderMissingField = 'recipient' | 'phone' | 'address';

export function findMissingFields(row: PurchaseOrderRow): PurchaseOrderMissingField[] {
  const missing: PurchaseOrderMissingField[] = [];
  if (!row.수취인명.trim()) missing.push('recipient');
  if (!row.수취인연락처1.trim() && !row.수취인연락처2.trim()) missing.push('phone');
  if (!row.배송지.trim()) missing.push('address');
  return missing;
}

/** 발주요청 창의 미리보기 표 한 줄. 전화·주소 원문은 싣지 않는다 — 판단 가치는 「비었는가」뿐이다(ss-ux 2026-10-06). */
export type PurchaseOrderPreviewRow = {
  productOrderId: string;
  orderId: string;
  recipientName: string;
  optionName: string;
  quantity: number;
  shippingMemo: string;
  /** 네이버 발주확인 전(`NOT_YET`)인가 — 확정 단계가 이 줄만 발주확인한다. */
  needsConfirm: boolean;
  missing: PurchaseOrderMissingField[];
};

export function toPreviewRow(row: PurchaseOrderRow): PurchaseOrderPreviewRow {
  return {
    productOrderId: String(row.상품주문번호),
    orderId: String(row._orderId),
    recipientName: row.수취인명,
    optionName: row.옵션정보,
    quantity: Number(row.수량) || 1,
    shippingMemo: row.배송메시지,
    needsConfirm: row._placeOrderStatus === 'NOT_YET',
    missing: findMissingFields(row),
  };
}

/**
 * 확정 단계에서 발주서에서 빠진 미리보기 주문과 그 이유.
 * - `status-changed`: 재조회해 보니 발주 대상 상태가 아니다(취소·클레임 등).
 * - `not-returned`: 네이버가 재조회에 응답하지 않았다(탈퇴 구매자 주문 등 — P7 구조적 원인 ②).
 * - `already-requested`: 그 사이 다른 발주요청으로 배송대기가 됐다.
 */
export type DroppedOrder = {
  productOrderId: string;
  recipientName: string;
  reason: 'status-changed' | 'not-returned' | 'already-requested';
};
