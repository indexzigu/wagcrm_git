import { NextRequest, NextResponse, after } from 'next/server';
import { prisma } from '@/lib/order-converter/prisma';
import { searchNaverProducts } from '@/lib/order-converter/naver-commerce-api';
import { autoMapOrderCampaign, syncOrderCountToCampaignDeal, recalculateSalesCampaignTotals, shouldResyncCampaignPeriod, isConcretePeriodString, isSalesCampaignLocked, resolveSaleWindowStartMs, resolveSaleWindowEndMs, resolveCampaignQueryStartMs, resolveSalesCampaignWindow, formatKstPeriodLabel } from '@/lib/order-converter/mapping-service';
import { resolveSalesReportOptionLabel } from '@/lib/order-converter/sales-report-options';
import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';
import { runSync, isSnapshotStale, toDateKeyKst, sweepDeliveringOrders } from '@/lib/order-converter/naver-order-sync';
import { isDemoMode } from '@/lib/demo-mode';
import { createInsightAccumulator, trackOrderInsight, trackClaimInsight, buildCampaignInsights } from '@/lib/order-converter/campaign-insights';
import { INVALID_ORDER_STATUSES, resolveOrderCountKey } from '@/lib/order-converter/group-orders';
import { isSupplementProduct } from '@/lib/order-converter/product-class';
import { deriveOrderPipelineBucket } from '@/lib/order-converter/order-fulfillment';
import { resolveLiveWindowKeys } from '@/lib/order-converter/daily-aggregate';
import { orderMatchesCampaignProductId, orderBelongsToPeerCampaign, findSharedLinkWindowConflicts, type PeerCampaignWindow } from '@/lib/order-converter/campaign-match';
import { pickBestMapping, evaluateMappingMatch, normalizeMatchText } from '@/lib/order-converter/mapping-match';
import { shouldSkipDealPush } from '@/lib/order-converter/sales-push';
import { orderFulfillmentRepository } from '@/repositories/orderFulfillmentRepository';
import { resolveOrderBrand } from '@/lib/order-converter/order-brand';
import { sortProductMappingsByProductName } from '@/lib/order-converter/product-mapping-sort';

// 파이프라인 지연 경고 임계값(결제/주문 후 경과일). 카드 라벨의 지연 경고 배지와
// 팝오버 드릴다운(경고 건만 노출)이 이 단일 기준을 공유한다 — 한쪽만 바뀌어 카드/팝오버가
// 어긋나지 않도록 상수화. 배송대기=2일(발주요청 후 송장 독촉), 배송중=5일(배송 지연 점검).
const PENDING_DELAY_WARN_DAYS = 2;
const SHIPPING_DELAY_WARN_DAYS = 5;
// 주문확인됐지만 발주요청·송장 전(newAfter)에서 결제 후 이 일수 이상 묵으면 경고(오너 확정 2026-07-12).
const CONFIRM_DELAY_WARN_DAYS = 2;

// 추가옵션(추가구성상품)의 딜(campaignDealId) 귀속용: 옵션명만으로 매핑을 찾는다.
// 메인 집계는 상품명+옵션명을 함께 보지만, 추가옵션은 productName이 애드온 자체명("아이보리")이라
// 상품명 매칭이 항상 실패한다. 반면 productOption("[VA-998] 파우치: 아이보리")은 매핑 optionName과
// 그대로 일치하므로, 옵션명 단독 매칭으로 해당 매핑의 딜을 찾아 판매캠페인 수량·매출에 반영한다.
function findMappingByOptionName(oName: string, mappings: any[]): any | null {
  const normOName = normalizeMatchText(oName);
  if (!normOName) return null;
  let bestMapping: any = null;
  let highestScore = -1;
  for (const m of mappings) {
    if (!m.optionName) continue;
    // 매칭 판정은 mapping-match SSOT(옵션 잡음제거 폴백 포함, 옵션 단독 축).
    const { optionMatches, score } = evaluateMappingMatch({ optionName: m.optionName }, '', oName);
    if (!optionMatches) continue;
    // 동점이면 정확 포함(substring)을 우선하도록 가중 — 기존 tie-break 보존.
    const normMOpt = normalizeMatchText(m.optionName);
    const exactIncludes = normOName.includes(normMOpt) || normMOpt.includes(normOName);
    const s = score + (exactIncludes ? 1 : 0);
    if (s > highestScore) { highestScore = s; bestMapping = m; }
  }
  return bestMapping;
}

// B1-2: 이 GET은 read-only다. 네이버 API를 절대 동기 대기하지 않는다.
// 동기화는 runSync()로 분리되어 (a) stale 날짜가 있으면 응답 후 백그라운드로 트리거되거나
// (b) 스냅샷이 전무한 최초 조회에서만 1회 부트스트랩으로 await된다.
export async function GET(request: NextRequest) {
  // isForceRefresh 파라미터는 더 이상 동기 재조회를 유발하지 않는다 (하위호환을 위해 파싱은 유지).
  void request.nextUrl.searchParams.get('forceRefresh');
  return await fetchAndSyncCampaigns(false);
}

// 매출전송(push) 결과 수집기 — handler가 채우고 push-sales 라우트가 읽어 운영자에게 보고한다.
// 매칭 0건 딜은 조용히 0으로 덮어쓰지 않고 여기 기록해 "미매칭"으로 표면화한다(P0: 실패를 삼키지 말 것).
export type SalesPushOutcome = {
  pushedDealIds: string[];    // 매칭 주문이 있어 실제 반영된 딜
  unmatchedDealIds: string[]; // 딜은 연결됐으나 판매기간 내 매칭 주문 0건 → 덮어쓰기 스킵(기존값 보존)
};

type FetchAndSyncCampaignsOptions = {
  salesPushOrderCampaignId?: string;
  awaitSalesPush?: boolean;
  salesPushOutcome?: SalesPushOutcome;
};

type CampaignDealStat = {
  orders: number;   // 유효주문 라인 수(INVALID_ORDER_STATUSES 제외) — quantity/revenue의 근거
  quantity: number;
  revenue: number;
  sellingPrice: number | null;
  // 상태 무관 매칭 라인 수(취소·반품 포함). "매핑 미스매치로 0"과 "전부 취소돼 유효 0"을 구분하는 신호.
  // matchedLines>0 && orders===0 = 매핑은 맞았고 실매출이 0이 된 것(→ 0으로 반영해야 정산 합계가 최신).
  matchedLines: number;
};

