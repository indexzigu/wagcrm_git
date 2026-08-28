import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { loadDealVocView } from "@/lib/order-converter/voc-store";

// Route segment config "dynamic"은 이 프로젝트의 Next16 cacheComponents와 비호환(빌드 에러 —
// #28 preflight 실측). 라우트 핸들러는 요청별 실행이 기본이라 선언 자체가 불필요해 제거.

type Context = { params: Promise<{ id: string }> };

/**
 * 딜 상세 "고객 반응" 섹션 데이터 — ProductQna(dealId 매칭분) + DealVocSource 리뷰 집계.
 * 리뷰 코퍼스 본문(Drive)은 읽지 않는다(얇은 행 집계·프리뷰만 — egress 0).
 */
export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: dealId } = await context.params;
  try {
    const view = await loadDealVocView(dealId);
    return NextResponse.json(view);
  } catch (error) {
    console.error("[deals/[id]/voc] load error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "VOC 로드 실패" },
      { status: 500 },
    );
  }
}
