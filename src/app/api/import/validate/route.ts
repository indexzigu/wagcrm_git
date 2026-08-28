import { NextResponse } from "next/server";
import { z } from "zod";
import { PARTNER_TYPES } from "@/lib/validations/partner";
import { SNS_TYPES } from "@/lib/validations/seller";

const ENTITY_TYPES = ["partners", "sellers", "deals"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const validateRequestSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  mapping: z.record(z.string(), z.string()), // csvColumn -> systemField
  rows: z.array(z.record(z.string(), z.string())),
});

// Relaxed schemas for CSV import (more lenient than create schemas)
const partnerImportSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다"),
  type: z
    .string()
    .transform((v) => v.toUpperCase())
    .pipe(z.enum(PARTNER_TYPES)),
  contactInfo: z.string().optional(),
  bankAccount: z.string().optional(),
  companyStatus: z.string().optional(),
  companyRole: z.string().optional(),
  notes: z.string().optional(),
});

const sellerImportSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다"),
  snsType: z
    .string()
    .transform((v) => v.toUpperCase())
    .pipe(z.enum(SNS_TYPES)),
  snsHandle: z.string().min(1, "SNS 핸들은 필수입니다"),
  currentFollowers: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v.replace(/,/g, ""), 10) : 0))
    .pipe(z.number().int().min(0)),
  category: z.string().optional(),
  channelUrl: z.string().optional(),
  email: z.string().optional(),
  phoneNumber: z.string().optional(),
  notes: z.string().optional(),
});

const dealImportSchema = z.object({
  dealName: z.string().min(1, "딜 이름은 필수입니다"),
  partnerId: z.string().min(1, "거래처 ID는 필수입니다"),
  costPrice: z
    .string()
    .optional()
    .transform((v) => (v ? parseFloat(v.replace(/,/g, "")) : 0))
    .pipe(z.number().min(0)),
  sellingPrice: z
    .string()
    .optional()
    .transform((v) => (v ? parseFloat(v.replace(/,/g, "")) : 0))
    .pipe(z.number().min(0)),
  brandName: z.string().optional(),
  partnerCompanyName: z.string().optional(),
  status: z.string().optional(),
  sourcingMemo: z.string().optional(),
});

function getSchemaForEntity(entityType: EntityType) {
  switch (entityType) {
    case "partners":
      return partnerImportSchema;
    case "sellers":
      return sellerImportSchema;
    case "deals":
      return dealImportSchema;
  }
}

interface RowError {
  row: number;
  errors: Record<string, string[]>;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = validateRequestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { entityType, mapping, rows } = parsed.data;
    const schema = getSchemaForEntity(entityType);

    let validCount = 0;
    let errorCount = 0;
    const rowErrors: RowError[] = [];
    const validRows: Record<string, unknown>[] = [];

    for (let i = 0; i < rows.length; i++) {
      const rawRow = rows[i];

      // Apply column mapping: transform CSV columns to system fields
      const mappedRow: Record<string, string> = {};
      for (const [csvCol, systemField] of Object.entries(mapping)) {
        if (systemField && rawRow[csvCol] !== undefined) {
          mappedRow[systemField] = rawRow[csvCol];
        }
      }

      const result = schema.safeParse(mappedRow);

      if (result.success) {
        validCount++;
        validRows.push(result.data);
      } else {
        errorCount++;
        const fieldErrors: Record<string, string[]> = {};
        for (const [field, messages] of Object.entries(
          result.error.flatten().fieldErrors
        )) {
          fieldErrors[field] = messages as string[];
        }
        rowErrors.push({ row: i + 1, errors: fieldErrors });
      }
    }

    return NextResponse.json({
      entityType,
      totalRows: rows.length,
      validCount,
      errorCount,
      rowErrors: rowErrors.slice(0, 50), // Limit error details to first 50
      validRows,
    });
  } catch (error) {
    console.error("Import validation error:", error);
    return NextResponse.json(
      { error: "Validation failed" },
      { status: 500 }
    );
  }
}
