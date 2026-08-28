import { describe, it, expect } from 'vitest';
import { isNaverProductOrderId } from '../naver-order-id';

/**
 * 회귀 방지: 발주서 '사은품' 시트의 가상 주문번호(`<부모>_02G`)가 네이버 발송처리로
 * 제출돼 400 '처리 권한이 없는 상품 주문 번호'를 유발하던 건. 이 판별이 제출
 * 경로(일괄등록 엑셀·dispatch API)의 유일한 게이트다.
 * (아래 번호는 형식만 맞춘 합성값 — 실주문 번호를 넣지 말 것, PUBLIC 레포다.)
 */
const PARENT_ID = '1234567890123456'; // 네이버 상품주문번호와 동일한 16자리 형식

describe('isNaverProductOrderId', () => {
  it('네이버 상품주문번호(16자리)를 통과시킨다', () => {
    expect(isNaverProductOrderId(PARENT_ID)).toBe(true);
    expect(isNaverProductOrderId('9876543210987654')).toBe(true);
  });

  it('사은품 가상 번호(_02G)를 배제한다 — 제출 시 네이버 400의 원인', () => {
    expect(isNaverProductOrderId(`${PARENT_ID}_02G`)).toBe(false);
    expect(isNaverProductOrderId('9876543210987654_02G')).toBe(false);
  });

  it('접미사 없는 부모 번호와 사은품 번호를 혼동하지 않는다', () => {
    expect(isNaverProductOrderId(PARENT_ID)).toBe(true);
    expect(isNaverProductOrderId(`${PARENT_ID}_02G`)).toBe(false);
  });

  it('임의 접미사가 붙은 변종도 배제한다(_02G 하드코딩이 아님)', () => {
    expect(isNaverProductOrderId(`${PARENT_ID}_03G`)).toBe(false);
    expect(isNaverProductOrderId(`${PARENT_ID}-사은품`)).toBe(false);
  });

  it('비주문 문자열 행(트리프 이벤트 등)과 빈 값을 배제한다', () => {
    expect(isNaverProductOrderId('이벤트(트리프지원)')).toBe(false);
    expect(isNaverProductOrderId('')).toBe(false);
    expect(isNaverProductOrderId(null)).toBe(false);
    expect(isNaverProductOrderId(undefined)).toBe(false);
  });

  it('앞뒤 공백은 허용한다(엑셀 셀 잔여 공백)', () => {
    expect(isNaverProductOrderId(`  ${PARENT_ID}  `)).toBe(true);
  });

  it('하이픈 형태 주문번호를 통과시키고, 8자리 미만은 배제한다', () => {
    expect(isNaverProductOrderId('12345678-0001')).toBe(true);
    expect(isNaverProductOrderId('1234567')).toBe(false);
  });
});
