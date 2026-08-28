import { z } from "zod";

export const ENTITY_TYPES = ["PARTNER", "SELLER", "DEAL", "CAMPAIGN"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ACTIVITY_LOG_TYPES = ["CHANGE", "CREATE", "DELETE", "MEMO"] as const;
export type ActivityLogType = (typeof ACTIVITY_LOG_TYPES)[number];

export const createMemoSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().min(1),
  content: z.string().min(1, "메모 내용은 필수입니다"),
  actor: z.string().default("SYSTEM"),
});

export type CreateMemoInput = z.infer<typeof createMemoSchema>;
