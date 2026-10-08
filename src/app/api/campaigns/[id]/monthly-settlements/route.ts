import { NextResponse } from "next/server";
import { createMonthlySettlementLineSchema } from "@/lib/validations/monthly-settlement";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import {
  MonthlySettlementError,
  monthlySettlementService,
} from "@/services/monthlySettlementService";

type Context = { params: Promise<{ id: string }> };

/** 월별 정산 줄 조회 — 캠페인 상세의 월별 정산 패널(T-240). */
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const view = await monthlySettlementService.getView(id);
  if (!view) return NextResponse.json({ error: "캠페인을 찾을 수 없습니다." }, { status: 404 });
  return NextResponse.json(view);
}

/** 월별 정산 줄 추가(「다음 달 정산 추가」). 같은 달이 이미 있으면 409. */
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  const parsed = createMonthlySettlementLineSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const line = await monthlySettlementService.createLine(id, parsed.data);
    revalidateCampaignCaches();
    return NextResponse.json(line, { status: 201 });
  } catch (error) {
    if (error instanceof MonthlySettlementError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
