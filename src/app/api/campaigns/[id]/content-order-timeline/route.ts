import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { getMobileCampaignGroupSales, getMobileCampaignSales } from "@/lib/mobile-campaign-sales";
import {
  resolveSalesCampaignWindow,
  endOfKstDayMs,
  startOfKstDayMs,
  isDayBoundaryMs,
} from "@/lib/order-converter/sale-window";
import { toDateKeyKst } from "@/lib/mobile-pulse-data";
import {
  buildTimelineDays,
  mapAssetMediaType,
  type ContentEvent,
} from "@/lib/content-order-correlation";
import { loadSuggestedPosts } from "@/lib/campaign-suggested-posts-loader";

type Context = { params: Promise<{ id: string }> };

/**
 * GET /api/campaigns/[id]/content-order-timeline — 콘텐츠 발행 시점 × 주문 반응 상관 타임라인.
 * 창은 주문 귀속 창(resolveSalesCampaignWindow)과 정렬한다 — stories/route.ts의 수집창(그룹 포락선,
 * 시작−7일~마감+1일)과는 의도적으로 다르다(창 밖 이벤트는 대조할 주문이 없다).
 * 일별 주문은 getMobileCampaignSales(dailyAggregate 경유)만 쓴다 — orders 블롭 미접촉(P7).
 * 읽기 전용 · requireAuth.
 *
 * **그룹 캠페인은 통합 스코프다(오너 2026-08-01).** 그룹은 한 셀러의 여러 딜/회차 묶음이고
 * (`campaign-group-clustering`이 sellerId로 파티션한다) 셀러는 콘텐츠를 묶음 단위로 한 몸처럼
 * 발행하므로, 회차 1건의 주문만 그리면 같은 게시물이 만든 반응이 회차 수만큼 쪼개져 보인다.
 * 그래서 멤버 어느 회차를 열어도 주문·콘텐츠·창을 그룹 전체로 합쳐 같은 차트를 돌려준다.
 * 그룹 미소속이면 종전대로 자기 회차만 본다.
 */
