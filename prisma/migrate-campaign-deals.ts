import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting migration for CampaignDeal...');
  
  // 1. 모든 SalesCampaign 조회
  const campaigns = await prisma.salesCampaign.findMany();
  console.log(`Found ${campaigns.length} campaigns to process.`);
  
  let migratedCount = 0;
  
  for (const campaign of campaigns) {
    if (!campaign.dealId) {
      console.log(`Skipping Campaign ID ${campaign.id}: No dealId associated.`);
      continue;
    }
    
    // Decimal 타입을 다루기 위해 Number로 변환하거나 Prisma Decimal 자체를 활용
    const actualSales = campaign.actualSales ? Number(campaign.actualSales) : 0;
    const quantity = campaign.quantity ? Number(campaign.quantity) : 0;
    
    // 2. CampaignDeal 테이블에 upsert
    await prisma.campaignDeal.upsert({
      where: {
        campaignId_dealId: {
          campaignId: campaign.id,
          dealId: campaign.dealId,
        },
      },
      update: {}, // 이미 존재하면 업데이트하지 않음 (안전제일)
      create: {
        campaignId: campaign.id,
        dealId: campaign.dealId,
        quantity: quantity,
        actualSales: actualSales,
        // 기존 캠페인의 수수료율이나 원가 정보가 있다면 필요시 추가 가능
      },
    });
    
    migratedCount++;
  }
  
  console.log(`Migration completed! Successfully migrated ${migratedCount} relations.`);
}

main()
  .catch((e) => {
    console.error('Error during migration:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
