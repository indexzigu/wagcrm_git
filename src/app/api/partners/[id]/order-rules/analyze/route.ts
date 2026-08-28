import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { readAssetBytes } from "@/lib/asset-storage";
import { analyzeOrderTemplate } from "@/lib/order-converter/template-analyze";

// F4 Phase 2 §3 — 거래처 발주서 양식(ORDER_TEMPLATE 자산) 분석 → 열 매핑 드래프트.
// 분석 결과는 DB에 기록하지 않는다(설계 D2): 검수 UI가 응답을 편집해
// PATCH /api/partners/[id] (orderExcelRules)로 확정할 때만 저장된다.

export const maxDuration = 120; // LLM 구조 분석(타임아웃 60s) 여유

type Context = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const prisma = getPrisma();

  const partner = await prisma.partner.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!partner) {
    return NextResponse.json({ error: "거래처를 찾을 수 없습니다." }, { status: 404 });
  }

  // 최신 발주서 양식 자산 (거래처 첨부 자료 ORDER_TEMPLATE 카테고리)
  const asset = await prisma.asset.findFirst({
    where: { entityType: "PARTNER", entityId: id, section: "ORDER_TEMPLATE", archivedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!asset) {
    return NextResponse.json(
      { error: "분석할 발주서 양식이 없습니다. 첨부 자료에 '발주서 양식(ORDER_TEMPLATE)' 카테고리로 파일을 먼저 업로드하세요." },
      { status: 404 }
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readAssetBytes(asset);
  } catch (error: any) {
    console.error("[order-rules/analyze] 자산 바이트 읽기 실패:", error);
    return NextResponse.json(
      { error: `발주서 양식 파일을 읽지 못했습니다: ${error?.message ?? "저장소 오류"}` },
      { status: 502 }
    );
  }

  try {
    const analysis = await analyzeOrderTemplate(bytes, { sourceAssetId: asset.id });
    return NextResponse.json({
      partner,
      asset: { id: asset.id, fileName: asset.fileName },
      ...analysis,
    });
  } catch (error: any) {
    console.error("[order-rules/analyze] 분석 실패:", error);
    return NextResponse.json({ error: error?.message ?? "발주서 양식 분석에 실패했습니다." }, { status: 422 });
  }
}
