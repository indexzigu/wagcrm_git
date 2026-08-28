import { NextRequest, NextResponse } from 'next/server';
import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';
import { toDateKeyKst } from '@/lib/order-converter/naver-order-sync';
import {
  deriveClaims,
  extractClaimSourceOrders,
  parseSnapshotClaimSource,
  type DerivedClaim,
  type CampaignMatchInfo,
} from '@/lib/order-converter/claim-derive';
import { resolveCompanyName } from '@/lib/order-converter/naver-return-delivery';
import { prisma } from '@/lib/order-converter/prisma';

/** egress 계측용 근사 바이트 — DB에서 받은 값을 JSON 직렬화한 utf8 길이. */
function approxJsonBytes(value: unknown): number {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.byteLength(text ?? '', 'utf8');
}

// B2-3: read-only GET. 스냅샷(DB)에서만 읽는다 — 네이버 API를 동기 대기하지 않는다
// (마스터 택배사 lazy fetch는 예외적으로 허용, naver-return-delivery.ts가 24h 캐시로 흡수).
// ?debug=1이면 raw __claim 원본을 포함해 반환한다(실응답 필드 확정용, R3).
//
// egress 절감(2026-07-21, P7): 종전에는 findRange로 30일 orders 블롭 전량(회당 3.94MB
// 실측)을 읽어 read-path 파생했다 — 이 라우트가 Supabase 풀러 egress의 최대 지분이었다.
// 이제 동기화가 쓰기 시점에 저장한 claimSource(클레임 보유 주문 최소 프로젝션)만 읽고,
// 미가용 행(레거시 null·{v:0}·버전 불일치)만 그 날짜 블롭을 폴백으로 읽어 동일
// SSOT(extractClaimSourceOrders → deriveClaims)로 파생한다 — 두 경로 수치는 일치한다.
export async function GET(request: NextRequest) {
  const debug = request.nextUrl.searchParams.get('debug') === '1';

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startDateKey = toDateKeyKst(thirtyDaysAgo);
    const endDateKey = toDateKeyKst(now);

    const sourceRows = await naverOrderSnapshotRepository.findRangeClaimSources(
      startDateKey,
      endDateKey,
    );

    const claimOrders: any[] = [];
    const fallbackDates: string[] = [];
    let sourceBytes = 0;
    for (const row of sourceRows) {
      sourceBytes += approxJsonBytes(row.claimSource);
      const projected = parseSnapshotClaimSource(row.claimSource);
      if (projected) claimOrders.push(...projected);
      else fallbackDates.push(row.snapshotDate);
    }

    let fallbackBytes = 0;
    if (fallbackDates.length > 0) {
      const blobRows = await naverOrderSnapshotRepository.findByDates(fallbackDates);
      for (const snapshot of blobRows) {
        fallbackBytes += approxJsonBytes(snapshot.orders);
        const orders = naverOrderSnapshotRepository.parseOrders(snapshot);
        if (Array.isArray(orders)) claimOrders.push(...extractClaimSourceOrders(orders));
      }
    }

    // L3 계측(착지 후 대시보드 기울기 검증용) — 이 라우트가 DB에서 실제로 당긴 근사 바이트.
    console.log(
      `[egress] claims: rows=${sourceRows.length} sourceBytes=${sourceBytes} fallbackRows=${fallbackDates.length} fallbackBytes=${fallbackBytes}`,
    );

    // 경량 캠페인 매칭 후보 — productId + 판매기간으로 서버 집계(campaigns route)와 동일하게 귀속한다.
    // (상품명 fuzzy는 productId 없는 캠페인/주문 폴백으로만.) 실패해도 클레임 조회는 계속돼야 하므로 별도 try/catch.
    let campaignCandidates: CampaignMatchInfo[] = [];
    try {
      const campaigns = await prisma.orderCampaign.findMany({
        where: { isActive: true },
        select: { name: true, productId: true, startDate: true, endDate: true },
      });
      campaignCandidates = campaigns
        .filter((c) => c.name)
        .map((c) => ({ name: c.name, productId: c.productId, startDate: c.startDate, endDate: c.endDate }));
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
        const base = { ...claim, collectDeliveryCompanyName };
        if (!debug) {
          const { raw, ...rest } = base;
          void raw;
          return rest;
        }
        return base;
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
