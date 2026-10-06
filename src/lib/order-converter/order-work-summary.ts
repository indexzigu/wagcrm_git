// 홈 「오늘 처리할 주문」 카드 + 사이드바 「주문 관리」 배지의 데이터 로더(서버 전용).
//
// ⛔ **네이버 호출 0** — 저장된 스냅샷(NaverOrderSnapshot)·발주요청 기록(OrderFulfillmentState)·
// DB 만 읽는다(발주 자동화 1단계 설계, 오너 승인 2026-10-06: 상위 목표가 프록시 하루 요청 수 절약).
// 그래서 주문 관리 핸들러(`fetchAndSyncCampaigns`)를 부르지 않는다 — 그쪽은 스토어 기간 재동기화
// (`searchNaverProducts`)·스냅샷 전무 시 FULL 부트스트랩·진입 동기화(after)를 태운다.
//
// 대신 **판정은 주문 관리 카드와 같은 함수**를 탄다(화면이 판정을 손으로 다시 쓰다 갈라지는 것이
// 이 레포의 반복 결함 유형이다):
//  · 조회 범위   `resolveActiveCampaignsQueryStart` → `resolveLiveWindowKeys`
//  · 주문 데이터 `hydrateSnapshotL1`(주문 관리 카드와 같은 프로세스 메모리 사본 — 블롭은 바뀐 날짜만)
//  · 집계 창     `resolveLiveOrderCampaignWindow` → `resolveSaleWindowStartMs/EndMs`
//  · 귀속        `collectCampaignAttributedOrders`(campaign-match)
//  · 버킷·지연   `classifyOrderWork`(order-work)
//  · 클레임      `loadClaimSourceOrders` → `deriveClaims` → `isCompleted` 아닌 것
//  · 기준 시각   `resolveLastOrderSyncIso`(주문 관리 툴바 「마지막 동기화」와 같은 값)
//
// 실패는 삼키지 않는다 — 주문 관리 카드는 낡은 L1·빈 발주요청 집합으로 계속 그리지만(그 화면엔
// 원본 목록이 함께 있다), 이 요약은 숫자 하나가 전부라 틀린 숫자보다 오류 표시가 낫다.

import { prisma } from '@/lib/order-converter/prisma';
import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';
import { orderFulfillmentRepository } from '@/repositories/orderFulfillmentRepository';
import { resolveLiveWindowKeys } from '@/lib/order-converter/daily-aggregate';
import {
  resolveActiveCampaignsQueryStart,
  resolveLiveOrderCampaignWindow,
  resolveSaleWindowEndMs,
  resolveSaleWindowStartMs,
} from '@/lib/order-converter/sale-window';
import { getSnapshotL1Cache, hydrateSnapshotL1 } from '@/lib/order-converter/snapshot-l1-cache';
import { collectCampaignAttributedOrders, type PeerCampaignWindow } from '@/lib/order-converter/campaign-match';
import {
  classifyOrderWork,
  summarizeOrderWork,
  type CampaignOrderWork,
  type OrderWorkSummary,
} from '@/lib/order-converter/order-work';
import { deriveClaims } from '@/lib/order-converter/claim-derive';
import {
  loadClaimSourceOrders,
  resolveClaimWindowKeys,
  toClaimCampaignCandidates,
} from '@/lib/order-converter/claim-source-loader';
import { getLastChangeSyncMs, resolveLastOrderSyncIso } from '@/lib/order-converter/order-auto-sync';

export type { OrderWorkSummary };

const LOG_TAG = 'order-work-summary';

