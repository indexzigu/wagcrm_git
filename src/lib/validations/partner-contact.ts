import { z } from "zod";

export const createContactSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다"),
  role: z.string().optional(),
  phoneNumber: z.string().optional(),
  email: z.string().optional(),
  notes: z.string().optional(),
});

export const updateContactSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다").optional(),
  role: z.string().nullable().optional(),
  phoneNumber: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
