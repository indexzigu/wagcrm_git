import { describe, expect, it } from 'vitest';
import {
  applyOrderExcelRules,
  ORDER_EXCEL_GUARDS,
  parseOrderExcelRules,
  resolveColumnValue,
  stripPreviousSlot,
  swapPreviousSlot,
  withPreviousSlot,
  type NaverOrderRowLike,
} from '../excel-rules';
// §7 레거시 폴백 제거 후 골든 규칙은 테스트 픽스처로 이전 — 범용 유효 규칙 샘플로 재사용.
import {
  NUTRIONE_GOLDEN_RULES as NUTRIONE_LEGACY_RULES,
  TRIPP_GOLDEN_RULES as TRIPP_LEGACY_RULES,
} from './golden-rules.fixture';

const BASE_ORDER: NaverOrderRowLike = {
  주문일: '2026-07-05 10:12',
  상품주문번호: '2026070512345671',
  구매자명: '김주문',
  구매자연락처: '010-1111-2222',
  수취인명: '박받아',
  수취인연락처1: '010-5555-6666',
  우편번호: '06236',
  배송지: '서울시 강남구',
  옵션정보: '1박스',
  수량: 2,
  배송비: '3,000원',
  배송메시지: '문앞',
  사은품: '',
  상품코드: 'ABC12345',
  검증: 'TRUE',
  공구판매가: 12900,
};

describe('ORDER_EXCEL_GUARDS.productCodeMapped', () => {
  it('상품코드 존재 + 검증 정상 → true', () => {
    expect(ORDER_EXCEL_GUARDS.productCodeMapped(BASE_ORDER)).toBe(true);
  });

  it('상품코드 없음 → false', () => {
    expect(ORDER_EXCEL_GUARDS.productCodeMapped({ ...BASE_ORDER, 상품코드: '' })).toBe(false);
  });

  it("검증에 'FALSE' 포함 → false (가격 불일치 행 수식 보존)", () => {
    expect(
      ORDER_EXCEL_GUARDS.productCodeMapped({ ...BASE_ORDER, 검증: 'FALSE (네이버: 1000원 != 계산: 2000원)' })
    ).toBe(false);
  });

  it("검증 '매핑 실패' → false", () => {
    expect(ORDER_EXCEL_GUARDS.productCodeMapped({ ...BASE_ORDER, 검증: '매핑 실패' })).toBe(false);
  });

  it('검증 미기재 + 상품코드 존재 → true (API 직접 매핑 케이스)', () => {
    expect(ORDER_EXCEL_GUARDS.productCodeMapped({ ...BASE_ORDER, 검증: undefined })).toBe(true);
  });
});

describe('resolveColumnValue', () => {
  it('field: 값 그대로, 빈값은 빈 문자열', () => {
    expect(resolveColumnValue({ type: 'field', field: '수취인명' }, BASE_ORDER, {})).toBe('박받아');
    expect(resolveColumnValue({ type: 'field', field: '수취인연락처2' }, BASE_ORDER, {})).toBe('');
  });

  it('fallbackField: 주필드 falsy 시 폴백 (구매자명 || 수취인명)', () => {
    const gift = { ...BASE_ORDER, 구매자명: '' };
    expect(
      resolveColumnValue({ type: 'field', field: '구매자명', fallbackField: '수취인명' }, gift, {})
    ).toBe('박받아');
  });

  it('fallbackValue: 수량 0 → 1 (레거시 `|| 1`), 마지막 항 falsy 보존: 공구판매가 undefined → 숫자 0', () => {
    expect(
      resolveColumnValue({ type: 'field', field: '수량', fallbackValue: 1 }, { ...BASE_ORDER, 수량: 0 }, {})
    ).toBe(1);
    expect(
      resolveColumnValue({ type: 'field', field: '공구판매가', fallbackValue: 0 }, { ...BASE_ORDER, 공구판매가: undefined }, {})
    ).toBe(0);
  });

  it("currency-krw: 비숫자 제거 + '\\' + ko-KR 천단위 (레거시 배송비 서식)", () => {
    expect(
      resolveColumnValue({ type: 'field', field: '배송비', transform: 'currency-krw' }, BASE_ORDER, {})
    ).toBe('\\3,000');
    expect(
      resolveColumnValue({ type: 'field', field: '배송비', transform: 'currency-krw' }, { ...BASE_ORDER, 배송비: '무료' }, {})
    ).toBe('\\0');
    expect(
      resolveColumnValue({ type: 'field', field: '배송비', transform: 'currency-krw' }, { ...BASE_ORDER, 배송비: 0 }, {})
    ).toBe('\\0');
  });

  it('guard 불충족 → undefined (셀 미접촉 신호)', () => {
    expect(
      resolveColumnValue(
        { type: 'field', field: '상품코드', guard: 'productCodeMapped' },
        { ...BASE_ORDER, 검증: '매핑 실패' },
        {}
      )
    ).toBeUndefined();
  });

  it('template: 변수 치환 + 전부 빈값이면 fallback (레거시 업체명 분기)', () => {
    const source = { type: 'template', template: '와이그라운드({{sellerName}})', fallback: '와이그라운드' } as const;
    expect(resolveColumnValue(source, BASE_ORDER, { sellerName: '김본명' })).toBe('와이그라운드(김본명)');
    expect(resolveColumnValue(source, BASE_ORDER, {})).toBe('와이그라운드');
    expect(resolveColumnValue(source, BASE_ORDER, { sellerName: '' })).toBe('와이그라운드');
  });

  it('const / empty', () => {
    expect(resolveColumnValue({ type: 'const', value: '고정' }, BASE_ORDER, {})).toBe('고정');
    expect(resolveColumnValue({ type: 'empty' }, BASE_ORDER, {})).toBe('');
  });
});

