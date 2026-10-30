import { describe, it, expect } from 'vitest';
import { orderMatchesCampaignProductId } from '../campaign-match';

describe('orderMatchesCampaignProductId (원상품/채널 번호 비대칭)', () => {
  it('캠페인 productId = 주문 originalProductId(원상품) → 매칭 (실사고 핵심)', () => {
    // 캠페인은 원상품번호를 저장, 주문 1차 productId는 채널번호. 채널만 비교하면 전량 실패.
    const order = { productId: '13656745519', originalProductId: '13596784327' };
    expect(orderMatchesCampaignProductId(order, '13596784327')).toBe(true);
  });

  it('캠페인 productId = 주문 productId(채널) → 매칭 (과거 데이터 호환)', () => {
    const order = { productId: '13596784327', originalProductId: null };
    expect(orderMatchesCampaignProductId(order, '13596784327')).toBe(true);
  });

  it('어느 쪽 번호와도 불일치 → 미매칭', () => {
    const order = { productId: '111', originalProductId: '222' };
    expect(orderMatchesCampaignProductId(order, '999')).toBe(false);
  });

  it('캠페인 productId 없음 → false(호출부가 이름/매핑 폴백)', () => {
    const order = { productId: '111', originalProductId: '222' };
    expect(orderMatchesCampaignProductId(order, null)).toBe(false);
    expect(orderMatchesCampaignProductId(order, '')).toBe(false);
    expect(orderMatchesCampaignProductId(order, '  ')).toBe(false);
  });

  it('주문 id 없음/빈값 → false, 숫자·문자 혼용 정규화', () => {
    expect(orderMatchesCampaignProductId({ productId: null, originalProductId: null }, '123')).toBe(false);
    expect(orderMatchesCampaignProductId({ productId: 123 }, '123')).toBe(true);
    expect(orderMatchesCampaignProductId(null, '123')).toBe(false);
  });
});

import { orderBelongsToPeerCampaign, findSharedLinkWindowConflicts } from '../campaign-match';

const ms = (iso: string) => new Date(iso).getTime();

describe('orderBelongsToPeerCampaign — 창을 담을 수 있는 이웃에만 양보한다', () => {
  const peerR2 = { id: 'r2', name: '셀러나 마켓', windowStartMs: ms('2026-07-11T00:00:00+09:00'), windowEndMs: ms('2026-07-20T23:59:59.999+09:00') };

  it('이름이 이웃을 가리키고 그 창이 결제시각을 담으면 양보한다', () => {
    expect(orderBelongsToPeerCampaign('셀러나 마켓 공용상품', ms('2026-07-15T12:00:00+09:00'), [peerR2])).toBe(true);
  });

  it('이름이 이웃을 가리켜도 그 창이 결제시각을 못 담으면 양보하지 않는다 (순차 전환 침묵 누락 회귀)', () => {
    expect(orderBelongsToPeerCampaign('셀러나 마켓 공용상품', ms('2026-07-05T12:00:00+09:00'), [peerR2])).toBe(false);
  });

  it('이름이 안 걸리면 창과 무관하게 양보하지 않는다', () => {
    expect(orderBelongsToPeerCampaign('무관한 상품', ms('2026-07-15T12:00:00+09:00'), [peerR2])).toBe(false);
  });

  it('이웃 창이 미확정이면 보수적으로 양보한다(기존 동작 보존)', () => {
    expect(orderBelongsToPeerCampaign('셀러나 마켓 공용상품', ms('2026-07-05T12:00:00+09:00'), [{ id: 'r2', name: '셀러나 마켓' }])).toBe(true);
  });

  it('결제시각 불명(0)이면 창으로 배제하지 않는다', () => {
    expect(orderBelongsToPeerCampaign('셀러나 마켓 공용상품', 0, [peerR2])).toBe(true);
  });

  it('시작만 있고 종료가 열린 이웃은 시작 이후를 담는다', () => {
    const openEnd = { id: 'r3', name: '셀러다 마켓', windowStartMs: ms('2026-07-11T00:00:00+09:00'), windowEndMs: null };
    expect(orderBelongsToPeerCampaign('셀러다 마켓 상품', ms('2026-09-01T00:00:00+09:00'), [openEnd])).toBe(true);
    expect(orderBelongsToPeerCampaign('셀러다 마켓 상품', ms('2026-07-01T00:00:00+09:00'), [openEnd])).toBe(false);
  });
});

describe('findSharedLinkWindowConflicts — 같은 링크 + 창 겹침만 잡는다', () => {
  const A = { id: 'a', name: 'A', productId: '111', windowStartMs: ms('2026-07-01T00:00:00+09:00'), windowEndMs: ms('2026-07-10T23:59:59+09:00') };

  it('같은 링크라도 창이 안 겹치면 정상(순차 전환)', () => {
    const B = { id: 'b', name: 'B', productId: '111', windowStartMs: ms('2026-07-11T00:00:00+09:00'), windowEndMs: ms('2026-07-20T23:59:59+09:00') };
    expect(findSharedLinkWindowConflicts([A, B])).toEqual([]);
  });

  it('같은 링크에 창이 겹치면 잡는다', () => {
    const B = { id: 'b', name: 'B', productId: '111', windowStartMs: ms('2026-07-05T00:00:00+09:00'), windowEndMs: ms('2026-07-20T23:59:59+09:00') };
    expect(findSharedLinkWindowConflicts([A, B])).toEqual([{ productId: '111', aId: 'a', bId: 'b' }]);
  });

  it('링크가 다르면 창이 겹쳐도 정상', () => {
    const B = { id: 'b', name: 'B', productId: '222', windowStartMs: ms('2026-07-05T00:00:00+09:00'), windowEndMs: ms('2026-07-20T23:59:59+09:00') };
    expect(findSharedLinkWindowConflicts([A, B])).toEqual([]);
  });

  it('링크 미지정(null) 캠페인은 판정 대상이 아니다', () => {
    const B = { id: 'b', name: 'B', productId: null, windowStartMs: ms('2026-07-05T00:00:00+09:00'), windowEndMs: ms('2026-07-20T23:59:59+09:00') };
    expect(findSharedLinkWindowConflicts([{ ...A, productId: null }, B])).toEqual([]);
  });

  it('창 미확정은 무한대로 보아 겹침으로 잡는다(안전측)', () => {
    const B = { id: 'b', name: 'B', productId: '111', windowStartMs: null, windowEndMs: null };
    expect(findSharedLinkWindowConflicts([A, B])).toHaveLength(1);
  });
});

