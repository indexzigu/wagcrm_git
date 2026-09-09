import { apiRequest } from './naver-commerce-client';
import { prisma } from './prisma';
import { queryOrderDetails } from './naver-order-sync';
import { isSalesCampaignLocked } from './mapping-service';

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
 *
 * **정산이 시작된 캠페인은 「확정 계산」을 한 번 마친 뒤로는 조회하지 않는다.** 동결 기준은
 * 마감(`isActive`)이 아니라 **정산 락**이라는 것이 오너 확정(2026-07-15)이고, 그 판정 SSOT 가
 * `isSalesCampaignLocked` 다 — 정산대기(SETTLEMENT_WAIT)까지는 반품·구매확정으로 변동
 * 가능하고 **정산중부터 확정**이다.
 * ⛔ 기준을 정산대기로 앞당기지 말 것 — 그 구간의 취소·반품을 놓친다(위 오너 확정).
 * ⛔ `lockedStatuses` 목록을 여기에 베껴 오지 말 것 — 판정은 위 SSOT 한 곳이다.
 *
 * 🔑 **「한 번 마친 뒤로는」이 이 함수의 핵심이고, 그 판정은 값이 아니라 마커가 한다.**
 * 이 함수가 두 값의 **유일한 writer** 이고 계산이 델타 누적이 아니라 **절대 스냅샷**이라,
 * 두 값이 `@default(0)` 인 한 "계산했는데 취소가 0" 과 "계산된 적이 없다" 가 값만으로는
 * 구분되지 않는다. 그래서 확정 여부는 **`cachedPostCloseCancelFinalizedAt` 하나**가 답한다.
 * ⛔ **값이 0 인지로 미계산을 판별하던 종전 방식으로 되돌리지 말 것**(2026-09-09 → T-140).
 * 그 방식은 한계 셋을 남겼고 이 마커가 셋을 함께 닫았다: ①동결 시점이 부분집합마다
 * 달랐다(「락 시점」이 아니라 「처음 0 이 아닌 값이 나온 시점」) ②취소가 정말 0 인 캠페인은
 * 90일 창이 끝날 때까지 매일 재조회돼 **수렴하지 않았다** ③컷오프가 「직전 크론 실행 시점」
 * 이라 마지막 실행과 수동 락 사이의 취소를 놓쳤다(**과소 계상 = 정산액 과대**, 돈 방향).
 *
 * **락 전이 훅이 필요 없는 이유가 여기 있다.** 마커는 「락 상태에서 계산했다」일 때만 찍히므로,
 * 락이 걸린 캠페인은 **락 이후 첫 성공 실행에서 정확히 한 번** 계산된다 — 그 계산이 실행
 * 시각까지의 취소를 전부 담으므로 ③의 누락 구간이 아예 없다. `SalesCampaign.status` 를 쓰는
 * 경로가 라우트·리포지토리·lib 에 흩어져 있어 전이 훅은 그 전부에 배선해야 하는데, 이
 * 방식은 배선 0 으로 같은 결과를 얻는다.
 * ⚠️ **대신 남는 어긋남 하나를 적어 둔다(방향이 반대다).** 확정 계산이 락 **이후**에 돌므로
 * 「락 ~ 그 실행」 사이에 들어온 취소는 **포함된다** — 의도(락=확정) 대비 취소 과다 계상 =
 * **정산액 과소**다. 종전의 ③과 반대 방향이고, 돈에서는 받을 돈을 적게 잡는 쪽이 안전하다.
 * 그 창은 다음 성공 실행까지이며(크론 실패가 끼면 늘어난다) **한 번 확정되면 더 벌어지지
 * 않는다** — 종전 ③은 반대로 실패가 낄수록 누락이 커졌다.
 *
 * ⚠️ 락이 **풀리면 마커를 지운다**(값을 다시 계산하는 그 회차에). 안 지우면 되돌린 캠페인이
 * 다시 락될 때 확정 계산 없이 옛 값으로 굳는다.
 * ⚠️ `cachedProductOrderIds` 가 비면 계산도 마커도 남기지 않는다 — "주문이 0 건"과 "마감
 * 스냅샷이 주문을 못 담았다"가 구분되지 않아, 그 상태로 0 을 확정하면 되돌릴 길이 없다.
 * 네이버 호출은 어차피 0 이라 매일 재평가해도 비용이 없다.
 * ⚠️ `cron.log` 의 성공 줄은 상한이 있어 응답 끝이 잘릴 수 있다 — `SystemTaskLog.details`
 * 나 수동 호출로 읽을 것.
 *
 * 90일 창(`endDate >= limitDate`)은 이제 **「끝내 락되지 않는 건」의 백스톱 하나**다. 종전에는
 * 취소가 0 인 락 캠페인에도 그 창이 유일한 1차 통제였는데, 마커가 그쪽을 가져갔다.
 *
 * `includeLocked` 는 그 위의 수동 재계산 레버다(확정된 값이 틀렸다고 판단될 때).
 * 호출 경로: `run-cron.sh 'naver-settlement-sync?includeLocked=1'`(잡 이름이 URL 에 그대로
 * 이어 붙고 허용목록이 없다 — 그 스크립트가 `CRON_SECRET` 을 알아서 읽는다) 또는 같은
 * 시크릿을 든 수동 curl. ⛔ 레이더의 실행 버튼(`/api/system/cron-run`)은 쿼리를 붙이지
 * 않으므로 이 레버를 못 쓴다. ⛔ **단 90일 창 안에서만이다** — 대상 조회의 `endDate` 필터는
 * 그 옵션과 무관하게 걸린다. 어느 경로든 정산 원장 재수집까지 함께 태운다(전부 멱등).
 */
