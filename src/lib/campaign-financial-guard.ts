/**
 * 캠페인 재무 저장의 낙관적 동시성 가드 — 「낡은 화면이 새 값을 덮어쓰지 못하게」.
 * 적용 화면: 정산 재무 카드(재무 칸·부가 항목) · 매출 품목 표(품목 목록).
 *
 * 배경(2026-10-13 운영 관찰): 정산 화면 패널이 캐시된 옛 행을 보여 주는 동안 재무 카드를
 * 저장하면, 클라이언트가 계산한 diff 의 **기준선**이 옛 값이다. 특히 정산 부가 항목은
 * 저장 시 **전체 교체**(campaignService deleteMany + create)라, 옛 목록으로 저장하면 그사이
 * 다른 화면에서 추가된 항목이 **실제로 삭제**된다. 매출 품목 표도 품목 목록을 통째로 보낸다.
 *
 * 계약: 클라이언트는 **이번에 쓰는 필드만** "내가 화면에서 본 이전 값"을 함께 보낸다
 * (`buildFinancialExpectation`). 서버는 같은 트랜잭션 안에서 현재 DB 값과 대조하고
 * (`findFinancialConflicts`) 하나라도 다르면 커밋 전체를 버리고 409 를 돌려준다.
 * 쓰지 않는 필드는 대조하지 않는다 — 주문 동기화 크론이 실판매액을 바꿨다는 이유만으로
 * 무관한 운영비 저장까지 막으면 오너는 같은 입력을 반복하게 된다.
 *
 * ⚠️ 대조 기준은 **화면이 받은 행(`CampaignRow`)의 정규화**와 같아야 한다 — 서버는 DB 의
 * Decimal 을, 클라이언트는 `campaign-row.ts` 가 숫자로 바꾼 값을 보낸다. 그래서 양쪽 다
 * `normalizeGuardValue` 를 거쳐 비교하고, 부가 항목은 행 변환과 같은 필터
 * (`isSettlementInvoiceMode`·`isSettlementCounterparty`)를 적용한다.
 */
import { z } from "zod";
import {
  isSettlementCounterparty,
  isSettlementInvoiceMode,
} from "@/lib/settlement-items";

/** 재무 카드가 쓰는 스칼라 필드 — 이 목록 밖의 필드는 대조 대상이 아니다. */
export const GUARDED_FINANCIAL_FIELDS = [
  "settlementSupplyCost",
  "settlementGoodsCost",
  "sellerFeeBasisOverride",
  "operatingExpense",
  "miscExpense",
  "totalMarginRate",
  "sellerMarginRate",
  "isManualSettlementSales",
  "settlementSales",
  "isManualSellerExpense",
  "sellerExpense",
  "isManualTaxExpense",
  "taxExpense",
] as const;

export type GuardedFinancialField = (typeof GUARDED_FINANCIAL_FIELDS)[number];

type GuardScalar = number | boolean | null;

export type SettlementItemComparable = {
  invoiceMode: string;
  counterparty: string;
  amount: unknown;
  note: string | null | undefined;
};

/**
 * 품목 대조 단위 — 품목 표 저장이 덮어쓰는 값 전부(구성·수량·실판매액·수수료율·셀러 수수료율·
 * 공급가·판매가). ⚠️ 화면 행은 스냅샷이 비면 **딜 기본값으로 채워** 보여 주므로, 서버는 원본
 * 컬럼이 아니라 같은 채움 함수(`campaign-row.ts` resolveCampaignDealPrices)를 거친 값을 넘겨야
 * 한다 — 아니면 바뀐 게 없어도 409 가 난다.
 */
export type DealComparable = {
  dealId: string;
  quantity: unknown;
  actualSales: unknown;
  feeRate?: unknown;
  sellerMarginRate?: unknown;
  costPrice?: unknown;
  sellingPrice?: unknown;
};

type ExpectedDeal = {
  dealId: string;
  quantity: number;
  actualSales: number;
  feeRate: number | null;
  sellerMarginRate: number | null;
  costPrice: number | null;
  sellingPrice: number | null;
};

export type FinancialExpectation = {
  fields?: Partial<Record<GuardedFinancialField, GuardScalar>>;
  /** 부가 항목을 교체할 때만 — 화면에서 본 목록(정렬 순서 그대로). */
  settlementItems?: Array<{
    invoiceMode: string;
    counterparty: string;
    amount: number;
    note: string | null;
  }>;
  /** 품목 목록을 교체할 때만 — 화면이 본 품목(순서 무관). */
  campaignDeals?: ExpectedDeal[];
};

const guardScalarSchema = z.union([z.number(), z.boolean(), z.null()]);

export const financialExpectationSchema = z
  .object({
    fields: z
      .object(
        Object.fromEntries(
          GUARDED_FINANCIAL_FIELDS.map((field) => [field, guardScalarSchema.optional()]),
        ) as Record<GuardedFinancialField, z.ZodOptional<typeof guardScalarSchema>>,
      )
      .strict()
      .optional(),
    settlementItems: z
      .array(
        z.object({
          invoiceMode: z.string(),
          counterparty: z.string(),
          amount: z.number(),
          note: z.string().nullable(),
        }),
      )
      .max(50)
      .optional(),
    campaignDeals: z
      .array(
        z.object({
          dealId: z.string(),
          quantity: z.number(),
          actualSales: z.number(),
          feeRate: z.number().nullable(),
          sellerMarginRate: z.number().nullable(),
          costPrice: z.number().nullable(),
          sellingPrice: z.number().nullable(),
        }),
      )
      .max(200)
      .optional(),
  })
  .strict();

