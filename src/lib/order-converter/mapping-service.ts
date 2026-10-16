import { prisma } from '@/lib/order-converter/prisma';
import fs from 'fs';
import path from 'path';
import {
  calculateDerivedCampaignFinancials,
  computeOperatingProfit,
  computeVatExpense,
  resolveSellerFee,
  resolveSellerFeeBasisEligibility,
} from '@/lib/campaign-financials';
import { isIndividualSeller, getSellerPayoutBase, calcIndividualIncomeTax } from '@/lib/seller-tax-utils';
import { getDisplayDealName } from '@/lib/deal-display';
import { countDistinctSellerIds, isCrossSellerSet, CROSS_SELLER_REJECT_MESSAGE } from '@/lib/cross-seller';
// 순수 유사도 함수는 클라이언트 번들 안전한 similarity.ts로 이전.
// 로컬 사용 + 기존 import 경로 보존을 위해 import 후 재수출.
import { computeSimilarityScore, extractSupplyMonths, computeSellerScore, scoreDealCandidate } from './similarity';
import { parseStoredPeriodEndMs, isSalesCampaignLocked, isCampaignPeriodFrozen, resolveSaleWindowStartMs, resolveSaleWindowEndMs, isDayBoundaryMs, startOfKstDayMs, endOfKstDayMs, resolveCampaignQueryStartMs, resolveSalesCampaignWindow, formatKstPeriodLabel, formatKstDateLabel, formatKstYmd, parseSalePeriodBounds, isSameKstDay, resolveStorePeriodDrift, buildStorePeriodPatchBody, STORE_PERIOD_TRUSTED_STATUS } from './sale-window';
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

  // 딜(CampaignDeal) → 소속 판매캠페인·셀러. 후보 창 밖(3개월 이전 시작) 딜은 아래 3.2 에서 DB 로 보충한다.
  type DealOwner = { salesCampaignId: string; sellerId: string | null | undefined; orderCampaignId: string | null };
  const ownerByDealId = new Map<string, DealOwner>();
  for (const sc of candidateSalesCamps) {
    for (const cd of sc.campaignDeals) {
      ownerByDealId.set(cd.id, { salesCampaignId: sc.id, sellerId: sc.sellerId, orderCampaignId: sc.orderCampaignId });
    }
  }

  // 승자 후보에서 **다른 주문캠페인에 이미 붙은 판매캠페인**을 뺀다(T-260). 같은 셀러·같은 상품으로
  // 회차를 다시 돌리면 새 회차 판매캠페인이 최근 3개월 창에 들어와 옛 주문캠페인의 옵션과 점수가 높게
  // 겹친다. 종전에는 그 딜이 승자가 되어, 옛 주문캠페인을 화면에서 저장하기만 해도 ①매핑의 딜 선택이
  // 새 회차 딜로 덮이고 ②새 회차 판매캠페인이 새 주문캠페인에서 떨어져 옛 주문캠페인으로 넘어왔다 —
  // 두 주문캠페인의 매출 상세가 함께 깨진다. 다른 주문캠페인으로 옮기는 일은 운영자가 화면에서 그 딜을
  // 직접 골라 저장할 때(PUT)만 한다. ownerByDealId 에는 그대로 남긴다 — 아래 3.2 의 유지분 판정이 쓴다.
  // ⛔ 이 제외를 후보 조회(where)로 옮기지 말 것 — 유지분 판정용 소유 정보까지 함께 사라진다.
  const isOwnedElsewhere = (salesCampOrderCampaignId: string | null | undefined) =>
    salesCampOrderCampaignId != null && salesCampOrderCampaignId !== orderCamp.id;
  const scoringSalesCamps = candidateSalesCamps.filter((sc) => !isOwnedElsewhere(sc.orderCampaignId));
  if (scoringSalesCamps.length !== candidateSalesCamps.length) {
    log(`Excluded ${candidateSalesCamps.length - scoringSalesCamps.length} candidate SalesCampaign(s) already linked to another OrderCampaign.`);
  }

  // 결정과 쓰기를 분리한다 — 셀러 단일성 게이트(아래 3.5)가 "전체 거부"이려면 검사 시점에
  // 아직 아무것도 쓰여 있지 않아야 한다. 종전에는 루프 안에서 곧바로 update 를 날려, 거부
  // 판정을 넣더라도 이미 절반이 반영된 상태가 됐을 것이다.
  const pendingLinks: { mappingId: string; dealId: string }[] = [];

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

    for (const salesCamp of scoringSalesCamps) {
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
    } else {
      log(` => No valid match found for Option "${mapping.optionName}"`);
    }
  }

  // 3.2 최종 딜 연결 = 옵션별 승자 ?? 이미 저장된 연결(운영자가 화면에서 고른 것 포함).
  //
  // 판매캠페인 연결(SalesCampaign.orderCampaignId)은 이 최종 연결에서 유도한다 — 수동 저장 라우트
  // (PUT /campaigns/[id])와 같은 규칙이다. 종전에는 "이번 실행의 승자"만 남기고 나머지를 전부 풀었는데,
  // 승자 후보가 최근 3개월 시작분뿐이라 오래된 주문캠페인을 화면에서 저장하면 PUT 이 막 붙인 연결을
  // 이 함수(저장 직후 백그라운드 실행)가 곧바로 전부 떼었다(T-258). 연결이 풀린 판매캠페인은 일별 주문
  // 집계·매출 상세·주문 등록 표시에서 빠진다. 승자가 없는 옵션의 기존 연결도 같은 이유로 지킨다.
  // ⛔ 연결 해제 기준을 다시 "이번 승자 집합"으로 되돌리지 말 것 — 후보 창(3개월)이 곧 해제 기준이 된다.
  const winnerByMappingId = new Map(pendingLinks.map((l) => [l.mappingId, l.dealId]));
  const finalDealIds = Array.from(
    new Set(
      orderCamp.mappings
        .map((m) => winnerByMappingId.get(m.id) ?? m.campaignDealId)
        .filter((dealId): dealId is string => !!dealId),
    ),
  );
  const outsideWindowDealIds = finalDealIds.filter((dealId) => !ownerByDealId.has(dealId));
  if (outsideWindowDealIds.length > 0) {
    const rows = await prisma.campaignDeal.findMany({
      where: { id: { in: outsideWindowDealIds } },
      select: { id: true, campaignId: true, campaign: { select: { sellerId: true, orderCampaignId: true } } },
    });
    for (const row of rows) {
      ownerByDealId.set(row.id, {
        salesCampaignId: row.campaignId,
        sellerId: row.campaign?.sellerId,
        orderCampaignId: row.campaign?.orderCampaignId ?? null,
      });
    }
    log(`Resolved ${rows.length} existing deal link(s) outside the 3-month candidate window.`);
  }
  // 유지분(이번 승자가 아닌 기존 연결)은 판매캠페인이 이미 **다른** 주문캠페인에 붙어 있으면 가져오지 않는다.
  // 낡은 딜 연결이 자동 연결이 돌 때마다 연결을 되찾아, 두 주문캠페인 사이에서 판매캠페인이 오가는 것을 막는다.
  // 다른 주문캠페인으로 옮기는 것은 운영자의 화면 저장(PUT)만 한다 — 승자 후보에서 이미 뺐으므로(위
  // scoringSalesCamps) 승자가 다른 주문캠페인 소속인 경우는 없다. 아래 `!winnerDealIds.has` 는 그 불변식의 방어선이다.
  const winnerDealIds = new Set(pendingLinks.map((l) => l.dealId));
  const finalOwners: DealOwner[] = [];
  for (const dealId of finalDealIds) {
    const owner = ownerByDealId.get(dealId);
    if (!owner) continue;
    if (isOwnedElsewhere(owner.orderCampaignId) && !winnerDealIds.has(dealId)) {
      log(`    Skip kept link CampaignDeal(${dealId}): SalesCampaign(${owner.salesCampaignId}) belongs to another OrderCampaign.`);
      continue;
    }
    finalOwners.push(owner);
  }
  const linkedSalesCampaignIds = Array.from(new Set(finalOwners.map((owner) => owner.salesCampaignId)));
  const finalSellerIds = finalOwners.map((owner) => owner.sellerId);

  // 3.5 셀러 단일성 게이트 — 최종 딜 연결(옵션별 승자 + 유지되는 기존 연결)이 서로 다른 셀러를
  // 가리키면 **전체 거부**한다. 유지분까지 보는 이유: 승자가 셀러 A 인데 다른 옵션의 기존 연결이
  // 셀러 B 면, 위 3.2 대로 둘 다 붙이는 순간 한 주문캠페인에 두 셀러가 생긴다.
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
  if (isCrossSellerSet(finalSellerIds)) {
    const sellerCount = countDistinctSellerIds(finalSellerIds);
    log(`\n⛔ REJECTED: 최종 딜 연결이 서로 다른 셀러 ${sellerCount}곳을 가리킵니다. 전체 거부(쓰기 0건).`);
    log(`   ${CROSS_SELLER_REJECT_MESSAGE}`);
    log(`\n=== [AUTO-MAP DEBUG] Finished (rejected). ===\n`);
    appendMappingDebugLog(debugLines);
    // fire-and-forget 호출부(캠페인 생성·수정 라우트)는 예외를 삼키므로, 오너가 볼 수 있는
    // 서버 로그에도 남긴다 — 포털 게이트의 warnCrossSellerCampaigns 와 같은 계열이다.
    // ⚠️ 셀러 실명·캠페인명을 싣지 않는다(P0, 레포 public) — 식별자만.
    console.warn(
      `[auto-map] OrderCampaign(${orderCamp.id}) 자동 매핑을 전체 거부했습니다: ` +
        `최종 딜 연결이 서로 다른 셀러 ${sellerCount}곳을 가리킵니다. ${CROSS_SELLER_REJECT_MESSAGE}`,
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

  // 4. SalesCampaign에 orderCampaignId 연동 (1:N 처리) — 기준은 3.2 의 최종 딜 연결이다.
  log(`\nSyncing OrderCampaign to SalesCampaigns...`);

  // 이 주문캠페인에 묶여 있었으나 최종 딜 연결 어디에도 없는 판매캠페인만 연결 해제
  await prisma.salesCampaign.updateMany({
    where: {
      orderCampaignId: orderCamp.id,
      ...(linkedSalesCampaignIds.length > 0 && { id: { notIn: linkedSalesCampaignIds } })
    },
    data: { orderCampaignId: null }
  });

  if (linkedSalesCampaignIds.length > 0) {
    await prisma.salesCampaign.updateMany({
      where: { id: { in: linkedSalesCampaignIds } },
      data: { orderCampaignId: orderCamp.id }
    });
    log(`Updated ${linkedSalesCampaignIds.length} SalesCampaigns with orderCampaignId.`);
  }

  log(`\n=== [AUTO-MAP DEBUG] Finished. ===\n`);
  appendMappingDebugLog(debugLines);

  // 반환값: 연결된 SalesCampaign 배열
  return prisma.salesCampaign.findMany({
    where: { id: { in: linkedSalesCampaignIds } },
    include: { seller: true, deal: true }
  });
}

// 종료 임박 2일 전부터 네이버 실기간 재동기화 후보로 삼는다. 상시(모든 로드마다) 네이버를
// 호출하지 않고, 판매기간 연장/종료 경계에서만 따라가기 위한 여유 창.
export const PERIOD_RESYNC_LEAD_MS = 2 * 24 * 60 * 60 * 1000;
// 종료 후 유예: 이 기간이 지나도록 여전히 활성이면 재동기화(네이버 폴링)를 멈춘다. '오래전 끝났는데
// 마감하지 않은' 캠페인이 매 로드마다 네이버를 호출하는 비용 누수를 막는다 — 그 시점엔 배지가
// 운영자에게 마감/연장 확인을 안내하므로 폴링을 지속할 이유가 없다.
export const PERIOD_RESYNC_STALE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
// 종료가 아직 먼 구간(= 위 리드 창 밖)의 재확인 간격. 오너 결정 2026-09-17: "몇 시간에 한 번 +
// 종료 무렵엔 지금처럼". 종전에는 이 구간에서 스토어를 **아예** 묻지 않아, 2주짜리 캠페인
// 3일차에 스토어에서 기간을 바꾸면 종료 이틀 전이 될 때까지 그 사실 자체를 몰랐다.
// ⛔ 이 구간을 '매 로드'로 되돌리지 말 것 — 스토어 조회는 대시보드 GET 안에서 동기 await 되고
// (P7 실측 avg 751ms = GET 평균의 약 43%) 프록시 요청 수도 화면을 여는 만큼 는다.
// ⚠️ 이 상수만으로는 **캠페인당** 상한이지 전체 상한이 아니다 — 캠페인마다 만기 시각이 어긋나면
// 호출이 그만큼 흩어진다. 전체 상한이 되는 것은 호출부가 **한 회차에 유휴 구간 전원을 함께 찍어**
// 위상을 모으기 때문이다(campaigns-handler). 그 짝을 떼면 이 주석의 전제가 깨진다.
export const PERIOD_RESYNC_IDLE_INTERVAL_MS = 4 * 60 * 60 * 1000;
// 종료 임박~경과 구간(리드 2일 안 ~ 그레이스 7일 안)의 재확인 간격. 오너 결정 2026-09-28 —
// 종전 "매 조회"(60초 TTL 만이 상한)는 화면 사용이 몰린 날 하루에 월 프록시 한도의 상당 비중을 소진(ProxyRequestDaily 실측, 수치는 로컬 핸드오프).
// 30분이면 화면을 쓰는 시간에만 발생해 하루 ≤48건이고, 스토어 기간 변경 반영 지연은 최대 30분 —
// 집계 경계가 걸리는 구간이라 유휴(4시간)보다는 촘촘하되 매 GET 은 아니다.
// ⚠️ 이 상수도 위 유휴 간격과 같은 전제를 진다 — 캠페인당 상한이며, 전체 상한이 되는 것은 호출부가
// 만기 회차에 간격 구간 전원을 함께 찍어 위상을 모으기 때문이다(campaigns-handler).
export const PERIOD_RESYNC_NEAR_END_INTERVAL_MS = 30 * 60 * 1000;

// 판매기간 컷오프 해석(순수 함수)은 ./sale-window로 이관해 라이브 집계(campaigns-handler)·마감
// 스냅샷(closed-campaign-cache)·재동기화 판정(shouldResyncCampaignPeriod)이 같은 SSOT를 공유한다.
// 하위 호환을 위해 mapping-service에서도 재노출한다.
export { parseStoredPeriodEndMs, isSalesCampaignLocked, isCampaignPeriodFrozen, resolveSaleWindowStartMs, resolveSaleWindowEndMs, isDayBoundaryMs, startOfKstDayMs, endOfKstDayMs, resolveCampaignQueryStartMs, resolveSalesCampaignWindow, formatKstPeriodLabel, formatKstDateLabel, formatKstYmd, parseSalePeriodBounds, isSameKstDay, resolveStorePeriodDrift, buildStorePeriodPatchBody, STORE_PERIOD_TRUSTED_STATUS };
export type { StorePeriodDrift } from './sale-window';

/** 재동기화 판정·확인 시각 기록이 공유하는 캠페인 최소 형태. */
type PeriodResyncCampaign = {
  isActive?: boolean | null;
  endDate?: Date | string | null;
  salePeriod?: string | null;
  periodCheckedAt?: Date | string | null;
};

/**
 * 재동기화 구간 분류 — **리드·그레이스 경계를 아는 유일한 자리**다.
 *
 * 아래 두 공개 판정이 이걸 공유한다. 각자 `!isActive → parseStoredPeriodEndMs → 리드 비교`를
 * 다시 쓰면 리드 창을 옮길 때 한쪽만 고쳐져 **찍는 구간과 읽는 구간이 어긋난다**(그러면 간격
 * 구간 캠페인이 영영 안 찍혀 매 GET 조회되거나, 판정이 읽지 않는 구간에서 쓰기만 는다).
 *
 * - `frozen` 마감 캠페인(기간 동결, 오너 2026-07-12)
 * - `unset` 기간 미확정 — 최초 확정이 필요해 간격을 보지 않는다
 * - `near-end` 종료 임박~경과 — 집계 경계가 걸리는 구간이라 짧은 간격(30분)으로 본다
 * - `idle` 종료가 아직 먼 구간 — 유휴 간격(4시간)으로 본다
 * - `stale` 그레이스를 지난 오래된 미마감 — 폴링을 멈춘다
 *
 * `near-end`·`idle` 둘이 `periodCheckedAt` 을 읽는 **간격 구간**이다(간격만 다르다).
 */
type PeriodResyncRegime = 'frozen' | 'unset' | 'near-end' | 'idle' | 'stale';

function classifyPeriodResyncRegime(camp: PeriodResyncCampaign, nowMs: number): PeriodResyncRegime {
  if (!camp.isActive) return 'frozen';
  const end = parseStoredPeriodEndMs(camp);
  if (end === null) return 'unset';
  if (end < nowMs - PERIOD_RESYNC_STALE_GRACE_MS) return 'stale';
  if (end <= nowMs + PERIOD_RESYNC_LEAD_MS) return 'near-end';
  return 'idle';
}

/**
 * 이 캠페인의 재동기화 판정이 **확인 간격**(`periodCheckedAt`)에 걸리는 구간인가 — 유휴(4시간)·
 * 임박(30분) 둘이 해당한다.
 *
 * 구간을 따로 물어보는 이유는 **확인 시각을 찍는 비용** 때문이다 — 기간 미확정(`unset`) 구간은
 * 시각과 무관하게 항상 후보라 `periodCheckedAt` 을 읽지 않는데, 거기서도 매번 찍으면 대시보드
 * GET 마다 캠페인 수만큼 쓰기가 나간다(P7 egress 규율). 판정이 실제로 그 값을 읽는 구간에서만 찍는다.
 * (종전에는 임박 구간도 "항상 후보"라 여기서 빠졌다 — 오너 결정 2026-09-28 로 임박이 간격 구간이
 * 되면서 들어왔다. 찍지 않으면 임박 판정이 매번 fail-open 으로 참이 되어 종전 "매 조회"와 같아진다.)
 */
export function usesPeriodCheckInterval(camp: PeriodResyncCampaign, nowMs: number): boolean {
  const regime = classifyPeriodResyncRegime(camp, nowMs);
  return regime === 'idle' || regime === 'near-end';
}

/**
 * **간격 구간이면서 간격이 지났는가** — 즉 이번 회차의 스토어 조회를 이 캠페인이 불렀는가.
 *
 * 호출부가 `usesPeriodCheckInterval(…) && shouldResyncCampaignPeriod(…)` 로 손수 합성하면
 * 두 판정의 결합 방식이 표면마다 갈린다(이 모듈이 구간 분류를 한 곳으로 모은 것과 같은 이유).
 * 소비처는 확인 시각 **위상 모으기** 하나다(`campaigns-handler`).
 */
export function isPeriodResyncDue(camp: PeriodResyncCampaign, nowMs: number): boolean {
  return usesPeriodCheckInterval(camp, nowMs) && shouldResyncCampaignPeriod(camp, nowMs);
}

/**
 * 활성(미마감) 캠페인의 판매기간을 네이버에서 재동기화할지 판정한다.
 *  - 마감(isActive=false) 캠페인은 기간을 동결한다(소유자 결정 2026-07-12): 네이버 스토어가
 *    계속 열려 있어도 마감된 캠페인의 집계 창을 늘리지 않는다.
 *  - 저장 기간이 없으면(null/'기간 미정') 항상 후보(최초 확정 필요).
 *  - 종료 임박(리드 2일)~경과 구간은 `PERIOD_RESYNC_NEAR_END_INTERVAL_MS`(30분)에 1회(오너 결정
 *    2026-09-28) — 기간 드리프트가 집계 경계에 바로 걸리는 구간이라 유휴보다 촘촘하되, 종전
 *    "매 조회"는 화면 사용이 몰린 날 프록시 한도를 갉아 물렸다(2026-09-28 실측).
 *  - 종료가 아직 먼 구간은 `PERIOD_RESYNC_IDLE_INTERVAL_MS`(4시간)에 1회만(오너 결정 2026-09-17).
 *    ⛔ 이 갈래를 지우지 말 것 — 없애면 캠페인 중반의 기간 연장·단축을 종료 이틀 전까지 못 본다.
 *  - 유예(그레이스 7일)를 지난 오래된 미마감 캠페인은 폴링을 멈춘다(비용 누수 차단). 그 시점엔
 *    배지가 운영자에게 마감/연장 확인을 안내하므로 계속 물을 이유가 없다.
 */
export function shouldResyncCampaignPeriod(camp: PeriodResyncCampaign, nowMs: number): boolean {
  switch (classifyPeriodResyncRegime(camp, nowMs)) {
    case 'frozen':
    case 'stale':
      return false;
    case 'unset':
      return true;
    case 'near-end':
      return isPeriodCheckIntervalElapsed(camp, nowMs, PERIOD_RESYNC_NEAR_END_INTERVAL_MS);
    case 'idle':
      return isPeriodCheckIntervalElapsed(camp, nowMs, PERIOD_RESYNC_IDLE_INTERVAL_MS);
  }
}

/** 마지막 확인(`periodCheckedAt`)으로부터 `intervalMs` 가 지났는가 — 간격 구간 둘이 공유한다. */
function isPeriodCheckIntervalElapsed(camp: PeriodResyncCampaign, nowMs: number, intervalMs: number): boolean {
  const checkedAtMs = camp.periodCheckedAt ? new Date(camp.periodCheckedAt).getTime() : Number.NaN;
  // 확인 기록이 없거나 읽을 수 없으면 묻는다 — "모르면 건너뛴다"로 기울면 신규·레거시
  // 캠페인이 영영 조회되지 않는다(이 레포가 반복해서 데인 fail-open/closed 방향 선택).
  if (!Number.isFinite(checkedAtMs)) return true;
  return nowMs - checkedAtMs >= intervalMs;
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

  const manualSellerExpense = campaign.sellerExpense != null ? Number(campaign.sellerExpense) : null;
  // 수동 정산 기준액 — 주문 동기화는 매출만 갱신하고 **운영자가 정한 기준액은 덮지 않는다**.
  const sellerFeeBasisOverride =
    campaign.sellerFeeBasisOverride != null ? Number(campaign.sellerFeeBasisOverride) : null;

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
    // `!= null` 로 판정한다 — 종전 truthy 검사는 수동 0원을 null 로 접어 자동값으로 덮었다.
    manualSettlementSales: campaign.settlementSales != null ? Number(campaign.settlementSales) : null,
    manualSellerExpense: manualSellerExpense,
    manualTaxExpense: campaign.taxExpense != null ? Number(campaign.taxExpense) : null,
    sellerFeeBasisOverride,
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
  // 판매대행비·원천세의 수동 층(수동 판매대행비 > 수동 기준액 > 자동)은 `resolveSellerFee`
  // 한 곳이 정한다 — 편집 PATCH(campaignService)와 같은 함수다.
  const basisEligibility = resolveSellerFeeBasisEligibility({
    deals: dealsList,
    campaignSellerMarginRate: nextSellerMarginRate,
  });
  const fee = resolveSellerFee({
    autoSellerExpense: calculatedSellerExpenseSum,
    autoWithholdingSum: calculatedTaxExpenseSum,
    sellerFeeBasisOverride,
    overrideSellerRate: basisEligibility.eligible ? basisEligibility.sellerRate : null,
    isManualSellerExpense: Boolean(campaign.isManualSellerExpense),
    manualSellerExpense,
  });
  derivedFinancials.sellerExpense = fee.sellerExpense;

  if (!campaign.isManualTaxExpense) {
    // 공제세액 = 부가세뿐 — 개인 셀러 원천세는 셀러 몫이라 넣지 않는다(오너 확정 2026-10-16).
    derivedFinancials.taxExpense = computeVatExpense({
      isIndividual,
      settlementSales: derivedFinancials.settlementSales,
      sellerExpense: derivedFinancials.sellerExpense,
    });
  }

  // 손익은 **영업수익 기준** SSOT 로만 낸다(오너 확정 2026-10-05). 종전 이 자리는
  // 피감수가 총매출(`nextActualSales`)이라 편집 경로와 같은 캠페인에 다른 값을 저장했다.
  derivedFinancials.operatingProfit = computeOperatingProfit({
    settlementSales: derivedFinancials.settlementSales,
    sellerExpense: derivedFinancials.sellerExpense,
    taxExpense: derivedFinancials.taxExpense,
    operatingExpense: nextOperatingExpense,
    miscExpense: nextMiscExpense,
  });

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
