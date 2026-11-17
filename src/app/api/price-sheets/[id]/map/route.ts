import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { isApplyLocked, PriceSheetRepository } from "@/repositories/priceSheetRepository";
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

  // T-310: 반영 중·반영 완료 시트를 MAPPED 로 되돌리면 반영 버튼이 다시 살아난다.
  if (isApplyLocked(priceSheet.status)) {
    return NextResponse.json({ error: APPLY_LOCKED_MESSAGE }, { status: 409 });
  }

  const results = await suggestMappingsForSheet(id, priceSheet.partnerId);
  // 위 확인과 이 쓰기 사이에 반영이 끝났을 수 있으므로 조건을 쓰기 자체에 건다.
  const changed = await PriceSheetRepository.updateStatusUnlessApplyLocked(id, "MAPPED");
  if (changed === 0) {
    return NextResponse.json({ error: APPLY_LOCKED_MESSAGE }, { status: 409 });
  }
  const updated = await PriceSheetRepository.findById(id, false);

  return NextResponse.json({
    priceSheet: updated ? normalizePriceSheetForResponse(updated) : null,
    mappingCount: results.length,
  });
}

const APPLY_LOCKED_MESSAGE = "반영 중이거나 반영이 끝난 가격표는 매핑을 다시 제안할 수 없습니다.";
