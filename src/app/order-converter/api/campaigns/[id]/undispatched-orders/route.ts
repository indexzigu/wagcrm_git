import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/order-converter/prisma';
import { requireAuth } from '@/lib/api-auth';
import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';
import { orderFulfillmentRepository } from '@/repositories/orderFulfillmentRepository';
import {
  buildUndispatchedRows,
  resolveCampaignWindowMs,
} from '@/lib/order-converter/undispatched-orders';
import { resolveLiveWindowKeys } from '@/lib/order-converter/daily-aggregate';

// 발송지연 안내 대상 조회 — 이 캠페인에 귀속된 "미발송" 주문(newBefore/newAfter/pending)을
// 스냅샷(NaverOrderSnapshot)에서 읽어 반환한다. 네이버 API를 호출하지 않는 순수 읽기 경로
// (대시보드 GET과 동일한 read-only 원칙). 판정 로직은 undispatched-orders.ts(순수 함수)로 고립.
//
// 조회 창은 **캠페인 창**이 정한다(P7 Campaign Period SSOT) — 절대 상한은 폭주 가드로만 남고
// 판정은 resolveLiveWindowKeys(daily-aggregate SSOT, 대시보드·모바일과 공용)에 위임한다.
// ⛔ 종전 서술 "알려진 한계: 스냅샷 보존창(최근 30일)을 따라간다"는 한계가 아니라 **결함**이었다:
// `Math.max(캠페인 시작, now − 30일)` 이라 캠페인 시작일은 고정인데 하한이 매일 전진해,
// 30일 넘게 미발송으로 남은 주문이 이 목록에서 **조용히 사라졌다**(발송지연 안내 대상 누락 —
// 오래 묵은 건일수록 먼저 사라지므로 정확히 가장 급한 주문부터 없어진다).

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const { id } = await params;
    const campaign = await prisma.orderCampaign.findUnique({
      where: { id },
      include: { mappings: true },
    });
    if (!campaign) {
      return NextResponse.json({ error: '캠페인을 찾을 수 없습니다.' }, { status: 404 });
    }

    // 스냅샷 조회 범위: 캠페인 시작일 ~ 오늘. 시작일 불명이면 상한 창으로 떨어진다.
    const now = new Date();
    const { startMs } = resolveCampaignWindowMs(campaign);
    const { startKey, todayKey: endKey } = resolveLiveWindowKeys(
      startMs > 0 ? Math.min(startMs, now.getTime()) : NaN,
      now,
      'undispatched-orders',
    );

    const snapshots = await naverOrderSnapshotRepository.findRange(startKey, endKey);
    const orders: any[] = [];
    for (const snapshot of snapshots) {
      const parsed = naverOrderSnapshotRepository.parseOrders(snapshot) as any[];
      if (Array.isArray(parsed)) orders.push(...parsed);
    }

    // 배송대기(=발주요청됨) 판정용 poRequested 집합 — 실패 시 빈 집합 폴백(대시보드와 동일 규칙:
    // 배송대기는 보수적으로 0으로 잡히고, 신규 버킷 판정은 네이버 상태만으로 계속된다).
    let poRequestedSet = new Set<string>();
    try {
      poRequestedSet = await orderFulfillmentRepository.getPoRequestedSet(
        orders.map((o: any) => o?.productOrderId).filter(Boolean),
      );
    } catch (err) {
      console.warn('[undispatched-orders] poRequested 집합 로드 실패 — 네이버 상태만으로 판정:', err);
    }

    const rows = buildUndispatchedRows(orders, campaign, poRequestedSet);

    return NextResponse.json({
      campaignId: id,
      campaignName: campaign.name,
      count: rows.length,
      rows,
    });
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[undispatched-orders] 조회 실패:', msg);
    return NextResponse.json({ error: msg || '미발송 주문 조회에 실패했습니다.' }, { status: 500 });
  }
}
