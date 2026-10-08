import { z } from "zod";

/**
 * 월별 정산 줄(T-240) 쓰기 입력 검증. 생략 = 무변경, null = 지움.
 * 공급가액·세액은 받지 않는다 — 서버가 수수료액에서 다시 나눈다(`monthlySettlementService`).
 */
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "귀속 월은 YYYY-MM 형식이어야 합니다");
const ymd = z.string().date().nullable().optional();
const money = z.number().finite().nullable().optional();
const text = (max: number) => z.string().trim().max(max).nullable().optional();

const lineFields = {
  periodStart: ymd,
  periodEnd: ymd,
  quantity: z.number().int().min(0).nullable().optional(),
  transactionAmount: money,
  commissionRate: z.number().min(0).max(100).nullable().optional(),
  commissionAmount: money,
  salesInvoiceIssuedAt: ymd,
  salesInvoiceNo: text(40),
  salesInvoiceItemName: text(100),
  purchaseInvoiceReceivedAt: ymd,
  goodsAmount: money,
  paymentAmount: money,
  paymentDueDate: ymd,
  paymentPaidAt: ymd,
  salesInvoiceCheckedAt: ymd,
  purchaseInvoiceCheckedAt: ymd,
  paymentScheduleCheckedAt: ymd,
  paymentCompletedCheckedAt: ymd,
  memo: text(1000),
};

export const createMonthlySettlementLineSchema = z.object({ yearMonth, ...lineFields }).strict();

export const updateMonthlySettlementLineSchema = z
  .object({ yearMonth: yearMonth.optional(), ...lineFields })
  .strict();

export const partnerMonthlySettlementSchema = z.object({ enabled: z.boolean() }).strict();
