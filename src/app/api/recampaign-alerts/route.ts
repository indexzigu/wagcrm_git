import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { computeRecampaignAlerts } from "@/lib/recampaign-timing";
import { buildProposalDedupeKey, readProposalDedupeKey } from "@/lib/recampaign-proposal";

// F1 재캠페인 적기 알림 (GROWTH_FLYWHEEL_PLAN.md §F1) — 대시보드 서버 페이로드에서
// 분리해 영업 관리(/outreach)의 RecampaignAlertsCard가 직접 조회한다.
export async function GET() {
  try {
    const prisma = getPrisma();
    const [campaigns, openProposals] = await Promise.all([
      prisma.salesCampaign.findMany({
        select: {
          sellerId: true,
          startDate: true,
          endDate: true,
          status: true,
          seller: { select: { name: true, alias: true, availabilityNote: true } },
        },
      }),
      // 이미 열린(대기/초안) 재캠페인 기안이 있는 셀러 — 카드가 '기안됨'으로 표시.
      // ⚠️ `structuredResult` 까지 읽는 이유: 같은 `requestType` 을 **딜 스코프 기안**(D2)
      // 도 쓴다. 셀러 id 만 보면 "이 셀러에게 어떤 딜을 제안하는 기안"이 열려 있다는 이유로
      // 이 카드가 '기안됨'이 되어, 정작 케이던스 기안은 못 올리게 된다.
      prisma.actionProposal.findMany({
        where: {
          requestType: "recampaign_suggestion",
          status: { in: ["DRAFT", "PENDING_APPROVAL"] },
          targetEntityType: "SELLER",
        },
        select: { targetEntityId: true, structuredResult: true },
      }),
    ]);

    const alerts = computeRecampaignAlerts(
      campaigns.map((campaign) => ({
        sellerId: campaign.sellerId,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        status: campaign.status,
        sellerName: campaign.seller.name,
        sellerAlias: campaign.seller.alias,
        availabilityNote: campaign.seller.availabilityNote,
      })),
      new Date(),
    );
    const proposedSellerIds = Array.from(
      new Set(
        openProposals
          .filter(
            (p) =>
              readProposalDedupeKey(p) ===
              buildProposalDedupeKey({
                sellerId: p.targetEntityId ?? "",
                reason: "CADENCE_DUE",
                dealId: null,
              }),
          )
          .map((p) => p.targetEntityId)
          .filter((v): v is string => !!v),
      ),
    );

    return NextResponse.json({ alerts, proposedSellerIds });
  } catch (error) {
    console.error("[RecampaignAlertsAPI] 조회 실패:", error);
    return NextResponse.json(
      { error: "재캠페인 알림을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
