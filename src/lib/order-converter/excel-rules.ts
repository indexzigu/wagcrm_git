import { z } from 'zod';

// F4 Phase 2 — 네이버→발주서 열 매핑 규칙 (F4_ORDER_MAPPING_ENGINE_PLAN.md §2)
// ─────────────────────────────────────────────────────────────
// "발주서의 어느 열에 어떤 네이버 값이 들어가는가"를 데이터(Partner.orderExcelRules)로
// 표현한다. 값 배치만 규칙 스코프이며, 수식 shift·스타일 복제·'코드' 시트 bigram
// 내리채우기 등 구조 기계는 excel-generator.ts에 잔존한다(설계 D5 경계).
//
// 무손실 패리티 원칙: 기존 하드코딩(뉴트리원/트리프)은 아래 *_LEGACY_RULES 상수로
// 바이트 동일하게 표현되고, __tests__/excel-generator-parity.test.ts가
// 변경 전 스냅샷과의 셀 단위 동일성으로 이를 증명한다.

/** 네이버 주문 표준 필드 화이트리스트 (OrderData 키와 1:1). */
export const NAVER_ORDER_FIELDS = [
  '주문일',
  '상품주문번호',
  '구매자명',
  '구매자연락처',
  '수취인명',
  '수취인연락처1',
  '수취인연락처2',
  '우편번호',
  '배송지',
  '옵션정보',
  '수량',
  '배송비',
  '배송메시지',
  '사은품',
  '상품코드',
  '검증',
  '공구판매가',
] as const;

export type NaverOrderField = (typeof NAVER_ORDER_FIELDS)[number];

/** 규칙 적용 대상 행 — OrderData가 이를 만족한다 (순환 import 방지용 최소 형태). */
export type NaverOrderRowLike = Partial<Record<NaverOrderField, string | number | undefined>>;

// 조건부 기입 술어 레지스트리. v1은 1종 — 뉴트리원 col16~18의 "API 매핑 우선" 조건.
// (레거시와 동일 판정: 상품코드 truthy && 검증에 'FALSE' 미포함 && 검증 !== '매핑 실패')
export const ORDER_EXCEL_GUARDS = {
  productCodeMapped: (order: NaverOrderRowLike): boolean =>
    Boolean(order.상품코드) && !String(order.검증 ?? '').includes('FALSE') && order.검증 !== '매핑 실패',
} as const;

export type OrderExcelGuard = keyof typeof ORDER_EXCEL_GUARDS;

const fieldSourceSchema = z.object({
  type: z.literal('field'),
  field: z.enum(NAVER_ORDER_FIELDS),
  // 폴백은 레거시(`||`)와 동일한 falsy 판정 — 수량 0도 fallbackValue로 대체된다.
  fallbackField: z.enum(NAVER_ORDER_FIELDS).optional(),
  fallbackValue: z.union([z.string(), z.number()]).optional(),
  // currency-krw: 비숫자 제거 → '\' + ko-KR 천단위 (레거시 배송비 서식과 바이트 동일)
  transform: z.enum(['currency-krw']).optional(),
  guard: z.enum(['productCodeMapped']).optional(),
});

const templateSourceSchema = z.object({
  type: z.literal('template'),
  template: z.string().min(1), // v1 변수: {{sellerName}}
  // 참조한 변수가 전부 빈값이면 이 값으로 대체 (예: '와이그라운드')
  fallback: z.string().optional(),
});

const constSourceSchema = z.object({ type: z.literal('const'), value: z.string() });
const emptySourceSchema = z.object({ type: z.literal('empty') }); // 의도적 공란(미매핑과 구분)

export const orderExcelColumnSourceSchema = z.discriminatedUnion('type', [
  fieldSourceSchema,
  templateSourceSchema,
  constSourceSchema,
  emptySourceSchema,
]);

export const orderExcelColumnRuleSchema = z.object({
  col: z.number().int().min(1), // 1-based 열 번호가 키 (헤더명은 중복 가능 — 트리프 '수량' 2회)
  header: z.string(), // 양식 헤더 스냅샷 (검증·표시용, 빈 헤더 열 허용)
  source: orderExcelColumnSourceSchema,
});

export const orderExcelWriteSchema = z.object({
  mode: z.enum(['fill-template', 'new-workbook']),
  sheetName: z.string().min(1),
  headerRow: z.number().int().min(1),
  dataStartRow: z.number().int().min(1),
  // '코드' 시트 재생성 게이트. 데이터 소스는 campaign.mappings이고 bigram 유사도
  // 내리채우기 로직은 엔진(excel-generator) 잔존 — 규칙은 on/off만 소유한다.
  codeSheet: z.object({ enabled: z.boolean() }).optional(),
});

