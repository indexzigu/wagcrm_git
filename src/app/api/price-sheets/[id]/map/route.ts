import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { PriceSheetRepository } from "@/repositories/priceSheetRepository";
import { suggestMappingsForSheet } from "@/lib/price-sheet/mapping";
import { normalizePriceSheetForResponse } from "@/lib/price-sheet/serialize-response";

/** 미검수 행 전체에 대해 Deal 매핑 제안(SUGGESTED/NEW_DEAL)을 계산한다. 자동 확정(MAPPED)은 하지 않는다. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;
  const priceSheet = await PriceSheetRepository.findById(id, false);
  if (!priceSheet) {
    return NextResponse.json({ error: "가격표를 찾을 수 없습니다." }, { status: 404 });
  }

  const results = await suggestMappingsForSheet(id, priceSheet.partnerId);
  const updated = await PriceSheetRepository.updateStatus(id, "MAPPED");

  return NextResponse.json({ priceSheet: normalizePriceSheetForResponse(updated), mappingCount: results.length });
}
