import { z } from "zod";

export const campaignChecklistStatusSchema = z.enum([
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
  "DROPPED",
]);

export const createCampaignChecklistItemSchema = z.object({
  label: z.string().trim().min(1, "항목명은 필수입니다").max(120),
  status: campaignChecklistStatusSchema.optional(),
  isRequired: z.boolean().default(true),
});

export const updateCampaignChecklistItemSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  status: campaignChecklistStatusSchema.optional(),
  sortOrder: z.coerce.number().int().nonnegative().optional(),
  isRequired: z.boolean().optional(),
  isChecked: z.boolean().optional(),
});

export const upsertCampaignChecklistTemplateSchema = z.object({
  id: z.string().optional(),
  status: campaignChecklistStatusSchema,
  label: z.string().trim().min(1).max(120),
  sortOrder: z.coerce.number().int().nonnegative(),
  isRequired: z.boolean().default(true),
  isActive: z.boolean().default(true),
});
