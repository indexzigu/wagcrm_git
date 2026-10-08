import { NextResponse } from "next/server";
import { updateMonthlySettlementLineSchema } from "@/lib/validations/monthly-settlement";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import {
  MonthlySettlementError,
  monthlySettlementService,
} from "@/services/monthlySettlementService";

type Context = { params: Promise<{ id: string; lineId: string }> };

function errorResponse(error: unknown) {
  if (error instanceof MonthlySettlementError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

/** 월별 정산 줄 수정 — 줄 저장 버튼·체크리스트 즉시 저장 공용. */
export async function PATCH(request: Request, context: Context) {
  const { id, lineId } = await context.params;
  const parsed = updateMonthlySettlementLineSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const line = await monthlySettlementService.updateLine(id, lineId, parsed.data);
    revalidateCampaignCaches();
    return NextResponse.json(line);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { id, lineId } = await context.params;
  try {
    await monthlySettlementService.deleteLine(id, lineId);
    revalidateCampaignCaches();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