export const orderExcelReplySchema = z.object({
  orderIdHeaders: z.array(z.string().min(1)).min(1),
  // naver-strict: /^\d[\d\-]{7,}$/ — 트리프 회신의 '이벤트(트리프지원)' 등 비주문 행 배제
  orderIdPattern: z.enum(['naver-strict', 'lenient']),
  trackingHeaders: z.array(z.string().min(1)).optional(),
});

const orderExcelRulesCoreSchema = z.object({
  version: z.literal(1),
  sourceAssetId: z.string().nullable(), // 분석 원본 ORDER_TEMPLATE 자산 (provenance)
  templateStoragePath: z.string().nullable(), // 확정 시 복사된 템플릿 스냅샷 (fill-template 필수)
  analyzedAt: z.string(), // ISO. 코드 상수(레거시)는 ''
  headerSnapshot: z.array(z.string()),
  write: orderExcelWriteSchema,
  columns: z.array(orderExcelColumnRuleSchema).min(1),
  reply: orderExcelReplySchema,
});

// 직전 확정본 1슬롯(설계 D10) — 검수 확정이 운영 문서를 바꾸므로 되돌리기 수단을 내장한다.
export const orderExcelRulesSchema = orderExcelRulesCoreSchema.extend({
  previous: orderExcelRulesCoreSchema.optional(),
});

export type OrderExcelColumnSource = z.infer<typeof orderExcelColumnSourceSchema>;
export type OrderExcelColumnRule = z.infer<typeof orderExcelColumnRuleSchema>;
export type OrderExcelReply = z.infer<typeof orderExcelReplySchema>;
export type OrderExcelRulesCore = z.infer<typeof orderExcelRulesCoreSchema>;
export type OrderExcelRules = z.infer<typeof orderExcelRulesSchema>;

/** previous 슬롯 제거 (중첩 방지 — previous 안에 previous를 담지 않는다). */
export function stripPreviousSlot(rules: OrderExcelRules | OrderExcelRulesCore): OrderExcelRulesCore {
  const { previous: _previous, ...core } = rules as OrderExcelRules;
  return core;
}

/** 확정 저장용: 새 규칙 + 기존 활성 규칙을 previous 슬롯으로. */
export function withPreviousSlot(next: OrderExcelRules | OrderExcelRulesCore, currentActive: OrderExcelRules | null): OrderExcelRules {
  const core = stripPreviousSlot(next);
  return currentActive ? { ...core, previous: stripPreviousSlot(currentActive) } : core;
}

/** 되돌리기: 활성↔직전 스왑 (직전이 없으면 null — 호출부가 액션 비노출/에러 처리). */
export function swapPreviousSlot(active: OrderExcelRules): OrderExcelRules | null {
  if (!active.previous) return null;
  return { ...active.previous, previous: stripPreviousSlot(active) };
}

/**
 * DB(Json 컬럼) 값 → 검증된 규칙. 실패는 null 반환 + 경고 로그(호출부는 레거시 폴백) —
 * 발주서는 운영 문서라 손상 규칙으로 생성하는 것보다 폴백이 안전하다.
 */
export function parseOrderExcelRules(raw: unknown): OrderExcelRules | null {
  if (raw == null) return null;
  const parsed = orderExcelRulesSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[order-excel-rules] 저장된 매핑 규칙이 스키마와 불일치 — 레거시 폴백 사용:', parsed.error.issues[0]);
    return null;
  }
  return parsed.data;
}

export interface OrderExcelContext {
  sellerName?: string;
}

/** '와이그라운드({{sellerName}})' 렌더. 참조 변수 전부 빈값이면 fallback(있을 때). */
function renderTemplate(template: string, fallback: string | undefined, ctx: OrderExcelContext): string {
  let anyVarFilled = false;
  let anyVarSeen = false;
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    anyVarSeen = true;
    const value = name === 'sellerName' ? ctx.sellerName : undefined;
    if (value) anyVarFilled = true;
    return value ? String(value) : '';
  });
  if (anyVarSeen && !anyVarFilled && fallback !== undefined) return fallback;
  return rendered;
}