export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  const { id: campaignId } = await context.params;
  const prisma = getPrisma();
  try {
    const campaign = await prisma.salesCampaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true, sellerId: true, groupId: true, startDate: true, endDate: true,
        // 주문축이 비는 이유를 화면이 말할 수 있게 — 발주 미연결이면 주문이 구조적으로 0이다.
        orderCampaignId: true,
      },
    });
    if (!campaign) {
      return NextResponse.json({ error: "캠페인을 찾을 수 없습니다." }, { status: 404 });
    }

    // 그룹 소속이면 멤버 전체가 이 타임라인의 스코프다(위 헤더 주석). 멤버 조회가 자기 자신만
    // 돌려주는 경우(그룹이 방금 해체됨 등)도 아래 로직이 그대로 성립한다.
    const groupMembers = campaign.groupId
      ? await prisma.salesCampaign.findMany({
          where: { groupId: campaign.groupId },
          select: { id: true, startDate: true, endDate: true, orderCampaignId: true },
        })
      : [];
    const scopeCampaigns =
      groupMembers.length > 0
        ? groupMembers
        : [
            {
              id: campaign.id,
              startDate: campaign.startDate,
              endDate: campaign.endDate,
              orderCampaignId: campaign.orderCampaignId,
            },
          ];
    const scopeCampaignIds = scopeCampaigns.map((sc) => sc.id);

    const window = resolveSalesCampaignWindow(scopeCampaigns);
    if (!window) {
      return NextResponse.json({ error: "캠페인 시작일이 설정되지 않았습니다." }, { status: 422 });
    }
    // resolveSalesCampaignWindow의 startMs/endMs는 날짜경계(day-boundary) 보정을 하지 않는다(SSOT
    // 문서화됨, sale-window.ts) — 스토리 gte/lte 필터처럼 정밀 타임스탬프 비교에 그대로 쓰면 마감일
    // 당일 오후(종료) 또는 시작일 새벽(시작, UTC 자정=KST 09:00) 콘텐츠가 통째로 누락된다(다른
    // 소비처 campaigns-handler.ts·closed-campaign-cache.ts와 동일하게 여기서 KST 종일로 보정).
    // 두 경계 모두 스토리 쿼리와 buildTimelineDays에 동일하게 써야 한다 — 갈라지면 같은 종류의
    // 조용한 과소집계가 재발한다.
    const windowStartMs = isDayBoundaryMs(window.startMs)
      ? startOfKstDayMs(window.startMs)
      : window.startMs;
    const windowEndMs =
      window.endMs === null
        ? endOfKstDayMs(Date.now())
        : isDayBoundaryMs(window.endMs)
          ? endOfKstDayMs(window.endMs)
          : window.endMs;

    const [sales, assets, stories] = await Promise.all([
      // 그룹은 멤버 전체를 한 창으로 합산하는 전용 로더가 이미 있다(형제 회차 귀속 계산 포함).
      campaign.groupId
        ? getMobileCampaignGroupSales(campaign.groupId, new Date(), { includeIntraday: true })
        : getMobileCampaignSales(campaignId, new Date(), { includeIntraday: true }),
      prisma.asset.findMany({
        where: {
          entityType: "CAMPAIGN",
          entityId: { in: scopeCampaignIds },
          provider: "EXTERNAL_LINK",
          archivedAt: null,
          postedAt: { not: null },
        },
        select: {
          id: true, mediaType: true, postedAt: true, thumbnailUrl: true,
          externalUrl: true, likeCount: true, commentCount: true, likesHidden: true,
        },
      }),
      prisma.sellerStorySnapshot.findMany({
        where: {
          sellerId: campaign.sellerId,
          classification: "CAMPAIGN",
          // 미분류(salesCampaignId=null) 스토리는 셀러 창으로 포함하되, 스코프 밖 캠페인에 명시
          // 분류된 스토리는 배제한다 — 그렇지 않으면 창이 겹치는 무관한 캠페인의 스토리가 이
          // 타임라인에도 혼입돼 홈 브리핑(스토리 1건=캠페인 1개 단일 배정)과 숫자가 갈라진다.
          // 그룹에서는 형제 회차에 분류된 스토리도 같은 묶음의 발행이므로 스코프 안이다.
          OR: [{ salesCampaignId: null }, { salesCampaignId: { in: scopeCampaignIds } }],
          takenAt: { gte: new Date(windowStartMs), lte: new Date(windowEndMs) },
        },
        select: { id: true, takenAt: true, thumbnailUrl: true },
      }),
    ]);

    const events: ContentEvent[] = [
      ...assets.map((a) => ({
        id: `asset-${a.id}`,
        source: "asset" as const,
        type: mapAssetMediaType(a.mediaType),
        postedAt: a.postedAt!.toISOString(),
        dateKey: toDateKeyKst(a.postedAt!),
        thumbnailUrl: a.thumbnailUrl,
        permalink: a.externalUrl,
        likeCount: a.likeCount,
        commentCount: a.commentCount,
        likesHidden: a.likesHidden === true,
      })),
      ...stories.map((s) => ({
        id: `story-${s.id}`,
        source: "story" as const,
        type: "story" as const,
        postedAt: s.takenAt.toISOString(),
        dateKey: toDateKeyKst(s.takenAt),
        thumbnailUrl: s.thumbnailUrl,
        permalink: null,
        likeCount: null,
        commentCount: null,
        likesHidden: false,
      })),
    ];

    const days = buildTimelineDays({
      windowStartMs,
      windowEndMs,
      daily: sales?.daily ?? [],
      events,
    });

    /**
     * 빈 상태의 **사유**. "수집된 게시물이 있는데 타임라인은 없다고 한다"는 체감 모순은
     * 데이터가 아니라 설명의 부재였다(오너 지적 2026-08-02) — 미검토 후보는 타임라인에
     * 오르지 않는다는 사실이 화면 어디에도 없었다.
     *
     * 후보 카운트는 **이벤트가 0건일 때만** 센다. 정상 경로(콘텐츠가 있는 캠페인)에 조회
     * 4건(프로필·등록자산·무관분류·스토리 count)을 상시로 얹지 않기 위해서다.
     * 후보 수는 자료관리와 **같은 SSOT**(`loadSuggestedPosts`)로 계산한다 — 두 화면이 서로
     * 다른 숫자를 말하면 안내 자체가 신뢰를 잃는다.
     */
    const orderLinked = scopeCampaigns.some((sc) => sc.orderCampaignId !== null);
    let unreviewedStories = 0;
    let unreviewedPostCandidates = 0;
    let reviewClosed = false;
    if (events.length === 0) {
      const [storyCount, suggested] = await Promise.all([
        prisma.sellerStorySnapshot.count({
          where: {
            sellerId: campaign.sellerId,
            classification: "UNREVIEWED",
            takenAt: { gte: new Date(windowStartMs), lte: new Date(windowEndMs) },
          },
        }),
        loadSuggestedPosts(prisma, campaign),
      ]);
      unreviewedStories = storyCount;
      unreviewedPostCandidates = suggested.suggestions.length;
      reviewClosed = suggested.reviewClosed;
    }

    return NextResponse.json({
      campaignId,
      // 화면이 "이 숫자가 어느 범위의 것인가"를 말할 수 있게 스코프를 함께 내린다 —
      // 그룹 통합은 회차 하나만 보고 있다고 착각하면 과대집계로 오독되는 값이다.
      scope: campaign.groupId
        ? { kind: "group" as const, campaignCount: scopeCampaignIds.length }
        : { kind: "campaign" as const, campaignCount: 1 },
      window: {
        start: new Date(window.startMs).toISOString(),
        end: window.endMs ? new Date(window.endMs).toISOString() : null,
      },
      source: sales?.source ?? "none",
      days,
      context: { orderLinked, unreviewedStories, unreviewedPostCandidates, reviewClosed },
      // 10분 인트라데이 — live 경로에서만 나온다. null 은 "이 캠페인은 인트라데이 소스가
      // 없다"(마감·미연동)이고, points 가 비었는데 daysWithoutBuckets 가 차 있으면
      // "아직 버킷이 안 채워진 과거 일자"다. 둘을 화면에서 같게 취급하지 말 것.
      intraday: sales?.intraday ?? null,
      // 실제로 조회한 창. `truncated=true` 면 `startDate` 이전 날짜는 **주문 0이 아니라
      // 조회한 적이 없는 것**이므로 0으로 그리면 안 된다(오너 원칙: "주문이 0이다와 기록이
      // 없다는 구분될 수 있어야지"). 정상 운영에서는 걸리지 않는 폭주 가드라 평소 false 다.
      coverage: sales?.coverage ?? null,
    });
  } catch (error) {
    console.error("[/api/campaigns/[id]/content-order-timeline] GET failed:", error);
    return NextResponse.json({ error: "타임라인을 불러오지 못했습니다." }, { status: 500 });
  }
}
