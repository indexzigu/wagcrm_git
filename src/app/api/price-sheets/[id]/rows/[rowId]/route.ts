import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { PriceSheetRowRepository } from "@/repositories/priceSheetRepository";
import { normalizePriceSheetRowForResponse } from "@/lib/price-sheet/serialize-response";

// M3: 비율 필드(commissionRate/discountRate)는 항상 0~1 소수로 저장한다(예: 30% -> 0.3).
// 검수자가 실수로 "30"을 입력하면 그대로 Deal.totalCommissionRate=30(수수료율 3000%)이 되는
// 금전 사고로 이어지므로, API 레벨에서 0~1 범위를 강제하고 벗어나면 400 + 명확한 안내 메시지를
// 반환한다(값을 임의로 /100 하지 않는다 — PATCH는 사람이 명시적으로 입력한 값이므로 자동
// 보정보다 즉시 거부가 안전하다).
const rateFieldSchema = z
  .number()
  .min(0, { message: "0~1 소수로 입력하거나 % 없이 0.3처럼 입력하세요 (예: 30% -> 0.3)." })
  .max(1, { message: "0~1 소수로 입력하거나 % 없이 0.3처럼 입력하세요 (예: 30% -> 0.3)." });

const patchSchema = z.object({
  productName: z.string().nullable().optional(),
  optionName: z.string().nullable().optional(),
  sellingPrice: z.number().nullable().optional(),
  commissionRate: rateFieldSchema.nullable().optional(),
  supplyPrice: z.number().nullable().optional(),
  listPrice: z.number().nullable().optional(),
  floorPrice: z.number().nullable().optional(),
  discountRate: rateFieldSchema.nullable().optional(),
  note: z.string().nullable().optional(),
  mappingStatus: z.enum(["UNMAPPED", "SUGGESTED", "MAPPED", "NEW_DEAL"]).optional(),
  mappedDealId: z.string().nullable().optional(),
});

/** 검수표에서 행 값 편집 및/또는 매핑 확정(SUGGESTED → MAPPED 등)을 처리한다. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; rowId: string }> }
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id, rowId } = await params;
  const body = await request.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const prisma = getPrisma();
  const existing = await prisma.priceSheetRow.findUnique({ where: { id: rowId } });
  if (!existing || existing.priceSheetId !== id) {
    return NextResponse.json({ error: "행을 찾을 수 없습니다." }, { status: 404 });
  }

  if (parsed.data.mappingStatus === "MAPPED" && !parsed.data.mappedDealId && !existing.mappedDealId) {
    return NextResponse.json(
      { error: "MAPPED 상태로 전환하려면 mappedDealId가 필요합니다." },
      { status: 400 }
    );
  }

  const { mappingStatus, mappedDealId, ...fieldEdits } = parsed.data;

  if (Object.keys(fieldEdits).length > 0) {
    await prisma.priceSheetRow.update({
      where: { id: rowId },
      data: fieldEdits,
    });
  }

  if (mappingStatus) {
    // 명시적 null("신규 딜로 생성" = 매핑 해제)과 미전달(undefined = 기존 유지)을 구분한다.
    // `??`를 쓰면 null이 기존 제안 딜 id로 되살아나 Select가 제안 딜에 고정되는 버그가 된다.
    await PriceSheetRowRepository.updateMapping(rowId, {
      mappingStatus,
      mappedDealId: mappedDealId === undefined ? existing.mappedDealId : mappedDealId,
    });
  }

  const finalRow = await prisma.priceSheetRow.findUnique({ where: { id: rowId } });
  return NextResponse.json({ row: finalRow ? normalizePriceSheetRowForResponse(finalRow) : null });
}

/**
 * 추출 행 삭제 — LLM이 같은 옵션을 다른 제품명으로 중복 추출하는 등 검수에서 걸러낼 행을
 * 지운다. 이미 딜에 반영된 행(APPLIED)은 반영 이력의 근거라 삭제를 막는다. 삭제 실수는
 * "재추출"로 복구 가능하다(추출은 rowHash 기준으로 행을 다시 만든다).
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; rowId: string }> }
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id, rowId } = await params;
  const prisma = getPrisma();
  const existing = await prisma.priceSheetRow.findUnique({ where: { id: rowId } });
  if (!existing || existing.priceSheetId !== id) {
    return NextResponse.json({ error: "행을 찾을 수 없습니다." }, { status: 404 });
  }
  if (existing.mappingStatus === "APPLIED") {
    return NextResponse.json(
      { error: "이미 딜에 반영된 행은 삭제할 수 없습니다." },
      { status: 409 }
    );
  }

  await prisma.priceSheetRow.delete({ where: { id: rowId } });
  return NextResponse.json({ ok: true });
}
