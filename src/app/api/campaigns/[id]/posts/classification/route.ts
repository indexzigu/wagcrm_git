import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { normalizeReferenceUrl } from "@/lib/reference-url";

type Context = { params: Promise<{ id: string }> };

/**
 * PATCH /api/campaigns/[id]/posts/classification — 셀러 게시물 후보의 "무관/되돌리기" 분류.
 * 통합 모델(오너 2026-07-13): "홍보 확정"은 이 라우트가 아니라 게시물 Asset 등록(POST /api/assets,
 * 성과추적)이 담당한다. 따라서 여기서 받는 값은 OTHER(무관 영구 숨김) 또는 UNREVIEWED(무관 되돌리기)뿐이다.
 * CAMPAIGN을 여기 쓰면 Asset과 이중 SSOT가 되므로 거부한다. 스토리 PATCH와 동형 계약
 * (캠페인 셀러 소유 검증 → 교차 셀러 변조 방지). body: { permalink, classification }.
 */
export async function PATCH(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: campaignId } = await context.params;
  const prisma = getPrisma();

  let body: { permalink?: unknown; classification?: unknown };
  try {
    body = (await request.json()) as { permalink?: unknown; classification?: unknown };
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const rawPermalink = typeof body.permalink === "string" ? body.permalink : null;
  const permalink = rawPermalink ? normalizeReferenceUrl(rawPermalink) : null;
  const classification = body.classification;
  // 홍보(CAMPAIGN)는 Asset 등록이 SSOT — 여기서는 무관/되돌리기만 허용한다.
  const validClass = classification === "OTHER" || classification === "UNREVIEWED";
  if (!permalink || !validClass) {
    return NextResponse.json(
      { error: "permalink와 유효한 classification(OTHER|UNREVIEWED)이 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const campaign = await prisma.salesCampaign.findUnique({
      where: { id: campaignId },
      select: { sellerId: true },
    });
    if (!campaign) {
      return NextResponse.json({ error: "캠페인을 찾을 수 없습니다." }, { status: 404 });
    }

    if (classification === "UNREVIEWED") {
      // 되돌리기 = 분류 행 제거(부재 = 미분류). 없으면 무해(멱등).
      await prisma.sellerPostClassification.deleteMany({
        where: { sellerId: campaign.sellerId, permalink },
      });
      return NextResponse.json({ ok: true, classification: "UNREVIEWED" });
    }

    // OTHER = 무관 영구 숨김. (sellerId, permalink) 유니크로 멱등 upsert.
    const updated = await prisma.sellerPostClassification.upsert({
      where: { sellerId_permalink: { sellerId: campaign.sellerId, permalink } },
      create: {
        sellerId: campaign.sellerId,
        permalink,
        classification: "OTHER",
        classifiedAt: new Date(),
        salesCampaignId: campaignId,
      },
      update: {
        classification: "OTHER",
        classifiedAt: new Date(),
        salesCampaignId: campaignId,
      },
      select: { id: true, permalink: true, classification: true },
    });
    return NextResponse.json({ ok: true, classification: updated.classification });
  } catch (error) {
    // P0: 실패를 삼키지 않는다.
    console.error("[/api/campaigns/[id]/posts/classification] PATCH failed:", error);
    return NextResponse.json({ error: "게시물 분류에 실패했습니다." }, { status: 500 });
  }
}