/** 이 사유 코드는 409 본문의 `code` 로 나가고 클라이언트 헬퍼가 문구를 고른다. */
export const CAMPAIGN_FINANCIAL_STALE_CODE = "CAMPAIGN_FINANCIAL_STALE";

/** Decimal·문자열·숫자를 같은 숫자로, null/undefined 는 null 로. 부동소수 잡음은 1e-6 에서 자른다. */
function normalizeGuardValue(value: unknown): GuardScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const numeric = Number(typeof value === "object" ? String(value) : value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 1e6) / 1e6;
}

function normalizeItems(items: readonly SettlementItemComparable[]) {
  return items
    .filter(
      (item) => isSettlementInvoiceMode(item.invoiceMode) && isSettlementCounterparty(item.counterparty),
    )
    .map((item) => ({
      invoiceMode: item.invoiceMode,
      counterparty: item.counterparty,
      amount: normalizeGuardValue(item.amount),
      note: item.note?.trim() ? item.note.trim() : null,
    }));
}

function normalizeDeals(deals: readonly DealComparable[]) {
  return deals
    .map((deal) => ({
      dealId: deal.dealId,
      quantity: normalizeGuardValue(deal.quantity),
      actualSales: normalizeGuardValue(deal.actualSales),
      feeRate: normalizeGuardValue(deal.feeRate),
      sellerMarginRate: normalizeGuardValue(deal.sellerMarginRate),
      costPrice: normalizeGuardValue(deal.costPrice),
      sellingPrice: normalizeGuardValue(deal.sellingPrice),
    }))
    // dealId 는 ASCII cuid 라 코드포인트 비교로 충분하다(로캘 비교는 환경마다 다를 수 있다).
    .sort((a, b) => (a.dealId < b.dealId ? -1 : a.dealId > b.dealId ? 1 : 0));
}

/**
 * 클라이언트 — 패치에 실린 가드 대상 필드마다 「화면이 본 이전 값」을 담는다.
 * 패치가 가드 대상을 하나도 안 쓰면 undefined(대조 없음).
 */
export function buildFinancialExpectation(
  baseline: Partial<Record<GuardedFinancialField, unknown>> & {
    settlementItems?: readonly SettlementItemComparable[] | null;
    campaignDeals?: readonly DealComparable[] | null;
  },
  patch: Record<string, unknown>,
): FinancialExpectation | undefined {
  const fields: Partial<Record<GuardedFinancialField, GuardScalar>> = {};
  for (const field of GUARDED_FINANCIAL_FIELDS) {
    if (patch[field] !== undefined) fields[field] = normalizeGuardValue(baseline[field]);
  }
  const expectation: FinancialExpectation = {};
  if (Object.keys(fields).length > 0) expectation.fields = fields;
  if (patch.settlementItems !== undefined) {
    expectation.settlementItems = normalizeItems(baseline.settlementItems ?? []).map((item) => ({
      ...item,
      amount: typeof item.amount === "number" ? item.amount : 0,
    }));
  }
  if (patch.campaignDeals !== undefined) {
    const numberOrNull = (value: GuardScalar) => (typeof value === "number" ? value : null);
    expectation.campaignDeals = normalizeDeals(baseline.campaignDeals ?? []).map((deal) => ({
      dealId: deal.dealId,
      quantity: numberOrNull(deal.quantity) ?? 0,
      actualSales: numberOrNull(deal.actualSales) ?? 0,
      feeRate: numberOrNull(deal.feeRate),
      sellerMarginRate: numberOrNull(deal.sellerMarginRate),
      costPrice: numberOrNull(deal.costPrice),
      sellingPrice: numberOrNull(deal.sellingPrice),
    }));
  }
  return Object.keys(expectation).length > 0 ? expectation : undefined;
}

/**
 * 서버 — 현재 DB 값과 기대값을 대조해 어긋난 필드 이름을 돌려준다(빈 배열 = 통과).
 * 부가 항목·품목 목록이 어긋나면 `"settlementItems"`·`"campaignDeals"` 한 개로 보고한다.
 */
export function findFinancialConflicts(
  current: Partial<Record<GuardedFinancialField, unknown>> & {
    settlementItems?: readonly SettlementItemComparable[] | null;
    campaignDeals?: readonly DealComparable[] | null;
  },
  expectation: FinancialExpectation,
): string[] {
  const conflicts: string[] = [];
  for (const [field, expected] of Object.entries(expectation.fields ?? {})) {
    if (expected === undefined) continue;
    const actual = normalizeGuardValue(current[field as GuardedFinancialField]);
    if (actual !== normalizeGuardValue(expected)) conflicts.push(field);
  }
  if (expectation.settlementItems !== undefined) {
    const actualItems = normalizeItems(current.settlementItems ?? []);
    const expectedItems = normalizeItems(expectation.settlementItems);
    if (JSON.stringify(actualItems) !== JSON.stringify(expectedItems)) {
      conflicts.push("settlementItems");
    }
  }
  if (expectation.campaignDeals !== undefined) {
    const actualDeals = normalizeDeals(current.campaignDeals ?? []);
    const expectedDeals = normalizeDeals(expectation.campaignDeals);
    if (JSON.stringify(actualDeals) !== JSON.stringify(expectedDeals)) {
      conflicts.push("campaignDeals");
    }
  }
  return conflicts;
}