/** currency-krw: 레거시 배송비 서식과 바이트 동일 ('\' + ko-KR 천단위, 비숫자 제거). */
function transformCurrencyKrw(raw: string | number | undefined): string {
  const digits = String(raw || '0').replace(/[^0-9]/g, '');
  const amount = Number(digits) || 0;
  return `\\${amount.toLocaleString('ko-KR')}`;
}

/**
 * 규칙 1열 → 셀 값. guard 불충족이면 undefined(셀을 건드리지 않음 — fill-template에서
 * 템플릿 수식 보존 의미). 'empty'는 ''(명시적 공란 기입)로, undefined와 구분된다.
 */
export function resolveColumnValue(
  source: OrderExcelColumnSource,
  order: NaverOrderRowLike,
  ctx: OrderExcelContext
): string | number | undefined {
  switch (source.type) {
    case 'empty':
      return '';
    case 'const':
      return source.value;
    case 'template':
      return renderTemplate(source.template, source.fallback, ctx);
    case 'field': {
      if (source.guard && !ORDER_EXCEL_GUARDS[source.guard](order)) return undefined;
      // 레거시 `a || b || <마지막 항>`과 동일한 falsy 폴백 체인.
      // 마지막 항은 falsy여도 그대로 기입된다 — `공구판매가 || 0`은 숫자 0을 쓴다(''가 아님).
      let value: string | number | undefined = order[source.field];
      if (!value && source.fallbackField) value = order[source.fallbackField];
      if (!value) value = source.fallbackValue !== undefined ? source.fallbackValue : '';
      if (source.transform === 'currency-krw') return transformCurrencyKrw(value);
      return value;
    }
  }
}

export interface OrderExcelCellWrite {
  col: number;
  value: string | number;
}

/** 주문 1행 × 규칙 → 셀 쓰기 목록. guard 불충족 열은 목록에서 제외(셀 미접촉). */
export function applyOrderExcelRules(
  order: NaverOrderRowLike,
  rules: OrderExcelRules,
  ctx: OrderExcelContext
): OrderExcelCellWrite[] {
  const writes: OrderExcelCellWrite[] = [];
  for (const column of rules.columns) {
    const value = resolveColumnValue(column.source, order, ctx);
    if (value === undefined) continue;
    writes.push({ col: column.col, value });
  }
  return writes;
}

// ─────────────────────────────────────────────────────────────
// 표준 발주서 (신규 브랜드 기본, 소유자 결정 2026-07-08).
// 뉴트리원/트리프가 아닌 미설정 브랜드(F4-② CUID slug)가 존재하지 않는
// public/{slug}_template.xlsx를 찾아 실패하던 문제를 해소한다. 매뉴팩처러가
// 배송에 필요한 최소 열 + 송장 회신 매핑 키(주문번호=상품주문번호)만 담은 범용 양식.
const DEFAULT_NEW_WORKBOOK_HEADERS = [
  '주문일', '주문번호', '수취인명', '연락처', '우편번호', '주소', '옵션', '수량', '배송메시지', '업체명',
];

export const DEFAULT_NEW_WORKBOOK_RULES: OrderExcelRules = {
  version: 1,
  sourceAssetId: null,
  templateStoragePath: null,
  analyzedAt: '',
  headerSnapshot: DEFAULT_NEW_WORKBOOK_HEADERS,
  write: { mode: 'new-workbook', sheetName: '발주서', headerRow: 1, dataStartRow: 2 },
  columns: [
    { col: 1, header: '주문일', source: { type: 'field', field: '주문일' } },
    { col: 2, header: '주문번호', source: { type: 'field', field: '상품주문번호' } }, // 송장 회신 매핑 키
    { col: 3, header: '수취인명', source: { type: 'field', field: '수취인명' } },
    { col: 4, header: '연락처', source: { type: 'field', field: '수취인연락처1' } },
    { col: 5, header: '우편번호', source: { type: 'field', field: '우편번호' } },
    { col: 6, header: '주소', source: { type: 'field', field: '배송지' } },
    { col: 7, header: '옵션', source: { type: 'field', field: '옵션정보' } },
    { col: 8, header: '수량', source: { type: 'field', field: '수량', fallbackValue: 1 } },
    { col: 9, header: '배송메시지', source: { type: 'field', field: '배송메시지' } },
    { col: 10, header: '업체명', source: { type: 'template', template: '와이그라운드({{sellerName}})', fallback: '와이그라운드' } },
  ],
  reply: {
    orderIdHeaders: ['주문번호', '상품주문번호'],
    orderIdPattern: 'lenient',
  },
};
