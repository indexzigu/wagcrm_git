import { describe, it, expect } from 'vitest';
import {
  buildUndispatchedRows,
  deriveAlreadyDelayed,
  hasClaimInProgress,
  resolveCampaignWindowMs,
  type CampaignForUndispatched,
} from '@/lib/order-converter/undispatched-orders';

const campaign: CampaignForUndispatched = {
  name: '뉴트리원 멀티비타민',
  productId: '1000001',
  salePeriod: '2026.07.01 ~ 2026.07.20',
  mappings: [{ productName: '뉴트리원 멀티비타민', optionName: '블루 세트' }],
};

function order(overrides: Record<string, unknown> = {}) {
  return {
    productOrderId: 'po-1',
    productId: '1000001',
    productName: '뉴트리원 멀티비타민',
    productOption: '블루 세트',
    productOrderStatus: 'PAYED',
    placeOrderStatus: 'NOT_YET',
    ordererName: '김철수',
    shippingAddress: { name: '김수령' },
    quantity: 2,
    paymentDate: '2026-07-08T10:00:00.000+09:00',
    shippingDueDate: '2026-07-15T23:59:59.000+09:00',
    ...overrides,
  };
}

describe('buildUndispatchedRows — 미발송 버킷 필터', () => {
  it('newBefore/newAfter/pending만 반환하고 배송중·완료·취소는 제외한다', () => {
    const orders = [
      order({ productOrderId: 'a', productOrderStatus: 'PAYED', placeOrderStatus: 'NOT_YET' }), // newBefore
      order({ productOrderId: 'b', productOrderStatus: 'PAYED', placeOrderStatus: 'OK' }), // newAfter
      order({ productOrderId: 'c', productOrderStatus: 'DELIVERING' }), // shipping — 제외
      order({ productOrderId: 'd', productOrderStatus: 'DELIVERED' }), // completed — 제외
      order({ productOrderId: 'e', productOrderStatus: 'CANCELED' }), // other — 제외
      order({ productOrderId: 'f', productOrderStatus: 'PAYED', placeOrderStatus: 'OK' }), // poRequested → pending
    ];
    const rows = buildUndispatchedRows(orders, campaign, new Set(['f']));
    expect(rows.map((r) => r.productOrderId).sort()).toEqual(['a', 'b', 'f']);
    expect(rows.find((r) => r.productOrderId === 'a')!.bucket).toBe('newBefore');
    expect(rows.find((r) => r.productOrderId === 'b')!.bucket).toBe('newAfter');
    expect(rows.find((r) => r.productOrderId === 'f')!.bucket).toBe('pending');
  });

  it('행 필드 매핑: 구매자/수령인/옵션/수량/결제일/발송기한', () => {
    const rows = buildUndispatchedRows([order()], campaign, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productOrderId: 'po-1',
      ordererName: '김철수',
      receiverName: '김수령',
      productOption: '블루 세트',
      quantity: 2,
      paymentDate: '2026-07-08T10:00:00.000+09:00',
      shippingDueDate: '2026-07-15T23:59:59.000+09:00',
      alreadyDelayed: false,
      claimInProgress: false,
    });
  });

  it('동일 productOrderId는 1건으로 dedup된다', () => {
    const rows = buildUndispatchedRows([order(), order()], campaign, new Set());
    expect(rows).toHaveLength(1);
  });
});

