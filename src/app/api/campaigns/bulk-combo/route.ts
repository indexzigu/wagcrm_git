import { NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import { syncCampaignToCalendar } from "@/lib/google-calendar-sync";
import { toCampaignRow } from "@/lib/campaign-row";
import { campaignService, recalculateCampaignRounds } from "@/services/campaignService";
import { campaignRepository } from "@/repositories/campaignRepository";
import { campaignGroupService, CampaignGroupError } from "@/services/campaignGroupService";
import { campaignGroupRepository } from "@/repositories/campaignGroupRepository";
import { toCampaignGroupRow } from "@/lib/campaign-group-row";

/**
 * POST /api/campaigns/bulk-combo — "셀러 1명 × 딜 N개" 조합 일괄 생성 + 그룹 동시 생성
 * (블루프린트 §3 경로 ⓐ · UI 스펙 §1). 기존 bulk(1딜×N셀러 브로드캐스트)와 별개.
 *
 * 원자성(전부-아니면-전무): 먼저 셀러·전 딜 존재를 검증하고(하나라도 무효면 400, 0건 생성),
 * 이후 실제 생성 경로(`campaignService.createCampaign`)로 딜별 캠페인을 만든 뒤
 * 그룹으로 묶는다. 어느 단계든 실패하면 이미 만든 캠페인을 보상 삭제한다(부분 성공 없음).
 *
 * 실제 생성 경로를 쓰는 이유: 체크리스트 시딩·활동 로그·추적 링크 빌드·딜별
 * recalculateCampaignRounds가 단건 생성과 동일하게 보존된다(가짜 추적링크 발명 금지).
 * 캘린더 동기화는 단건 생성 라우트와 동일하게 캠페인별 after()로만 — 그룹 단위 캘린더는 CG-3.
 */

const bulkComboSchema = z
  .object({
    sellerId: z.string().min(1),
    dealIds: z
      .array(z.string().min(1))
      .min(2, "조합은 딜 2개 이상이 필요합니다."),
    startDate: z.string().date(),
    endDate: z.string().date(),
    // createCampaignSchema(campaigns POST)의 salesChannel enum과 동일 정의(재사용).
    salesChannel: z
      .enum([
        "UNSPECIFIED",
        "OWN_MALL",
        "OWN_MALL_NAVER",
        "OWN_MALL_KAKAO",
        "SELLER_MALL",
        "BRAND_MALL",
      ])
      .optional(),
    status: z
      .enum([
        "PROPOSAL",
        "PREPARATION",
        "ACTIVE",
        "CLOSED",
        "SETTLEMENT_WAIT",
        "SETTLEMENT_IN_PROGRESS",
        "COMPLETED",
        "DROPPED",
      ])
      .default("PROPOSAL"),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: "종료일은 시작일보다 빠를 수 없습니다.",
    path: ["endDate"],
  });

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const parsed = bulkComboSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { sellerId, startDate, endDate, salesChannel, status } = parsed.data;
  const dealIds = [...new Set(parsed.data.dealIds)];
  if (dealIds.length < 2) {
    return NextResponse.json(
      { error: "조합은 서로 다른 딜 2개 이상이 필요합니다." },
      { status: 400 },
    );
  }

  const prisma = getPrisma();

  // 사전 검증(전부-아니면-전무): 셀러·전 딜 존재 확인. 하나라도 무효면 0건 생성 후 400.
  const [seller, deals] = await Promise.all([
    prisma.seller.findUnique({ where: { id: sellerId }, select: { id: true } }),
    prisma.deal.findMany({ where: { id: { in: dealIds } }, select: { id: true } }),
  ]);
  const foundDealIds = new Set(deals.map((d) => d.id));
  const missingDealIds = dealIds.filter((id) => !foundDealIds.has(id));
  if (!seller || missingDealIds.length > 0) {
    return NextResponse.json(
      {
        error: !seller
          ? "셀러를 찾을 수 없습니다."
          : "일부 딜을 찾을 수 없습니다.",
        sellerFound: Boolean(seller),
        missingDealIds,
      },
      { status: 400 },
    );
  }

  const created: Awaited<ReturnType<typeof campaignService.createCampaign>>[] = [];

  try {
    // 딜별 실제 생성(단건 경로 그대로 — 딜별 recalculateCampaignRounds 포함).
    for (const dealId of dealIds) {
      const campaign = await campaignService.createCampaign(
        {
          dealId,
          sellerId,
          startDate,
          endDate,
          salesChannel: salesChannel ?? "UNSPECIFIED",
          // 조합 생성은 링크 미확정 — 실제 경로가 빈 base를 안전히 처리(추적링크 발명 금지).
          baseNaverLink: "",
          status,
          isManualMargin: false,
        },
        { userId: auth.context.userId, email: auth.context.email },
      );
      created.push(campaign);
    }

    // 동일 셀러·미그룹 캠페인들 → 새 그룹(원자적 트랜잭션은 서비스가 소유).
    const group = await campaignGroupService.createGroup(created.map((c) => c.id));
    const groupDetail = await campaignGroupRepository.findByIdOrThrow(group.id);
    const groupRow = toCampaignGroupRow(groupDetail);

    revalidateCampaignCaches();

    // 캘린더 동기화 — 단건 생성 라우트(campaigns/route.ts)와 동일 패턴: 캠페인별 after() 백그라운드.
    for (const campaign of created) {
      after(() =>
        syncCampaignToCalendar(campaign.id).catch((calendarError) =>
          console.error("[calendar-sync] bulk-combo 생성 훅 실패:", calendarError),
        ),
      );
    }

    // 방금 그룹핑되었으므로 응답 행에 소속 정보를 즉시 반영(보드/배지 낙관 갱신용).
    const createdRows = created.map((campaign) => {
      const row = toCampaignRow(campaign);
      row.groupId = group.id;
      row.groupMemberCount = groupRow.memberCount;
      return row;
    });

    return NextResponse.json({ created: createdRows, group: groupRow }, { status: 201 });
  } catch (error) {
    // 보상 삭제 — 이미 만든 캠페인을 되돌린다(부분 성공 방지).
    // 삭제 실패분은 삼키지 않고 orphanCampaignIds로 응답에 표면화한다(수동 정리 대상).
    const orphanCampaignIds: string[] = [];
    await Promise.allSettled(
      created.map((campaign) =>
        campaignRepository.delete(campaign.id).catch((cleanupError) => {
          orphanCampaignIds.push(campaign.id);
          console.error(
            `[bulk-combo] 보상 삭제 실패(수동 정리 필요) campaignId=${campaign.id}:`,
            cleanupError,
          );
        }),
      ),
    );

    // 생성 단계의 recalculateCampaignRounds가 이미 형제 캠페인을 renumber했으므로,
    // 보상 삭제만 하고 떠나면 형제가 stale "N차" 이름으로 남는다. 삭제에 성공한
    // 캠페인의 (dealId, sellerId) 코호트를 재계산해 원상 복구한다.
    // advisory xact lock 요건상 반드시 tx 안에서 호출(campaignService.ts:738 주석).
    const recalcDealIds = [
      ...new Set(
        created
          .filter((campaign) => !orphanCampaignIds.includes(campaign.id))
          .map((campaign) => campaign.dealId),
      ),
    ];
    if (recalcDealIds.length > 0) {
      try {
        await prisma.$transaction(async (tx) => {
          for (const dealId of recalcDealIds) {
            await recalculateCampaignRounds(dealId, sellerId, tx);
          }
        });
      } catch (recalcError) {
        console.error("[bulk-combo] 보상 후 차수 재계산 실패:", recalcError);
      }
    }
    // 생성→삭제·renumber로 목록 캐시가 실데이터와 어긋날 수 있어 보상 경로에서도 무효화.
    if (created.length > 0) revalidateCampaignCaches();

    if (error instanceof CampaignGroupError) {
      return NextResponse.json(
        { error: error.message, code: error.code, orphanCampaignIds },
        { status: error.status },
      );
    }
    console.error("POST /api/campaigns/bulk-combo failed:", error);
    return NextResponse.json(
      { error: "조합 캠페인 생성에 실패했습니다.", orphanCampaignIds },
      { status: 500 },
    );
  }
}
