import { prisma } from '@/lib/order-converter/prisma';
import fs from 'fs';
import path from 'path';
import { calculateDerivedCampaignFinancials } from '@/lib/campaign-financials';
import { isIndividualSeller, getSellerPayoutBase, calcIndividualIncomeTax } from '@/lib/seller-tax-utils';
import { getDisplayDealName } from '@/lib/deal-display';
import { countDistinctSellerIds, isCrossSellerSet, CROSS_SELLER_REJECT_MESSAGE } from '@/lib/cross-seller';
// 순수 유사도 함수는 클라이언트 번들 안전한 similarity.ts로 이전.
// 로컬 사용 + 기존 import 경로 보존을 위해 import 후 재수출.
import { computeSimilarityScore, extractSupplyMonths, computeSellerScore, scoreDealCandidate } from './similarity';
import { parseStoredPeriodEndMs, resolveSaleWindowStartMs, resolveSaleWindowEndMs, isDayBoundaryMs, startOfKstDayMs, endOfKstDayMs, resolveCampaignQueryStartMs, resolveSalesCampaignWindow, formatKstPeriodLabel, parseSalePeriodBounds, isSameKstDay } from './sale-window';
export { computeSimilarityScore };

const MAPPING_DEBUG_LOG_FILE = 'mapping-debug.log';