// 시그니처는 route.ts 밖(POST, [id]/route.ts 등)에서 재사용 중이라 유지한다.
// 인자(isForceRefresh)는 더 이상 동기 fetch를 유발하지 않으므로 무시된다.
export async function fetchAndSyncCampaigns(isForceRefresh: boolean, options: FetchAndSyncCampaignsOptions = {}) {
  void isForceRefresh;
  try {
    const rawCampaigns = await prisma.orderCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        tasks: {
          orderBy: { date: 'desc' },
          take: 5 // 최근 5일치 태스크만 반환
        },
        mappings: true, // 캠페인 설정(매핑) 정보도 함께 로드
        // 이 핸들러는 salesCampaigns의 startDate/endDate만 읽는다(딜별 통계는 mappings의
        // campaignDealId로 별도 조회) — campaignDeals→deal 3단 nested include는 매 폴링마다
        // 전 캠페인의 딜 레코드를 통째로 DB 풀러 egress로 실어 나르기만 하고 어디서도 안 읽혀
        // 제거한다(Supabase Shared Pooler Egress 176% 초과의 주 원인, 실측 캠페인당 30KB).
        // id·sellerId는 이 응답의 다른 소비자인 셀러 포털 리포트(seller-portal-report.tsx)가
        // "이 셀러 소속 캠페인" 필터와 콘텐츠 성과 조회에 쓴다 — 빼면 전 셀러 포털이 빈 화면이
        // 된다(#137 egress 정리 시 누락된 회귀). status는 집계 창 동결 판정(isSalesCampaignLocked —
        // 정산 시작 이후엔 창을 얼린다)에 쓴다 — 빼면 sc.status=undefined라 락이 전부 false로 읽혀
        // 정산 중인 캠페인의 창까지 움직인다. startDate/endDate는 창 정본(판매관리)의 원천이다.
        // 넷 다 스칼라라 egress 영향은 무시 가능하다.
        salesCampaigns: {
          select: { id: true, sellerId: true, status: true, startDate: true, endDate: true }
        }
      }
    });

    // 백필(카테고리/판매기간/상품상태 null 복구) + 활성 캠페인 판매기간 재동기화.
    //  · firstFill: 값이 null인 기존 데이터 최초 확정(기존 동작).
    //  · resync: 활성(미마감) 캠페인은 네이버 실기간을 계속 따라간다. 판매기간이 연장돼도 반영되게 —
    //    과거에는 salePeriod가 한번 채워지면 다시 동기화되지 않아 연장이 영영 미반영됐다(58 vs 발주 78 사고).
    //    마감(isActive=false) 캠페인은 shouldResyncCampaignPeriod가 false를 반환해 기간을 동결한다(소유자 결정).
    const nowMs = Date.now();
    const needsFirstFill = (c: any) => !c.category || !c.salePeriod || !c.productStatus;
    const needsResync = (c: any) => shouldResyncCampaignPeriod(c, nowMs);
    // 데모 배포: 네이버 자격증명이 없고 시드가 category/salePeriod/productStatus를 채워 두므로
    // 스토어 조회를 아예 시도하지 않는다(매 GET마다 실패 경고가 쌓이는 것 방지).
    const needsNaver = !isDemoMode() && rawCampaigns.some((c: any) => needsFirstFill(c) || needsResync(c));
    let naverProducts: any[] = [];
    if (needsNaver) {
      try {
        const prodData = await searchNaverProducts();
        naverProducts = prodData.contents || [];
      } catch (err) {
        console.warn('Failed to fetch naver products for period sync:', err);
      }
    }

    const backfilledCampaigns = [];
    for (const rawCamp of rawCampaigns) {
      const camp = rawCamp as any;
      const firstFill = needsFirstFill(camp);
      const resync = needsResync(camp);
      if (firstFill || resync) {
        // 스토어 상품 매칭은 productId(원상품/채널 어느 쪽이든)가 1순위 — 캠페인 productId는 네이버
        // 원상품번호로 저장되고 채널상품번호와 다르므로 둘 다 비교한다(campaign-match.ts와 같은 신뢰키, PR#106).
        // 과거 여기서 이름 부분일치(정규화 없는 raw includes)만 썼더니, 캠페인명에 공백이 둘 들어간 것만으로도
        // 매칭이 실패해 startDate/endDate가 영영 null로 남았다(2026-07-15 실사고). 이름은 정규화 후 폴백으로만 쓴다.
        const normName = (s: string) => (s || '').replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();
        const campNameNorm = normName(camp.name);
        const prodNameOf = (p: any) => p.channelProducts?.[0]?.name || p.name || '';
        const hasChannel = (p: any) => !!p.channelProducts?.[0];

        const matchedById = camp.productId
          ? naverProducts.find((p: any) => {
              if (!hasChannel(p)) return false;
              const pid = String(camp.productId);
              return String(p.originProductNo ?? '') === pid
                || p.channelProducts.some((cp: any) => String(cp.channelProductNo ?? '') === pid);
            })
          : undefined;

        const matchedProd = matchedById ?? naverProducts.find((p: any) => {
          if (!hasChannel(p)) return false;
          const prodNorm = normName(prodNameOf(p));
          if (!prodNorm || !campNameNorm) return false;
          return campNameNorm.includes(prodNorm) || prodNorm.includes(campNameNorm);
        });

        if (matchedProd) {
          const cp = matchedProd.channelProducts[0];
          const categoryName = cp.wholeCategoryName?.split('>').pop() || matchedProd.originProduct?.category?.name || matchedProd.category?.name || '카테고리 미지정';
          
          const formatDt = (dtStr: string) => dtStr ? dtStr.split('T')[0].replace(/-/g, '.') : '';
          let dateStr = '기간 미정';
          // 스토어 API 실판매기간(정밀 시각)을 startDate/endDate에 영속하기 위한 후보 — 구체 기간일 때만 채운다.
          // 집계 컷오프(resolveSaleWindowEndMs)가 이 정밀 종료시각을 권위 소스로 존중한다(오너 지시 2026-07-14).
          let preciseStart: Date | null = null;
          let preciseEnd: Date | null = null;
          const status = cp.statusType || 'WAIT';
          if (cp.saleStartDate && cp.saleEndDate) {
            const start = new Date(cp.saleStartDate);
            const end = new Date(cp.saleEndDate);
            const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
            if (['WAIT', 'SUSPENDED', 'OUTOFSTOCK'].includes(status) && diffDays >= 13 && diffDays <= 15) {
              dateStr = '미등록';
            } else {
              dateStr = `${formatDt(cp.saleStartDate)} ~ ${formatDt(cp.saleEndDate)}`;
              if (!isNaN(start.getTime())) preciseStart = start;
              if (!isNaN(end.getTime())) preciseEnd = end;
            }
          } else if (cp.saleStartDate) {
            dateStr = `${formatDt(cp.saleStartDate)} ~ 계속`;
            const start = new Date(cp.saleStartDate);
            if (!isNaN(start.getTime())) preciseStart = start; // 종료 미정(계속) → endDate는 세우지 않음
          }

          // 재동기화는 실기간(구체 기간)일 때만 salePeriod를 덮어쓴다. 네이버 상태가 대기라
          // '미등록'·'기간 미정' 폴백이 나올 수 있는데, 그 폴백으로 이미 확정된 기존 기간을
          // 되돌리면 안 된다(연장 반영이 뒤집힘). 최초 확정(firstFill)일 때만 폴백도 수용한다.
          const acceptPeriod = firstFill || isConcretePeriodString(dateStr);
          const nextPeriod = acceptPeriod ? dateStr : camp.salePeriod;
          const nextCategory = firstFill ? categoryName : (camp.category || categoryName);
          // 집계 창(startDate/endDate)의 정본은 판매관리다(오너 2026-07-15) — 판매캠페인이 연결돼 있으면
          // 스토어 기간으로 창을 덮지 않는다. 스토어가 '종료 후 임시 오픈'으로 열려 있어도 회차 창이
          // 끌려가면 안 되기 때문. salePeriod(위 nextPeriod)는 관측값이라 계속 갱신해 불일치를 볼 수 있게 둔다.
          // 연결이 없는 캠페인만 스토어 정밀 기간을 창으로 승격한다(그 경우 다른 근거가 없다).
          const followsSalesCampaign = (camp.salesCampaigns?.length ?? 0) > 0;
          const nextStart = (!followsSalesCampaign && acceptPeriod && preciseStart) ? preciseStart : (camp.startDate ?? null);
          const nextEnd = (!followsSalesCampaign && acceptPeriod && preciseEnd) ? preciseEnd : (camp.endDate ?? null);
          const sameMs = (a: Date | string | null, b: Date | null) => {
            const am = a ? new Date(a).getTime() : null;
            const bm = b ? b.getTime() : null;
            return am === bm;
          };
          const changed = camp.salePeriod !== nextPeriod || camp.productStatus !== status || camp.category !== nextCategory
            || !sameMs(camp.startDate ?? null, nextStart) || !sameMs(camp.endDate ?? null, nextEnd);
          if (changed) {
            const updated = await prisma.orderCampaign.update({
              where: { id: camp.id },
              data: {
                category: nextCategory,
                salePeriod: nextPeriod,
                productStatus: status,
                startDate: nextStart,
                endDate: nextEnd,
              } as any
            }) as any;
            camp.category = updated.category;
            camp.salePeriod = updated.salePeriod;
            camp.productStatus = updated.productStatus;
            camp.startDate = updated.startDate;
            camp.endDate = updated.endDate;
          }
        } else if (firstFill) {
          // 최초 확정에서 매칭 실패 시에만 미정 폴백. 재동기화(resync) 매칭 실패는 기존값을 유지한다.
          const updated = await prisma.orderCampaign.update({
            where: { id: camp.id },
            data: {
              category: '카테고리 미지정',
              salePeriod: '기간 미정',
              productStatus: 'UNKNOWN'
            } as any
          }) as any;
          camp.category = updated.category;
          camp.salePeriod = updated.salePeriod;
          camp.productStatus = updated.productStatus;
        }
      }
      backfilledCampaigns.push(camp);
    }

    const campaigns = JSON.parse(JSON.stringify(backfilledCampaigns));

    // 발주서 파일명 미리보기용 브랜드/거래처 표기명(provider). 발송 팝업이 파일명 기본값을
    // 서버 권위값으로 미리 보여주도록 캠페인별로 실어 보낸다. 템플릿 slug 단위로 1회씩만
    // resolveOrderBrand를 호출(캠페인 N+1 아님). 실패해도 파일명 프리뷰만 영향이라 무해.
    const providerBySlug: Record<string, string> = {};
    const distinctSlugs = new Set<string>();
    for (const c of campaigns as any[]) {
      if (c.template) distinctSlugs.add(String(c.template));
    }
    for (const slug of distinctSlugs) {
      try {
        const brand = await resolveOrderBrand(slug);
        providerBySlug[slug] = brand?.displayName || slug;
      } catch {
        providerBySlug[slug] = slug;
      }
    }
    const resolveProvider = (camp: any): string =>
      (camp.template && providerBySlug[camp.template]) || camp.template || '기본';

    // 통계 산출을 위한 조회 기간 결정 (활성화된 캠페인 중 가장 빠른 판매 시작일 기준).
    // 캠페인별 기여값 판정은 resolveCampaignQueryStartMs(sale-window SSOT)에 위임한다 — 과거 여기서
    // c.startDate를 raw로 읽어 startDate가 null인 캠페인이 salePeriod를 놔두고 기여 0이 되던 실사고
    // (2026-07-15 실사고: 활성 캠페인이 전부 startDate null → 조회창이 기본값으로 떨어져
    // 판매 시작일 이전 주문이 통째로 미조회) 방지.
    const activeCampaigns = campaigns.filter((c: any) => c.isActive);

    let earliestStart = new Date();
    // 기간이 없는 경우 최근 7일로 가정
    earliestStart.setDate(earliestStart.getDate() - 7);

    let hasValidStart = false;
    activeCampaigns.forEach((c: any) => {
      const startMs = resolveCampaignQueryStartMs(c);
      if (startMs === null) return;
      const startD = new Date(startMs);
      if (!hasValidStart || startD < earliestStart) {
        earliestStart = startD;
        hasValidStart = true;
      }
    });

    // 기본값('오늘-7일') 폴백은 조용히 틀린다 — 화면 판매기간은 멀쩡한데 그 이전 매출만 사라지고,
    // 시작일이 매일 하루씩 밀린다. 활성 캠페인이 있는데도 기간을 하나도 못 얻었으면 반드시 남긴다.
    if (!hasValidStart && activeCampaigns.length > 0) {
      console.warn(
        `[campaigns] 활성 캠페인 ${activeCampaigns.length}개에서 판매 시작일을 얻지 못해 조회창이 기본값(최근 7일)으로 떨어졌습니다. ` +
          `그 이전 주문은 조회되지 않습니다 — 판매기간/판매캠페인 연결을 확인하세요: ` +
          activeCampaigns.map((c: any) => `${c.id}(salePeriod=${c.salePeriod ?? 'null'}, sc=${c.salesCampaigns?.length ?? 0})`).join(', '),
      );
    }

    // 같은 상품 링크를 여러 캠페인이 쓰는 건 정상 운영이다(상품명을 바꿔가며 셀러를 교체하는
    // 순차 회차). 다만 **집계창까지 겹치면** 그 구간 주문은 상품·옵션·상품명 어느 것으로도 셀러를
    // 가릴 수 없어 두 캠페인이 같은 주문을 각자 집계한다(2026-07-23 실사고: 두 마감 캐시 합이
    // 원천 실재 수량 초과). 해소는 코드가 아니라 운영자가 판매관리에서 회차 경계를 안 겹치게
    // 잡는 것이므로, 감지해서 남기는 데까지가 코드의 몫이다.
    const sharedLinkConflicts = findSharedLinkWindowConflicts(
      activeCampaigns.map((c: any) => ({
        id: c.id,
        name: c.name,
        productId: c.productId,
        windowStartMs: resolveSaleWindowStartMs(c),
        windowEndMs: resolveSaleWindowEndMs(c),
      })),
    );
    if (sharedLinkConflicts.length > 0) {
      console.warn(
        `[campaigns] 같은 상품 링크를 쓰는 캠페인들의 판매기간이 겹칩니다 — 겹치는 구간의 주문은 ` +
          `셀러별로 나눌 신호가 없어 양쪽에 중복 집계됩니다. 판매관리에서 회차 경계를 분리하세요: ` +
          sharedLinkConflicts.map((c) => `productId=${c.productId}(${c.aId} ↔ ${c.bId})`).join(', '),
      );
    }

    const now = new Date();
    // 만약 startDate가 미래라면 현재 시간 전일로 세팅
    if (earliestStart > now) {
      earliestStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }
    
    // 조회 창의 시작은 **캠페인 창**이 정한다(P7 Campaign Period SSOT). 절대 상한은 폭주
    // 가드로만 남는다 — 판정은 resolveLiveWindowKeys(daily-aggregate SSOT, 모바일 상세·펄스와 공용).
    //
    // ⛔ 종전 `now − 30일` **하한**을 되살리지 말 것. 캠페인 시작일은 고정인데 하한은 매일
    // 전진하므로, 시작 후 30일이 지나면 캠페인 초반 날짜가 하루에 하나씩 조회 밖으로 밀려나
    // **주문 건수·매출이 조용히 줄었다**(모바일 경로에서 실측·수정 — 같은 결함이 여기에도 있었다).
    // 종전 주석의 근거 "API 과호출 방지"는 **부정확했다**: 이 창이 구동하는 것은 스냅샷
    // 하이드레이션이고, 네이버를 부르는 `runSync('FULL', {startDateKey, endDateKey})` 는
    // **L1+DB 완전 무데이터 부트스트랩에서만** 발화한다(아래 `hadAnySnapshot` 분기).
    // 즉 창을 넓혀도 정상 운영의 네이버 호출량은 늘지 않는다.
    const { startKey: windowStartKey } = resolveLiveWindowKeys(
      earliestStart.getTime(),
      now,
      'campaigns-handler',
    );
    earliestStart = new Date(Date.parse(`${windowStartKey}T00:00:00.000Z`) - 9 * 60 * 60 * 1000);

    const recentOrders: any[] = [];

    if (!(global as any).__naverDailyCache) {
      (global as any).__naverDailyCache = {};
    }
    const dailyCache = (global as any).__naverDailyCache;

    let lastSyncIso: string | null = null;
    let isSyncing = false;
    let syncTypeHeader: string | null = null;

    try {
      // KST 기준으로 자정부터 시작하도록 earliestStart 조정
      const currentKst = new Date(earliestStart.getTime() + 9 * 60 * 60 * 1000);
      currentKst.setUTCHours(0, 0, 0, 0);
      const currentFrom = new Date(currentKst.getTime() - 9 * 60 * 60 * 1000);

      const nowKst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      nowKst.setUTCHours(23, 59, 59, 999);
      const endFrom = new Date(nowKst.getTime() - 9 * 60 * 60 * 1000);

      const startDateKey = toDateKeyKst(currentFrom);
      const endDateKey = toDateKeyKst(endFrom);

      // 하이드레이션(2단 조회): 매 요청 ①경량 메타(snapshotDate·lastCallTime)로 신선도를
      // 판정하고 ②L1에 없거나 DB가 더 최신인 날짜만 블롭을 가져와 L1을 갱신한다.
      // 발주확인/발송 반영(syncOrdersByIds)은 요청을 처리한 인스턴스의 L1+DB에만 기록되므로,
      // 다른 웜 인스턴스가 "완전히 비었을 때만 하이드레이션" 규칙(구 로직)으로는 과거 날짜의
      // 낡은 L1을 무기한 서빙했다(2026-07-07 실사고: DB=발주후 248 정합인데 대시보드=151 고정).
      // DB lastCallTime 비교로 신선도를 따라가는 규칙은 유지하되, 종전처럼 전 기간 블롭을
      // 전송한 **뒤** 비교하지 않는다 — 이 폴링 표면이 DB 풀러 egress의 주 원인이었다.
      let hadAnySnapshot = Object.keys(dailyCache).length > 0;
      try {
        const metas = await naverOrderSnapshotRepository.findRangeMeta(startDateKey, endDateKey);
        const datesToFetch = metas
          .filter((meta) => {
            const l1Entry = dailyCache[meta.snapshotDate];
            return !l1Entry || new Date(meta.lastCallTime).getTime() > (l1Entry.lastCallTime || 0);
          })
          .map((meta) => meta.snapshotDate);
        const snapshots = await naverOrderSnapshotRepository.findByDates(datesToFetch);
        // L3 egress 계측(2026-07-21) — 이 하이드레이션이 DB에서 당긴 블롭 근사 바이트.
        // 웜 폴링은 보통 rows=0~1이어야 정상이고, 콜드스타트는 전 기간이 실린다.
        if (snapshots.length > 0) {
          const hydrateBytes = snapshots.reduce((sum, s) => {
            const text = typeof s.orders === 'string' ? s.orders : JSON.stringify(s.orders ?? null);
            return sum + Buffer.byteLength(text ?? '', 'utf8');
          }, 0);
          console.log(`[egress] campaigns-handler hydrate: rows=${snapshots.length} bytes=${hydrateBytes}`);
        }
        for (const snapshot of snapshots) {
          const l1Entry = dailyCache[snapshot.snapshotDate];
          const dbCallTime = new Date(snapshot.lastCallTime).getTime();
          if (!l1Entry || dbCallTime > (l1Entry.lastCallTime || 0)) {
            dailyCache[snapshot.snapshotDate] = {
              lastCallTime: dbCallTime,
              orders: naverOrderSnapshotRepository.parseOrders(snapshot),
              newOrdersCount: snapshot.newOrdersCount,
              preparingCount: snapshot.preparingCount,
              deliveringCount: snapshot.deliveringCount,
              isDirty: snapshot.isDirty,
            };
          }
        }
        hadAnySnapshot = hadAnySnapshot || metas.length > 0;
      } catch (hydrateErr) {
        console.warn('Failed to hydrate daily cache from NaverOrderSnapshot:', hydrateErr);
      }

      // 부트스트랩: L1+DB 완전 무데이터(첫 조회)면, 이 요청에서 1회 FULL 동기화를 await하고 재하이드레이션한다.
      if (!hadAnySnapshot) {
        try {
          await runSync('FULL', { startDateKey, endDateKey });
          const snapshots = await naverOrderSnapshotRepository.findRange(startDateKey, endDateKey);
          for (const snapshot of snapshots) {
            dailyCache[snapshot.snapshotDate] = {
              lastCallTime: new Date(snapshot.lastCallTime).getTime(),
              orders: naverOrderSnapshotRepository.parseOrders(snapshot),
              newOrdersCount: snapshot.newOrdersCount,
              preparingCount: snapshot.preparingCount,
              deliveringCount: snapshot.deliveringCount,
              isDirty: snapshot.isDirty,
            };
          }
        } catch (bootstrapErr) {
          console.warn('Bootstrap FULL sync failed:', bootstrapErr);
        }
      }

      // read-only 순회: L1/DB에 있는 데이터를 recentOrders로 모으고, stale한 날짜를 수집한다.
      const staleDates: string[] = [];
      let cursor = currentFrom;
      while (cursor <= endFrom) {
        const dateKeyKst = new Date(cursor.getTime() + 9 * 60 * 60 * 1000);
        const dateKey = toDateKeyKst(cursor);

        const cacheEntry = dailyCache[dateKey];
        if (cacheEntry?.orders) {
          recentOrders.push(...cacheEntry.orders);
        }

        if (isSnapshotStale(cacheEntry, dateKeyKst, false)) {
          staleDates.push(dateKey);
        }

        if (cacheEntry?.lastCallTime && (!lastSyncIso || cacheEntry.lastCallTime > new Date(lastSyncIso).getTime())) {
          lastSyncIso = new Date(cacheEntry.lastCallTime).toISOString();
        }

        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      }

      // stale한 날짜가 있으면 응답은 그대로 반환하고, 백그라운드로 변경피드 동기화를 트리거한다 (서버판 SWR).
      // 데모 배포: 동기화가 no-op이라 stale이 영원히 해소되지 않는다 — syncing 상태를 아예 켜지
      // 않아 클라이언트 폴링 루프("동기화 중" 배지)가 돌지 않게 한다.
      if (!isDemoMode() && staleDates.length > 0 && hadAnySnapshot) {
        isSyncing = true;
        syncTypeHeader = 'CHANGED';
        // 배송중(DELIVERING) 건은 변경피드가 배송완료 전이(DELIVERING→DELIVERED)를 안 실어 CHANGED
        // 동기화로는 못 잡힌다(피드 갭). 그 건들을 query-by-id로 직접 재조회(3h 쿨다운 내장)해 배송완료
        // 반영을 보정 → '배송중'에 stale하게 남아 false 지연이 되던 문제를 해소한다.
        const deliveringIds = recentOrders
          .filter((o: any) => o?.productOrderStatus === 'DELIVERING' || o?.productOrderStatus === 'DISPATCHED')
          .map((o: any) => String(o?.productOrderId || ''))
          .filter(Boolean);
        after(async () => {
          try { await runSync('CHANGED'); } catch (err) { console.warn('Background CHANGED sync failed:', err); }
          try { await sweepDeliveringOrders(deliveringIds); } catch (err) { console.warn('Background delivering sweep failed:', err); }
        });
      }

      // 응답 헤더용 최신 동기화 메타를 DB에서 조회 (L1 lastCallTime 순회보다 신뢰도 높음)
      try {
        const meta = await naverOrderSnapshotRepository.latestSyncMeta();
        if (meta?.lastCallTime) {
          lastSyncIso = new Date(meta.lastCallTime).toISOString();
        }
        if (!syncTypeHeader && meta?.syncType) {
          syncTypeHeader = meta.syncType;
        }
      } catch (metaErr) {
        console.warn('Failed to read latestSyncMeta:', metaErr);
      }
    } catch (apiErr) {
      console.warn('Failed to hydrate naver orders from snapshots:', apiErr);
      // 에러 발생 시 가능한 한 모든 캐시된 데이터 반환
      Object.values(dailyCache).forEach((c: any) => {
        if (c.orders) recentOrders.push(...c.orders);
      });
    }

    const campaignDealStats: Record<string, CampaignDealStat> = {};
    const shouldCollectDealStats = (orderCampaignId: string) =>
      !options.salesPushOrderCampaignId || options.salesPushOrderCampaignId === orderCampaignId;
    if (options.salesPushOrderCampaignId) {
      const targetCampaign = rawCampaigns.find((camp: any) => camp.id === options.salesPushOrderCampaignId);
      for (const mapping of targetCampaign?.mappings ?? []) {
        if (!mapping.campaignDealId) continue;
        if (!campaignDealStats[mapping.campaignDealId]) {
          campaignDealStats[mapping.campaignDealId] = { orders: 0, quantity: 0, revenue: 0, sellingPrice: null, matchedLines: 0 };
        }
        const price = Number(mapping.price ?? 0);
        if (price > 0 && campaignDealStats[mapping.campaignDealId].sellingPrice == null) {
          campaignDealStats[mapping.campaignDealId].sellingPrice = price;
        }
      }
    }

    // 배송대기 재정의(order-fulfillment.ts): 발주요청 메일이 발송된 상품주문(poRequestedAt)을 한 번에
    // 배치 로드해, 아래 판정에서 네이버 상태와 합성한다. 조회 실패 시 빈 집합으로 폴백 —
    // 그러면 배송대기는 0으로 보수적으로 잡히고 판정은 네이버 상태만으로 계속 진행된다.
    const allProductOrderIds = recentOrders.map((o: any) => o?.productOrderId).filter(Boolean);
    // 발주요청 시각까지 로드(맵) — 판정에는 keys() 집합만 쓰므로 무회귀, 배송대기 목록의 "경과일" 계산에 값 사용.
    let poRequestedMap = new Map<string, Date>();
    try {
      poRequestedMap = await orderFulfillmentRepository.getPoRequestedMap(allProductOrderIds);
    } catch (err) {
      console.warn('[campaigns] poRequested 맵 로드 실패 — 네이버 상태만으로 판정:', err);
    }
    const poRequestedSet = new Set<string>(poRequestedMap.keys());

    // 마감 시점에 동결한 캐시 컬럼으로 캠페인 응답을 구성한다. 마감(isActive=false) 캠페인과,
    // 마감취소됐지만 라이브 집계가 비어(조회창 만료) 스냅샷으로 폴백하는 활성 캠페인이 공유한다.
    // extra로 폴백 표식(isFrozenFallback) 등을 덧입힌다. isActive는 ...camp에서 그대로 상속.
    const buildSnapshotResponse = (camp: any, extra: Record<string, unknown> = {}) => ({
      ...camp,
      mappings: sortProductMappingsByProductName(camp.mappings ?? []),
      orderProvider: resolveProvider(camp),
      // 마감·스냅샷 폴백 카드도 표시 기간은 **창에서 파생**해야 한다. 여기서 안 실으면 클라이언트가
      // salePeriod(스토어 관측값)로 폴백해, 정작 운영자가 가장 자주 보는 완료 회차에서 표시와 동결 수치의
      // 출처가 갈라진다. 스냅샷 수치는 마감 시점 창으로 계산됐으므로 그 창(저장된 startDate/endDate)을 쓴다.
      periodLabel:
        formatKstPeriodLabel(resolveSaleWindowStartMs(camp), resolveSaleWindowEndMs(camp)) ?? camp.salePeriod ?? null,
      newOrderBeforeCount: camp.cachedNewOrderBeforeCount || 0,
      newOrderAfterCount: camp.cachedNewOrderAfterCount || 0,
      pendingCount: camp.cachedPendingCount,
      shippingCount: camp.cachedShippingCount,
      completedCount: camp.cachedCompletedCount,
      postPeriodOrderCount: 0,
      postPeriodOrders: [],
      totalOrders: camp.cachedTotalOrders,
      distinctOrderCount: camp.cachedDistinctOrderCount ?? camp.cachedTotalOrders ?? 0,
      totalQuantity: camp.cachedTotalQuantity,
      naverSettlement: camp.cachedSettledAmount != null ? {
        settledAmount: camp.cachedSettledAmount ?? 0,
        feeAmount: camp.cachedSettleFeeAmount ?? 0,
        feeBreakdown: camp.cachedSettleFeeBreakdown ?? null,
        unsettledAmount: camp.cachedUnsettledAmount ?? 0,
        settledCount: camp.cachedSettledCount ?? 0,
      } : null,
      totalRevenue: camp.cachedTotalRevenue,
      dailyStats: camp.cachedDailyStats ? (typeof camp.cachedDailyStats === 'string' ? JSON.parse(camp.cachedDailyStats) : camp.cachedDailyStats) : [],
      insights: camp.cachedInsights ? (typeof camp.cachedInsights === 'string' ? JSON.parse(camp.cachedInsights) : camp.cachedInsights) : null,
      cancelReturnOrderIds: null,
      cancelReturnQuantity: camp.cachedPostCloseCancelQuantity || 0,
      cancelReturnAmount: camp.cachedPostCloseCancelRevenue || 0,
      pendingOrders: [],
      shippingOrders: [],
      confirmOrders: [],
      ...extra,
    });

    // 마감 스냅샷이 존재하는가(폴백 가능 여부) — 이전 마감으로 캐시가 채워진 캠페인만 참.
    const hasFrozenSnapshot = (camp: any) =>
      (camp.cachedDistinctOrderCount ?? 0) > 0 || (camp.cachedTotalQuantity ?? 0) > 0 || (camp.cachedTotalOrders ?? 0) > 0;

    const campaignsWithStats = campaigns.map((camp: any) => {
      let newOrderBeforeCount = 0;
      let newOrderAfterCount = 0;
      let pendingCount = 0;
      let shippingCount = 0;
      let completedCount = 0;
      // 판매기간 종료(campEnd) 이후에 들어온 발주 대상 주문(PAYED/PRODUCT_ORDERED) 수 + 드릴다운 목록.
      // 집계 창 밖이라 주문확인 등 파이프라인 카운트엔 안 잡히지만 발주서엔 실린다 — 이 간극을
      // 카드에 배지로 노출하고, 배지 클릭 시 어떤 주문인지 목록으로 보여준다. 목록은 최신순 100건 캡
      // (카운트는 전량 정확). "기간 연장 반영 필요 or 스토어 마감 필요"를 운영자가 즉시 판단하게 한다.
      let postPeriodOrderCount = 0;
      const postPeriodOrders: Array<{ productOrderId: string; ordererName: string; receiverName: string; optionName: string; quantity: number; paymentDate: string | null }> = [];
      const POST_PERIOD_LIST_CAP = 100;
      let totalOrders = 0;
      let totalQuantity = 0;
      let oldestPendingDate = 0;
      let oldestShippingDate = 0;
      // 마지막 주문 시각(유효 주문 기준) + 지연 일수별 버킷(카드 라벨 툴팁용: "2일 지연 3건 · 3일 지연 2건")
      let lastOrderAt = 0;
      const pendingDelayDays: Record<string, number> = {};
      const shippingDelayDays: Record<string, number> = {};
      // 배송대기 버킷 주문 목록(카드 배송대기 클릭 시 팝오버). 카운트만 세고 버리지 않고 같은 순회에서 수집한다.
      // 판단 핵심값은 "발주요청 후 경과일"이라 poRequestedAt을 함께 실어 보낸다.
      const pendingOrders: Array<{ productOrderId: string; ordererName: string; receiverName: string; optionName: string; quantity: number; paymentDate: string | null; poRequestedAt: string | null }> = [];
      // 배송 지연 경고 주문 목록(카드 배송중 클릭 시 팝오버). 팝오버는 "모든 배송중"이 아니라
      // 파악이 필요한 경고 건(배송 경과 SHIPPING_DELAY_WARN_DAYS일↑)만 담는다 — 그래서 카드 배송중 경고
      // 배지(shippingDelayDays)와 정확히 같은 집합이고, 페이로드도 경고 건수만큼만 실린다.
      // 발송 시각 필드가 스냅샷에 없어 배송 경과는 주문/결제 시각(orderTime) 기준(카드 경고와 동일).
      const shippingOrders: Array<{ productOrderId: string; ordererName: string; receiverName: string; optionName: string; quantity: number; paymentDate: string | null }> = [];
      // 주문확인 후 발주 지연(newAfter · 결제 후 경과) 버킷 + 목록 — 배송대기/배송중과 동일 패턴.
      const confirmDelayDays: Record<string, number> = {};
      const confirmOrders: Array<{ productOrderId: string; ordererName: string; receiverName: string; optionName: string; quantity: number; paymentDate: string | null }> = [];
      const nowMs = Date.now();

      // 추가구성상품(추가옵션) 귀속용: 이 캠페인에 매칭된 메인 품목의 productId 집합과,
      // 매칭 판단을 2차로 미루는 추가구성상품 보류 리스트. (네이버는 추가구성상품을 메인 상품
      // 리스팅 하위=동일 productId로 등록하므로 productId가 신뢰 가능한 연결키다.)
      const campaignProductIds = new Set<string>();
      const deferredAddons: any[] = [];
      // 주문건수(주문번호 distinct) 집계용 — 유효 주문의 orderId만 모은다(전량취소 주문은 유효 분기 미진입으로 자동 제외).
      const validOrderKeys = new Set<string>();

      // 비활성(마감) 캠페인은 캐시된 고정값(마감 시점 스냅샷)을 사용.
      // distinctOrderCount·insights·dailyStats·정산 결산 매핑은 buildSnapshotResponse(SSOT)로 일원화 —
      // 마감취소 후 라이브가 빈 활성 캠페인의 스냅샷 폴백과 동일 매핑을 공유한다.
      if (!camp.isActive) {
        return buildSnapshotResponse(camp);
      }

      let totalRevenue = 0;
      // 일자별 집계 엔트리. 취소·반품(cancelQuantity/cancelRevenue)은 '주문일자 코호트' 기준으로 되돌려
      // 귀속한다 — 취소가 일어난 날이 아니라 원래 주문일(dateStr=결제일)에 가산해, 그날 블록에서
      // "순수 수량 + 취소 수량 = gross"가 자기완결적으로 맞아떨어지게 한다. 형태는 makeDailyEntry로 봉인
      // (초기화 지점 4곳의 필드 누락 방지).
      type DailyEntry = { orderKeys: Set<string>; quantity: number; revenue: number; cancelQuantity: number; cancelRevenue: number; newOrderBefore: number; newOrderAfter: number; pending: number; shipping: number; completed: number; options: Record<string, { price: number; orderKeys: Set<string>; quantity: number; revenue: number }> };
      const makeDailyEntry = (): DailyEntry => ({ orderKeys: new Set<string>(), quantity: 0, revenue: 0, cancelQuantity: 0, cancelRevenue: 0, newOrderBefore: 0, newOrderAfter: 0, pending: 0, shipping: 0, completed: 0, options: {} });
      const dailyMap: Record<string, DailyEntry> = {};
      const insightAcc = createInsightAccumulator();
      // 이 캠페인에 귀속된 취소·반품 주문의 productOrderId(교환 제외). 카드 '취소·반품' 숫자와
      // 클릭 시 드릴다운 목록이 매출·주문과 동일한 서버 귀속 기준을 공유하도록 클라이언트에 넘긴다.
      const cancelReturnOrderIds: string[] = [];
      // 취소·반품 수량(카드 표시) + 환불금액(매출보고 표시). 부분취소까지 정확한 수량 기준.
      // 미결제취소(CANCELED_BY_NOPAYMENT)는 아래 CANCELED/RETURNED 필터에 안 걸려 자동 제외된다.
      let cancelReturnQuantity = 0;
      let cancelReturnAmount = 0;

      // 집계 창 정본 = 판매관리(SalesCampaign) 일정(오너 확정 2026-07-15). 스토어(salePeriod)는
      // 관측값으로 보존한다 — 덮어쓰면 '스토어엔 연장이 있는데 판매관리엔 없다'를 감지할 근거가 사라진다.
      //
      // 동결 기준은 마감(isActive)이 아니라 **정산 락**이다(오너 확정 2026-07-15): 판매마감은 되돌리는
      // 경우가 있고, 반품·구매확정 때문에 판매일정 후 ~10일은 정산대기로 변동 가능하다. 정산이 시작되면
      // 그때부터 확정이므로 창을 얼려 마감 스냅샷·정산 귀속(cachedProductOrderIds)과 어긋나지 않게 한다.
      const salesWindow = resolveSalesCampaignWindow(camp.salesCampaigns);
      // 딜 하나라도 정산에 들어갔으면 창 전체를 얼린다. 창은 주문캠페인당 하나뿐이라 늘리면 이미 정산 중인
      // 딜의 귀속 주문까지 바뀌기 때문 — 정산 무결성 쪽으로 보수적으로 잡는다. 오너도 "정산시작이 들어가면
      // 판매마감도 확정"이라며 회차 단위로 본다(실측상 한 캠페인의 딜들은 상태가 함께 움직인다).
      const periodFrozenBySettlement =
        !!camp.salesCampaigns?.some((sc: any) => isSalesCampaignLocked(sc.status));
      camp._periodMismatch = salesWindow?.hasPeriodMismatch ?? false;

      const sameMs = (a: Date | string | null | undefined, b: Date | null) => {
        const am = a ? new Date(a).getTime() : null;
        const bm = b ? b.getTime() : null;
        return am === bm;
      };

      if (salesWindow) {
        const nextStart = new Date(salesWindow.startMs);
        const nextEnd = salesWindow.endMs === null ? null : new Date(salesWindow.endMs);
        // salePeriod가 아니라 창(startDate/endDate) 자체를 게이트로 쓴다 — 과거 salePeriod 문자열만
        // 비교해서, 문자열이 같으면 startDate를 영영 안 쓰던 탓에 prod 전 캠페인의 startDate가 null로
        // 남아 있었다(실측). 그 결과 컷오프가 문자열 폴백에만 의존했다.
        const windowDiffers = !sameMs(camp.startDate, nextStart) || !sameMs(camp.endDate, nextEnd);

        if (windowDiffers && !periodFrozenBySettlement) {
          camp.startDate = nextStart;
          camp.endDate = nextEnd;
          camp._needsPeriodSyncToDB = true;
        }
        // 동결됐는데 판매관리 일정이 창과 다르다 = 운영자가 판매관리에서 기간을 고쳤지만 정산 확정이라
        // 반영되지 않는 상태. 이걸 조용히 무시하면 "판매관리에서 종료일을 늘리세요" 안내를 따랐는데도
        // 아무 일이 안 일어나는 최악의 무응답이 된다 — 배지로 드러내 운영자가 원인을 알게 한다.
        camp._periodFrozenDrift = windowDiffers && periodFrozenBySettlement;
      }

      // 집계 컷오프(SSOT). 종료는 반드시 KST 그 날 끝(23:59:59.999)까지 포함 — 스토어 API가 준 정밀
      // 판매종료시각(시:분 존재)은 그대로 존중하고, 날짜만 저장된 값은 KST 종일로 보정한다.
      // 미확정(null)은 폴백 전 원본을 따로 들고 있는다 — 표시 라벨은 폴백값(0·MAX)이 아니라 실제 창을
      // 보여줘야 하고, 0을 그대로 포맷하면 1970년이 찍힌다.
      const campStartRaw = resolveSaleWindowStartMs(camp);
      const campEndRaw = resolveSaleWindowEndMs(camp);
      const campStart = campStartRaw ?? 0;
      const campEnd = campEndRaw ?? Number.MAX_SAFE_INTEGER;

      // 교차 귀속 가드용 이웃 목록 — 캠페인당 1회만 만든다(주문 루프 안에서 만들면 주문×캠페인 배).
      const peerCampaigns: PeerCampaignWindow[] = activeCampaigns
        .filter((otherCamp: any) => otherCamp.id !== camp.id)
        .map((otherCamp: any) => ({
          id: otherCamp.id,
          name: otherCamp.name,
          windowStartMs: resolveSaleWindowStartMs(otherCamp),
          windowEndMs: resolveSaleWindowEndMs(otherCamp),
        }));

      recentOrders.forEach((order) => {
        if (!order || !camp.mappings) return;

        // 개별 캠페인 판매 기간 내 주문인지 필터링 (결제일시 우선 기준)
        const orderTimeStr = order.paymentDate || order.orderDate || order.orderCreateDate;
        const orderTime = orderTimeStr ? new Date(orderTimeStr).getTime() : 0;
        
        if (orderTime > 0 && (orderTime < campStart || orderTime > campEnd)) {
          // 판매기간 종료 후 들어온 발주 대상 주문은 별도 카운트(배지 신호). 이 캠페인 소속만
          // — 스테일 기간 시나리오에선 동일 상품이라 상품명/상품ID로 정확히 걸린다(발주서 대상과 일치).
          if (orderTime > campEnd && (order.productOrderStatus === 'PAYED' || order.productOrderStatus === 'PRODUCT_ORDERED')) {
            const pn = order.productName || '';
            const belongs = orderMatchesCampaignProductId(order, camp.productId)
              || pn.includes(camp.name) || camp.name.includes(pn);
            if (belongs) {
              postPeriodOrderCount++;
              if (postPeriodOrders.length < POST_PERIOD_LIST_CAP) {
                postPeriodOrders.push({
                  productOrderId: String(order.productOrderId || ''),
                  ordererName: order.ordererName || '',
                  receiverName: order.shippingAddress?.name || '',
                  optionName: resolveSalesReportOptionLabel(pn, order.productOption || order.productOptionName || ''),
                  quantity: Number(order.quantity) || 1,
                  paymentDate: orderTimeStr || null,
                });
              }
            }
          }
          return; // 판매 기간을 벗어난 주문은 파이프라인 집계에서 스킵
        }

        // 추가구성상품(추가옵션)은 자체 이름(예: "아이보리")이라 캠페인명/매핑으로 매칭되지 않는다.
        // 같은 productId의 메인 품목이 이 캠페인에 귀속됐는지로 판단하기 위해 2차 패스로 보류한다.
        if (isSupplementProduct(order)) {
          deferredAddons.push(order);
          return;
        }

        const pName = order.productName || '';
        const oName = order.productOption || order.productOptionName || '';

        // 매칭 판정은 mapping-match.ts SSOT(handler·closed-campaign-cache 공유).
        // 유사도·정규화 substring·옵션 잡음제거 폴백을 한 표준형으로 수렴한다.
        // camp는 any라 매핑 원소 타입(campaignDealId·price 포함)을 보존하려 <any>로 호출한다.
        const matchedMapping = pickBestMapping<any>(camp.mappings, pName, oName);

        let isCampaignOrder = false;
        let matchesCampName = false;

        if (camp.productId && (order.productId != null || order.originalProductId != null)) {
          // 원상품/채널 번호 어느 쪽이든 캠페인 productId와 맞을 때만 캠페인명 매칭 인정
          if (orderMatchesCampaignProductId(order, camp.productId)) {
            if (pName.includes(camp.name) || camp.name.includes(pName)) {
              matchesCampName = true;
            }
          }
        } else {
          if (pName.includes(camp.name) || camp.name.includes(pName)) {
            matchesCampName = true;
          }
        }

        if (matchesCampName) {
          isCampaignOrder = true;
        } else if (matchedMapping) {
          // 매핑 룰에 맞더라도, 상품명(pName)이 다른 활성 캠페인을 가리키고 **그 캠페인 창이 이
          // 결제 시각을 담을 수 있으면** 그쪽 주문으로 간주(SSOT=campaign-match).
          // 창 조건이 핵심 — 한 링크의 상품명을 바꿔가며 셀러를 교체하는 순차 운영에서, 이름 변경
          // 후 재싱크된 옛 주문은 상품명만 새 셀러 것이 된다. 창을 안 보면 옛 캠페인은 "새 셀러
          // 것"이라며 양보하고 새 캠페인은 창 밖이라 걸러 **아무도 세지 않는다**(침묵 누락).
          if (!orderBelongsToPeerCampaign(pName, orderTime, peerCampaigns)) {
            isCampaignOrder = true;
          }
        }

        if (isCampaignOrder) {
          // 이 캠페인에 귀속된 메인 품목의 productId를 기록 → 동일 productId의 추가구성상품 귀속에 사용
          if (order.productId) campaignProductIds.add(String(order.productId));
          const effectiveMapping = matchedMapping || { productName: camp.name, optionName: '', price: 0 };
          const status = order.productOrderStatus;

          // 상태 무관 매칭 라인 카운트(취소·반품 포함). push의 "매칭 0건 딜 스킵"이 매핑 미스매치와
          // '전부 취소돼 유효 0'을 구분하게 하는 신호 — 유효주문 게이트 밖(아래)이라 취소 라인도 잡는다.
          if (effectiveMapping.campaignDealId && shouldCollectDealStats(camp.id)) {
            if (!campaignDealStats[effectiveMapping.campaignDealId]) {
              campaignDealStats[effectiveMapping.campaignDealId] = { orders: 0, quantity: 0, revenue: 0, sellingPrice: null, matchedLines: 0 };
            }
            campaignDealStats[effectiveMapping.campaignDealId].matchedLines++;
          }

          let dateStr = '';
          if (orderTimeStr) {
            const d = new Date(orderTimeStr);
            const dKst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
            const yyyy = dKst.getUTCFullYear();
            const mm = String(dKst.getUTCMonth() + 1).padStart(2, '0');
            const dd = String(dKst.getUTCDate()).padStart(2, '0');
            dateStr = `${yyyy}-${mm}-${dd}`;
          }
          
          // 인사이트: 클레임(취소/반품/교환)은 유효 집계에서 제외되므로 별도 카운트
          // (결제 단위 dedup — 같은 주문의 여러 취소 라인은 1건). cancelReturnOrderIds는 드릴다운
          // 목록용이라 라인 단위 그대로 유지한다(클라 표시가 라인 기준).
          trackClaimInsight(insightAcc, resolveOrderCountKey(order), status);
          if ((status === 'CANCELED' || status === 'RETURNED') && order.productOrderId) {
            cancelReturnOrderIds.push(String(order.productOrderId));
            const cQty = Number(order.quantity) || 1;
            cancelReturnQuantity += cQty;
            const refundNaverDiscount = Math.max(0, (order.productDiscountAmount || 0) - (order.sellerBurdenDiscountAmount || 0));
            const cAmt = (order.totalPaymentAmount + refundNaverDiscount) || 0;
            cancelReturnAmount += cAmt;
            // 주문일자 코호트에 되돌려 귀속(취소일자 아님) — 일자별 블록의 순수 수량과 자기완결적으로 합산.
            if (dateStr) {
              if (!dailyMap[dateStr]) dailyMap[dateStr] = makeDailyEntry();
              dailyMap[dateStr].cancelQuantity += cQty;
              dailyMap[dateStr].cancelRevenue += cAmt;
            }
          }

          // 취소, 반품, 교환, 결제대기가 아닌 유효 주문으로 간주하여 총주문/총매출 집계
          const invalidStatuses = INVALID_ORDER_STATUSES;
          if (!invalidStatuses.includes(status)) {
            totalOrders++;
            const _ok = resolveOrderCountKey(order);
            if (_ok) validOrderKeys.add(_ok);
            if (orderTime > lastOrderAt) lastOrderAt = orderTime;
            const qty = Number(order.quantity) || 1;
            totalQuantity += qty;

            // 네이버 플랫폼 자체 할인(쿠폰 등)은 판매자 매출에 포함되어야 함
            const naverDiscount = Math.max(0, (order.productDiscountAmount || 0) - (order.sellerBurdenDiscountAmount || 0));
            const baseAmount = order.totalPaymentAmount + naverDiscount;

            const paymentAmount = baseAmount || ((effectiveMapping.price || 0) * qty);
            totalRevenue += paymentAmount;
            trackOrderInsight(insightAcc, order, qty, paymentAmount, orderTimeStr, _ok);
            
            if (effectiveMapping.campaignDealId && shouldCollectDealStats(camp.id)) {
              if (!campaignDealStats[effectiveMapping.campaignDealId]) {
                campaignDealStats[effectiveMapping.campaignDealId] = { orders: 0, quantity: 0, revenue: 0, sellingPrice: null, matchedLines: 0 };
              }
              campaignDealStats[effectiveMapping.campaignDealId].orders++;
              campaignDealStats[effectiveMapping.campaignDealId].quantity += qty;
              campaignDealStats[effectiveMapping.campaignDealId].revenue += paymentAmount;
              if (effectiveMapping.price > 0 && campaignDealStats[effectiveMapping.campaignDealId].sellingPrice == null) {
                campaignDealStats[effectiveMapping.campaignDealId].sellingPrice = Number(effectiveMapping.price);
              }
            }
              
            if (dateStr) {
              if (!dailyMap[dateStr]) dailyMap[dateStr] = makeDailyEntry();
              if (_ok) dailyMap[dateStr].orderKeys.add(_ok);
              dailyMap[dateStr].quantity += qty;
              dailyMap[dateStr].revenue += paymentAmount;

              const optionKey = resolveSalesReportOptionLabel(pName, oName);
              // 판매가격: 매핑 표 단가 우선(공구판매가 정본), 비어 있으면 실주문 결제액÷수량으로 산출
              // (매핑에 단가를 안 넣는 일반 거래처 캠페인에서 매출보고 판매가격이 전부 0원으로 나오던 문제)
              const optionUnitPrice = effectiveMapping.price || (qty > 0 ? Math.round(paymentAmount / qty) : 0);
              if (!dailyMap[dateStr].options[optionKey]) {
                dailyMap[dateStr].options[optionKey] = {
                  price: optionUnitPrice,
                  orderKeys: new Set<string>(),
                  quantity: 0,
                  revenue: 0
                };
              } else if (!dailyMap[dateStr].options[optionKey].price && optionUnitPrice) {
                dailyMap[dateStr].options[optionKey].price = optionUnitPrice;
              }
              if (_ok) dailyMap[dateStr].options[optionKey].orderKeys.add(_ok);
              dailyMap[dateStr].options[optionKey].quantity += qty;
              dailyMap[dateStr].options[optionKey].revenue += paymentAmount;
            }
          }

          // 파이프라인 버킷 판정: 네이버 상태 + 우리 발주요청 여부(poRequestedSet) 합성.
          // 배송대기 = 발주요청 메일 발송됨(order-fulfillment.ts 참조).
          const bucket = deriveOrderPipelineBucket(status, order.placeOrderStatus, poRequestedSet.has(String(order.productOrderId || '')));
          if (bucket === 'newBefore') {
            newOrderBeforeCount++;
            if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].newOrderBefore++;
          } else if (bucket === 'newAfter') {
            newOrderAfterCount++;
            if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].newOrderAfter++;
            // 주문확인됐지만 발주요청·송장 전에서 오래 묵는 건 추적 — 발주요청 타임스탬프가 아직 없으므로
            // 결제 시각(orderTime) 기준 경과. 경고(≥CONFIRM_DELAY_WARN_DAYS일)만 배지+팝오버(동일 집합).
            if (orderTime > 0) {
              const delayDays = Math.floor((nowMs - orderTime) / 86400000);
              if (delayDays >= CONFIRM_DELAY_WARN_DAYS) {
                confirmDelayDays[delayDays] = (confirmDelayDays[delayDays] || 0) + 1;
                confirmOrders.push({
                  productOrderId: String(order.productOrderId || ''),
                  ordererName: order.ordererName || '',
                  receiverName: order.shippingAddress?.name || '',
                  optionName: resolveSalesReportOptionLabel(pName, oName),
                  quantity: Number(order.quantity) || 1,
                  paymentDate: orderTimeStr || null,
                });
              }
            }
          } else if (bucket === 'pending') {
            pendingCount++;
            if (!oldestPendingDate || orderTime < oldestPendingDate) oldestPendingDate = orderTime;
            if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].pending++;
            // 배송대기 지연 = 발주요청 후 경과(poRequestedAt) 기준(팝오버 '발주경과' 표시와 동일 클락).
            // 경고(≥임계값)만 카드 지연 배지 + 팝오버 목록에 함께 담는다(동일 집합, 파악 필요 건만).
            const _poId = String(order.productOrderId || '');
            const _poAt = poRequestedMap.get(_poId) || null;
            if (_poAt) {
              const poDelayDays = Math.floor((nowMs - _poAt.getTime()) / 86400000);
              if (poDelayDays >= PENDING_DELAY_WARN_DAYS) {
                pendingDelayDays[poDelayDays] = (pendingDelayDays[poDelayDays] || 0) + 1;
                pendingOrders.push({
                  productOrderId: _poId,
                  ordererName: order.ordererName || '',
                  receiverName: order.shippingAddress?.name || '',
                  optionName: resolveSalesReportOptionLabel(pName, oName),
                  quantity: Number(order.quantity) || 1,
                  paymentDate: orderTimeStr || null,
                  poRequestedAt: _poAt.toISOString(),
                });
              }
            }
          } else if (bucket === 'shipping') {
            shippingCount++;
            if (!oldestShippingDate || orderTime < oldestShippingDate) oldestShippingDate = orderTime;
            if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].shipping++;
            if (orderTime > 0) {
              const delayDays = Math.floor((nowMs - orderTime) / 86400000);
              // 배송 지연 경고(≥임계값)만 카드 배지 카운트 + 팝오버 목록에 함께 담는다(동일 집합).
              if (delayDays >= SHIPPING_DELAY_WARN_DAYS) {
                shippingDelayDays[delayDays] = (shippingDelayDays[delayDays] || 0) + 1;
                shippingOrders.push({
                  productOrderId: String(order.productOrderId || ''),
                  ordererName: order.ordererName || '',
                  receiverName: order.shippingAddress?.name || '',
                  optionName: resolveSalesReportOptionLabel(pName, oName),
                  quantity: Number(order.quantity) || 1,
                  paymentDate: orderTimeStr || null,
                });
              }
            }
          } else if (bucket === 'completed') {
            completedCount++;
            if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].completed++;
          }
        }
      });

      // 2차 패스: 추가구성상품(추가옵션)을, 같은 주문 상품(=동일 productId)의 메인 품목이 이 캠페인에
      // 귀속된 경우에 한해 동일 캠페인 매출/집계에 합산한다. 메인 품목 경로는 위에서 그대로 처리되므로
      // 기존 매출 수치에는 영향이 없고(가산만), 그동안 누락되던 추가옵션만 더해진다.
      deferredAddons.forEach((order: any) => {
        if (!order.productId || !campaignProductIds.has(String(order.productId))) return;

        const status = order.productOrderStatus;
        const pName = order.productName || '';
        const oName = order.productOption || order.productOptionName || '';
        const orderTimeStr = order.paymentDate || order.orderDate || order.orderCreateDate;
        const orderTime = orderTimeStr ? new Date(orderTimeStr).getTime() : 0;

        // 추가옵션 매칭(딜)은 상태 무관으로 먼저 계산 — 취소 라인도 matchedLines에 세어 본품과 동일하게
        // '전부 취소돼 유효 0'과 '미매칭'을 구분한다. 유효주문 가산은 아래 유효 게이트에서 이 결과를 재사용.
        const addonMapping = findMappingByOptionName(oName, camp.mappings);
        if (addonMapping?.campaignDealId && shouldCollectDealStats(camp.id)) {
          if (!campaignDealStats[addonMapping.campaignDealId]) {
            campaignDealStats[addonMapping.campaignDealId] = { orders: 0, quantity: 0, revenue: 0, sellingPrice: null, matchedLines: 0 };
          }
          campaignDealStats[addonMapping.campaignDealId].matchedLines++;
        }

        let dateStr = '';
        if (orderTimeStr) {
          const d = new Date(orderTimeStr);
          const dKst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
          dateStr = `${dKst.getUTCFullYear()}-${String(dKst.getUTCMonth() + 1).padStart(2, '0')}-${String(dKst.getUTCDate()).padStart(2, '0')}`;
        }

        // 인사이트: 추가구성상품도 메인 품목과 동일 기준으로 클레임 카운트(결제 단위 dedup)
        trackClaimInsight(insightAcc, resolveOrderCountKey(order), status);
        if ((status === 'CANCELED' || status === 'RETURNED') && order.productOrderId) {
          cancelReturnOrderIds.push(String(order.productOrderId));
          const cQty = Number(order.quantity) || 1;
          cancelReturnQuantity += cQty;
          const refundNaverDiscount = Math.max(0, (order.productDiscountAmount || 0) - (order.sellerBurdenDiscountAmount || 0));
          const cAmt = (order.totalPaymentAmount + refundNaverDiscount) || 0;
          cancelReturnAmount += cAmt;
          // 주문일자 코호트에 되돌려 귀속(취소일자 아님) — 추가구성 2차 패스도 본품과 동일 기준.
          if (dateStr) {
            if (!dailyMap[dateStr]) dailyMap[dateStr] = makeDailyEntry();
            dailyMap[dateStr].cancelQuantity += cQty;
            dailyMap[dateStr].cancelRevenue += cAmt;
          }
        }

        const invalidStatuses = INVALID_ORDER_STATUSES;
        if (!invalidStatuses.includes(status)) {
          totalOrders++;
          const _ok = resolveOrderCountKey(order);
          if (_ok) validOrderKeys.add(_ok);
          if (orderTime > lastOrderAt) lastOrderAt = orderTime;
          const qty = Number(order.quantity) || 1;
          totalQuantity += qty;

          const naverDiscount = Math.max(0, (order.productDiscountAmount || 0) - (order.sellerBurdenDiscountAmount || 0));
          const baseAmount = order.totalPaymentAmount + naverDiscount;
          const paymentAmount = baseAmount || 0;
          totalRevenue += paymentAmount;
          trackOrderInsight(insightAcc, order, qty, paymentAmount, orderTimeStr, _ok);

          // 추가옵션도 딜별 집계(campaignDealStats)에 반영 — 위에서 상태 무관으로 구한 addonMapping 재사용.
          // 이래야 판매캠페인 수량·매출에 추가옵션(케이블·파우치)이 포함된다(유효주문만 가산).
          if (addonMapping?.campaignDealId && shouldCollectDealStats(camp.id)) {
            if (!campaignDealStats[addonMapping.campaignDealId]) {
              campaignDealStats[addonMapping.campaignDealId] = { orders: 0, quantity: 0, revenue: 0, sellingPrice: null, matchedLines: 0 };
            }
            campaignDealStats[addonMapping.campaignDealId].orders++;
            campaignDealStats[addonMapping.campaignDealId].quantity += qty;
            campaignDealStats[addonMapping.campaignDealId].revenue += paymentAmount;
            if (addonMapping.price > 0 && campaignDealStats[addonMapping.campaignDealId].sellingPrice == null) {
              campaignDealStats[addonMapping.campaignDealId].sellingPrice = Number(addonMapping.price);
            }
          }

          if (dateStr) {
            if (!dailyMap[dateStr]) dailyMap[dateStr] = makeDailyEntry();
            if (_ok) dailyMap[dateStr].orderKeys.add(_ok);
            dailyMap[dateStr].quantity += qty;
            dailyMap[dateStr].revenue += paymentAmount;

            const optionKey = resolveSalesReportOptionLabel(pName, oName);
            // 판매가격: 추가옵션은 매핑 단가가 없으므로 실주문 결제액÷수량으로 산출(절대가)
            const optionUnitPrice = qty > 0 ? Math.round(paymentAmount / qty) : 0;
            if (!dailyMap[dateStr].options[optionKey]) {
              dailyMap[dateStr].options[optionKey] = { price: optionUnitPrice, orderKeys: new Set<string>(), quantity: 0, revenue: 0 };
            } else if (!dailyMap[dateStr].options[optionKey].price && optionUnitPrice) {
              dailyMap[dateStr].options[optionKey].price = optionUnitPrice;
            }
            if (_ok) dailyMap[dateStr].options[optionKey].orderKeys.add(_ok);
            dailyMap[dateStr].options[optionKey].quantity += qty;
            dailyMap[dateStr].options[optionKey].revenue += paymentAmount;
          }
        }

        // 파이프라인 버킷 판정(추가구성 2차 패스도 본품과 동일 규칙 적용).
        const bucket = deriveOrderPipelineBucket(status, order.placeOrderStatus, poRequestedSet.has(String(order.productOrderId || '')));
        if (bucket === 'newBefore') {
          newOrderBeforeCount++;
          if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].newOrderBefore++;
        } else if (bucket === 'newAfter') {
          newOrderAfterCount++;
          if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].newOrderAfter++;
          if (orderTime > 0) {
            const delayDays = Math.floor((nowMs - orderTime) / 86400000);
            if (delayDays >= CONFIRM_DELAY_WARN_DAYS) {
              confirmDelayDays[delayDays] = (confirmDelayDays[delayDays] || 0) + 1;
              confirmOrders.push({
                productOrderId: String(order.productOrderId || ''),
                ordererName: order.ordererName || '',
                receiverName: order.shippingAddress?.name || '',
                optionName: resolveSalesReportOptionLabel(pName, oName),
                quantity: Number(order.quantity) || 1,
                paymentDate: orderTimeStr || null,
              });
            }
          }
        } else if (bucket === 'pending') {
          pendingCount++;
          if (!oldestPendingDate || orderTime < oldestPendingDate) oldestPendingDate = orderTime;
          if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].pending++;
          // 배송대기 지연 = 발주요청 후 경과(poRequestedAt) 기준(팝오버 '발주경과' 표시와 동일 클락).
          // 경고(≥임계값)만 카드 지연 배지 + 팝오버 목록에 함께 담는다(동일 집합, 파악 필요 건만).
          const _poId = String(order.productOrderId || '');
          const _poAt = poRequestedMap.get(_poId) || null;
          if (_poAt) {
            const poDelayDays = Math.floor((nowMs - _poAt.getTime()) / 86400000);
            if (poDelayDays >= PENDING_DELAY_WARN_DAYS) {
              pendingDelayDays[poDelayDays] = (pendingDelayDays[poDelayDays] || 0) + 1;
              pendingOrders.push({
                productOrderId: _poId,
                ordererName: order.ordererName || '',
                receiverName: order.shippingAddress?.name || '',
                optionName: resolveSalesReportOptionLabel(pName, oName),
                quantity: Number(order.quantity) || 1,
                paymentDate: orderTimeStr || null,
                poRequestedAt: _poAt.toISOString(),
              });
            }
          }
        } else if (bucket === 'shipping') {
          shippingCount++;
          if (!oldestShippingDate || orderTime < oldestShippingDate) oldestShippingDate = orderTime;
          if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].shipping++;
          if (orderTime > 0) {
            const delayDays = Math.floor((nowMs - orderTime) / 86400000);
            // 배송 지연 경고(≥임계값)만 카드 배지 카운트 + 팝오버 목록에 함께 담는다(동일 집합).
            if (delayDays >= SHIPPING_DELAY_WARN_DAYS) {
              shippingDelayDays[delayDays] = (shippingDelayDays[delayDays] || 0) + 1;
              shippingOrders.push({
                productOrderId: String(order.productOrderId || ''),
                ordererName: order.ordererName || '',
                receiverName: order.shippingAddress?.name || '',
                optionName: resolveSalesReportOptionLabel(pName, oName),
                quantity: Number(order.quantity) || 1,
                paymentDate: orderTimeStr || null,
              });
            }
          }
        } else if (bucket === 'completed') {
          completedCount++;
          if (dateStr && dailyMap[dateStr]) dailyMap[dateStr].completed++;
        }
      });

      const dailyStats = Object.keys(dailyMap)
        .sort((a, b) => b.localeCompare(a)) // 최신 날짜순 정렬
        .map(date => {
          const dateData = dailyMap[date];
          const optionsArray = Object.keys(dateData.options).map(optName => {
            const opt = dateData.options[optName];
            return {
              name: optName,
              price: opt.price,
              orders: opt.orderKeys.size,
              quantity: opt.quantity,
              revenue: opt.revenue,
              ratio: dateData.quantity > 0 ? (opt.quantity / dateData.quantity) * 100 : 0
            };
          });
          
          return {
            date,
            orders: dateData.orderKeys.size,
            quantity: dateData.quantity,
            revenue: dateData.revenue,
            // 주문일자 코호트 기준 취소·반품(취소일자 아님) — 매출보고 일자별 블록에서 순수치임을 명시.
            cancelQuantity: dateData.cancelQuantity,
            cancelRevenue: dateData.cancelRevenue,
            newOrderBefore: dateData.newOrderBefore,
            newOrderAfter: dateData.newOrderAfter,
            pending: dateData.pending,
            shipping: dateData.shipping,
            completed: dateData.completed,
            options: optionsArray
          };
        });

      // 마감취소 후 스냅샷 폴백: 활성이지만 라이브 유효주문이 0이고(판매기간 만료·조회창 밖 등) 이전
      // 마감 스냅샷이 있으면, 빈 라이브 대신 동결 스냅샷을 그대로 표시한다(오너 결정 2026-07-13).
      // isFrozenFallback 표식으로 클라가 "마감 시점 스냅샷" 안내를 띄운다. 실판매 0인 신규 활성 캠페인은
      // 스냅샷이 없어(hasFrozenSnapshot=false) 이 분기를 타지 않는다 — 정상적으로 빈 라이브를 보여준다.
      if (validOrderKeys.size === 0 && hasFrozenSnapshot(camp)) {
        return buildSnapshotResponse(camp, { isFrozenFallback: true });
      }

      return {
        ...camp,
        mappings: sortProductMappingsByProductName(camp.mappings ?? []),
        orderProvider: resolveProvider(camp),
        // 화면에 띄울 '판매기간'은 반드시 **집계 창 그대로**여야 한다. salePeriod(스토어 관측값)를 그냥
        // 보여주면, 스토어가 '임시 오픈'으로 열려 있을 때 표시와 집계가 갈라져 "화면 기간은 맞는데 매출만
        // 다르다"는 실사고(#170)가 재발한다. 창이 없으면(판매캠페인 미연결) salePeriod로 폴백한다 —
        // 그땐 컷오프도 salePeriod를 쓰므로 표시와 집계가 여전히 같은 값이다.
        periodLabel: formatKstPeriodLabel(campStartRaw, campEndRaw) ?? camp.salePeriod ?? null,
        // 연결된 판매캠페인들의 기간이 서로 달라 min~max 합성이 어느 딜에도 정확하지 않다는 신호(오너 결정: 경고만).
        periodMismatch: camp._periodMismatch === true,
        // 정산 확정으로 창이 얼어 판매관리 기간 변경이 반영되지 않는 상태(무응답을 드러내는 신호).
        periodFrozenDrift: camp._periodFrozenDrift === true,
        newOrderBeforeCount,
        newOrderAfterCount,
        pendingCount,
        shippingCount,
        completedCount,
        postPeriodOrderCount,
        // 최신 주문이 위로 오도록 정렬(운영자가 가장 최근 유입부터 확인). 카운트는 전량, 목록은 최대 100건.
        postPeriodOrders: postPeriodOrders
          .sort((a, b) => new Date(b.paymentDate || 0).getTime() - new Date(a.paymentDate || 0).getTime()),
        totalOrders,
        distinctOrderCount: validOrderKeys.size,
        totalQuantity,
        totalRevenue,
        dailyStats,
        insights: buildCampaignInsights(insightAcc, validOrderKeys.size),
        cancelReturnOrderIds,
        cancelReturnQuantity,
        cancelReturnAmount,
        oldestPendingDate,
        oldestShippingDate,
        lastOrderAt: lastOrderAt || null,
        pendingDelayDays,
        shippingDelayDays,
        confirmDelayDays,
        // 발주요청이 오래된 순(독촉 우선) — poRequestedAt 없으면 결제일, 둘 다 없으면 맨 뒤.
        pendingOrders: pendingOrders.sort((a, b) => {
          const ta = a.poRequestedAt ? new Date(a.poRequestedAt).getTime() : (a.paymentDate ? new Date(a.paymentDate).getTime() : Number.MAX_SAFE_INTEGER);
          const tb = b.poRequestedAt ? new Date(b.poRequestedAt).getTime() : (b.paymentDate ? new Date(b.paymentDate).getTime() : Number.MAX_SAFE_INTEGER);
          return ta - tb;
        }),
        // 배송 경과가 오래된 순(배송 지연 우선) — paymentDate(=orderTime) 없으면 맨 뒤.
        shippingOrders: shippingOrders.sort((a, b) => {
          const ta = a.paymentDate ? new Date(a.paymentDate).getTime() : Number.MAX_SAFE_INTEGER;
          const tb = b.paymentDate ? new Date(b.paymentDate).getTime() : Number.MAX_SAFE_INTEGER;
          return ta - tb;
        }),
        // 결제 경과가 오래된 순(발주 지연 우선) — paymentDate 없으면 맨 뒤.
        confirmOrders: confirmOrders.sort((a, b) => {
          const ta = a.paymentDate ? new Date(a.paymentDate).getTime() : Number.MAX_SAFE_INTEGER;
          const tb = b.paymentDate ? new Date(b.paymentDate).getTime() : Number.MAX_SAFE_INTEGER;
          return ta - tb;
        }),
      };
    });

    // 비동기로 CampaignDeal의 주문수/매출 갱신 후 부모 캠페인 재계산
    const syncCampaignDealStats = async () => {
      const updatedCampaignIds = new Set<string>();
      for (const dealId of Object.keys(campaignDealStats)) {
        const stat = campaignDealStats[dealId];
        // 명시적 매출전송(push) 경로에서 "매핑이 어긋나 매칭 라인이 아예 0건"인 딜만 덮어쓰기를 건너뛴다
        // (직전값·수동입력 보존 + "미매칭" 보고). matchedLines는 취소·반품 라인까지 세므로,
        // "매핑은 맞았는데 전부 취소돼 유효 0"(matchedLines>0 && orders===0)은 스킵하지 않고 0을 반영한다 —
        // 그래야 취소로 실매출이 0이 된 딜의 정산 합계가 낡은 값을 물지 않는다.
        // (GET 백그라운드 경로는 기존 동작 유지: 스코프를 push로 한정.)
        if (options.salesPushOrderCampaignId && shouldSkipDealPush(stat)) {
          options.salesPushOutcome?.unmatchedDealIds.push(dealId);
          continue;
        }
        const campaignId = await syncOrderCountToCampaignDeal(
          dealId,
          stat.quantity, // 정산데이터용 하위품목에는 주문건수가 아닌 주문수량 동기화
          stat.revenue,
          options.salesPushOrderCampaignId ? stat.sellingPrice : null,
        );
        if (campaignId) {
          updatedCampaignIds.add(campaignId);
          options.salesPushOutcome?.pushedDealIds.push(dealId);
        }
      }
      for (const campaignId of updatedCampaignIds) {
        await recalculateSalesCampaignTotals(campaignId);
      }
    };
    if (options.awaitSalesPush) {
      await syncCampaignDealStats();
    } else {
      void syncCampaignDealStats().catch((err) => {
        console.error('Failed to sync campaign deal stats or recalculate totals:', err);
      });
    }

    // 캠페인 기간 동기화는 **단방향**이다: 판매관리(SalesCampaign) → 주문캠페인 창(startDate/endDate).
    // 과거엔 스토어가 판매중/대기면 반대로 syncSalesCampaignPeriod(스토어 salePeriod → 판매캠페인)가
    // GET마다 돌아, 운영자가 판매관리에서 고친 기간이 다음 페이지 로드에 스토어 값으로 되돌아갔다.
    // 게다가 판매캠페인 기간은 정산서·구글 캘린더·재구매 집계가 전부 소비해서, '임시로 판매를 연' 스토어
    // 기간이 그쪽까지 오염시켰다. 정본이 판매관리로 확정된 이상 그 역방향은 존재하면 안 된다(오너 2026-07-15).
    //
    // salePeriod(스토어 관측값)는 여기서 쓰지 않는다 — 덮으면 '스토어엔 연장이 있는데 판매관리엔 없다'를
    // 감지할 근거가 사라진다. 그 불일치는 기간 후 주문 배지(postPeriodOrderCount)가 운영자에게 알린다.
    campaigns.forEach((camp: any) => {
      if (!camp._needsPeriodSyncToDB) return;
      prisma.orderCampaign.update({
        where: { id: camp.id },
        data: {
          startDate: camp.startDate,
          endDate: camp.endDate,
        },
      }).catch(err => console.error(`Failed to sync period TO order campaign ${camp.id}:`, err));
    });

    return NextResponse.json(campaignsWithStats, {
      headers: {
        'X-Naver-Last-Sync': lastSyncIso || '',
        'X-Naver-Syncing': isSyncing ? '1' : '0',
        'X-Naver-Sync-Type': syncTypeHeader || '',
      },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: (error as Error).message || 'Failed to fetch campaigns' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const data = await req.json();
    const campaign = await prisma.orderCampaign.create({
      data: {
        name: data.name,
        template: data.template || null, // Optional
        sellerName: data.sellerName,
        toEmail: data.toEmail || null,
        ccEmail: data.ccEmail || null,
        thumbnailUrl: data.thumbnailUrl || null,
        category: data.category || null,
        productStatus: data.productStatus || null,
        salePeriod: data.salePeriod || null,
        productId: data.productId || null,
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
        ...(data.mappings && data.mappings.length > 0 && {
          mappings: {
            create: sortProductMappingsByProductName(data.mappings).map((m: any) => ({
              productName: m.productName || '',
              optionName: m.optionName || '',
              brandCode: m.brandCode || '',
              price: Number(m.price) || 0
            }))
          }
        })
      },
      include: {
        mappings: true
      }
    });

    // 비동기로 자동 매핑 수행 및 주문 동기화 수행
    autoMapOrderCampaign(campaign.id)
      .then(() => fetchAndSyncCampaigns(false))
      .catch(e => console.error("Auto-mapping or sync failed:", e));

    return NextResponse.json({
      ...campaign,
      mappings: sortProductMappingsByProductName(campaign.mappings),
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: (error as Error).message || 'Failed to create campaign' }, { status: 500 });
  }
}
