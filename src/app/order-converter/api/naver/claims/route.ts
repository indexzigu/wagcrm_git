import { NextRequest, NextResponse } from 'next/server';
import { withProxySource } from '@/lib/order-converter/proxy-usage';
import {
  deriveClaims,
  maskClaimForClient,
  redactPersonalValues,
  type DerivedClaim,
  type CampaignMatchInfo,
} from '@/lib/order-converter/claim-derive';
import {
  loadClaimSourceOrders,
  resolveClaimWindowKeys,
  toClaimCampaignCandidates,
} from '@/lib/order-converter/claim-source-loader';
import { resolveCompanyName } from '@/lib/order-converter/naver-return-delivery';
import { prisma } from '@/lib/order-converter/prisma';

// B2-3: read-only GET. 스냅샷(DB)에서만 읽는다 — 네이버 API를 동기 대기하지 않는다
// (마스터 택배사 lazy fetch는 예외적으로 허용, naver-return-delivery.ts가 24h 캐시로 흡수).
// ?debug=1이면 raw __claim 원본을 포함해 반환한다(실응답 필드 확정용, R3).
//
// egress 절감(2026-07-21, P7): 종전에는 findRange로 30일 orders 블롭 전량(회당 3.94MB
// 실측)을 읽어 read-path 파생했다 — 이 라우트가 Supabase 풀러 egress의 최대 지분이었다.
// 이제 동기화가 쓰기 시점에 저장한 claimSource(클레임 보유 주문 최소 프로젝션)만 읽고,
// 미가용 행(레거시 null·{v:0}·버전 불일치)만 그 날짜 블롭을 폴백으로 읽어 동일
// SSOT(extractClaimSourceOrders → deriveClaims)로 파생한다 — 두 경로 수치는 일치한다.
// 창·소스 읽기·캠페인 후보는 claim-source-loader SSOT — 홈 「오늘 처리할 주문」 요약과 공유한다.
// 이 요청 안에서 나가는 프록시(Fixie) 요청을 경로별 일 집계에서 claims 로 센다(proxy-usage.ts).
export const GET = withProxySource('claims', handleClaimsGet);

async function handleClaimsGet(request: NextRequest) {
  const debug = request.nextUrl.searchParams.get('debug') === '1';

  try {
    const { startDateKey, endDateKey } = resolveClaimWindowKeys(new Date());
    const claimOrders = await loadClaimSourceOrders(startDateKey, endDateKey, 'claims');

    // 경량 캠페인 매칭 후보 — productId + 판매기간으로 서버 집계(campaigns route)와 동일하게 귀속한다.
    // (상품명 fuzzy는 productId 없는 캠페인/주문 폴백으로만.) 실패해도 클레임 조회는 계속돼야 하므로 별도 try/catch.
    let campaignCandidates: CampaignMatchInfo[] = [];
    try {
      const campaigns = await prisma.orderCampaign.findMany({
        where: { isActive: true },
        select: { name: true, productId: true, startDate: true, endDate: true },
      });
      campaignCandidates = toClaimCampaignCandidates(campaigns);
    } catch (campaignErr) {
      console.warn('[api/naver/claims] 캠페인 후보 조회 실패 — 매칭 없이 진행:', campaignErr);
    }

    const claims: DerivedClaim[] = deriveClaims(claimOrders, campaignCandidates);

    // 택배사 코드 → 이름 변환. 실패해도(폴백) 코드 원문이 그대로 남으므로 무해하다.
    const claimsWithCompanyName = await Promise.all(
      claims.map(async (claim) => {
        const collectDeliveryCompanyName = claim.collectDeliveryCompanyCode
          ? await resolveCompanyName(claim.collectDeliveryCompanyCode)
          : null;
        // 연락처는 원문 대신 뒷 4자리만 내보낸다(화면은 *** 후 클릭 시 공개).
        const base = { ...maskClaimForClient(claim), collectDeliveryCompanyName };
        if (!debug) {
          const { raw, ...rest } = base;
          void raw;
          return rest;
        }
        // debug는 실응답 필드명 확정용(R3)이다 — 키 구조는 보이되 이름·연락처·주소 값은 가린다.
        return { ...base, raw: redactPersonalValues(base.raw) };
      }),
    );

    return NextResponse.json({
      data: claimsWithCompanyName,
      count: claimsWithCompanyName.length,
      rangeStart: startDateKey,
      rangeEnd: endDateKey,
    });
  } catch (error) {
    console.error('[api/naver/claims] Unexpected error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