import { orderProvesOtherProduct, resolveMainOrderAttribution } from '../campaign-match';

describe('orderProvesOtherProduct — 상품번호로 「다른 스토어 상품」이 확정되는가', () => {
  it('양쪽 번호가 있고 어느 것도 안 맞으면 true', () => {
    expect(orderProvesOtherProduct({ productId: '111', originalProductId: '222' }, '999')).toBe(true);
  });

  it('원상품·채널 번호 중 하나라도 맞으면 false', () => {
    expect(orderProvesOtherProduct({ productId: '111', originalProductId: '999' }, '999')).toBe(false);
    expect(orderProvesOtherProduct({ productId: '999', originalProductId: null }, '999')).toBe(false);
  });

  it('번호가 한쪽이라도 비면 판정하지 않는다(false) — 매핑 폴백에 맡긴다', () => {
    expect(orderProvesOtherProduct({ productId: '111' }, null)).toBe(false);
    expect(orderProvesOtherProduct({ productId: '111' }, '  ')).toBe(false);
    expect(orderProvesOtherProduct({ productId: null, originalProductId: '' }, '999')).toBe(false);
    expect(orderProvesOtherProduct(null, '999')).toBe(false);
  });
});

/**
 * 실사고(2026-10-29): 같은 스토어의 **다른 상품**(다른 셀러 회차, 판매창은 이미 끝남) 주문이
 * 매핑 폴백으로 진행 중 캠페인에 섞였다. 매핑 유사도는 낱말 하나(상품명 「마켓」, 옵션명 「유산균」)만
 * 겹쳐도 매칭이라, 캠페인명 경로에는 있던 상품번호 확인이 매핑 경로에만 빠진 것이 구멍이었다.
 * 이웃 양보도 못 막았다 — 이웃 창이 끝났고, 스토어 상품명이 바뀌어 캠페인명과도 안 맞았다.
 */
describe('resolveMainOrderAttribution — 상품번호가 다른 주문은 매핑으로 귀속하지 않는다', () => {
  const CAMP_NAME = '[셀러A X 브랜드A] 비피더스 100억 보장 유산균 최저가 마켓';
  const camp = {
    name: CAMP_NAME,
    productId: '5000',
    mappings: [
      { productName: CAMP_NAME, optionName: '제품: [브랜드A] 비피더스 100억 유산균 / 수량: [29%] 3통 (3개월분)', price: 30000 },
      { productName: CAMP_NAME, optionName: '제품: [브랜드A] 비피더스 100억 유산균 / 수량: [33%] 6통 (6개월분) + 케일 1박스', price: 60000 },
    ],
  };
  const otherProductOrder = {
    productName: '[브랜드B] 콜라겐/애사비/질유산균/오메가3 최대 ~80% 할인 마켓',
    productOption: '제품: [브랜드B] 여성 질 유산균 / 수량: [57%] 4통 (4개월분)',
    productId: '7001',
    originalProductId: '7000',
  };
  const t = ms('2026-10-29T10:46:00+09:00');
  // 이웃(같은 다른 상품의 지난 회차) — 창이 끝났고 이름도 스토어 상품명과 다르다.
  const endedPeer = { id: 'p', name: '[셀러B] 브랜드B 콜라겐/애사비/질유산균/오메가3 최대 ~70% 할인 마켓', windowStartMs: ms('2026-10-16T00:00:00+09:00'), windowEndMs: ms('2026-10-26T23:59:59.999+09:00') };

  it('낱말이 겹쳐 매핑이 맞아도 상품번호가 다르면 이 캠페인 주문이 아니다', () => {
    const r = resolveMainOrderAttribution(otherProductOrder, camp, t, [endedPeer]);
    expect(r.isCampaignOrder).toBe(false);
  });

  it('같은 상품번호(원상품 기준)의 주문은 매핑으로 그대로 귀속된다', () => {
    // 같은 링크의 셀러 교체로 스토어 상품명만 바뀐 주문 — 캠페인명 경로는 빗나가고 매핑 경로로 잡힌다.
    const own = { productName: '[셀러C X 브랜드A] 비피더스 100억 보장 유산균 최저가 마켓', productOption: camp.mappings[0].optionName, productId: '5001', originalProductId: '5000' };
    const r = resolveMainOrderAttribution(own, camp, t, []);
    expect(r.isCampaignOrder).toBe(true);
    expect(r.matchedMapping?.price).toBe(30000);
  });

  it('캠페인 상품번호가 없으면 종전대로 매핑만으로 귀속한다(하위호환)', () => {
    const r = resolveMainOrderAttribution(otherProductOrder, { ...camp, productId: null }, t, []);
    expect(r.isCampaignOrder).toBe(true);
  });

  it('주문에 상품번호가 없으면 종전대로 매핑만으로 귀속한다(하위호환)', () => {
    const r = resolveMainOrderAttribution({ ...otherProductOrder, productId: null, originalProductId: null }, camp, t, []);
    expect(r.isCampaignOrder).toBe(true);
  });
});
