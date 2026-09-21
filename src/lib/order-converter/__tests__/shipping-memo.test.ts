import { describe, expect, it } from 'vitest';
import { resolveShippingMemo } from '../shipping-memo';

describe('resolveShippingMemo', () => {
  it("productOrder 최상위 shippingMemo 를 읽는다 (실제 응답 위치 — shippingAddress 안이 아니다)", () => {
    const productOrder = {
      shippingMemo: '경비실에 맡겨주세요',
      shippingAddress: { name: '수령인', tel1: '010-0000-0000' },
    };
    expect(resolveShippingMemo(productOrder, {})).toBe('경비실에 맡겨주세요');
  });

  it('주문(order) 계층에 실려 오는 응답도 살린다', () => {
    expect(resolveShippingMemo({ shippingAddress: {} }, { shippingMemo: '부재 시 전화' })).toBe('부재 시 전화');
  });

  it('과거 경로(shippingAddress.shippingMemo)도 계속 지원한다', () => {
    expect(resolveShippingMemo({ shippingAddress: { shippingMemo: '문 앞' } })).toBe('문 앞');
  });

  it('메시지가 없거나 공백뿐이면 빈 문자열', () => {
    expect(resolveShippingMemo({ shippingMemo: '   ', shippingAddress: {} }, {})).toBe('');
    expect(resolveShippingMemo(null)).toBe('');
    expect(resolveShippingMemo(undefined, undefined)).toBe('');
  });
});
