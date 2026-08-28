import { z } from "zod";

export const SNS_TYPES = ["INSTAGRAM", "YOUTUBE", "X"] as const;
export type SnsType = (typeof SNS_TYPES)[number];

// F6 outcome 적립: 유입 경로 구분값 (GROWTH_FLYWHEEL_PLAN.md §F6)
export const ACQUISITION_CHANNELS = ["REFERRAL", "NETWORK", "INBOUND", "COLD", "DISCOVERY"] as const;
export type AcquisitionChannel = (typeof ACQUISITION_CHANNELS)[number];

export const createSellerSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다"),
  alias: z.string().optional(),
  snsType: z.enum(SNS_TYPES),
  snsHandle: z.string().min(1, "SNS 핸들은 필수입니다"),
  currentFollowers: z.number().int().min(0).default(0),
  currentPostsCount: z.number().int().min(0).nullable().optional(),
  profileBio: z.string().nullable().optional(),
  profilePicUrl: z.string().nullable().optional(),
  profileExternalUrls: z.string().nullable().optional(),
  isMonitored: z.boolean().optional().default(false),
  category: z.string().optional(),
  agencyId: z.string().optional(),
  channelUrl: z.string().optional(),
  reviewer: z.string().optional(),
  personalCategory: z.string().optional(),
  proposalProduct: z.string().optional(),
  proposalWaitlist: z.string().optional(),
  collaborationScore: z.string().optional(),
  adResponseScore: z.string().optional(),
  commentResponseScore: z.string().optional(),
  activityFrequency: z.string().optional(),
  accountNumber: z.string().optional(),
  email: z.string().optional(),
  phoneNumber: z.string().optional(),
  mailingAddress: z.string().optional(),
  notes: z.string().optional(),
  lastReviewedAt: z.coerce.date().optional(),
  fitLevel: z.string().optional(),
  residentNumber: z.string().optional(),
  acquisitionChannel: z.enum(ACQUISITION_CHANNELS).nullable().optional(),
  referredById: z.string().nullable().optional(),
  acquisitionNote: z.string().nullable().optional(),
});

export const updateSellerSchema = z.object({
  name: z.string().min(1).optional(),
  alias: z.string().nullable().optional(),
  /** 원천징수 신고용 법적 실명 — `name`(활동명)과 별개다. */
  realName: z.string().nullable().optional(),
  snsType: z.enum(SNS_TYPES).optional(),
  snsHandle: z.string().min(1).optional(),
  currentFollowers: z.number().int().min(0).optional(),
  currentPostsCount: z.number().int().min(0).nullable().optional(),
  profileBio: z.string().nullable().optional(),
  profilePicUrl: z.string().nullable().optional(),
  profileExternalUrls: z.string().nullable().optional(),
  isMonitored: z.boolean().optional(),
  category: z.string().nullable().optional(),
  agencyId: z.string().nullable().optional(),
  channelUrl: z.string().nullable().optional(),
  reviewer: z.string().nullable().optional(),
  personalCategory: z.string().nullable().optional(),
  proposalProduct: z.string().nullable().optional(),
  proposalWaitlist: z.string().nullable().optional(),
  collaborationScore: z.string().nullable().optional(),
  adResponseScore: z.string().nullable().optional(),
  commentResponseScore: z.string().nullable().optional(),
  activityFrequency: z.string().nullable().optional(),
  accountNumber: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phoneNumber: z.string().nullable().optional(),
  mailingAddress: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  lastReviewedAt: z.coerce.date().nullable().optional(),
  fitLevel: z.string().nullable().optional(),
  residentNumber: z.string().nullable().optional(),
  acquisitionChannel: z.enum(ACQUISITION_CHANNELS).nullable().optional(),
  referredById: z.string().nullable().optional(),
  acquisitionNote: z.string().nullable().optional(),
  // availabilityUpdatedAt은 클라이언트가 보내지 않는다 — 서버가 availabilityNote 변경 시 자동 스탬프
  availabilityNote: z.string().nullable().optional(),
});

export type CreateSellerInput = z.infer<typeof createSellerSchema>;
export type UpdateSellerInput = z.infer<typeof updateSellerSchema>;
