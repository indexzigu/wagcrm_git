import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import {
  STORY_CAPTURE_PREROLL_DAYS,
  STORY_CAPTURE_TRAIL_DAYS,
} from "@/lib/story-capture";
import { resolveCampaignContentScope } from "@/lib/campaign-group-scope";
import { isContentReviewOpen } from "@/lib/campaign-review-window";
import type { CampaignStory } from "@/lib/crm-types";

type Context = { params: Promise<{ id: string }> };

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STORIES = 60;

/**
 * GET /api/campaigns/[id]/stories — 캠페인 셀러가 수집창(시작−7일~마감+1일)에 올린 스토리를
 * 최신순(게시시각 내림차순)으로 반환한다. 스토리는 전량 수집 후 후분류(오너 2026-07-10)라,
 * 이 캠페인 기간에 잡힌 셀러 스토리를 담당자가 캠페인 맥락에서 검토·분류한다.
 * 읽기 전용 · requireAuth. 수집창 상수는 story-capture와 통일(시각적 일관성).
 */
export async function GET(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: campaignId } = await context.params;
  // 종료된 캠페인의 접힌 미분류 스토리를 되살리는 탈출구(후보 피드와 동일 규약).
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

    // 그룹(조합) 캠페인은 스토리도 그룹 전체가 공유(오너 2026-07-13) — 창을 멤버 기간 포락선으로.
    const scope = await resolveCampaignContentScope(prisma, campaign);

    // 수집창 = 시작−7일 ~ 마감+1일. 캠페인 날짜가 없으면 해당 경계만 열어둔다(한쪽만 적용).
    const gte = scope.startDate
      ? new Date(scope.startDate.getTime() - STORY_CAPTURE_PREROLL_DAYS * DAY_MS)
      : undefined;
    const lte = scope.endDate
      ? new Date(scope.endDate.getTime() + STORY_CAPTURE_TRAIL_DAYS * DAY_MS)
      : undefined;
    const takenAtFilter =
      gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : undefined;

    // 검토 기간(마감 +7일)이 지나면 미분류(UNREVIEWED)는 접고 확정된 홍보(CAMPAIGN)만 남긴다 —
    // 스토리는 24h 휘발이라 뒤늦게 분류할 실익이 더 작다(후보 피드와 동일 판정, 오너 2026-07-31).
    // 접혀도 데이터는 그대로이고 전역 분류함(/admin/stories)에서는 계속 보인다.
    // reviewClosed 는 **창의 사실**이라 includeClosed 와 무관하게 언제나 실제 상태를 보고한다.
    const reviewClosed = !isContentReviewOpen(scope.endDate);
    const showUnreviewed = includeClosed || !reviewClosed;

    const rows = await prisma.sellerStorySnapshot.findMany({
      where: {
        sellerId: campaign.sellerId,
        // 무관(OTHER)은 캠페인 표시에서 영구 숨김(오너 결정4). 홍보(CAMPAIGN)+미분류(UNREVIEWED)만 노출.
        // 전역 트리아지(/admin/stories)는 이 필터를 쓰지 않으므로 무관 복원은 거기서 가능.
        classification: showUnreviewed ? { not: "OTHER" } : "CAMPAIGN",
        ...(takenAtFilter ? { takenAt: takenAtFilter } : {}),
      },
      orderBy: { takenAt: "desc" },
      take: MAX_STORIES,
      select: {
        id: true,
        storyPk: true,
        takenAt: true,
        capturedAt: true,
        mediaType: true,
        thumbnailUrl: true,
        sourceImageUrl: true,
        caption: true,
        classification: true,
      },
    });

    const stories: CampaignStory[] = rows.map((s) => ({
      id: s.id,
      storyPk: s.storyPk,
      takenAt: s.takenAt.toISOString(),
      capturedAt: s.capturedAt.toISOString(),
      mediaType: s.mediaType,
      thumbnailUrl: s.thumbnailUrl,
      sourceImageUrl: s.sourceImageUrl,
      caption: s.caption,
      classification: s.classification,
    }));

    // 마지막 수집시각 = 이 창에서 가장 최근 capturedAt(수집시각 표시용).
    // ⚠️ **표시 필터가 아니라 창 전체**에서 계산한다. rows 는 접힘 상태에서 CAMPAIGN 만 담으므로
    // rows 로 계산하면 "펼치기/접기"라는 순수 표시 토글만으로 마지막 수집 시각이 왔다 갔다 해
    // 담당자가 수집이 다시 돌았다고 오해한다(수집 신선도는 분류와 무관한 사실이다).
    const lastCapturedAt = showUnreviewed
      ? rows.reduce<Date | null>(
          (acc, s) => (!acc || s.capturedAt > acc ? s.capturedAt : acc),
          null,
        )
      : (
          await prisma.sellerStorySnapshot.aggregate({
            _max: { capturedAt: true },
            where: {
              sellerId: campaign.sellerId,
              classification: { not: "OTHER" },
              ...(takenAtFilter ? { takenAt: takenAtFilter } : {}),
            },
          })
        )._max.capturedAt;

    return NextResponse.json({
      stories,
      lastCapturedAt: lastCapturedAt?.toISOString() ?? null,
      reviewClosed,
    });
  } catch (error) {
    // P0: 실패를 삼키지 않는다.
    console.error("[/api/campaigns/[id]/stories] GET failed:", error);
    return NextResponse.json(
      { error: "스토리를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/campaigns/[id]/stories — 스토리 분류(캠페인 홍보 / 무관 / 되돌리기).
 * CAMPAIGN이면 이 캠페인을 홍보이력으로 연결(salesCampaignId), 그 외는 연결 해제.
 * 캠페인 셀러의 스토리만 변경 가능(교차 셀러 변조 방지). body: { snapshotId, classification }.
 */
export async function PATCH(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: campaignId } = await context.params;
  const prisma = getPrisma();

  let body: { snapshotId?: unknown; classification?: unknown };
  try {
    body = (await request.json()) as { snapshotId?: unknown; classification?: unknown };
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const snapshotId = typeof body.snapshotId === "string" ? body.snapshotId : null;
  const classification = body.classification;
  const validClass =
    classification === "CAMPAIGN" ||
    classification === "OTHER" ||
    classification === "UNREVIEWED";
  if (!snapshotId || !validClass) {
    return NextResponse.json(
      { error: "snapshotId와 유효한 classification이 필요합니다." },
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
    const snapshot = await prisma.sellerStorySnapshot.findUnique({
      where: { id: snapshotId },
      select: { sellerId: true },
    });
    if (!snapshot || snapshot.sellerId !== campaign.sellerId) {
      return NextResponse.json(
        { error: "이 캠페인 셀러의 스토리가 아닙니다." },
        { status: 404 },
      );
    }

    const updated = await prisma.sellerStorySnapshot.update({
      where: { id: snapshotId },
      data: {
        classification,
        classifiedAt: classification === "UNREVIEWED" ? null : new Date(),
        // CAMPAIGN이면 이 캠페인을 홍보이력으로 연결, 그 외는 해제
        salesCampaignId: classification === "CAMPAIGN" ? campaignId : null,
      },
      select: { id: true, classification: true },
    });
    return NextResponse.json({ ok: true, snapshot: updated });
  } catch (error) {
    console.error("[/api/campaigns/[id]/stories] PATCH failed:", error);
    return NextResponse.json({ error: "스토리 분류에 실패했습니다." }, { status: 500 });
  }
}
