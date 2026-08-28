import { z } from "zod";

export const DEFAULT_CHECKLIST_ITEMS = [
  "정산 진행",
  "매출 세금계산서 발행",
  "입금",
  "매입 세금계산서 발행",
  "출금",
] as const;

export const toggleChecklistItemSchema = z.object({
  itemId: z.string(),
  isChecked: z.boolean(),
});

export const addChecklistItemSchema = z.object({
  label: z.string().min(1, "항목명은 필수입니다"),
});

export type ToggleChecklistItemInput = z.infer<typeof toggleChecklistItemSchema>;
export type AddChecklistItemInput = z.infer<typeof addChecklistItemSchema>;
