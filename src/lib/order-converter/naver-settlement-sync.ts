import { apiRequest } from './naver-commerce-client';
import { prisma } from './prisma';
import { queryOrderDetails } from './naver-order-sync';

/**
 * 네이버 정산(pay-settle) 수집 — SSOT: NAVER_SETTLEMENT_API_PLAN.md
 *
 * - `settle/case`(건별 정산)를 일자별로 수집해 NaverSettlementCase에 upsert.
 *   차감/취소 계열(settleType *_CANCEL 등)이 동일 productOrderId의 별도 행으로 오므로
 *   PK는 `${productOrderId}:${settleType}` 합성 — 원거래와 차감이 공존하고 SUM으로 자연 상쇄.
 * - 빠른정산(QUICK_SETTLE_*) 혼재로 구매확정 전에도 정산이 완료됨 →
 *   완료 여부는 오직 settleCompleteDate 존재로 판정(라벨: 정산완료/정산예정).
 * - 마감 캠페인 결산: 마감 시 저장된 OrderCampaign.cachedProductOrderIds(캠페인 귀속
 *   상품주문번호, 취소 포함)와 IN 조인해 결산 캐시 4컬럼을 갱신 — 카드 조회는 캐시만 읽음.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** KST 기준 YYYY-MM-DD */