/** 'YYYY-MM-DD' 범위의 날짜키(양끝 포함). */
function enumerateDateKeys(startKey: string, endKey: string): string[] {
  const keys: string[] = [];
  const cursor = new Date(`${startKey}T00:00:00.000Z`);
  const end = new Date(`${endKey}T00:00:00.000Z`).getTime();
  // 폭주 가드는 resolveLiveWindowKeys 의 절대 상한이 이미 건다 — 여기는 그 범위를 펼치기만 한다.
  while (cursor.getTime() <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

export async function loadOrderWorkSummary(now: Date = new Date()): Promise<OrderWorkSummary> {
  const nowMs = now.getTime();

  // 주문 관리 카드가 귀속·창 판정에 읽는 필드만(블롭·딜 관계 없음).
  const activeCampaigns = await prisma.orderCampaign.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      productId: true,
      startDate: true,
      endDate: true,
      salePeriod: true,
      mappings: { select: { productName: true, optionName: true } },
      salesCampaigns: { select: { startDate: true, endDate: true, status: true } },
    },
  });

  const campaignWork: CampaignOrderWork[] = [];
  let hasSnapshot = false;

  if (activeCampaigns.length > 0) {
    const { startMs } = resolveActiveCampaignsQueryStart(activeCampaigns, nowMs);
    const { startKey, todayKey } = resolveLiveWindowKeys(startMs, now, LOG_TAG);

    const { metaCount } = await hydrateSnapshotL1(startKey, todayKey, LOG_TAG);
    hasSnapshot = metaCount > 0;
    const l1 = getSnapshotL1Cache();
    const orders: any[] = [];
    for (const key of enumerateDateKeys(startKey, todayKey)) {
      const entry = l1[key];
      if (entry?.orders) orders.push(...entry.orders);
    }

    const poRequestedMap = await orderFulfillmentRepository.getPoRequestedMap(
      orders.map((o) => o?.productOrderId).filter(Boolean),
    );

    const windowed = activeCampaigns.map((camp) => {
      const live = resolveLiveOrderCampaignWindow(camp);
      const withWindow = { ...camp, startDate: live.startDate, endDate: live.endDate };
      return {
        camp: withWindow,
        windowStartMs: resolveSaleWindowStartMs(withWindow),
        windowEndMs: resolveSaleWindowEndMs(withWindow),
      };
    });

    for (const { camp, windowStartMs, windowEndMs } of windowed) {
      const peers: PeerCampaignWindow[] = windowed
        .filter((other) => other.camp.id !== camp.id)
        .map((other) => ({
          id: other.camp.id,
          name: other.camp.name,
          windowStartMs: other.windowStartMs,
          windowEndMs: other.windowEndMs,
        }));
      const attributed = collectCampaignAttributedOrders(
        orders,
        camp,
        windowStartMs ?? 0,
        windowEndMs ?? Number.MAX_SAFE_INTEGER,
        peers,
      );
      campaignWork.push({
        campaignId: camp.id,
        classifications: attributed.map(({ order, orderTimeMs }) =>
          classifyOrderWork({
            productOrderStatus: order.productOrderStatus,
            placeOrderStatus: order.placeOrderStatus,
            poRequestedAt: poRequestedMap.get(String(order.productOrderId || '')) || null,
            orderTimeMs,
            nowMs,
          }),
        ),
      });
    }
  }

  // 진행 중 클레임 — 주문 관리 「반품/교환 N」 버튼과 같은 창·소스·후보·판정.
  const { startDateKey, endDateKey } = resolveClaimWindowKeys(now);
  const claimOrders = await loadClaimSourceOrders(startDateKey, endDateKey, LOG_TAG);
  const openClaims = deriveClaims(claimOrders, toClaimCampaignCandidates(activeCampaigns)).filter(
    (claim) => !claim.isCompleted,
  );

  const [lastChangeSyncMs, syncMeta] = await Promise.all([
    getLastChangeSyncMs(),
    naverOrderSnapshotRepository.latestSyncMeta(),
  ]);

  return {
    ...summarizeOrderWork(campaignWork, openClaims),
    lastSyncAt: resolveLastOrderSyncIso(lastChangeSyncMs, syncMeta?.lastCallTime ?? null),
    activeCampaignCount: activeCampaigns.length,
    hasSnapshot,
  };
}
