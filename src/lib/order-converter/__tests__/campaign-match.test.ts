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
