import { PrismaClient } from "@prisma/client";
import { generateCampaignName } from "../src/lib/campaign-name";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting campaign rounds migration...");

  // 1. 모든 캠페인을 가져오고 deal, seller 정보를 조인
  const campaigns = await prisma.salesCampaign.findMany({
    include: {
      deal: true,
      seller: true,
    },
  });

  // 2. dealId와 sellerId 기준으로 캠페인 그룹화
  const groups: Record<string, typeof campaigns> = {};
  for (const c of campaigns) {
    const key = `${c.dealId}_${c.sellerId}`;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(c);
  }

  let updateCount = 0;

  // 3. 각 그룹별로 정렬 및 차수/이름 계산하여 업데이트
  for (const key of Object.keys(groups)) {
    const groupCampaigns = groups[key];
    
    // startDate 오름차순, startDate가 같으면 createdAt 오름차순 정렬
    groupCampaigns.sort((a, b) => {
      const dateA = new Date(a.startDate).getTime();
      const dateB = new Date(b.startDate).getTime();
      if (dateA !== dateB) {
        return dateA - dateB;
      }
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    const count = groupCampaigns.length;

    for (let i = 0; i < count; i++) {
      const campaign = groupCampaigns[i];
      const newRoundNumber = count > 1 ? i + 1 : null;
      const dealName = campaign.deal?.dealName ?? null;
      const sellerName = campaign.seller?.alias || campaign.seller?.name || null;
      const newCampaignName = generateCampaignName(dealName, sellerName, newRoundNumber);

      if (campaign.roundNumber !== newRoundNumber || campaign.campaignName !== newCampaignName) {
        console.log(
          `Updating Campaign [${campaign.id}]: "${campaign.campaignName}" (round: ${campaign.roundNumber}) -> "${newCampaignName}" (round: ${newRoundNumber})`
        );
        await prisma.salesCampaign.update({
          where: { id: campaign.id },
          data: {
            roundNumber: newRoundNumber,
            campaignName: newCampaignName,
          },
        });
        updateCount++;
      }
    }
  }

  console.log(`Migration completed. Updated ${updateCount} campaigns.`);
}

main()
  .catch((e) => {
    console.error("Migration error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
