import { describe, it, expect } from 'vitest';
import { parseEmailDomains, normalizeFormatAdapter, partnerToOrderBrand, resolveReplyRule, type OrderBrand } from '../order-brand';
import { DEFAULT_NEW_WORKBOOK_RULES } from '../excel-rules';
import {
  NUTRIONE_GOLDEN_RULES as NUTRIONE_LEGACY_RULES,
  TRIPP_GOLDEN_RULES as TRIPP_LEGACY_RULES,
} from './golden-rules.fixture';

const baseBrand: OrderBrand = {
  slug: 's',
  partnerId: 'p',
  displayName: 'd',
  emailDomains: [],
  formatAdapter: 'template-file',
  toEmail: null,
  ccEmail: null,
  excelRules: null,
};

describe('parseEmailDomains', () => {
  it('splits, trims, lowercases, and guarantees a leading @', () => {
    expect(parseEmailDomains('@Alpha.co.kr, BETA.com')).toEqual(['@alpha.co.kr', '@beta.com']);
  });
  it('extracts the domain even if a full address is pasted', () => {
    expect(parseEmailDomains('order@Brand.co.kr')).toEqual(['@brand.co.kr']);
  });
  it('treats null/empty/whitespace-only as no domains', () => {
    expect(parseEmailDomains(null)).toEqual([]);
    expect(parseEmailDomains(undefined)).toEqual([]);
    expect(parseEmailDomains('')).toEqual([]);
    expect(parseEmailDomains('  ,  , ')).toEqual([]);
  });
});

describe('normalizeFormatAdapter', () => {
  it('keeps tripp, coerces everything else to template-file', () => {
    expect(normalizeFormatAdapter('tripp')).toBe('tripp');
    expect(normalizeFormatAdapter('template-file')).toBe('template-file');
    expect(normalizeFormatAdapter(null)).toBe('template-file');
    expect(normalizeFormatAdapter('legacy-unknown')).toBe('template-file');
  });
});

describe('partnerToOrderBrand', () => {
  const base = {
    id: 'p1',
    name: '뉴트리원(주)',
    orderTemplateSlug: null,
    orderDisplayName: null,
    orderEmailDomains: null,
    orderFormatAdapter: null,
    orderToEmail: null,
    orderCcEmail: null,
  };

  it('returns null for a partner that is not an order brand (no slug)', () => {
    expect(partnerToOrderBrand(base)).toBeNull();
  });

  it('falls back displayName to the partner name when orderDisplayName is blank', () => {
    expect(partnerToOrderBrand({ ...base, orderTemplateSlug: 'nutrione' })).toEqual({
      slug: 'nutrione',
      partnerId: 'p1',
      displayName: '뉴트리원(주)',
      emailDomains: [],
      formatAdapter: 'template-file',
      toEmail: null,
      ccEmail: null,
      excelRules: null,
    });
  });

  it('uses every configured field and derives the reply-match domain from the To email', () => {
    expect(
      partnerToOrderBrand({
        id: 'p2',
        name: '내부명',
        orderTemplateSlug: 'tripp',
        orderDisplayName: '트리프',
        orderEmailDomains: null,
        orderFormatAdapter: 'tripp',
        orderToEmail: 'order@tripp.co.kr',
        orderCcEmail: 'cs@tripp.co.kr',
      }),
    ).toEqual({
      slug: 'tripp',
      partnerId: 'p2',
      displayName: '트리프',
      emailDomains: ['@tripp.co.kr'],
      formatAdapter: 'tripp',
      toEmail: 'order@tripp.co.kr',
      ccEmail: 'cs@tripp.co.kr',
      excelRules: null,
    });
  });

  it('parses confirmed excelRules and returns null for corrupted JSON (legacy fallback signal)', () => {
    const withRules = partnerToOrderBrand({
      ...base,
      orderTemplateSlug: 'p1',
      orderExcelRules: TRIPP_LEGACY_RULES,
    });
    expect(withRules?.excelRules?.write.mode).toBe('new-workbook');
    expect(withRules?.excelRules?.columns).toHaveLength(18);

    const corrupted = partnerToOrderBrand({
      ...base,
      orderTemplateSlug: 'p1',
      orderExcelRules: { version: 99, broken: true },
    });
    expect(corrupted?.excelRules).toBeNull();
  });
});

describe('resolveReplyRule (F4 Phase 2 §5단계 — 신규 브랜드 회신 파싱 복구)', () => {
  it('확정 규칙이 있으면 규칙의 reply가 권위', () => {
    const brand: OrderBrand = { ...baseBrand, excelRules: NUTRIONE_LEGACY_RULES };
    expect(resolveReplyRule(brand)).toBe(NUTRIONE_LEGACY_RULES.reply);
  });

  it('규칙이 없으면 표준 reply로 폴백 (§7 레거시 폴백 제거 — formatAdapter 무관)', () => {
    // 알려진 브랜드는 orderExcelRules로 시드돼 각자 reply를 쓰므로 이 폴백에 도달하지 않는다.
    expect(resolveReplyRule({ ...baseBrand, formatAdapter: 'tripp' })).toEqual(DEFAULT_NEW_WORKBOOK_RULES.reply);
    expect(resolveReplyRule({ ...baseBrand, formatAdapter: 'template-file' })).toEqual(DEFAULT_NEW_WORKBOOK_RULES.reply);
  });

  it('brand가 null이면 표준(lenient) reply 기본', () => {
    expect(resolveReplyRule(null)).toEqual(DEFAULT_NEW_WORKBOOK_RULES.reply);
  });
});
