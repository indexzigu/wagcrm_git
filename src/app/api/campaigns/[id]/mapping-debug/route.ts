import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { computeSimilarityScore } from "@/lib/order-converter/mapping-service";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const prisma = getPrisma();

  const salesCamp = await prisma.salesCampaign.findUnique({
    where: { id },
    include: {
      seller: true,
      campaignDeals: { include: { deal: true } }
    }
  });

  if (!salesCamp) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // 최근 3개월간 수집된 스토어 주문 캠페인 조회
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const orderCamps = await prisma.orderCampaign.findMany({
    where: {
      createdAt: { gte: threeMonthsAgo }
    },
    include: {
      mappings: true
    }
  });

  const debugLines: string[] = [];
  const log = (msg: string) => debugLines.push(msg);

  log(`=== [AUTO-MAP DEBUG] Searching candidates for SalesCampaign: "${salesCamp.campaignName}" ===`);
  log(`Seller Name: "${salesCamp.seller.name}", Alias: "${salesCamp.seller.alias}"`);
  log(`Total recent OrderCampaigns (Store Products) checked: ${orderCamps.length}\n`);

  for (const orderCamp of orderCamps) {
    log(`-> Checking Store Product: "${orderCamp.name}"`);

    const sellerStr = `${salesCamp.seller.name || ''} ${salesCamp.seller.alias || ''}`;
    const storeStr = `${orderCamp.name || ''} ${orderCamp.sellerName || ''}`;
    const sellerScore = computeSimilarityScore(sellerStr, storeStr);

    if (sellerScore === 0) {
      log(`   [FAIL] Seller mismatch. Score is 0.`);
      continue;
    }
    log(`   [PASS] Seller matched (score: ${sellerScore}). Checking deals...`);

    let isDealMatch = false;
    for (const mapping of orderCamp.mappings) {
      for (const campaignDeal of salesCamp.campaignDeals) {
        let currentScore = sellerScore * 10;
        const dealName = campaignDeal.deal.dealName || '';
        const optionName = mapping.optionName || '';
        const productName = mapping.productName || orderCamp.name || '';

        let dealScore = 0;
        if (dealName && optionName && (dealName.includes(optionName) || optionName.includes(dealName))) {
          dealScore += 50;
        } else {
          dealScore += computeSimilarityScore(dealName, optionName) * 20;
          dealScore += computeSimilarityScore(dealName, productName) * 5;
        }
        currentScore += dealScore;

        const optionPrice = Number(mapping.price || 0);
        const dealPrice = Number(campaignDeal.sellingPrice || campaignDeal.deal.sellingPrice || 0);
        let priceScore = 0;
        if (optionPrice > 0 && dealPrice > 0 && optionPrice === dealPrice) {
          priceScore = 30;
          currentScore += priceScore;
        }

        if (dealScore > 0 && currentScore >= 30) {
          log(`       [MATCH!] Option "${mapping.optionName}" matches Deal "${dealName}" (Score: ${currentScore})`);
          isDealMatch = true;
        }
      }
    }

    if (isDealMatch) {
      log(`   => [SUCCESS] This store product successfully matches the CRM campaign!`);
    } else {
      log(`   => [FAIL] Seller matched, but no deals reached score threshold.`);
    }
    log('');
  }

  return NextResponse.json({ log: debugLines.join('\n') });
}
