/**
 * 정산 재무 카드 저장의 낙관적 동시성 가드(W1) — 「낡은 화면이 새 값을 덮어쓰지 못하게」.
 *
 * 배경(2026-10-13 운영 관찰): 정산 화면 패널이 캐시된 옛 행을 보여 주는 동안 재무 카드를
 * 저장하면, 클라이언트가 계산한 diff 의 **기준선**이 옛 값이다. 특히 정산 부가 항목은
 * 저장 시 **전체 교체**(campaignService deleteMany + create)라, 옛 목록으로 저장하면 그사이
 * 다른 화면에서 추가된 항목이 **실제로 삭제**된다.
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

export type FinancialExpectation = {
  fields?: Partial<Record<GuardedFinancialField, GuardScalar>>;
  /** 부가 항목을 교체할 때만 — 화면에서 본 목록(정렬 순서 그대로). */
  settlementItems?: Array<{
    invoiceMode: string;
    counterparty: string;
    amount: number;
    note: string | null;
  }>;
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

/**
 * 클라이언트 — 패치에 실린 가드 대상 필드마다 「화면이 본 이전 값」을 담는다.
 * 패치가 가드 대상을 하나도 안 쓰면 undefined(대조 없음).
 */
export function buildFinancialExpectation(
  baseline: Partial<Record<GuardedFinancialField, unknown>> & {
    settlementItems?: readonly SettlementItemComparable[] | null;
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
  return Object.keys(expectation).length > 0 ? expectation : undefined;
}

/**
 * 서버 — 현재 DB 값과 기대값을 대조해 어긋난 필드 이름을 돌려준다(빈 배열 = 통과).
 * 부가 항목 목록이 어긋나면 `"settlementItems"` 한 개로 보고한다.
 */
export function findFinancialConflicts(
  current: Partial<Record<GuardedFinancialField, unknown>> & {
    settlementItems?: readonly SettlementItemComparable[] | null;
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
  return conflicts;
}
