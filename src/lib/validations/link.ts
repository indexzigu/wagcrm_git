import { z } from "zod";

/**
 * Validation schema for linking a deal to a partner (changing deal's partnerId).
 * Since Deal.partnerId is a required (non-nullable) FK, partnerId is always required.
 */
export const linkDealRequestSchema = z.object({
  partnerId: z.string().min(1, "파트너 ID는 필수입니다"),
});

/**
 * Validation schema for linking a campaign to a deal (changing campaign's dealId).
 * Since SalesCampaign.dealId is a required (non-nullable) FK, dealId is always required.
 */
export const linkCampaignRequestSchema = z.object({
  dealId: z.string().min(1, "딜 ID는 필수입니다"),
});

export type LinkDealRequest = z.infer<typeof linkDealRequestSchema>;
export type LinkCampaignRequest = z.infer<typeof linkCampaignRequestSchema>;
