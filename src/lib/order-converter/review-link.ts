import { getPrisma } from '@/lib/prisma';

/**
 * 리뷰 소스 링크 판정 — leaf 모듈(의존: prisma뿐).
 *
 * pickShortLink·판정 로직을 review-collect.ts에서 분리한 이유: 조회 경로(voc-store — I1 계약)와
 * 캠페인 쓰기 경로(campaigns 라우트·campaignService)가 이 판정을 공유하는데, review-collect를
 * 직접 import하면 ① voc-store와 순환(review-collect→voc-store) ② Playwright 의존이 조회·쓰기
 * 번들에 유입된다. review-collect가 re-export해 기존 소비처 API는 그대로다(#191 leaf 이전 선례).
 */

/** 딜의 캠페인 링크들에서 진입에 쓸 mkt.shopping 단축링크를 고른다(순수). 직접 URL은 로그인 벽. */
export function pickShortLink(links: (string | null | undefined)[]): string | null {
  for (const l of links) {
    if (typeof l === 'string' && /mkt\.shopping\.naver\.com\/link\//.test(l)) return l;
  }
  return null;
}

/** needsReviewSourceLink 입력 — 딜 하나의 리뷰 소스 신호 4종. */
export type DealReviewSourceSignal = {
  /** DealStoreLink.status(RESOLVED|FAILED). null=해석 이력 없음(다음 크론이 시도) */
  storeLinkStatus: string | null;
  /** OrderCampaign.productId(원상품번호) 연결 캠페인 보유 — 주문검증 소스 */
  productIdMatched: boolean;
  /** 캠페인 baseNaverLink 중 mkt.shopping 단축링크 보유 — 로그인벽을 통과하는 유일 진입 */
  hasShortLink: boolean;
  /** DealVocSource 리뷰 합계 — >0이면 소스가 이미 작동 중 */
  reviewCount: number;
};

/**
 * "리뷰 소스 없음 — 상품 링크 필요" 판정(순수). 오너 데이터 경로 ② 스펙:
 * FAILED(전 티어 해석 실패) 또는 (productId 미매칭 && 단축링크 없음 && 리뷰 0).
 *
 * RESOLVED여도 단축링크가 없으면 둘째 절에 걸리는 게 의도다 — 이름매칭(Tier-2)으로 "연결"은
 * 됐지만 수집 진입이 직접 URL→로그인벽이라 리뷰가 0으로 남는 실측 코호트(#43)가 정확히 이
 * 상태다. 단, 묶음 리스팅을 공유하는 딜이 링크를 갖고 있어 리뷰가 배분되면 reviewCount>0으로
 * 첫 절에서 꺼진다(정직한 공유 — 오탐 아님).
 */
export function needsReviewSourceLink(s: DealReviewSourceSignal): boolean {
  if (s.reviewCount > 0) return false;
  if (s.storeLinkStatus === 'FAILED') return true;
  return !s.productIdMatched && !s.hasShortLink;
}

/**
 * 캠페인 저장에서 DealStoreLink 리셋이 필요한 딜 id들(순수). 상품 링크가 실제로 바뀌었거나
 * 캠페인이 다른 딜로 재배정되면(링크가 그 딜로 따라감) 관련 딜 전부를 반환한다.
 * 변경 없음 = 빈 배열(폼 재제출로 같은 값이 와도 캐시를 안 건드린다).
 */
export function dealStoreLinkResetTargets(
  previous: { dealId: string; baseNaverLink: string | null },
  next: { dealId?: string; baseNaverLink?: string },
): string[] {
  const linkChanged = next.baseNaverLink !== undefined && next.baseNaverLink !== previous.baseNaverLink;
  const dealChanged = next.dealId !== undefined && next.dealId !== previous.dealId;
  if (!linkChanged && !dealChanged) return [];
  const ids = new Set<string>([previous.dealId]);
  if (next.dealId) ids.add(next.dealId);
  return Array.from(ids);
}

/** 오너 액션 가치가 없는 터미널 딜 상태 — 배지·힌트를 켜지 않는다(ss-ux Q4 판정, 두 표면 공용 게이트). */
const TERMINAL_DEAL_STATUSES = new Set(['ARCHIVED', 'DROPPED']);

/**
 * 딜 목록/상세 배지용 배치 판정 — 신호 4종을 쿼리 4개로 모아 딜별 needsReviewSourceLink를
 * 평가한다. 캠페인이 하나도 없는 딜은 제외한다(수집 파이프라인의 해석 대상 자체가
 * salesCampaign 행에서 나오므로, 캠페인 0 딜에 배지를 켜면 영구 오탐이 된다).
 * 터미널 상태(완료·보류) 딜도 제외한다 — "액션 가능" 신호의 신뢰를 지키는 서버 단일 게이트
 * (표면마다 상태 필터를 재구현하지 않는다).
 */
export async function findDealsNeedingReviewLink(dealIds: string[]): Promise<Set<string>> {
  if (dealIds.length === 0) return new Set();
  const prisma = getPrisma();
  const [links, campaigns, vocSources, dealRows] = await Promise.all([
    prisma.dealStoreLink.findMany({
      where: { dealId: { in: dealIds } },
      select: { dealId: true, status: true },
    }),
    prisma.salesCampaign.findMany({
      where: { dealId: { in: dealIds } },
      select: { dealId: true, baseNaverLink: true, orderCampaign: { select: { productId: true } } },
    }),
    prisma.dealVocSource.findMany({
      where: { dealId: { in: dealIds } },
      select: { dealId: true, reviewCount: true },
    }),
    prisma.deal.findMany({
      where: { id: { in: dealIds } },
      select: { id: true, status: true },
    }),
  ]);

  const statusByDeal = new Map(links.map((l) => [l.dealId, l.status]));
  const dealsWithCampaign = new Set<string>();
  const dealsWithShortLink = new Set<string>();
  const dealsWithProductId = new Set<string>();
  for (const c of campaigns) {
    dealsWithCampaign.add(c.dealId);
    if (pickShortLink([c.baseNaverLink])) dealsWithShortLink.add(c.dealId);
    if (c.orderCampaign?.productId) dealsWithProductId.add(c.dealId);
  }
  const reviewCountByDeal = new Map<string, number>();
  for (const s of vocSources) {
    reviewCountByDeal.set(s.dealId, (reviewCountByDeal.get(s.dealId) ?? 0) + (s.reviewCount || 0));
  }

  const dealStatusById = new Map(dealRows.map((d) => [d.id, d.status]));

  const out = new Set<string>();
  for (const id of dealIds) {
    if (!dealsWithCampaign.has(id)) continue;
    const dealStatus = dealStatusById.get(id);
    if (!dealStatus || TERMINAL_DEAL_STATUSES.has(dealStatus)) continue;
    const needs = needsReviewSourceLink({
      storeLinkStatus: statusByDeal.get(id) ?? null,
      productIdMatched: dealsWithProductId.has(id),
      hasShortLink: dealsWithShortLink.has(id),
      reviewCount: reviewCountByDeal.get(id) ?? 0,
    });
    if (needs) out.add(id);
  }
  return out;
}