function toDateKeyKst(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

function recentDateKeys(days: number): string[] {
  const keys: string[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) keys.push(toDateKeyKst(new Date(now - i * DAY_MS)));
  return keys;
}

/** settle/case 1일치 수집(페이지네이션). 응답 스키마 방어적 파싱. */
async function fetchCasesForDate(searchDate: string, periodType: string, extra: Record<string, string> = {}): Promise<any[]> {
  const all: any[] = [];
  const pageSize = 1000;
  let page = 1;
  for (;;) {
    const res = await apiRequest('GET', '/v1/pay-settle/settle/case', undefined, {
      searchDate,
      periodType,
      pageNumber: String(page),
      pageSize: String(pageSize),
      ...extra,
    });
    const body = res?.data ?? res ?? {};
    const elements: any[] = body.elements || body.contents || body.data?.elements || [];
    if (!Array.isArray(elements) || elements.length === 0) break;
    all.push(...elements);
    if (elements.length < pageSize) break;
    page++;
    if (page > 50) break; // 안전 상한(5만 행/일 — 실사용 초과 불가)
  }
  return all;
}

function toIntOrZero(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

async function upsertCases(cases: any[]): Promise<number> {
  let upserted = 0;
  for (const c of cases) {
    const productOrderId = c?.productOrderId != null ? String(c.productOrderId).trim() : '';
    if (!productOrderId) continue;
    const settleType = c?.settleType ? String(c.settleType) : 'NORMAL';
    const id = `${productOrderId}:${settleType}`;
    const data = {
      productOrderId,
      orderId: c.orderId != null ? String(c.orderId) : null,
      productId: c.productId != null ? String(c.productId) : null,
      productOrderType: c.productOrderType ?? null,
      settleType,
      payDate: c.payDate ? new Date(c.payDate) : null,
      settleExpectDate: c.settleExpectDate ? new Date(c.settleExpectDate) : null,
      settleCompleteDate: c.settleCompleteDate ? new Date(c.settleCompleteDate) : null,
      paySettleAmount: toIntOrZero(c.paySettleAmount),
      totalPayCommissionAmount: toIntOrZero(c.totalPayCommissionAmount),
      sellingInterlockCommissionAmount: toIntOrZero(c.sellingInterlockCommissionAmount),
      freeInstallmentCommissionAmount: toIntOrZero(c.freeInstallmentCommissionAmount),
      benefitSettleAmount: toIntOrZero(c.benefitSettleAmount),
      settleExpectAmount: toIntOrZero(c.settleExpectAmount),
      settled: !!c.settleCompleteDate,
      fetchedAt: new Date(),
    };
    await prisma.naverSettlementCase.upsert({ where: { id }, create: { id, ...data }, update: data });
    upserted++;
  }
  return upserted;
}

/**
 * 정산 원장 수집.
 * @param settledDays 정산완료일 기준 lookback (기본 3일 — 일일 크론이면 충분, 초기 백필 시 확대)
 * @param unsettledDays 결제일 기준 미정산 lookback (기본 21일 — 일반정산의 구매확정 대기 기간 커버)
 */
export async function runSettlementSync(settledDays = 3, unsettledDays = 21): Promise<{ settledFetched: number; unsettledFetched: number }> {
  let settledFetched = 0;
  let unsettledFetched = 0;

  // 1) 정산완료분 — 완료일 기준 최근 N일
  for (const dateKey of recentDateKeys(settledDays)) {
    const cases = await fetchCasesForDate(dateKey, 'SETTLE_CASEBYCASE_SETTLE_COMPLETE_DATE');
    settledFetched += await upsertCases(cases);
  }

  // 2) 미정산(정산예정)분 — 결제일 기준 최근 N일 (settleExpectAmount 선확보)
  for (const dateKey of recentDateKeys(unsettledDays)) {
    const cases = await fetchCasesForDate(dateKey, 'SETTLE_CASEBYCASE_PAY_DATE', { settleDecisionType: 'UNSETTLED' });
    unsettledFetched += await upsertCases(cases);
  }

  return { settledFetched, unsettledFetched };
}

const IN_CHUNK = 500;

/**
 * 마감 캠페인 결산 캐시 갱신 — cachedProductOrderIds 보유 마감 캠페인만 대상.
 * PROD_ORDER 원장만 귀속(배송비/리뷰적립 등 비상품 원장은 스토어 공통 비용 — v1 미귀속).
 */
export async function recomputeClosedCampaignSettlements(): Promise<{ campaigns: number; updated: number }> {
  const closed = await prisma.orderCampaign.findMany({
    where: { isActive: false },
    select: { id: true, cachedProductOrderIds: true },
  });

  let updated = 0;
  for (const camp of closed) {
    const raw = camp.cachedProductOrderIds;
    const ids = Array.isArray(raw) ? (raw as any[]).map((v) => String(v)) : [];
    if (ids.length === 0) continue;

    const rows: any[] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const part = await prisma.naverSettlementCase.findMany({ where: { productOrderId: { in: chunk } } });
      rows.push(...part);
    }
    // productOrderType이 오는 경우 PROD_ORDER만, 미기재(null)면 포함(조인 키 자체가 캠페인 귀속 주문이므로)
    const scoped = rows.filter((r) => !r.productOrderType || r.productOrderType === 'PROD_ORDER');
    if (scoped.length === 0) continue;

    const settledRows = scoped.filter((r) => r.settled);
    const unsettledRows = scoped.filter((r) => !r.settled);
    const settledAmount = settledRows.reduce((s, r) => s + (r.settleExpectAmount || 0), 0);
    // 수수료 구성요소 분해(카드 툴팁용) — 각 계열은 음수 흐름
    const feePay = settledRows.reduce((s, r) => s + (r.totalPayCommissionAmount || 0), 0);
    const feeInterlock = settledRows.reduce((s, r) => s + (r.sellingInterlockCommissionAmount || 0), 0);
    const feeFreeInstall = settledRows.reduce((s, r) => s + (r.freeInstallmentCommissionAmount || 0), 0);
    const feeAmount = feePay + feeInterlock + feeFreeInstall;
    const unsettledAmount = unsettledRows.reduce((s, r) => s + (r.settleExpectAmount || 0), 0);
    const settledCount = new Set(settledRows.filter((r) => (r.settleExpectAmount || 0) > 0).map((r) => r.productOrderId)).size;

    await prisma.orderCampaign.update({
      where: { id: camp.id },
      data: {
        cachedSettledAmount: settledAmount,
        cachedSettleFeeAmount: feeAmount,
        cachedSettleFeeBreakdown: { pay: feePay, interlock: feeInterlock, freeInstallment: feeFreeInstall },
        cachedUnsettledAmount: unsettledAmount,
        cachedSettledCount: settledCount,
      } as any,
    });
    updated++;
  }

  return { campaigns: closed.length, updated };
}

/**
 * 마감 캠페인 사후 취소 동기화
 * 정산 동기화 시점에 호출되어, 마감 당시의 원본 주문(cachedProductOrderIds) 상태를 조회하고
 * 취소/반품 수량과 금액을 산출해 캠페인의 cachedPostCloseCancelQuantity/Revenue를 갱신합니다.
 * (Absolute Snapshot 방식 - 멱등성 보장)
 */
export async function syncPostCloseCancellations(): Promise<{ campaigns: number; updated: number }> {
  // 최대 90일 전 마감된 캠페인까지만 취소 분을 조회(API 요금 및 Rate Limit, timeout 방지)
  const limitDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const closedCampaigns = await prisma.orderCampaign.findMany({
    where: { 
      isActive: false,
      endDate: { gte: limitDate }
    },
    select: {
      id: true,
      cachedProductOrderIds: true,
      cachedPostCloseCancelQuantity: true,
      cachedPostCloseCancelRevenue: true,
      mappings: true,
      name: true
    }
  });

  let updated = 0;
  const CHUNK_SIZE = 300;

  for (const camp of closedCampaigns) {
    const rawIds = camp.cachedProductOrderIds;
    const ids = Array.isArray(rawIds) ? (rawIds as any[]).map(v => String(v)) : [];
    if (ids.length === 0) continue;

    let cancelQty = 0;
    let cancelRev = 0;

    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const orders = await queryOrderDetails(chunk);

      for (const order of orders) {
        const status = order.productOrderStatus;
        let qtyToCancel = 0;

        if (status === 'CANCELED' || status === 'RETURNED') {
           qtyToCancel = Number(order.quantity) || 1;
        } else {
           const cancelClaim = order.__claim?.cancel?.claimQuantity;
           const returnClaim = order.__claim?.return?.claimQuantity;
           if (cancelClaim) qtyToCancel += Number(cancelClaim);
           if (returnClaim) qtyToCancel += Number(returnClaim);
        }

        if (qtyToCancel > 0) {
          cancelQty += qtyToCancel;

          const pName = (order.productName || '').trim().toLowerCase();
          const oName = (order.productOption || order.productOptionName || '').trim().toLowerCase();
          
          const matchedMapping = (camp.mappings as any[]).find((m: any) => {
            const mp = m.productName.trim().toLowerCase();
            const mo = m.optionName.trim().toLowerCase();
            if (mp && !pName.includes(mp)) return false;
            if (mo && !oName.includes(mo)) return false;
            return true;
          });

          const effectivePrice = matchedMapping?.price || 0;
          const naverDiscount = Math.max(0, (Number(order.productDiscountAmount) || 0) - (Number(order.sellerBurdenDiscountAmount) || 0));
          
          const totalPayment = Number(order.totalPaymentAmount) || 0;
          const qty = Number(order.quantity) || 1;
          const unitPrice = (totalPayment + naverDiscount > 0 && qty > 0) 
            ? (totalPayment + naverDiscount) / qty 
            : effectivePrice;

          // round to avoid float issues
          cancelRev += Math.round(unitPrice * qtyToCancel);
        }
      }
    }

    const currentQty = camp.cachedPostCloseCancelQuantity || 0;
    const currentRev = camp.cachedPostCloseCancelRevenue || 0;

    if (cancelQty !== currentQty || cancelRev !== currentRev) {
      await prisma.orderCampaign.update({
        where: { id: camp.id },
        data: {
          cachedPostCloseCancelQuantity: cancelQty,
          cachedPostCloseCancelRevenue: cancelRev
        }
      });
      updated++;
    }
  }

  return { campaigns: closedCampaigns.length, updated };
}
