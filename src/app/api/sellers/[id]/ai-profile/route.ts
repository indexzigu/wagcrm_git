import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";

type Context = { params: Promise<{ id: string }> };

// GET /api/sellers/[id]/ai-profile — 저장된 SellerAiProfile 조회 (분석 이력 없으면 profile: null).
// 읽기 전용. 카드 렌더용 파생 점수는 클라이언트에서 aiTags.metrics로 재계산(seller-analysis/adapter).
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  try {
    const profile = await getPrisma().sellerAiProfile.findUnique({
      where: { sellerId: id },
      select: {
        aiTags: true,
        compositeScore: true,
        confidence: true,
        sourceTier: true,
        analyzedAt: true,
        updatedAt: true,
      },
    });
    return NextResponse.json({ profile });
  } catch (e) {
    // 테이블 미적용 환경(로컬 SQLite 등)에선 미분석으로 축소 (분석은 프로덕션 Supabase 기준)
    console.warn("[ai-profile] 조회 실패 — 미분석 처리:", e instanceof Error ? e.message : e);
    return NextResponse.json({ profile: null });
  }
}