describe('applyOrderExcelRules', () => {
  it('guard 불충족 열은 쓰기 목록에서 제외된다 (뉴트리원 16~18열)', () => {
    const failed = { ...BASE_ORDER, 상품코드: '', 검증: '매핑 실패' };
    const cols = applyOrderExcelRules(failed, NUTRIONE_LEGACY_RULES, {}).map((w) => w.col);
    expect(cols).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('guard 충족 시 16~18열 포함 + 검증 폴백 TRUE(API)', () => {
    const apiMapped = { ...BASE_ORDER, 검증: undefined, 공구판매가: undefined };
    const writes = applyOrderExcelRules(apiMapped, NUTRIONE_LEGACY_RULES, {});
    const byCol = Object.fromEntries(writes.map((w) => [w.col, w.value]));
    expect(byCol[16]).toBe('ABC12345');
    expect(byCol[17]).toBe('TRUE(API)');
    expect(byCol[18]).toBe(0);
  });

  it('트리프 규칙은 18열 전부 기입한다 (의도적 공란 포함)', () => {
    const writes = applyOrderExcelRules(BASE_ORDER, TRIPP_LEGACY_RULES, { sellerName: '김본명' });
    expect(writes.map((w) => w.col)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    const byCol = Object.fromEntries(writes.map((w) => [w.col, w.value]));
    expect(byCol[2]).toBe('010-5555-6666'); // 살아있는 프로덕션 배치: 전화(col2)=수취인연락처1
    expect(byCol[3]).toBe('');
    expect(byCol[17]).toBe('와이그라운드(김본명)');
  });
});

describe('parseOrderExcelRules (DB Json 검증)', () => {
  it('레거시 상수는 스키마를 통과한다', () => {
    expect(parseOrderExcelRules(TRIPP_LEGACY_RULES)).not.toBeNull();
    expect(parseOrderExcelRules(NUTRIONE_LEGACY_RULES)).not.toBeNull();
  });

  it('null/불량 JSON → null (레거시 폴백 신호)', () => {
    expect(parseOrderExcelRules(null)).toBeNull();
    expect(parseOrderExcelRules({ version: 2 })).toBeNull();
    expect(parseOrderExcelRules({ ...TRIPP_LEGACY_RULES, columns: [] })).toBeNull();
    expect(
      parseOrderExcelRules({
        ...TRIPP_LEGACY_RULES,
        columns: [{ col: 1, header: 'x', source: { type: 'field', field: '없는필드' } }],
      })
    ).toBeNull();
  });

  it('previous 슬롯이 있는 규칙도 스키마를 통과하고, 중첩 previous는 거부한다', () => {
    const withPrev = { ...TRIPP_LEGACY_RULES, previous: NUTRIONE_LEGACY_RULES };
    expect(parseOrderExcelRules(withPrev)).not.toBeNull();
    const nested = { ...TRIPP_LEGACY_RULES, previous: { ...NUTRIONE_LEGACY_RULES, previous: TRIPP_LEGACY_RULES } };
    // zod 비-strict 객체는 미지 키를 벗겨낸다 — 중첩 previous는 저장물에서 제거됨
    const parsed = parseOrderExcelRules(nested);
    expect((parsed?.previous as Record<string, unknown> | undefined)?.previous).toBeUndefined();
  });
});

describe('previous 슬롯 헬퍼 (D10 되돌리기)', () => {
  it('withPreviousSlot: 기존 활성 규칙이 previous로 들어가고 중첩되지 않는다', () => {
    const first = withPreviousSlot(TRIPP_LEGACY_RULES, null);
    expect(first.previous).toBeUndefined();

    const second = withPreviousSlot(NUTRIONE_LEGACY_RULES, { ...TRIPP_LEGACY_RULES, previous: stripPreviousSlot(NUTRIONE_LEGACY_RULES) });
    expect(second.write.mode).toBe('fill-template');
    expect(second.previous?.write.mode).toBe('new-workbook');
    expect((second.previous as Record<string, unknown> | undefined)?.['previous' as never]).toBeUndefined();
  });

  it('swapPreviousSlot: 활성↔직전 스왑, previous 없으면 null', () => {
    expect(swapPreviousSlot(TRIPP_LEGACY_RULES)).toBeNull();

    const active = withPreviousSlot(NUTRIONE_LEGACY_RULES, TRIPP_LEGACY_RULES);
    const swapped = swapPreviousSlot(active);
    expect(swapped?.write.mode).toBe('new-workbook'); // 직전(트리프형)이 활성으로
    expect(swapped?.previous?.write.mode).toBe('fill-template'); // 현 활성이 직전으로
    // 한 번 더 스왑하면 원상복구 (토글 가능)
    const swappedBack = swapPreviousSlot(swapped!);
    expect(swappedBack?.write.mode).toBe('fill-template');
  });
});
