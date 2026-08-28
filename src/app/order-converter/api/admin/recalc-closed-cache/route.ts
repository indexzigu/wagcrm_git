import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/order-converter/prisma';
import { apiRequest } from '@/lib/order-converter/naver-commerce-client';
import { orderFulfillmentRepository } from '@/repositories/orderFulfillmentRepository';
import {
  computeClosedCampaignCache,
  fetchClosedCampaignOrders,
  resolveClosedCampaignPeriod,
} from '@/lib/order-converter/closed-campaign-cache';

/**
 * 마감(비활성) 캠페인 통계 캐시 재계산 백필 — prod 런타임 전용(네이버 커머스 크레덴셜이 있는 곳).
 *
 * 로컬 .env에는 NAVER_CLIENT_ID/SECRET이 없어(Vercel sensitive) 스크립트로는 prod에서 못 돈다.
 * 이 라우트는 마감 라우트와 동일한 SSOT(closed-campaign-cache)로 재계산한다.
 *
 *   GET  ?name=&limit=            → dry-run(쓰기 없음). before/after diff 반환.
 *   POST { name?, limit?, allowZero? } → 변화분 DB 반영.
 *
 * 안전장치: fetch 전체 실패 시 해당 캠페인 스킵(lib에서 throw), 이전 비영(非零) 캐시가 전부 0으로
 * 바뀌는 건 조회 누락 의심으로 allowZero 없이는 쓰지 않는다. requireAuth(admin 세션)로 보호.
 */

export const maxDuration = 300;

type Row = {
  id: string;
  name: string;
  fetched: number;
  skippedReason?: string;
  before: { distinctOrders: number; totalOrders: number; quantity: number; revenue: number };
  after: { distinctOrders: number; totalOrders: number; quantity: number; revenue: number };
  changed: boolean;
  applied: boolean;
};

async function run(opts: { apply: boolean; name: string; limit: number; allowZero: boolean }) {
  let campaigns = await prisma.orderCampaign.findMany({
    where: { isActive: false },
    include: { mappings: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (opts.name) campaigns = campaigns.filter((c: any) => (c.name || '').includes(opts.name));
  if (opts.limit > 0) campaigns = campaigns.slice(0, opts.limit);

  // 교차 귀속 가드용 peer — 필터(name/limit)와 무관하게 전 캠페인을 넘긴다. 대상만 넘기면
  // 필터에 따라 같은 캠페인이 다른 수치로 재계산되는 비결정성이 생긴다.
  const peerCampaigns = await prisma.orderCampaign.findMany({ select: { id: true, name: true, startDate: true, endDate: true, salePeriod: true } });

  const now = new Date();
  const rows: Row[] = [];
  let changed = 0, applied = 0, skipped = 0;

  for (const camp of campaigns as any[]) {
    const before = {
      distinctOrders: camp.cachedDistinctOrderCount ?? 0,
      totalOrders: camp.cachedTotalOrders ?? 0,
      quantity: camp.cachedTotalQuantity ?? 0,
      revenue: camp.cachedTotalRevenue ?? 0,
    };
    const { start, end } = resolveClosedCampaignPeriod(camp);
    if (!start) {
      rows.push({ id: camp.id, name: camp.name, fetched: 0, skippedReason: '판매기간(start) 불명', before, after: before, changed: false, applied: false });
      skipped++; continue;
    }

    const fetchNow = end ? new Date(Math.min(now.getTime(), end.getTime() + 86400000)) : now;
    let recentOrders: any[] = [];
    try {
      recentOrders = await fetchClosedCampaignOrders(start, apiRequest, { now: fetchNow });
    } catch (e: any) {
      rows.push({ id: camp.id, name: camp.name, fetched: 0, skippedReason: `주문 조회 실패: ${e?.message || e}`, before, after: before, changed: false, applied: false });
      skipped++; continue;
    }

    let poRequestedSet = new Set<string>();
    try {
      poRequestedSet = await orderFulfillmentRepository.getPoRequestedSet(
        recentOrders.map((o: any) => o?.productOrderId).filter(Boolean),
      );
    } catch { /* 빈 집합 폴백 */ }

    const next = computeClosedCampaignCache(camp, recentOrders, poRequestedSet, { start, end }, peerCampaigns);
    const after = {
      distinctOrders: next.cachedDistinctOrderCount,
      totalOrders: next.cachedTotalOrders,
      quantity: next.cachedTotalQuantity,
      revenue: next.cachedTotalRevenue,
    };
    // 인사이트 스냅샷 백필: 숫자 캐시는 이미 맞아도 cachedInsights가 비어있던 과거 마감 캠페인은
    // 여기서 처음 채운다(숫자 무변화라도 insights 신규 → 변경으로 취급). fetch가 실제로 주문을
    // 가져온 경우에만(빈 스냅샷 덮어쓰기 방지) 트리거한다.
    const insightsBackfill = camp.cachedInsights == null && recentOrders.length > 0;
    const isChanged = before.distinctOrders !== after.distinctOrders || before.totalOrders !== after.totalOrders ||
      before.quantity !== after.quantity || before.revenue !== after.revenue || insightsBackfill;

    const wouldZeroOut = (before.quantity > 0 || before.revenue > 0 || before.totalOrders > 0) &&
      after.quantity === 0 && after.revenue === 0 && after.totalOrders === 0;
    if (wouldZeroOut && !opts.allowZero) {
      rows.push({ id: camp.id, name: camp.name, fetched: recentOrders.length, skippedReason: '이전 비영 캐시 → 전부 0(조회 누락 의심, allowZero 필요)', before, after, changed: isChanged, applied: false });
      skipped++; continue;
    }

    let didApply = false;
    if (opts.apply && isChanged) {
      await prisma.orderCampaign.update({ where: { id: camp.id }, data: next as any });
      didApply = true; applied++;
    }
    if (isChanged) changed++;
    rows.push({ id: camp.id, name: camp.name, fetched: recentOrders.length, before, after, changed: isChanged, applied: didApply });
  }

  return {
    mode: opts.apply ? 'apply' : 'dry-run',
    targets: campaigns.length,
    changed,
    applied,
    skipped,
    unchanged: campaigns.length - changed - skipped,
    rows,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  const q = request.nextUrl.searchParams;
  try {
    const result = await run({
      apply: false,
      name: q.get('name') || '',
      limit: Number(q.get('limit') || '0'),
      allowZero: false,
    });
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[recalc-closed-cache][GET] failed:', error);
    return NextResponse.json({ error: error?.message || '재계산 dry-run 실패' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  let body: any = {};
  try { body = await request.json(); } catch { /* 빈 바디 허용 */ }
  try {
    const result = await run({
      apply: true,
      name: typeof body.name === 'string' ? body.name : '',
      limit: Number(body.limit || 0),
      allowZero: body.allowZero === true,
    });
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[recalc-closed-cache][POST] failed:', error);
    return NextResponse.json({ error: error?.message || '재계산 반영 실패' }, { status: 500 });
  }
}
