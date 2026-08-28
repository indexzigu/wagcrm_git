import { z } from "zod";

export const DEAL_STATUSES = [
  "SOURCING",
  "NEGOTIATING",
  "SAMPLE_TESTING",
  "CONFIRMED",
  "ARCHIVED",
  "DROPPED",
] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

/** Valid forward transitions + DROPPED from any state */
const VALID_TRANSITIONS: Record<DealStatus, DealStatus[]> = {
  SOURCING: ["NEGOTIATING", "DROPPED"],
  NEGOTIATING: ["CONFIRMED", "SAMPLE_TESTING", "DROPPED"],
  SAMPLE_TESTING: ["CONFIRMED", "DROPPED"],
  CONFIRMED: ["ARCHIVED", "DROPPED"],
  ARCHIVED: ["DROPPED"],
  DROPPED: [],
};

/**
 * Validates whether a deal status transition is allowed.
 * Only forward transitions and transitions to DROPPED are permitted.
 */
export function isValidDealStatusTransition(
  from: DealStatus,
  to: DealStatus
): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

const marginRateSchema = z.object({
  totalMarginRate: z.number(),
  sellerMarginRate: z.number(),
});

const slideRuleSchema = z.object({
  minActualSales: z.number(),
  totalMarginAddRate: z.number(),
  sellerMarginAddRate: z.number().optional(),
});

export const baseMarginPolicySchema = z.object({
  byChannel: z.record(z.string(), marginRateSchema),
  slides: z.array(slideRuleSchema).optional(),
});

export const createDealSchema = z.object({
  dealName: z.string().min(1, "딜 이름은 필수입니다"),
  partnerId: z.string().min(1, "거래처 연결은 필수입니다"),
  costPrice: z.number().min(0).default(0),
  sellingPrice: z.number().min(0).default(0),
  brandName: z.string().optional(),
  partnerCompanyName: z.string().optional(),
  listPrice: z.number().min(0).optional(),
  floorPrice: z.number().min(0).optional(),
  supplyPrice: z.number().min(0).nullable().optional(),
  discountRate: z.number().optional(),
  totalCommissionRate: z.number().optional(),
  brokerageCommissionRate: z.number().optional(),
  sourcingMemo: z.string().optional(),
  candidateSellers: z.string().optional(),
  baseMarginPolicy: baseMarginPolicySchema,
  parentDealId: z.string().nullable().optional(),
  dealType: z.string().optional(),
  optionSortOrder: z.number().int().min(0).optional(),
  unit: z.string().nullable().optional(),
  unitQuantity: z.number().nullable().optional(),
  supplementaryInfo: z.string().nullable().optional(),
});

export const updateDealSchema = z.object({
  dealName: z.string().min(1).optional(),
  partnerId: z.string().min(1).optional(),
  costPrice: z.number().min(0).optional(),
  sellingPrice: z.number().min(0).optional(),
  brandName: z.string().nullable().optional(),
  partnerCompanyName: z.string().nullable().optional(),
  listPrice: z.number().min(0).nullable().optional(),
  floorPrice: z.number().min(0).nullable().optional(),
  supplyPrice: z.number().min(0).nullable().optional(),
  discountRate: z.number().nullable().optional(),
  totalCommissionRate: z.number().nullable().optional(),
  brokerageCommissionRate: z.number().nullable().optional(),
  sourcingMemo: z.string().nullable().optional(),
  candidateSellers: z.string().nullable().optional(),
  status: z.enum(DEAL_STATUSES).optional(),
  baseMarginPolicy: baseMarginPolicySchema.optional(),
  parentDealId: z.string().nullable().optional(),
  dealType: z.string().optional(),
  optionSortOrder: z.number().int().min(0).optional(),
  unit: z.string().nullable().optional(),
  unitQuantity: z.number().nullable().optional(),
  supplementaryInfo: z.string().nullable().optional(),
  // 클레임 게이트의 카테고리 규칙 선택자(C1). enum 이 아니라 문자열인 것은
  // 카테고리 세트가 운영 중 늘어나기 때문 — 값 집합은 UI 가 제시한다.
  category: z.string().nullable().optional(),
});

export type CreateDealInput = z.infer<typeof createDealSchema>;
export type UpdateDealInput = z.infer<typeof updateDealSchema>;
export type BaseMarginPolicy = z.infer<typeof baseMarginPolicySchema>;
