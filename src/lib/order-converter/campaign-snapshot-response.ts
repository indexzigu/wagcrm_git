// 마감 캠페인의 응답 모양 SSOT(순수 — prisma·네이버 없음).
//
// 마감(`isActive=false`) 캠페인은 라이브 집계를 돌리지 않고 **마감 시점에 얼려 둔 캐시 컬럼**을
// 그대로 응답 필드로 옮긴다. 종전에는 이 매핑이 `campaigns-handler.fetchAndSyncCampaigns` 의
// 클로저 안에만 있어서 목록 응답 말고는 같은 모양을 만들 길이 없었다 — 접힌 캠페인을 펼칠 때
// 쓰는 단건 조회(`GET /order-converter/api/campaigns/[id]`)가 생기며 두 번째 소비처가 됐다.
//
// ⛔ 호출부에서 이 매핑을 손으로 다시 쓰지 말 것. 사본이 갈리면 목록에서 본 수치와 펼친 뒤 수치가
// 달라지는데, 둘을 나란히 볼 일이 없어 **아무도 눈치채지 못한다**(이 레포에 반복된 실패 형태).

import { formatKstPeriodLabel, resolveSaleWindowEndMs, resolveSaleWindowStartMs } from './sale-window';
import { sortProductMappingsByProductName } from './product-mapping-sort';

/**
 * 마감 스냅샷이 존재하는가(폴백 가능 여부) — 이전 마감으로 캐시가 채워진 캠페인만 참.
 */
export function hasFrozenSnapshot(camp: any): boolean {
  return (camp.cachedDistinctOrderCount ?? 0) > 0 || (camp.cachedTotalQuantity ?? 0) > 0 || (camp.cachedTotalOrders ?? 0) > 0;
}

/**
 * 마감 캠페인 1건을 응답 모양으로 만든다.
 *
 * `periodLabel` 은 **창에서 파생**한다 — 여기서 안 실으면 클라이언트가 `salePeriod`(스토어
 * 관측값)로 폴백해, 정작 운영자가 가장 자주 보는 완료 회차에서 표시와 동결 수치의 출처가 갈라진다.
 * 스냅샷 수치는 마감 시점 창으로 계산됐으므로 그 창(저장된 startDate/endDate)을 쓴다.
 */
export function buildCampaignSnapshotResponse(
  camp: any,
  orderProvider: string,
  extra: Record<string, unknown> = {},
): Record<string, any> {
  return {
    ...camp,
    mappings: sortProductMappingsByProductName(camp.mappings ?? []),
    orderProvider,
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
  };
}
