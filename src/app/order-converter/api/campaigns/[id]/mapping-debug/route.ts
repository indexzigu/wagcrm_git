import { NextResponse } from "next/server";
import { prisma } from '@/lib/order-converter/prisma';
import { computeSimilarityScore } from "@/lib/order-converter/mapping-service";
import { getDisplayDealName } from "@/lib/deal-display";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const orderCamp = await prisma.orderCampaign.findUnique({
    where: { id },
    include: { mappings: true }
  });

  if (!orderCamp) {
    return NextResponse.json({ log: "OrderCampaign not found." });
  }

  const debugLines: string[] = [];
  const log = (msg: string) => debugLines.push(msg);

  log(`=== [AUTO-MAP DEBUG] Starting Option-based 1:N Mapping Simulation for OrderCampaign ID: ${orderCamp.id} ===`);
  log(`OrderCampaign Name (Store Product): "${orderCamp.name}"`);
  log(`Options to map: ${orderCamp.mappings.map(m => `"${m.optionName}"(price:${m.price})`).join(', ')}`);

  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const candidateSalesCamps = await prisma.salesCampaign.findMany({
    where: { startDate: { gte: threeMonthsAgo } },
    include: {
      seller: true,
      deal: true,
      campaignDeals: { include: { deal: true } }
    }
  });

  log(`Found ${candidateSalesCamps.length} candidate SalesCampaigns (>= 3 months)`);



  const matchedSalesCampaignIds = new Set<string>();

  for (const mapping of orderCamp.mappings) {
    log(`\n--- Evaluating Option: "${mapping.optionName}" (Price: ${mapping.price}) ---`);
    let bestDealId = null;
    let bestSalesCampId = null;
    let highestScore = 0;

    for (const salesCamp of candidateSalesCamps) {
      // 1. Seller Match Score
      const aliasStr = salesCamp.seller.alias || '';
      const nameStr = salesCamp.seller.name || '';
      const storeStr = `${orderCamp.name || ''} ${orderCamp.sellerName || ''}`;
      
      const aliasSimilarity = computeSimilarityScore(aliasStr, storeStr);
      const nameSimilarity = computeSimilarityScore(nameStr, storeStr);
      
      const sellerScore = Math.max(aliasSimilarity * 20, nameSimilarity * 10);

      if (sellerScore === 0) continue;

      for (const campaignDeal of salesCamp.campaignDeals) {
        let currentScore = sellerScore;
        const dealName = getDisplayDealName(campaignDeal.deal);
        const optionName = mapping.optionName || '';
        const productName = mapping.productName || orderCamp.name || '';
        
        // 2. Deal Match Score
        let dealScore = 0;
        const optionSimilarity = computeSimilarityScore(dealName, optionName);
        dealScore += optionSimilarity * 20;
        const productSimilarity = computeSimilarityScore(dealName, productName);
        dealScore += productSimilarity * 5;
        
        if (dealName && optionName && (optionSimilarity > 0 || productSimilarity > 0) && 
            (dealName.includes(optionName) || optionName.includes(dealName))) {
          dealScore += 30;
        }
        
        currentScore += dealScore;

        const optionPrice = Number(mapping.price || 0);
        const dealPrice = Number(campaignDeal.sellingPrice || campaignDeal.deal.sellingPrice || 0);
        let priceScore = 0;
        if (optionPrice > 0 && dealPrice > 0 && optionPrice === dealPrice) {
          priceScore = 50;
          currentScore += priceScore;
        }

        if (sellerScore > 0 && (dealScore > 0 || priceScore > 0)) {
           log(`     -> vs Deal "${dealName}" in "${salesCamp.campaignName}" | Seller:${sellerScore} + Deal:${dealScore} + Price:${priceScore} = ${currentScore}`);
        }

        if (sellerScore > 0 && (dealScore > 0 || priceScore > 0) && currentScore > highestScore && currentScore >= 30) {
          highestScore = currentScore;
          bestDealId = campaignDeal.id;
          bestSalesCampId = salesCamp.id;
        }
      }
    }

    if (bestDealId && bestSalesCampId) {
      log(` => [WINNER] Best Match for "${mapping.optionName}": CampaignDeal(${bestDealId}) in SalesCampaign(${bestSalesCampId}) with score: ${highestScore}`);
      matchedSalesCampaignIds.add(bestSalesCampId);
    } else {
      log(` => [FAIL] No valid match found for Option "${mapping.optionName}"`);
    }
  }

  const matchedList = Array.from(matchedSalesCampaignIds);
  if (matchedList.length > 0) {
    log(`\n=> FINAL RESULT: OrderCampaign will be linked to ${matchedList.length} SalesCampaigns in 1:N structure.`);
  } else {
    log(`\n=> FINAL RESULT: No SalesCampaigns matched.`);
  }

  return NextResponse.json({ log: debugLines.join('\n') });
}