export async function syncPostCloseCancellations(
  options: { includeLocked?: boolean } = {},
): Promise<{ campaigns: number; updated: number; skippedLocked: number; finalizedLocked: number }> {
  // 최대 90일 전 마감된 캠페인까지만 취소 분을 조회.
  // ⚠️ 이 창은 **「끝내 락되지 않는 건」의 백스톱**이다 — 락이 걸리는 캠페인은 확정 마커가
  //    1차 통제를 맡는다. 줄이면 락되지 않은 채 방치된 캠페인의 조정이 멈춘다.
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
      cachedPostCloseCancelFinalizedAt: true,
      mappings: true,
      name: true,
      salesCampaigns: { select: { status: true } }
    }
  });

  let updated = 0;
  let skippedLocked = 0;
  // 이번 실행에서 **확정**된 건수(락 상태 첫 계산). 배포 후 따라잡기의 진행과 수렴을 재는 신호다.
  let finalizedLocked = 0;
  const CHUNK_SIZE = 300;

  for (const camp of closedCampaigns) {
    // 딜 하나라도 정산에 들어갔으면 그 캠페인은 확정이다 — `campaigns-handler` 의 집계 창
    // 동결(`periodFrozenBySettlement`)과 같은 기준을 쓴다.
    const locked = (camp.salesCampaigns ?? []).some((sc) => isSalesCampaignLocked(sc.status));
    // ⛔ 확정 여부는 **마커만** 본다 — 값이 0 인지로 판별하던 종전 방식으로 되돌리지 말 것
    //    (기본값이 0 이라 "계산했는데 0" 과 "계산된 적 없음" 이 구분되지 않는다. 위 doc 🔑).
    const finalized = camp.cachedPostCloseCancelFinalizedAt != null;

    if (!options.includeLocked && locked && finalized) {
      skippedLocked++;
      continue;
    }
    const rawIds = camp.cachedProductOrderIds;
    const ids = Array.isArray(rawIds) ? (rawIds as any[]).map(v => String(v)) : [];
    // ⚠️ 주문 목록이 비면 계산도 **확정도** 하지 않는다 — "주문 0 건" 과 "마감 스냅샷이
    //    주문을 못 담았다" 가 구분되지 않아, 그대로 확정하면 0 이 영구가 된다(위 doc).
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
    const valuesChanged = cancelQty !== currentQty || cancelRev !== currentRev;

    // 락 상태에서 계산했으면 확정으로 찍고, 락이 풀렸으면 지운다(다시 락될 때 확정 계산을
    // 한 번 더 받게 하려는 것이다 — 안 지우면 옛 값으로 굳는다).
    const nextFinalizedAt = locked ? new Date() : null;
    const markerChanged = locked !== finalized;

    // ⛔ `valuesChanged` 만으로 쓰기를 결정하지 말 것 — 값이 그대로인 락 캠페인이 영영
    //    확정되지 않아 90일 내내 재조회된다(그것이 이 작업이 닫은 「수렴하지 않는다」다).
    if (valuesChanged || markerChanged) {
      await prisma.orderCampaign.update({
        where: { id: camp.id },
        data: {
          cachedPostCloseCancelQuantity: cancelQty,
          cachedPostCloseCancelRevenue: cancelRev,
          cachedPostCloseCancelFinalizedAt: nextFinalizedAt
        }
      });
      // `updated` 는 **값이 바뀐 건수**로 유지한다 — 마커만 찍힌 회차까지 세면 이 지표가
      // 종전 실행과 비교 불가가 된다.
      if (valuesChanged) updated++;
      if (locked && !finalized) finalizedLocked++;
    }
  }

  // `campaigns` 는 **창 안의 전체**이고 실제 조회한 것은 `campaigns - skippedLocked` 다.
  return { campaigns: closedCampaigns.length, updated, skippedLocked, finalizedLocked };
}
