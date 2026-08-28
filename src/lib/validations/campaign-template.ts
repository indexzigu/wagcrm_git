import { z } from "zod";

export const createTemplateSchema = z.object({
  name: z.string().min(1, "템플릿 이름은 필수입니다"),
  dealId: z.string().optional(),
  salesChannel: z.string().optional(),
  marginSettings: z.string().optional(),
  trackingPattern: z.string().optional(),
});

export const updateTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  dealId: z.string().nullable().optional(),
  salesChannel: z.string().nullable().optional(),
  marginSettings: z.string().nullable().optional(),
  trackingPattern: z.string().nullable().optional(),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
