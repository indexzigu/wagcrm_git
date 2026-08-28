import { describe, expect, it } from 'vitest';
import {
  normalizeMatchText,
  normalizeOptionMatchText,
  evaluateMappingMatch,
  pickBestMapping,
} from './mapping-match';

describe('normalizeMatchText (기본 정규화 — 기존 3곳과 byte-identical)', () => {
  it('영숫자·한글만 남기고 소문자화한다', () => {
    expect(normalizeMatchText('제품: A / 수량: 2개')).toBe('제품a수량2개');
    expect(normalizeMatchText('AB-12 세트')).toBe('ab12세트');
  });
  it('null/undefined는 빈 문자열', () => {
    expect(normalizeMatchText(null)).toBe('');
    expect(normalizeMatchText(undefined)).toBe('');
  });
});

describe('normalizeOptionMatchText (옵션 잡음 제거 확장)', () => {
  it('라벨 접두어(전각/반각 콜론)를 지운다', () => {
    expect(normalizeOptionMatchText('맛: 딸기')).toBe('딸기');
    expect(normalizeOptionMatchText('색상：블랙')).toBe('블랙');
  });
  it('할인율·수량 단위 꼬리를 지운다', () => {
    expect(normalizeOptionMatchText('딸기 [27%]')).toBe('딸기');
    expect(normalizeOptionMatchText('딸기 2박스')).toBe('딸기2');
  });
  it('여러 축 조합 옵션을 값만 남긴다', () => {
    // "맛: 딸기 / 용량: 500ml" → 라벨 제거 후 "딸기500ml" 표준형
    expect(normalizeOptionMatchText('맛: 딸기 / 용량: 500ml')).toBe('딸기500ml');
  });
});

describe('evaluateMappingMatch', () => {
  it('상품+옵션 둘 다 있으면 AND 매칭', () => {
    const m = { productName: '콜라겐', optionName: '딸기' };
    expect(evaluateMappingMatch(m, '콜라겐 100', '딸기').isMatch).toBe(true);
    expect(evaluateMappingMatch(m, '콜라겐 100', '포도').isMatch).toBe(false);
  });

  it('2차 폴백: 잡음 낀 옵션명도 매칭한다(1차 실패 → 잡음제거 substring)', () => {
    // 매핑 옵션 "딸기500ml", 주문 옵션 "맛: 딸기 / 용량: 500ml [27%]"
    // 기본 정규화로는 "맛딸기용량500ml"에 "딸기500ml"이 substring이 아니라 1차 실패,
    // 잡음 제거 후 양쪽 "딸기500ml"로 수렴해 2차 폴백이 건진다.
    const m = { optionName: '딸기500ml' };
    const res = evaluateMappingMatch(m, '', '맛: 딸기 / 용량: 500ml [27%]');
    expect(res.optionMatches).toBe(true);
    expect(res.isMatch).toBe(true);
  });

  it('전혀 다른 옵션은 폴백으로도 매칭되지 않는다(오매칭 방지)', () => {
    const m = { optionName: '딸기' };
    expect(evaluateMappingMatch(m, '', '초콜릿').isMatch).toBe(false);
  });

  it('상품/옵션이 모두 비면 매칭 아님', () => {
    expect(evaluateMappingMatch({}, '아무거나', '아무거나').isMatch).toBe(false);
  });
});

describe('pickBestMapping — 옵션 완전일치 우선(1상품 N옵션 스토어)', () => {
  // 2026-07-17 실사고 재현: 스토어 상품 1개 + 옵션 11개 구조.
  // 모든 주문의 상품명이 동일하므로 pScore는 변별력이 없는데, 매핑 표의 상품명이 스토어명과
  // 우연히 더 많은 단어를 공유하는 행(3종혼합)이 정답(칼마디)을 점수로 이겨 주문을 흡수했다.
  const STORE_NAME = '[라온 X 비타슈넬]  이노시톨 / 철분 / 칼마디 3종 최저가 마켓';
  const MAPPINGS = [
    { productName: '이노시톨+칼마디+철분', optionName: '제품: [비타슈넬] 3종 혼합 SET / 수량: [23%] 1+1+1박스 (1개월분)', campaignDealId: 'deal-3종-1개월' },
    { productName: '이노시톨+칼마디+철분', optionName: '제품: [비타슈넬] 3종 혼합 SET / 수량: [27%] 3+3+3박스 (3개월분)', campaignDealId: 'deal-3종-3개월' },
    { productName: '칼마디K 2X PGA', optionName: '제품: [비타슈넬] 칼마디K / 수량: [27%] 3박스 (3개월분)', campaignDealId: 'deal-칼마디-3박스' },
    { productName: '데일리 철분 츄어블', optionName: '제품: [비타슈넬] 철분 츄어블 / 수량: [24%] 3박스 (3개월분)', campaignDealId: 'deal-철분-3박스' },
  ];

  it('칼마디 주문은 칼마디 딜에 붙는다 (3종혼합 매핑이 상품명 점수로 흡수하지 못한다)', () => {
    const best = pickBestMapping(MAPPINGS, STORE_NAME, '제품: [비타슈넬] 칼마디K / 수량: [27%] 3박스 (3개월분)');
    expect(best?.campaignDealId).toBe('deal-칼마디-3박스');
  });

  it('3종혼합 3개월 주문은 3개월 딜에 붙는다 (동점→선착순으로 1개월에 붙지 않는다)', () => {
    const best = pickBestMapping(MAPPINGS, STORE_NAME, '제품: [비타슈넬] 3종 혼합 SET / 수량: [27%] 3+3+3박스 (3개월분)');
    expect(best?.campaignDealId).toBe('deal-3종-3개월');
  });

  it('3종혼합 1개월 주문은 1개월 딜에 붙는다', () => {
    const best = pickBestMapping(MAPPINGS, STORE_NAME, '제품: [비타슈넬] 3종 혼합 SET / 수량: [23%] 1+1+1박스 (1개월분)');
    expect(best?.campaignDealId).toBe('deal-3종-1개월');
  });

  it('철분 주문은 철분 딜에 붙는다', () => {
    const best = pickBestMapping(MAPPINGS, STORE_NAME, '제품: [비타슈넬] 철분 츄어블 / 수량: [24%] 3박스 (3개월분)');
    expect(best?.campaignDealId).toBe('deal-철분-3박스');
  });

  it('완전일치가 없으면 기존 점수 규칙으로 폴백한다', () => {
    const best = pickBestMapping(MAPPINGS, STORE_NAME, '제품: [비타슈넬] 칼마디K / 수량: [99%] 9박스 (9개월분)');
    // 완전일치 없음 → 점수 최고를 고르되, 매칭 자체는 유지(회귀 없음)
    expect(best).not.toBeNull();
  });
});

describe('pickBestMapping', () => {
  it('매칭된 것 중 최고 점수 매핑을 고른다', () => {
    const mappings = [
      { productName: '콜라겐', optionName: '딸기', campaignDealId: 'deal-A' },
      { productName: '콜라겐 프리미엄 딸기', optionName: '딸기', campaignDealId: 'deal-B' },
    ];
    const best = pickBestMapping(mappings, '콜라겐 프리미엄 딸기', '딸기');
    expect(best?.campaignDealId).toBe('deal-B');
  });

  it('매칭이 하나도 없으면 null', () => {
    const mappings = [{ productName: '콜라겐', optionName: '딸기' }];
    expect(pickBestMapping(mappings, '비타민', '포도')).toBeNull();
  });
});
