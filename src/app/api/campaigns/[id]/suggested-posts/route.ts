import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { loadSuggestedPosts } from "@/lib/campaign-suggested-posts-loader";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/campaigns/[id]/suggested-posts — R5/R6 후속(후보②): 캠페인 셀러가 이미 수집한
 * 피드(SellerAiProfile.postsPreview)에서 "이 캠페인 홍보로 보이는" 게시물 후보를 제시한다.
 * 읽기 전용 · 신규 수집 트리거 없음 · requireAuth. 등록은 별도로 기존 /api/assets POST가 담당한다.
 * 후보 규칙은 campaign-suggested-posts.suggestCampaignPosts(기간창 ∩ 미등록 ∩ 무관 아님)에 있고,
 * 조회 배선은 `campaign-suggested-posts-loader` 가 타임라인 GET 과 공유한다 — 두 화면이 같은
 * 후보 수를 말해야 하기 때문이다(빈 상태 안내가 그 숫자를 인용한다).
 */
export async function GET(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: campaignId } = await context.params;
  // 종료된 캠페인의 접힌 후보를 되살리는 탈출구 — 뒤늦게 올라온 홍보 게시물을 등록할 길을 남긴다.
  const includeClosed = new URL(request.url).searchParams.get("includeClosed") === "1";
  const prisma = getPrisma();

  try {
    const campaign = await prisma.salesCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, sellerId: true, startDate: true, endDate: true, groupId: true },
    });
    if (!campaign) {
      return NextResponse.json({ error: "캠페인을 찾을 수 없습니다." }, { status: 404 });
    }

    const { suggestions, lastCollectedAt, sharedCampaignIds, reviewClosed } =
      await loadSuggestedPosts(prisma, campaign, { includeClosed });

    return NextResponse.json({
      suggestions,
      lastCollectedAt,
      // 캠페인 상세(asset-manager)가 등록 게시물 목록을 그룹 스코프로 필터하는 데 사용.
      sharedCampaignIds,
      reviewClosed,
    });
  } catch (error) {
    // P0: 실패를 삼키지 않는다.
    console.error("[/api/campaigns/[id]/suggested-posts] failed:", error);
    return NextResponse.json(
      { error: "추천 게시물을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
