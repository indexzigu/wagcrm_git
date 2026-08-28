import { NextResponse } from "next/server";
import { prisma } from '@/lib/order-converter/prisma';
import { computeSellerScore, scoreDealCandidate, extractSupplyMonths } from "@/lib/order-converter/similarity";
import { getDisplayDealName } from "@/lib/deal-display";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const orderCamp = await prisma.orderCampaign.findUnique({
    where: { id },
    include: { mappings: true }
  });

  if (!orderCamp) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 매핑 후보 찾기 (3개월 이내 캠페인)
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const candidateSalesCamps = await prisma.salesCampaign.findMany({
    where: { startDate: { gte: threeMonthsAgo } },
    include: {
      seller: true,
      campaignDeals: { include: { deal: true } }
    }
  });

  const recommendations: Record<string, any[]> = {};

  for (const mapping of orderCamp.mappings) {
    const dealsWithScores = [];

    // 옵션의 월 공급량(N개월분)은 딜 후보 순회 내내 불변 — 한 번만 추출한다.
    // 스토어 상품명(orderCamp.name)은 자유 마케팅 텍스트라 폴백 소스에서 제외(mapping-service 와 동일).
    const optionMonths =
      extractSupplyMonths(mapping.optionName) ?? extractSupplyMonths(mapping.productName);

    for (const salesCamp of candidateSalesCamps) {
      // 스코어링은 autoMap(mapping-service)과 반드시 동일해야 한다 — SSOT 공유.
      const storeStr = `${orderCamp.name || ''} ${orderCamp.sellerName || ''}`;
      const sellerScore = computeSellerScore(salesCamp.seller.alias, salesCamp.seller.name, storeStr);

      if (sellerScore === 0) continue;

      for (const campaignDeal of salesCamp.campaignDeals) {
        const dealName = getDisplayDealName(campaignDeal.deal);
        const optionName = mapping.optionName || '';
        const productName = mapping.productName || orderCamp.name || '';
        const optionPrice = Number(mapping.price || 0);
        const dealPrice = Number(campaignDeal.sellingPrice || campaignDeal.deal.sellingPrice || 0);

        const { dealScore, priceScore, totalScore, periodMismatch, dealMonths } = scoreDealCandidate({
          sellerScore, dealName, optionName, productName, optionMonths, optionPrice, dealPrice,
        });

        // 기간(개월분) 완전일치 게이트 — 옵션과 딜의 월 공급량이 서로 다르면 이 딜은 추천에서
        // 제외한다. autoMap 이 후보에서 빼는 것과 동일하게, 추천 드롭다운도 기간 불일치 딜을
        // 노출하지 않아야 오너가 잘못된 점수(예: 3개월분 옵션에 1개월분 딜 50점)에 오도되지 않는다.
        if (periodMismatch) continue;

        if (dealScore > 0 || priceScore > 0) {
          dealsWithScores.push({
            id: campaignDeal.id,
            name: dealName,
            score: totalScore,
            // 기간(N개월분)이 옵션과 정확히 일치하는 강한 이산 신호 — 모달 자동채움이 가격
            // 불일치로 100점에 못 미치는 후보(예: 옵션가는 할인 적용, 딜가는 정가)를 놓치지
            // 않도록 노출한다. 가격은 매칭 기준이 아니다(오너 확정 2026-07-19: 스토어 실판매가
            // 가 정본, 옵션가는 할인율에 따라 흔들린다).
            periodExact: optionMonths !== null && dealMonths === optionMonths,
            // 딜 등록가 — 매핑 옵션가(스토어 실판매가)와의 교차검증(가격 확인 배지)용.
            // campaigns-handler 는 egress 절감으로 campaignDeals 를 싣지 않으므로(#137·#151)
            // 모달이 딜 가격을 아는 유일한 경로가 이 응답이다.
            dealPrice,
          });
        }
      }
    }

    // Sort by score DESC and take top 10.
    // 단, 기간(N개월분) 정확일치 후보는 절단에서 보존한다 — 다회차 반복 셀러처럼 후보가
    // 10개를 넘는 경우, 점수 낮은 기간일치 회차가 잘려나가면 모달 자동채움 ② 규칙이
    // "10위 안에서만 유일"을 진짜 유일로 오판해 엉뚱한 회차에 자동 연결될 수 있다
    // (code-reviewer MEDIUM). 보존하면 모달의 유일성 판정 = 전체 후보 기준 유일성이 되고,
    // 드롭다운에서도 기간 맞는 딜이 절단으로 숨지 않는다.
    dealsWithScores.sort((a, b) => b.score - a.score);
    const top = dealsWithScores.slice(0, 10);
    const periodExactExtras = dealsWithScores.slice(10).filter((d) => d.periodExact);
    recommendations[mapping.id] = [...top, ...periodExactExtras];
  }

  return NextResponse.json({ recommendations });
}
