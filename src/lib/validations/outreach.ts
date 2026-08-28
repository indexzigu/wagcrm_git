import { z } from "zod";

export const OUTREACH_STATUSES = [
  "PROPOSED",
  "NEGOTIATION",
  "TESTING",
  "PENDING_APPROVAL",
  "CONVERTED",
  "DROPPED",
] as const;

export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

const VALID_OUTREACH_TRANSITIONS: Record<OutreachStatus, OutreachStatus[]> = {
  PROPOSED: ["NEGOTIATION", "TESTING", "PENDING_APPROVAL", "DROPPED"],
  NEGOTIATION: ["PROPOSED", "TESTING", "PENDING_APPROVAL", "DROPPED"],
  TESTING: ["PROPOSED", "NEGOTIATION", "PENDING_APPROVAL", "DROPPED"],
  PENDING_APPROVAL: ["PROPOSED", "NEGOTIATION", "TESTING", "DROPPED"],
  // CONVERTED는 캠페인 생성(승인) 후 자동 전환 — 수동 되돌리기 불가
  CONVERTED: ["DROPPED"],
  DROPPED: ["PROPOSED"],
};

export function isValidOutreachTransition(
  from: string,
  to: OutreachStatus,
): boolean {
  if (from === to) return true;
  const actualFrom = from === "CONFIRMED" ? "PENDING_APPROVAL" : from;
  const actualTo = to === "CONVERTED" ? "PENDING_APPROVAL" : to;
  if (actualFrom === actualTo) return true;
  return VALID_OUTREACH_TRANSITIONS[actualFrom as OutreachStatus]?.includes(actualTo) ?? false;
}

export function getValidOutreachNextStatuses(
  current: OutreachStatus,
): OutreachStatus[] {
  const allStatuses: OutreachStatus[] = [
    "PROPOSED",
    "NEGOTIATION",
    "TESTING",
    "PENDING_APPROVAL",
    "CONVERTED",
    "DROPPED",
  ];
  return allStatuses.filter(
    (status) => status !== current && isValidOutreachTransition(current, status)
  );
}

export const createOutreachSchema = z.object({
  dealId: z.string().min(1, "딜 ID는 필수입니다"),
  sellerId: z.string().min(1, "셀러 ID는 필수입니다"),
  contactChannel: z.string().trim().min(1).default("DM"),
  proposalMessage: z.string().trim().max(2000).optional().nullable(),
});

export const updateOutreachSchema = z.object({
  status: z.enum(OUTREACH_STATUSES).optional(),
  autoCreateCampaign: z.boolean().optional().default(false),
  dropReason: z.string().trim().max(500).optional().nullable(),
  proposalMessage: z.string().trim().max(2000).optional().nullable(),
  negotiationMemo: z.string().trim().max(4000).optional().nullable(),
  testingMemo: z.string().trim().max(4000).optional().nullable(),
  nextReminderAt: z.string().datetime().optional().nullable(),
  lastReminderAt: z.string().datetime().optional().nullable(),
  sellerId: z.string().optional(),
  dealId: z.string().optional(),
  totalMarginRate: z.coerce.number().nonnegative().optional(),
  sellerMarginRate: z.coerce.number().nonnegative().optional(),
});

export type CreateOutreachInput = z.infer<typeof createOutreachSchema>;
export type UpdateOutreachInput = z.infer<typeof updateOutreachSchema>;
