import { NextResponse } from "next/server";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { revalidateCampaignCaches, revalidateMasterDataCaches } from "@/lib/cache-tags";

type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({ enabled: z.boolean() });

/**
 * 거래처 월정산 켜기/끄기(T-240). 켜면 이 거래처 캠페인의 공급사 계산서 칸이 달별 계산서 여러 장으로
 * 바뀐다(`campaign-invoices.ts`). **플래그만 바꾼다** — 데이터를 만들거나 옮기지 않는다(명세 「사람
 * 검수 없는 자동 실행 금지」). 이미 계산서 날짜가 있는 캠페인은 그 날짜 칸을 그대로 보인다(레거시 모드).
 * 끄면 달별 칸이 숨고 단일 날짜 칸으로 돌아간다 — 기록한 계산서는 지우지 않는다.
 * ⛔ #159 의 「켜는 순간 기존 캠페인마다 월별 줄 만들기」는 캠페인을 달로 쪼갠 셈이라 걷어냈다(2026-10-08).
 */
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }
  const { count } = await getPrisma().partner.updateMany({
    where: { id },
    data: { monthlySettlement: parsed.data.enabled },
  });
  if (count !== 1) return NextResponse.json({ error: "거래처를 찾을 수 없습니다." }, { status: 404 });
  revalidateMasterDataCaches();
  revalidateCampaignCaches();
  return NextResponse.json({ enabled: parsed.data.enabled });
}
