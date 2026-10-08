import { NextResponse } from "next/server";
import { partnerMonthlySettlementSchema } from "@/lib/validations/monthly-settlement";
import { revalidateCampaignCaches, revalidateMasterDataCaches } from "@/lib/cache-tags";
import {
  MonthlySettlementError,
  monthlySettlementService,
} from "@/services/monthlySettlementService";

type Context = { params: Promise<{ id: string }> };

/** 월정산을 켜면 줄이 생길 기존 캠페인 수 — 켜기 확인 창 문구용(실제 생성과 같은 조건). */
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const backfillTargetCount = await monthlySettlementService.countBackfillTargets(id);
  return NextResponse.json({ backfillTargetCount });
}

/**
 * 거래처 월정산 켜기/끄기(T-240). 켜면 그 거래처의 기존 캠페인(드랍 제외, 줄 없는 것)에 월별 줄
 * 1개씩을 같은 트랜잭션에서 만든다 — 이것이 기존 데이터 이전의 유일한 실행 지점이다(배포 시
 * 자동 이전 없음, 명세 「사람 검수 없는 자동 실행 금지」). 끄면 줄은 보관하고 플래그만 내린다.
 */
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  const parsed = partnerMonthlySettlementSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const result = await monthlySettlementService.setPartnerMonthlySettlement(id, parsed.data.enabled);
    revalidateMasterDataCaches();
    revalidateCampaignCaches();
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MonthlySettlementError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
