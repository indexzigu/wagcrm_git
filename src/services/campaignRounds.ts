import { generateCampaignName } from "@/lib/campaign-name";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";

/**
 * Recalculates roundNumber and campaignName for every campaign of a
 * (dealId, sellerId) pair, ordered by startDate then createdAt.
 *
 * Must run inside the same transaction as the create/update/delete that
 * triggered it — pass the transaction client as `tx`. Shared by
 * campaignService (single create/update) and the bulk creation route.
 */
export async function recalculateCampaignRounds(dealId: string, sellerId: string, tx: any) {
  // Read Committed에서는 동시 트랜잭션의 미커밋 캠페인이 서로 안 보여 두 생성이
  // 같은 차수·캠페인명을 받을 수 있다. (dealId, sellerId)별 advisory lock으로
  // 재계산 구간을 직렬화한다 — 트랜잭션 종료 시 자동 해제되므로 반드시 tx 안에서
  // 호출해야 한다. DB의 DEFERRABLE 유니크 제약(dealId, sellerId, roundNumber)이
  // 커밋 시점 최후 안전망.
  // $executeRaw 사용 — pg_advisory_xact_lock은 void 반환이라 $queryRaw는 역직렬화에 실패한다.
  // SQLite dev runtime에는 advisory lock이 없으므로 건너뛴다(단일 프로세스라 경합 없음).
  if (!isSqliteDatabaseUrl()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dealId}), hashtext(${sellerId}))`;
  }

  const campaigns = await tx.salesCampaign.findMany({
    where: { dealId, sellerId },
    include: {
      deal: true,
      seller: true,
    },
    orderBy: [
      { startDate: "asc" },
      { createdAt: "asc" },
    ],
  });

  const count = campaigns.length;

  for (let i = 0; i < count; i++) {
    const campaign = campaigns[i];
    const newRoundNumber = count > 1 ? i + 1 : null;
    const dealName = campaign.deal?.dealName ?? null;
    const sellerName = campaign.seller?.alias || campaign.seller?.name || null;
    const newCampaignName = generateCampaignName(dealName, sellerName, newRoundNumber);

    if (campaign.roundNumber !== newRoundNumber || campaign.campaignName !== newCampaignName) {
      await tx.salesCampaign.update({
        where: { id: campaign.id },
        data: {
          roundNumber: newRoundNumber,
          campaignName: newCampaignName,
        },
      });
    }
  }
}
