import { describe, it, expect } from 'vitest';
import { buildStoreMappingRows, computeDiscountedPrice } from '../store-option-rows';

describe('computeDiscountedPrice', () => {
  it('WON 즉시할인을 차감한다', () => {
    expect(computeDiscountedPrice(35000, { value: 5100, unitType: 'WON' })).toBe(29900);
  });

  it('PERCENT 즉시할인을 반올림 적용한다', () => {
    expect(computeDiscountedPrice(35000, { value: 10, unitType: 'PERCENT' })).toBe(31500);
  });

  it('할인 정책이 없으면 판매가 그대로', () => {
    expect(computeDiscountedPrice(35000, null)).toBe(35000);
    expect(computeDiscountedPrice(35000, undefined)).toBe(35000);
  });

  it('할인이 판매가보다 커도 음수가 되지 않는다', () => {
    expect(computeDiscountedPrice(1000, { value: 2000, unitType: 'WON' })).toBe(0);
  });
});

describe('buildStoreMappingRows', () => {
  const detail = {
    originProduct: {
      name: '[김본명 X 보바]  보조 배터리 마켓',
      salePrice: 35000,
      customerBenefit: { immediateDiscountPolicy: { discountMethod: { value: 5100, unitType: 'WON' } } },
      detailAttribute: {
        optionInfo: {
          optionCombinationGroupNames: { optionGroupName1: '보조배터리', optionGroupName2: '컬러' },
          optionCombinations: [
            { id: 1, optionName1: '[VA-115] 1만 키링형', optionName2: '화이트', price: 0, usable: true },
            { id: 2, optionName1: '[VA-123] 2만 키링형', optionName2: '퍼플', price: 9600, usable: true },
            { id: 3, optionName1: '[VA-115] 1만 키링형', optionName2: '단종', price: 0, usable: false },
          ],
        },
        supplementProductInfo: {
          supplementProducts: [
            { id: 11, groupName: '[VA-998] 파우치', name: '아이보리', price: 5900, usable: true },
            { id: 12, groupName: '[VA-223] 케이블', name: '핑크', price: 8900, usable: true },
            { id: 13, groupName: '[VA-998] 파우치', name: '단종색', price: 5900, usable: false },
          ],
        },
      },
    },
    smartstoreChannelProduct: { name: '[김본명 X 보바]  보조 배터리 마켓' },
  };

  it('옵션 조합을 주문 productOption 포맷("그룹: 옵션 / 그룹: 옵션")으로 만든다', () => {
    const { rows } = buildStoreMappingRows(detail);
    const combo = rows.find(r => r.optionName.includes('2만 키링형'));
    expect(combo?.optionName).toBe('보조배터리: [VA-123] 2만 키링형 / 컬러: 퍼플');
    expect(combo?.productName).toBe('[김본명 X 보바]  보조 배터리 마켓');
  });

  it('옵션 가격 = 할인 반영가 + 델타 (29900 + 9600 = 39500, 실주문 결제액과 일치)', () => {
    const { rows } = buildStoreMappingRows(detail);
    expect(rows.find(r => r.optionName.includes('2만 키링형'))?.price).toBe(39500);
    expect(rows.find(r => r.optionName.includes('1만 키링형'))?.price).toBe(29900);
  });

  it('추가구성상품은 주문 포맷("그룹명: 이름")·절대가·상품명 공백으로 만든다', () => {
    const { rows } = buildStoreMappingRows(detail);
    const addon = rows.find(r => r.optionName === '[VA-998] 파우치: 아이보리');
    expect(addon).toBeTruthy();
    expect(addon?.price).toBe(5900);
    expect(addon?.productName).toBe(''); // 추가구성 주문 productName은 애드온 자체명 — 옵션명 단독 매칭
  });

  it('usable=false 옵션/추가구성은 제외한다', () => {
    const { rows } = buildStoreMappingRows(detail);
    expect(rows.some(r => r.optionName.includes('단종'))).toBe(false);
  });

  it('brandCode는 전부 빈 값(코드표 없는 거래처 미기입 운영)', () => {
    const { rows } = buildStoreMappingRows(detail);
    expect(rows.every(r => r.brandCode === '')).toBe(true);
  });

  it('옵션이 전혀 없으면 상품명+할인가 단일 행', () => {
    const single = buildStoreMappingRows({
      originProduct: { name: '단일상품', salePrice: 10000 },
    });
    expect(single.rows).toEqual([{ productName: '단일상품', optionName: '', brandCode: '', price: 10000 }]);
  });

  it('본문이 비어도 안전하게 빈 결과를 반환한다', () => {
    expect(buildStoreMappingRows(null).rows).toEqual([]);
    expect(buildStoreMappingRows({}).rows).toEqual([]);
  });
});