function appendMappingDebugLog(debugLines: string[]) {
  const logPath = path.join(process.cwd(), MAPPING_DEBUG_LOG_FILE);

  try {
    fs.appendFileSync(logPath, `${debugLines.join('\n')}\n`);
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'UNKNOWN';
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[auto-map] Failed to write ${MAPPING_DEBUG_LOG_FILE}; continuing without file debug log.`, {
      code,
      message,
      path: logPath,
    });
  }
}

/**
 * 네이버 커머스 상품(OrderCampaign)과 CRM 캠페인(SalesCampaign) 간 자동 매핑
 */
export async function autoMapOrderCampaign(orderCampaignId: string) {
  const debugLines: string[] = [];
  const log = (msg: string) => debugLines.push(msg);

  log(`\n=== [AUTO-MAP DEBUG] Starting Option-based 1:N Mapping for OrderCampaign ID: ${orderCampaignId} ===`);

  const orderCamp = await prisma.orderCampaign.findUnique({
    where: { id: orderCampaignId },
    include: { mappings: true }
  });

  if (!orderCamp) {
    log(`Result: OrderCampaign not found.`);
    appendMappingDebugLog(debugLines);
    return;
  }

  log(`OrderCampaign Name (Store Product): "${orderCamp.name}"`);
  log(`Options to map: ${orderCamp.mappings.map(m => `"${m.optionName}"(price:${m.price})`).join(', ')}`);

  // 대상이 되는 SalesCampaign 후보 찾기 (최근 3개월)
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

  const sellerIdBySalesCampId = new Map<string, string | null | undefined>(
    candidateSalesCamps.map((sc) => [sc.id, sc.sellerId]),
  );

  const matchedSalesCampaignIds = new Set<string>();
  // 결정과 쓰기를 분리한다 — 셀러 단일성 게이트(아래 3.5)가 "전체 거부"이려면 검사 시점에
  // 아직 아무것도 쓰여 있지 않아야 한다. 종전에는 루프 안에서 곧바로 update 를 날려, 거부
  // 판정을 넣더라도 이미 절반이 반영된 상태가 됐을 것이다.
  const pendingLinks: { mappingId: string; dealId: string }[] = [];
  const winningSellerIds: (string | null | undefined)[] = [];

  for (const mapping of orderCamp.mappings) {
    log(`\n--- Evaluating Option: "${mapping.optionName}" (Price: ${mapping.price}) ---`);
    let bestDealId: string | null = null;
    let bestSalesCampId: string | null = null;
    let highestScore = 0;

    // 옵션의 월 공급량(N개월분)은 딜 후보 순회 내내 불변이므로 한 번만 추출한다.
    // 옵션명에 없으면 매핑 상품명에서 폴백한다. 스토어 상품명(orderCamp.name)은 자유 마케팅
    // 텍스트("무이자 12개월 할부" 등)라 폴백 소스에서 제외한다 — 공급기간이 아닌 값을 뽑아
    // 정상 매칭을 오탈락시킬 위험(extractSupplyMonths가 공급 접미사만 인정해 1차 방어하지만,
    // 소스 자체를 신뢰 가능한 필드로 좁혀 2차 방어).
    const optionMonths =
      extractSupplyMonths(mapping.optionName) ?? extractSupplyMonths(mapping.productName);

    for (const salesCamp of candidateSalesCamps) {
      // 1. Seller Match Score (SSOT: computeSellerScore)
      const storeStr = `${orderCamp.name || ''} ${orderCamp.sellerName || ''}`;
      const sellerScore = computeSellerScore(salesCamp.seller.alias, salesCamp.seller.name, storeStr);

      if (sellerScore === 0) {
        continue; // 셀러 정보가 전혀 겹치지 않으면 이 캠페인은 패스
      }

      for (const campaignDeal of salesCamp.campaignDeals) {
        const dealName = getDisplayDealName(campaignDeal.deal);
        const optionName = mapping.optionName || '';
        const productName = mapping.productName || orderCamp.name || '';
        const optionPrice = Number(mapping.price || 0);
        const dealPrice = Number(campaignDeal.sellingPrice || campaignDeal.deal.sellingPrice || 0);

        // 2·3. 딜 매칭 점수 + 가격 점수 + 기간(개월분) 완전일치 게이트를 SSOT(scoreDealCandidate)로
        // 계산한다. 이 스코어링은 recommended-deals(드롭다운 추천 점수)와 반드시 동일해야 하며,
        // 게이트가 한 구현에만 있어 추천 화면이 기간 불일치 딜을 높은 점수로 노출하던 drift를
        // 봉인하기 위해 단일 함수로 통일했다. periodMismatch면 이 딜은 후보에서 제외한다
        // (한쪽이라도 월 공급량이 없으면 게이트 미적용 → 기존 점수 폴백=회귀 안전).
        const { dealScore, priceScore, totalScore, periodMismatch, dealMonths } = scoreDealCandidate({
          sellerScore, dealName, optionName, productName, optionMonths, optionPrice, dealPrice,
        });

        if (periodMismatch) {
          log(`     -> SKIP Deal "${dealName}" in "${salesCamp.campaignName}" | 기간 불일치(옵션 ${optionMonths}개월분 ≠ 딜 ${dealMonths}개월분)`);
          continue;
        }

        if (dealScore > 0 || priceScore > 0) {
           log(`     -> vs Deal "${dealName}" in "${salesCamp.campaignName}" | Seller:${sellerScore} + Deal:${dealScore} + Price:${priceScore} = ${totalScore}`);
        }

        // 특정 기준점을 넘는 경우만 유효한 매칭으로 인정
        // 상품/옵션 매칭(dealScore > 0) 혹은 가격 일치(priceScore > 0)가 있어야 함
        // (sellerScore > 0 은 위 continue 로 이미 보장).
        if ((dealScore > 0 || priceScore > 0) && totalScore > highestScore && totalScore >= 30) {
          highestScore = totalScore;
          bestDealId = campaignDeal.id;
          bestSalesCampId = salesCamp.id;
        }
      }
    }

    if (bestDealId && bestSalesCampId) {
      log(` => Best Match for "${mapping.optionName}": CampaignDeal(${bestDealId}) in SalesCampaign(${bestSalesCampId}) with score: ${highestScore}`);
      // ⚠️ 여기서 **쓰지 않는다** — 아래 셀러 단일성 검사를 통과한 뒤 일괄 반영한다(전체 거부).
      pendingLinks.push({ mappingId: mapping.id, dealId: bestDealId });
      matchedSalesCampaignIds.add(bestSalesCampId);
      winningSellerIds.push(sellerIdBySalesCampId.get(bestSalesCampId));
    } else {
      log(` => No valid match found for Option "${mapping.optionName}"`);
    }
  }

  // 3.5 셀러 단일성 게이트 — 옵션별 승자가 서로 다른 셀러를 가리키면 **전체 거부**한다.
  //
  // 왜 부분 반영이 아니라 전체 거부인가(오너 결정 2026-08-05): 옵션 승자가 셀러별로 갈렸다는
  // 것은 이 주문캠페인의 이름·옵션명이 여러 셀러의 딜과 비슷하게 읽힌다는 뜻이고, 그 상태에서
  // "지배적 셀러 채택"이나 "갈린 옵션만 미매핑"을 하면 **어느 쪽이 맞는지 기계가 모르는 채로
  // 절반을 확정**해 버린다. 잘못 붙은 링크는 셀러 화면에 남의 매출을 합산해 내보내므로(P0)
  // 조용한 부분 성공보다 시끄러운 전량 실패가 낫다.
  //
  // ⛔ 이 게이트를 완화해 자동매핑을 "통과시키는" 방향으로 고치지 말 것 — 걸렸다는 건 매핑이
  // 잘못됐다는 뜻이고, 해소는 딜 연결을 한 셀러로 정리하거나 주문캠페인을 나누는 것이다.
  // 판정 규칙은 `@/lib/cross-seller` 가 SSOT 다(포털 표시 제외 게이트와 같은 규칙을 쓴다).
  if (isCrossSellerSet(winningSellerIds)) {
    const sellerCount = countDistinctSellerIds(winningSellerIds);
    log(`\n⛔ REJECTED: 옵션별 승자가 서로 다른 셀러 ${sellerCount}곳을 가리킵니다. 전체 거부(쓰기 0건).`);
    log(`   ${CROSS_SELLER_REJECT_MESSAGE}`);
    log(`\n=== [AUTO-MAP DEBUG] Finished (rejected). ===\n`);
    appendMappingDebugLog(debugLines);
    // fire-and-forget 호출부(캠페인 생성·수정 라우트)는 예외를 삼키므로, 오너가 볼 수 있는
    // 서버 로그에도 남긴다 — 포털 게이트의 warnCrossSellerCampaigns 와 같은 계열이다.
    // ⚠️ 셀러 실명·캠페인명을 싣지 않는다(P0, 레포 public) — 식별자만.
    console.warn(
      `[auto-map] OrderCampaign(${orderCamp.id}) 자동 매핑을 전체 거부했습니다: ` +
        `옵션별 승자가 서로 다른 셀러 ${sellerCount}곳을 가리킵니다. ${CROSS_SELLER_REJECT_MESSAGE}`,
    );
    return [];
  }

  // 3.9 검사 통과 — 이제서야 쓴다. 기존 링크 여부와 관계없이 업데이트(자동 매핑 재실행 대응).
  for (const link of pendingLinks) {
    await prisma.productMapping.update({
      where: { id: link.mappingId },
      data: { campaignDealId: link.dealId },
    });
    const target = orderCamp.mappings.find((m) => m.id === link.mappingId);
    if (target) target.campaignDealId = link.dealId;
    log(`    Linked ProductMapping(${link.mappingId}) to CampaignDeal(${link.dealId})`);
  }

  // 4. SalesCampaign에 orderCampaignId 연동 (1:N 처리)
  const matchedList = Array.from(matchedSalesCampaignIds);
  
  log(`\nSyncing OrderCampaign to SalesCampaigns...`);
  
  // 기존에 이 주문캠페인에 묶여있었으나 이번 자동매핑으로 제외된 캠페인들의 연결 해제
  await prisma.salesCampaign.updateMany({
    where: {
      orderCampaignId: orderCamp.id,
      ...(matchedList.length > 0 && { id: { notIn: matchedList } })
    },
    data: { orderCampaignId: null }
  });

  if (matchedList.length > 0) {
    await prisma.salesCampaign.updateMany({
      where: { id: { in: matchedList } },
      data: { orderCampaignId: orderCamp.id }
    });
    log(`Updated ${matchedList.length} SalesCampaigns with orderCampaignId.`);
  }

  log(`\n=== [AUTO-MAP DEBUG] Finished. ===\n`);
  appendMappingDebugLog(debugLines);

  // 반환값: 매칭된 SalesCampaign 배열
  return prisma.salesCampaign.findMany({
    where: { id: { in: matchedList } },
    include: { seller: true, deal: true }
  });
}

/**
 * 정산완료(SETTLEMENT 이상) 여부를 확인하여, 락(Lock)이 걸렸는지 반환
 */
export function isSalesCampaignLocked(status: string | null | undefined) {
  // 정산대기(SETTLEMENT_WAIT)까지는 업데이트 허용, 정산중/정산완료/드랍 상태일 때만 잠금.
  // null/undefined(미선택·미확정)는 락 아님으로 취급 — status.toUpperCase() 크래시 방어(defense-in-depth).
  if (status == null) return false;
  const lockedStatuses = ['SETTLEMENT_IN_PROGRESS', 'COMPLETED', 'DROPPED'];
  return lockedStatuses.includes(status.toUpperCase());
}

// 종료 임박 2일 전부터 네이버 실기간 재동기화 후보로 삼는다. 상시(모든 로드마다) 네이버를
// 호출하지 않고, 판매기간 연장/종료 경계에서만 따라가기 위한 여유 창.
export const PERIOD_RESYNC_LEAD_MS = 2 * 24 * 60 * 60 * 1000;
// 종료 후 유예: 이 기간이 지나도록 여전히 활성이면 재동기화(네이버 폴링)를 멈춘다. '오래전 끝났는데
// 마감하지 않은' 캠페인이 매 로드마다 네이버를 호출하는 비용 누수를 막는다 — 그 시점엔 배지가
// 운영자에게 마감/연장 확인을 안내하므로 폴링을 지속할 이유가 없다.
export const PERIOD_RESYNC_STALE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// 판매기간 컷오프 해석(순수 함수)은 ./sale-window로 이관해 라이브 집계(campaigns-handler)·마감
// 스냅샷(closed-campaign-cache)·재동기화 판정(shouldResyncCampaignPeriod)이 같은 SSOT를 공유한다.
// 하위 호환을 위해 mapping-service에서도 재노출한다.
export { parseStoredPeriodEndMs, resolveSaleWindowStartMs, resolveSaleWindowEndMs, isDayBoundaryMs, startOfKstDayMs, endOfKstDayMs, resolveCampaignQueryStartMs, resolveSalesCampaignWindow, formatKstPeriodLabel, parseSalePeriodBounds, isSameKstDay };

/**
 * 활성(미마감) 캠페인의 판매기간을 네이버에서 재동기화할지 판정한다.
 *  - 마감(isActive=false) 캠페인은 기간을 동결한다(소유자 결정 2026-07-12): 네이버 스토어가
 *    계속 열려 있어도 마감된 캠페인의 집계 창을 늘리지 않는다.
 *  - 활성 캠페인은 저장된 종료가 임박/경과했을 때만(=기간 드리프트가 실제로 집계에 영향을 주는
 *    구간) 재동기화 후보로 삼아, 판매 중인 캠페인마다 상시 네이버를 호출하지 않는다.
 *  - 저장 기간이 없으면(null/'기간 미정') 항상 후보(최초 확정 필요).
 */
export function shouldResyncCampaignPeriod(
  camp: { isActive?: boolean | null; endDate?: Date | string | null; salePeriod?: string | null },
  nowMs: number,
): boolean {
  if (!camp.isActive) return false;
  const end = parseStoredPeriodEndMs(camp);
  if (end === null) return true; // 기간 미확정(null/'기간 미정') → 항상 최초 확정 시도
  // 종료 임박(리드) ~ 종료 후 유예(그레이스) 구간에서만 재동기화. 종료가 한참 남았으면 상시 폴링을
  // 피하고, 유예를 지난 오래된 미마감 캠페인은 폴링을 멈춰 비용 누수를 막는다.
  return end <= nowMs + PERIOD_RESYNC_LEAD_MS && end >= nowMs - PERIOD_RESYNC_STALE_GRACE_MS;
}

// 네이버 상품 상태 유추로 만든 판매기간 문자열이 "구체적 기간"인지(미등록/미정 폴백이 아닌지).
// 재동기화 시 실기간이 아닌 폴백값('미등록'·'기간 미정')으로 기존 확정 기간을 되돌리지 않기 위한 게이트.
export function isConcretePeriodString(s: string | null | undefined): boolean {
  return !!s && s.includes('~') && !s.includes('미등록') && !s.includes('미정');
}

/**
 * 주문 수집 데이터를 바탕으로 CampaignDeal 매출 동기화
 */
export async function syncOrderCountToCampaignDeal(
  campaignDealId: string,
  totalOrders: number,
  totalSales: number,
  sellingPrice?: number | null,
): Promise<string | null> {
  const campaignDeal = await prisma.campaignDeal.findUnique({
    where: { id: campaignDealId },
    include: { campaign: true }
  });

  if (!campaignDeal) return null;

  // 락(Lock) 확인: 매출 확정 상태라면 업데이트 안 함
  if (isSalesCampaignLocked(campaignDeal.campaign.status)) {
    console.log(`CampaignDeal ${campaignDealId} is locked due to campaign status: ${campaignDeal.campaign.status}. Ignoring update.`);
    return null;
  }

  await prisma.campaignDeal.update({
    where: { id: campaignDealId },
    data: {
      quantity: totalOrders, // 현재는 덮어쓰기 방식으로 동작
      actualSales: totalSales,
      ...(sellingPrice != null ? { sellingPrice } : {}),
    }
  });
  
  return campaignDeal.campaignId;
}

// [제거됨] syncSalesCampaignPeriod — 스토어(OrderCampaign.salePeriod) → SalesCampaign 기간 덮어쓰기.
//
// 되살리지 말 것(오너 확정 2026-07-15). 판매기간의 정본은 **판매관리(SalesCampaign) 일정**이고 스토어
// 기간은 관측값이다. 이 함수는 정확히 그 반대로, 스토어가 판매중/대기이기만 하면 GET마다 판매캠페인
// 기간을 스토어 값으로 덮어썼다:
//  · 운영자가 판매관리에서 고친 기간이 다음 페이지 로드에 스토어 값으로 되돌아갔다(입력 무력화).
//  · '종료 후 별도 주문건 때문에 임시로 판매를 여는' 운영이 스토어 기간을 늘리면, 그 값이 판매캠페인으로
//    흘러 정산서·정산리포트·구글 캘린더·재구매 집계·대시보드까지 오염됐다(그 전부가 판매캠페인 기간을
//    소비한다).
// 이제 동기화는 판매관리 → 주문캠페인 창(startDate/endDate) 단방향뿐이다(campaigns-handler).

/**
 * 하위 CampaignDeal 들의 주문수와 매출이 업데이트된 후, 
 * 부모 SalesCampaign 의 합계 및 정산/수수료 정보(financials)를 재계산합니다.
 */
export async function recalculateSalesCampaignTotals(campaignId: string) {
  const campaign = await prisma.salesCampaign.findUnique({
    where: { id: campaignId },
    include: { seller: { include: { agency: true } }, campaignDeals: true }
  });
  
  if (!campaign) return;
  if (isSalesCampaignLocked(campaign.status)) return;

  const dealsList = campaign.campaignDeals || [];
  
  const actualSalesSum = dealsList.reduce((sum, cd) => sum + (cd.actualSales ? Number(cd.actualSales) : 0), 0);
  const quantitySum = dealsList.reduce((sum, cd) => sum + (cd.quantity || 0), 0);
  
  const isIndividual = isIndividualSeller({
    sellerTaxType: campaign.sellerTaxType,
    sellerCompanyBusinessNumber: campaign.seller?.agency?.businessNumber ?? null,
  });

  const nextActualSales = actualSalesSum;
  const nextOperatingExpense = Number(campaign.operatingExpense ?? 0);
  const nextMiscExpense = Number(campaign.miscExpense ?? 0);
  const nextTotalMarginRate = Number(campaign.totalMarginRate ?? 0);
  const nextSellerMarginRate = Number(campaign.sellerMarginRate ?? 0);

  const derivedFinancials = calculateDerivedCampaignFinancials({
    actualSales: nextActualSales,
    operatingExpense: nextOperatingExpense,
    miscExpense: nextMiscExpense,
    totalMarginRate: nextTotalMarginRate,
    sellerMarginRate: nextSellerMarginRate,
    sellerTaxType: campaign.sellerTaxType,
    sellerCompanyBusinessNumber: campaign.seller?.agency?.businessNumber ?? null,
    isManualSettlementSales: campaign.isManualSettlementSales,
    isManualSellerExpense: campaign.isManualSellerExpense,
    isManualTaxExpense: campaign.isManualTaxExpense,
    manualSettlementSales: campaign.settlementSales ? Number(campaign.settlementSales) : null,
    manualSellerExpense: campaign.sellerExpense ? Number(campaign.sellerExpense) : null,
    manualTaxExpense: campaign.taxExpense ? Number(campaign.taxExpense) : null,
  });

  let calculatedSellerExpenseSum = 0;
  let calculatedTotalMarginSum = 0;
  let calculatedTaxExpenseSum = 0;

  for (const cd of dealsList) {
    const sRate = cd.sellerMarginRate != null ? Number(cd.sellerMarginRate) : nextSellerMarginRate;
    const tRate = cd.feeRate != null ? Number(cd.feeRate) : nextTotalMarginRate;
    const salesVal = cd.actualSales != null ? Number(cd.actualSales) : 0;
    
    calculatedTotalMarginSum += Math.round(salesVal * (tRate / 100));
    
    const sellerBase = getSellerPayoutBase(salesVal, isIndividual);
    const preTaxPayout = Math.round(sellerBase * (sRate / 100));
    
    if (isIndividual) {
      const tax = calcIndividualIncomeTax(preTaxPayout);
      calculatedTaxExpenseSum += tax;
      calculatedSellerExpenseSum += preTaxPayout;
    } else {
      calculatedSellerExpenseSum += preTaxPayout;
    }
  }

  if (!campaign.isManualSettlementSales) derivedFinancials.settlementSales = calculatedTotalMarginSum;
  if (!campaign.isManualSellerExpense) derivedFinancials.sellerExpense = calculatedSellerExpenseSum;

  const netCommission = derivedFinancials.settlementSales - derivedFinancials.sellerExpense;

  if (!campaign.isManualTaxExpense) {
    derivedFinancials.taxExpense = isIndividual 
      ? calculatedTaxExpenseSum + Math.round(derivedFinancials.settlementSales - (derivedFinancials.settlementSales / 1.1)) 
      : Math.round(netCommission - (netCommission / 1.1));
  }

  derivedFinancials.operatingProfit = 
    nextActualSales - derivedFinancials.sellerExpense - derivedFinancials.taxExpense - nextOperatingExpense - nextMiscExpense;

  await prisma.salesCampaign.update({
    where: { id: campaignId },
    data: {
      actualSales: nextActualSales,
      quantity: quantitySum,
      itemCount: dealsList.length,
      settlementSales: derivedFinancials.settlementSales,
      sellerExpense: derivedFinancials.sellerExpense,
      taxExpense: derivedFinancials.taxExpense,
      operatingProfit: derivedFinancials.operatingProfit,
    }
  });
}
