import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { instagramShortcode } from "@/lib/instagram-embed";

type Context = {
  params: Promise<{ id: string }>;
};

type PreviewPost = { permalink?: string | null; media_type?: string | null };

/** SellerAiProfile.aiTags(Json)에서 postsPreview 배열을 방어적으로 꺼낸다. */
function extractPostsPreview(aiTags: unknown): PreviewPost[] {
  if (!aiTags || typeof aiTags !== "object") return [];
  const preview = (aiTags as Record<string, unknown>).postsPreview;
  return Array.isArray(preview) ? (preview as PreviewPost[]) : [];
}

/**
 * GET /api/campaigns/[id]/post-formats — 포맷별 반응(③b 후속)용 { IG shortcode → media_type } 맵.
 * media_type은 Asset에 없고 seller-analysis postsPreview에만 있으므로, 이 캠페인 셀러의 프리뷰에서
 * shortcode별 포맷을 뽑아 클라(aggregateErByFormat)가 등록 게시물을 포맷별로 묶게 한다.
 * 읽기 전용 · 신규 수집 트리거 없음 · requireAuth. 프리뷰(최근 ~30)에 없는 게시물은 클라에서 '기타'.
 */
export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: campaignId } = await context.params;
  const prisma = getPrisma();

  try {
    const campaign = await prisma.salesCampaign.findUnique({
      where: { id: campaignId },
      select: { sellerId: true },
    });
    if (!campaign) {
      return NextResponse.json({ error: "캠페인을 찾을 수 없습니다." }, { status: 404 });
    }

    const profile = await prisma.sellerAiProfile.findUnique({
      where: { sellerId: campaign.sellerId },
      select: { aiTags: true },
    });
    const preview = extractPostsPreview(profile?.aiTags);

    const formats: Record<string, string> = {};
    for (const p of preview) {
      const sc = instagramShortcode(p.permalink);
      if (sc && typeof p.media_type === "string" && p.media_type) {
        formats[sc] = p.media_type;
      }
    }

    return NextResponse.json({ formats });
  } catch (error) {
    console.error("[/api/campaigns/[id]/post-formats] failed:", error);
    return NextResponse.json({ error: "포맷 정보를 불러오지 못했습니다." }, { status: 500 });
  }
}
