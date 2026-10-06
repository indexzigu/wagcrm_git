import { describe, expect, it } from 'vitest';
import {
  buildPurchaseOrderRow,
  buildPurchaseOrderRows,
  describeEmptyPurchaseOrder,
  findMissingFields,
  orderMatchesCampaign,
  toPreviewRow,
  wrapFlatOrder,
} from '../purchase-order-rows';
import { SUPPLEMENT_PRODUCT_CLASS } from '../product-class';

/**
 * 발주서 행 SSOT 의 계약. 이 함수는 주문확인·발주요청 미리보기·확정·준비본이 **함께** 쓰므로
 * 여기서 갈리면 네 표면이 같이 틀린다.
 */

const campaign = {
  id: 'c1',
  name: '테스트 공구',
  productId: null as string | null,
  mappings: [{ productName: '', optionName: '블루' }],
};

function wrapper(po: Record<string, unknown>, order: Record<string, unknown> = {}) {
  return {
    order: { orderId: 'O-1', orderDate: '2026-10-05T10:20:00.000+09:00', ordererName: '주문자', ordererTel: '010-0000-0000', ...order },
    productOrder: {
      productOrderId: 'PO-1',
      productOrderStatus: 'PAYED',
      placeOrderStatus: 'NOT_YET',
      productName: '테스트 공구 세트',
      productOption: '색상: 블루',
      productId: 'P1',
      quantity: 2,
      shippingFee: '0',
      shippingAddress: { name: '수령인', tel1: '010-1111-2222', zipCode: '12345', baseAddress: '서울시 어딘가', detailedAddress: '101호' },
      ...po,
    },
  };
}

describe('buildPurchaseOrderRows — 발주 대상 판정', () => {
  it('캠페인명이 상품명에 들어 있는 결제완료 주문을 행으로 만든다', () => {
    const { rows } = buildPurchaseOrderRows({ wrappers: [wrapper({})], campaign, activeCampaigns: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      상품주문번호: 'PO-1',
      _orderId: 'O-1',
      주문일: '2026-10-05 10:20',
      수취인명: '수령인',
      배송지: '서울시 어딘가 101호',
      수량: 2,
      _placeOrderStatus: 'NOT_YET',
    });
  });

  it('발주 대상 상태가 아니면(취소·배송중) 싣지 않고 pendingLineCount 에도 세지 않는다', () => {
    const { rows, pendingLineCount } = buildPurchaseOrderRows({
      wrappers: [wrapper({ productOrderStatus: 'CANCELED' }), wrapper({ productOrderId: 'PO-2', productOrderStatus: 'DELIVERING' })],
      campaign,
      activeCampaigns: [],
    });
    expect(rows).toEqual([]);
    expect(pendingLineCount).toBe(0);
  });

  it('제외 집합(이미 발주요청한 배송대기)에 든 주문은 뺀다 — 같은 주문이 브랜드사에 두 번 가지 않게', () => {
    const { rows } = buildPurchaseOrderRows({
      wrappers: [wrapper({}), wrapper({ productOrderId: 'PO-2' })],
      campaign,
      activeCampaigns: [],
      excludeProductOrderIds: new Set(['PO-1']),
    });
    expect(rows.map((r) => r.상품주문번호)).toEqual(['PO-2']);
  });

  it('매핑만 맞는 주문은 다른 활성 캠페인명을 가리키면 양보한다', () => {
    const order = wrapper({ productName: '다른 공구 블루', productOption: '블루' });
    const other = [{ id: 'c2', name: '다른 공구' }];
    expect(buildPurchaseOrderRows({ wrappers: [order], campaign, activeCampaigns: other }).rows).toEqual([]);
    expect(buildPurchaseOrderRows({ wrappers: [order], campaign, activeCampaigns: [] }).rows).toHaveLength(1);
  });

  it('추가구성상품은 같은 상품번호의 메인 라인이 귀속될 때만 따라 실리고 메인 바로 뒤에 붙는다', () => {
    const main = wrapper({});
    const otherMain = wrapper({ productOrderId: 'PO-9', productId: 'P9', productName: '무관 상품', productOption: '없음' }, { orderId: 'O-9' });
    const addon = wrapper({ productOrderId: 'PO-1A', productClass: SUPPLEMENT_PRODUCT_CLASS, productName: '추가 구성', productOption: '파우치' });
    const strayAddon = wrapper(
      { productOrderId: 'PO-9A', productClass: SUPPLEMENT_PRODUCT_CLASS, productId: 'P9', productName: '추가 구성', productOption: '파우치' },
      { orderId: 'O-9' },
    );
    const { rows } = buildPurchaseOrderRows({ wrappers: [addon, main, otherMain, strayAddon], campaign, activeCampaigns: [] });
    expect(rows.map((r) => r.상품주문번호)).toEqual(['PO-1', 'PO-1A']);
  });

  it('행이 0건이면 「발주 대상 없음」과 「매핑 불일치」를 가른다', () => {
    const unmatched = wrapper({ productName: '무관 상품', productOption: '레드' });
    const { rows, pendingLineCount } = buildPurchaseOrderRows({ wrappers: [unmatched], campaign, activeCampaigns: [] });
    expect(rows).toEqual([]);
    expect(pendingLineCount).toBe(1);
    expect(describeEmptyPurchaseOrder(pendingLineCount).noWork).toBe(false);
    expect(describeEmptyPurchaseOrder(0).noWork).toBe(true);
  });
});

describe('평평한 주문(스냅샷·재조회) 맞춤', () => {
  it('wrapFlatOrder 로 감싼 스냅샷 주문이 조회 응답과 같은 행이 된다', () => {
    const live = wrapper({});
    const flat = { ...live.order, ...live.productOrder };
    expect(buildPurchaseOrderRow(wrapFlatOrder(flat))).toEqual(buildPurchaseOrderRow(live));
  });

  it('기본 주소가 없으면 문자열 undefined 를 싣지 않고 「주소 없음」으로 드러낸다', () => {
    const row = buildPurchaseOrderRow(wrapper({ shippingAddress: { name: '수령인', tel1: '010' } }));
    expect(row.배송지).not.toContain('undefined');
    expect(findMissingFields(row)).toEqual(['address']);
  });

  it('미리보기 행은 전화·주소 원문 없이 빈 칸 여부와 발주확인 필요만 싣는다', () => {
    const preview = toPreviewRow(buildPurchaseOrderRow(wrapper({ shippingAddress: { name: '', baseAddress: '주소' } })));
    expect(preview).toEqual({
      productOrderId: 'PO-1',
      orderId: 'O-1',
      recipientName: '',
      optionName: '색상: 블루',
      quantity: 2,
      shippingMemo: expect.any(String),
      needsConfirm: true,
      missing: ['recipient', 'phone'],
    });
    expect(JSON.stringify(preview)).not.toContain('주소');
  });
});

describe('orderMatchesCampaign — 상품번호 우선', () => {
  it('캠페인에 상품번호가 있으면 상품번호가 다른 주문은 이름이 같아도 이름 일치로 인정하지 않는다', () => {
    const withProduct = { ...campaign, productId: 'P1', mappings: [] };
    expect(orderMatchesCampaign({ productName: '테스트 공구 세트', productId: 'P1' }, withProduct, [])).toBe(true);
    expect(orderMatchesCampaign({ productName: '테스트 공구 세트', productId: 'P2' }, withProduct, [])).toBe(false);
  });
});