describe('buildUndispatchedRows — 캠페인 귀속·판매기간', () => {
  it('다른 상품(매핑·이름 불일치)은 제외한다', () => {
    const foreign = order({
      productOrderId: 'x',
      productId: '9999',
      productName: '전혀 다른 상품',
      productOption: '레드',
    });
    const rows = buildUndispatchedRows([order(), foreign], campaign, new Set());
    expect(rows.map((r) => r.productOrderId)).toEqual(['po-1']);
  });

  it('판매기간(salePeriod) 밖 주문은 제외한다', () => {
    const outOfWindow = order({ productOrderId: 'old', paymentDate: '2026-06-01T10:00:00.000+09:00' });
    const rows = buildUndispatchedRows([order(), outOfWindow], campaign, new Set());
    expect(rows.map((r) => r.productOrderId)).toEqual(['po-1']);
  });

  it('추가구성상품은 동일 productId 메인 품목이 귀속됐을 때만 2차 포함된다', () => {
    const addon = order({
      productOrderId: 'addon-1',
      productClass: '추가구성상품',
      productName: '아이보리', // 자체명이라 이름/매핑 매칭 불가
      productOption: '파우치: 아이보리',
    });
    const orphanAddon = order({
      productOrderId: 'addon-2',
      productClass: '추가구성상품',
      productId: '8888',
      productName: '아이보리',
      productOption: '파우치: 아이보리',
    });
    const rows = buildUndispatchedRows([addon, orphanAddon, order()], campaign, new Set());
    expect(rows.map((r) => r.productOrderId).sort()).toEqual(['addon-1', 'po-1']);
  });

  it('resolveCampaignWindowMs — salePeriod를 KST 자정~말일로 파싱한다', () => {
    const { startMs, endMs } = resolveCampaignWindowMs(campaign);
    expect(startMs).toBe(new Date('2026-07-01T00:00:00+09:00').getTime());
    expect(endMs).toBe(new Date('2026-07-20T23:59:59.999+09:00').getTime());
  });
});

describe('deriveAlreadyDelayed — 지연 안내 이력 방어적 필드 체크', () => {
  it('문서 필드명(delayedDispatchReason)이 있으면 안내됨 + 사유 보존', () => {
    const r = deriveAlreadyDelayed(order({ delayedDispatchReason: 'PRODUCT_PREPARE' }));
    expect(r).toEqual({ alreadyDelayed: true, reason: 'PRODUCT_PREPARE' });
  });
  it('폴백 표기(dispatchDelayedReason)도 인식한다', () => {
    const r = deriveAlreadyDelayed(order({ dispatchDelayedReason: 'ETC' }));
    expect(r).toEqual({ alreadyDelayed: true, reason: 'ETC' });
  });
  it('상세 사유 필드만 있어도 안내된 것으로 본다', () => {
    const r = deriveAlreadyDelayed(order({ delayedDispatchDetailedReason: '출고 지연' }));
    expect(r.alreadyDelayed).toBe(true);
  });
  it('지연 필드가 없으면 미안내', () => {
    expect(deriveAlreadyDelayed(order())).toEqual({ alreadyDelayed: false, reason: null });
  });
});

describe('hasClaimInProgress — claim-derive 재사용 + 평면 폴백', () => {
  it('__claim 진행 중 클레임 → true (buildUndispatchedRows에서 claimInProgress 플래그)', () => {
    const claimed = order({
      __claim: {
        cancel: null,
        return: { claimStatus: 'RETURN_REQUEST' },
        exchange: null,
        beforeClaim: null,
        currentClaim: { claimType: 'RETURN', claimStatus: 'RETURN_REQUEST' },
        completedClaims: null,
      },
    });
    expect(hasClaimInProgress(claimed)).toBe(true);
    const rows = buildUndispatchedRows([claimed], campaign, new Set());
    expect(rows[0].claimInProgress).toBe(true);
  });

  it('완료된 클레임(__claim RETURN_DONE)은 진행 중이 아니다', () => {
    const done = order({
      __claim: {
        cancel: null,
        return: { claimStatus: 'RETURN_DONE' },
        exchange: null,
        beforeClaim: null,
        currentClaim: null,
        completedClaims: null,
      },
    });
    expect(hasClaimInProgress(done)).toBe(false);
  });

  it('FULL 동기화 경로(top-level claimStatus)도 폴백으로 판정한다', () => {
    expect(hasClaimInProgress(order({ claimStatus: 'CANCEL_REQUEST' }))).toBe(true);
    expect(hasClaimInProgress(order({ claimStatus: 'CANCEL_DONE' }))).toBe(false);
  });
});
