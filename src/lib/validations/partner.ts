import { z } from "zod";

export const PARTNER_TYPES = ["BRAND", "VENDOR", "AGENCY", "AGENT", "SELLER"] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

/**
 * 사업자번호 유효성 검증: 빈 문자열 또는 정확히 10자리 숫자만 허용
 */
const businessNumberSchema = z
  .string()
  .refine(
    (val) => val === "" || /^\d{10}$/.test(val),
    { message: "사업자번호는 10자리 숫자여야 합니다" },
  )
  .transform((val) => (val === "" ? undefined : val))
  .optional();

/**
 * 사업자번호 유효성 검증 (PATCH용): null 허용 (값 삭제), 빈 문자열 또는 정확히 10자리 숫자
 */
const businessNumberNullableSchema = z
  .union([
    z.null(),
    z.string().refine(
      (val) => val === "" || /^\d{10}$/.test(val),
      { message: "사업자번호는 10자리 숫자여야 합니다" },
    ),
  ])
  .transform((val) => {
    if (val === null || val === "") return null;
    return val;
  })
  .optional();

/**
 * F4-② 발주 코드(orderTemplateSlug): 영소문자·숫자·하이픈. 빈 문자열은 미설정으로 취급.
 */
const orderSlugSchema = z
  .string()
  .refine((v) => v === "" || /^[a-z0-9][a-z0-9-]*$/.test(v), {
    message: "발주 코드는 영소문자·숫자·하이픈만 사용합니다",
  })
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const orderSlugNullableSchema = z
  .union([
    z.null(),
    z.string().refine((v) => v === "" || /^[a-z0-9][a-z0-9-]*$/.test(v), {
      message: "발주 코드는 영소문자·숫자·하이픈만 사용합니다",
    }),
  ])
  .transform((v) => (v === null || v === "" ? null : v))
  .optional();

export const createPartnerSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다"),
  type: z.enum(PARTNER_TYPES),
  status: z.enum(["거래중", "거래중단", "응답없음", "거래보류"]).optional(),
  businessNumber: businessNumberSchema,
  contactInfo: z.string().optional(),
  bankAccount: z.string().optional(),
  companyStatus: z.string().optional(),
  companyRole: z.string().optional(),
  ceoName: z.string().optional(),
  address: z.string().optional(),
  lastContactAt: z.coerce.date().optional(),
  notes: z.string().optional(),
  referredById: z.string().optional(),
  businessType: z.string().optional(),
  businessItem: z.string().optional(),
  representativeEmail: z.string().optional(),
  // F4-② 발주 브랜드 설정
  orderTemplateSlug: orderSlugSchema,
  orderDisplayName: z.string().optional(),
  orderEmailDomains: z.string().optional(),
  orderFormatAdapter: z.enum(["template-file", "tripp"]).optional(),
  orderToEmail: z.string().optional(),
  orderCcEmail: z.string().optional(),
});

export const updatePartnerSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(PARTNER_TYPES).optional(),
  status: z.enum(["거래중", "거래중단", "응답없음", "거래보류"]).nullable().optional(),
  businessNumber: businessNumberNullableSchema,
  contactInfo: z.string().nullable().optional(),
  bankAccount: z.string().nullable().optional(),
  companyStatus: z.string().nullable().optional(),
  companyRole: z.string().nullable().optional(),
  ceoName: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  bizSyncedAt: z.coerce.date().nullable().optional(),
  lastContactAt: z.coerce.date().nullable().optional(),
  notes: z.string().nullable().optional(),
  referredById: z.string().nullable().optional(),
  businessType: z.string().nullable().optional(),
  businessItem: z.string().nullable().optional(),
  representativeEmail: z.string().nullable().optional(),
  // F4-② 발주 브랜드 설정
  orderTemplateSlug: orderSlugNullableSchema,
  orderDisplayName: z.string().nullable().optional(),
  orderEmailDomains: z.string().nullable().optional(),
  orderFormatAdapter: z.enum(["template-file", "tripp"]).nullable().optional(),
  orderToEmail: z.string().nullable().optional(),
  orderCcEmail: z.string().nullable().optional(),
});

export type CreatePartnerInput = z.infer<typeof createPartnerSchema>;
export type UpdatePartnerInput = z.infer<typeof updatePartnerSchema>;
