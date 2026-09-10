import { apiRequest } from './naver-commerce-client';
import { createNaverCallTally, runWithNaverCallTally } from './naver-api-usage';
import { prisma } from './prisma';
import { queryOrderDetails } from './naver-order-sync';
import { isSalesCampaignLocked } from './mapping-service';
import { isProductOrderLedgerRow, type SettlementQueryPlan } from './settlement-pending-dates';

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

/**
 * settle/case 1일치 수집(페이지네이션). 응답 스키마 방어적 파싱.
 * 실제로 나간 HTTP 호출 수(`pages`)도 돌려준다 — 프록시 사용량과 대조하는 값이다.
 */
async function fetchCasesForDate(
  searchDate: string,
  periodType: string,
  extra: Record<string, string> = {},
): Promise<{ cases: any[]; pages: number }> {
  const all: any[] = [];
  const pageSize = 1000;
  let page = 1;
  let pages = 0;
  for (;;) {
    const res = await apiRequest('GET', '/v1/pay-settle/settle/case', undefined, {
      searchDate,
      periodType,
      pageNumber: String(page),
      pageSize: String(pageSize),
      ...extra,
    });
    pages++;
    const body = res?.data ?? res ?? {};
    const elements: any[] = body.elements || body.contents || body.data?.elements || [];
    if (!Array.isArray(elements) || elements.length === 0) break;
    all.push(...elements);
    if (elements.length < pageSize) break;
    page++;
    if (page > 50) break; // 안전 상한(5만 행/일 — 실사용 초과 불가)
  }
  return { cases: all, pages };
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
 * 정산 원장 **백필** — 고정 달력으로 넓게 훑는다. ⚠️ **기본 경로가 아니다**(2단계, 2026-09-10).
 *
 * 크론이 `?settledDays=` · `?unsettledDays=` 를 **명시적으로** 받았을 때만 부른다. 기본 경로는
 * 아래 `runPlannedSettlementSync` 다. 이 함수는 데이터 유무와 무관하게 날짜 수만큼 부르므로
 * (기본값 3 + 21 = 24콜) 매일 돌리면 프록시 한도를 태운다 — 그게 재설계의 출발점이었다.
 * ⛔ 그렇다고 지우지 말 것: 재확인 창(`SETTLEMENT_ORDER_DATE_RECHECK_DAYS`)보다 긴 크론 중단
 * (프록시 한도 소진·자격증명 만료 등) 구간은 계획으로는 영영 안 메워지고, **이 경로가 유일한
 * 복구 수단**이다.
 * @param settledDays 정산완료일 기준 lookback
 * @param unsettledDays 결제일 기준 미정산 lookback
 */
export async function runSettlementSync(settledDays = 3, unsettledDays = 21): Promise<{ settledFetched: number; unsettledFetched: number }> {
  let settledFetched = 0;
  let unsettledFetched = 0;

  // 1) 정산완료분 — 완료일 기준 최근 N일
  for (const dateKey of recentDateKeys(settledDays)) {
    const { cases } = await fetchCasesForDate(dateKey, 'SETTLE_CASEBYCASE_SETTLE_COMPLETE_DATE');
    settledFetched += await upsertCases(cases);
  }

  // 2) 미정산(정산예정)분 — 결제일 기준 최근 N일 (settleExpectAmount 선확보)
  for (const dateKey of recentDateKeys(unsettledDays)) {
    const { cases } = await fetchCasesForDate(dateKey, 'SETTLE_CASEBYCASE_PAY_DATE', { settleDecisionType: 'UNSETTLED' });
    unsettledFetched += await upsertCases(cases);
  }

  return { settledFetched, unsettledFetched };
}

/** `runPlannedSettlementSync` 의 실행 요약 — 크론 응답과 `SystemTaskLog.details` 에 실린다. */
export interface PlannedSettlementSyncResult {
  /** 결제일 축으로 부른 날짜 수. */
  datesFetched: number;
  /** 정산완료일 축(안전망)으로 부른 날짜 수. */
  completionDatesFetched: number;
  /** 논리 요청 수(페이지 포함). 재시도는 세지 않는다. */
  requests: number;
  /**
   * 실제 HTTP 시도 수 — `apiRequest` 의 401·429 재시도를 포함한다(`naver-api-usage` 집계기).
   * ⚠️ 그래도 프록시 사용량과 **같지는 않다**: 토큰 발급과 `proxyFetch` 의 전송 계층 재시도는
   * 어느 집계에도 안 들어가므로(P7) 프록시가 세는 수는 이 값 **이상**이다.
   */
  httpAttempts: number;
  /** upsert 한 원장 행 수. */
  casesUpserted: number;
  /**
   * 조회에 실패한 날짜(`pay:YYYY-MM-DD` · `complete:YYYY-MM-DD`). 비어 있지 않으면 호출자가
   * 크론을 **실패로 선언**해야 한다. ⛔ 오류 메시지는 싣지 않는다 — 전송 계층 오류 사슬에 프록시
   * 주소가 섞일 수 있어 `SystemTaskLog.details` 로 새면 안 된다(P0). 원인은 서버 로그에 남긴다.
   */
  failedDates: string[];
}

/**
 * **계획한 날짜만** 조회한다 — 정산 조회의 기본 경로(2단계, 2026-09-10).
 *
 * 부를 날짜는 `settlement-pending-dates` 가 DB 만 읽어 정한다: 결제일 축(정산 대기 주문의
 * 결제일 · 주문이 있었던 최근 날짜 · 차감을 기다리는 취소 주문의 결제일)과 정산완료일 축
 * 안전망(최근 끝난 며칠). 대기 주문이 없는 날은 결제일 조회가 **0콜**이고 안전망 몫만 남는다 —
 * 종전 고정 달력은 그런 날에도 24콜을 썼다.
 *
 * 🔑 결제일 축을 `settleDecisionType` **없이** 부른다 — 정산완료·미정산·차감 행이 한 응답에
 * 함께 온다. 공식 문서는 이 파라미터를 선택으로만 적고 생략 시 동작을 명시하지 않아서,
 * 2026-09-10 실호출로 확인했다: 같은 날짜의 `UNSETTLED` 응답 행이 필터 없는 응답에 **전부**
 * 들어 있었고, 과거 날짜는 정산완료 행이 왔다. 그래서 날짜당 **1콜**로 충분하다.
 * ⛔ 「안전하게」 정산·미정산을 나눠 두 번 부르지 말 것 — 같은 데이터에 호출량만 두 배다.
 *
 * 🔑 **정산완료일 축은 좁게 남는다 — 이것이 안전망이다.** 2단계 첫 커밋은 이 축을 통째로
 * 뺐고, 교차 검증 두 레인이 같은 결함을 잡았다: 취소 사실을 읽는 스냅샷 프로젝션이 놓치는
 * 반품(평평한 클레임 모양 · 결제 30일 이후 반품)의 차감이 **영영 조회되지 않아** 금액이 부풀려진
 * 채 남는다. 완료·차감은 끝나는 날 정산완료일 축에 반드시 나타나므로 그 축이 그것을 닫는다.
 * 창 크기의 근거는 `SETTLEMENT_COMPLETE_DATE_LOOKBACK_DAYS`.
 *
 * **날짜별로 실패를 격리한다.** 한 날짜의 조회가 계속 실패해도 나머지 날짜(특히 재확인 창이
 * 짧은 최근 주문일)는 받아야 한다 — 종전처럼 첫 실패에서 전체를 멈추면, 결정론적으로 실패하는
 * 옛 날짜 하나가 최근 날짜를 재확인 창 밖으로 밀어낸다. 실패는 `failedDates` 로 돌려준다.
 */
export async function runPlannedSettlementSync(
  plan: Pick<SettlementQueryPlan, 'dates' | 'completionDates'>,
): Promise<PlannedSettlementSyncResult> {
  const tally = createNaverCallTally();
  let requests = 0;
  let casesUpserted = 0;
  const failedDates: string[] = [];

  const fetchInto = async (label: string, dateKey: string, periodType: string) => {
    try {
      const { cases, pages } = await fetchCasesForDate(dateKey, periodType);
      requests += pages;
      casesUpserted += await upsertCases(cases);
    } catch (error) {
      failedDates.push(`${label}:${dateKey}`);
      console.error(`[naver-settlement-sync] ${label}:${dateKey} 조회 실패 — 다른 날짜는 계속한다:`, error);
    }
  };

  await runWithNaverCallTally(tally, async () => {
    for (const { dateKey } of plan.dates) await fetchInto('pay', dateKey, 'SETTLE_CASEBYCASE_PAY_DATE');
    for (const dateKey of plan.completionDates) await fetchInto('complete', dateKey, 'SETTLE_CASEBYCASE_SETTLE_COMPLETE_DATE');
  });

  return {
    datesFetched: plan.dates.length,
    completionDatesFetched: plan.completionDates.length,
    requests,
    httpAttempts: tally.httpAttempts,
    casesUpserted,
    failedDates,
  };
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
    // productOrderType이 오는 경우 PROD_ORDER만, 미기재(null)면 포함(조인 키 자체가 캠페인 귀속 주문이므로).
    // 판정 SSOT 는 `isProductOrderLedgerRow` 하나다 — 종전엔 여기 인라인으로만 있어서
    // 같은 술어를 쓰는 새 모듈이 그것을 복사했고, 사본이 둘이 되면 한쪽만 고쳐진다.
    const scoped = rows.filter(isProductOrderLedgerRow);
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

/** `syncPostCloseCancellations` 의 실행 요약 — 크론 응답과 `SystemTaskLog.details` 에 그대로 실린다. */
export interface PostCloseCancelSyncResult {
  /** 90일 창 안의 마감 캠페인 전체. */
  campaigns: number;
  /** 취소 **값이 실제로 바뀐** 건수(마커만 찍힌 회차는 세지 않는다). */
  updated: number;
  /** 확정돼 있어 조회를 건너뛴 건수. */
  skippedLocked: number;
  /** 이번 실행에서 확정된 건수(락 상태 첫 계산). */
  finalizedLocked: number;
  /**
   * 응답이 모자라 **확정만** 미룬 건수(값은 갱신됐다) — 매일 0 이 아니면 그 캠페인은
   * 수렴하지 못하고 있다. `protectedFinalized` 와 배타적이다.
   * ⚠️ **둘 다 락 캠페인만 센다** — 미락 캠페인의 모자란 응답은 어느 쪽에도 안 잡힌다
   *    (미락은 애초에 확정 대상이 아니라 다음 회차가 그냥 다시 계산한다).
   */
  deferredIncomplete: number;
  /**
   * 응답이 모자라 **이미 확정된 값을 지키느라 통째로 건너뛴** 건수(값도 마커도 안 썼다).
   * `includeLocked` 로 강제 재계산했는데 0 이 아니면 그 캠페인은 레버로도 갱신되지 않았다.
   */
  protectedFinalized: number;
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
 * 시각까지의 취소를 전부 담으므로 ③의 누락 구간이 없다. `SalesCampaign.status` 를 쓰는
 * 경로가 라우트·리포지토리·lib 에 흩어져 있어 전이 훅은 그 전부에 배선해야 하는데, 이
 * 방식은 배선 0 으로 같은 결과를 얻는다.
 * ⚠️ **단 90일 창 안에서만이다** — 창을 벗어난 뒤 락이 걸리는 캠페인은 애초에 대상 조회에
 * 안 들어와 확정 계산도 없다(그쪽은 창이 유일한 통제이고 종전과 같다).
 *
 * 🔒 **확정에는 전제가 하나 더 있다 — 응답이 온전해야 한다.** `queryOrderDetails` 는 응답이
 * 요청보다 모자라도 `console.warn` 만 남기고 짧은 배열을 돌려준다. 그 결과로 확정하면 일시적
 * API 저하가 **과소 계상된 값을 영구히 동결**시킨다(유일 writer 라 수동 레버 말고는 복구
 * 경로가 없다). 그래서 요청 id 수보다 적게 돌아오면 **값은 쓰되 확정은 미룬다** — 다음 회차가
 * 다시 계산한다. 미룬 건수는 `deferredIncomplete` 로 응답에 실어 조용히 넘기지 않는다.
 * ⚠️ **탈퇴한 구매자의 주문은 커머스API 가 영구히 돌려주지 않으므로**(P7) 그런 주문이 섞인
 * 캠페인은 이 전제를 영영 못 채우고 90일 창이 끝날 때까지 매일 재조회된다 — 알고 택한
 * 값이다(틀리는 방향을 「헛조회」 쪽으로 잡는다). `deferredIncomplete` 가 그 부류를 드러낸다.
 *
 * ⚠️ **대신 남는 어긋남 하나를 적어 둔다(방향이 반대다).** 확정 계산이 락 **이후**에 돌므로
 * 「락 ~ 그 실행」 사이에 들어온 취소는 **포함된다** — 의도(락=확정) 대비 취소 과다 계상이다.
 * 종전 ③과 반대 방향이고, 그 창은 다음 성공 실행까지이며(크론 실패가 끼면 늘어난다)
 * **한 번 확정되면 더 벌어지지 않는다** — 종전 ③은 반대로 실패가 낄수록 누락이 커졌다.
 * ⚠️ **이 두 값을 「정산액」으로 말하지 말 것(2026-09-09 실측 정정).** 소비처는
 * `campaigns-handler` → 마감 캠페인 판매 리포트·보드 카드의 **표시**뿐이고(`cancelReturnQuantity`
 * /`cancelReturnAmount`), 정산 금액 계산에 들어가지 않는다 — 그 리포트의 총매출·총수량은
 * 이미 취소·반품이 빠진 순수치라 이 값은 「차감」이 아니라 「참고」로 붙는다
 * (`SalesReportModal` 주석). 종전 소스·P7 의 「정산액 과대/과소」 표현은 그만큼 과장이었다.
 * 실제 피해는 **오너가 보는 참고 수치가 틀리는 것**이다.
 *
 * ⚠️ 락이 **풀리면 마커를 지운다**(값을 다시 계산하는 그 회차에). 안 지우면 되돌린 캠페인이
 * 다시 락될 때 확정 계산 없이 옛 값으로 굳는다.
 * 🪤 **단 이 삭제는 「관측했을 때」만 일어난다** — 두 크론 실행 **사이에** 락 해제 → 재락 을
 * 마치면 이 잡은 해제를 못 보고 옛 마커로 건너뛴다. 상태를 되돌렸다 다시 정산에 넣은
 * 캠페인의 값을 다시 받으려면 `includeLocked` 레버를 쓴다. 이것을 배선으로 닫으려면 결국
 * status 를 쓰는 경로 전부에 마커 무효화를 넣어야 해서, 위 「전이 훅 불필요」와 같은 비용
 * 판단으로 **문서화를 택했다.**
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
): Promise<PostCloseCancelSyncResult> {
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
  // 응답이 모자라 확정을 **미룬** 락 캠페인 수 — 이 값이 매일 0 이 아니면 그 캠페인은
  // 수렴하지 못하고 있다는 뜻이다(조용히 넘기지 않으려고 응답에 싣는다, P0 No Silent Failure).
  let deferredIncomplete = 0;
  // 응답이 모자라 **확정된 값을 지키느라 건너뛴** 건수(위와 배타적) — `includeLocked` 로
  // 강제 재계산했는데 0 이 아니면 그 캠페인은 레버로도 갱신되지 않았다는 뜻이다.
  let protectedFinalized = 0;
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
    // 중복 id 는 응답이 1건이라 아래 **완전성 대조의 분모를 부풀린다** — 먼저 접는다.
    const ids = Array.isArray(rawIds) ? [...new Set((rawIds as any[]).map(v => String(v)))] : [];
    // ⚠️ 주문 목록이 비면 계산도 **확정도** 하지 않는다 — "주문 0 건" 과 "마감 스냅샷이
    //    주문을 못 담았다" 가 구분되지 않아, 그대로 확정하면 0 이 영구가 된다(위 doc).
    if (ids.length === 0) continue;

    let cancelQty = 0;
    let cancelRev = 0;
    // 요청한 주문이 전부 돌아왔는가 — 확정(동결)의 전제다(위 doc 🔒).
    // ⛔ 개수로 재지 말 것: 중복·잉여 행 하나가 **빠진 id 를 가려 「온전함」으로 읽힌다**
    //    (그 오판의 대가가 영구 동결이다). 🪤 `normalizeQueriedOrder` 는 `productOrder` 가
    //    있기만 하면 통과시키므로 **id 없는 행도 배열에는 남는다** — 그런 행은 이 집합에
    //    들어오지 않아 「모자람」으로 판정된다(fail-closed, 의도한 방향이다).
    const fetchedIds = new Set<string>();

    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const orders = await queryOrderDetails(chunk);
      for (const o of orders) {
        if (o?.productOrderId != null) fetchedIds.add(String(o.productOrderId));
      }

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

    // 🔒 **응답이 온전할 때만 확정한다.** `queryOrderDetails` 는 응답이 모자라도 `console.warn`
    //    만 남기고 짧은 배열을 돌려준다 — 그 결과로 확정해 버리면 일시적 API 저하가
    //    **과소 계상된 값을 영구히 동결**시키고, 유일 writer 라 `includeLocked` 수동 레버
    //    말고는 복구 경로가 없다. 종전 값 기반 판별은 그 경우 다음 날 재조회로 자연 치유됐다.
    // ⚠️ 값은 그대로 쓴다 — 부분 응답이라도 **지금 알 수 있는 최선**이고, 안 쓰면 탈퇴 구매자
    //    주문이 섞인 캠페인은 영영 값을 못 갖는다(그 주문은 API 가 원래 돌려주지 않는다, P7).
    //    미루는 것은 **동결뿐**이라 다음 회차가 다시 계산한다.
    // 🔒-b ⚠️ **단 이미 확정된 캠페인은 값도 쓰지 않는다**(사유는 그 가드 주석에). 그 결과
    //    `includeLocked` 레버는 응답이 모자라는 동안 무위이며, 그때는 `protectedFinalized` 로 센다.
    const complete = ids.every((id) => fetchedIds.has(id));

    // 🔒-b **이미 확정된 값은 부분 응답으로 덮지 않는다.** 그대로 쓰면 온전했던 값이 과소 계상
    //    값으로 바뀌는데 마커는 남아 **다음 회차부터 다시 건너뛴다** — 위 🔒 가 막으려던 영구
    //    동결이 이 경로로 되살아난다. 그래서 값도 마커도 손대지 않는다.
    //    ⚠️ 그 결과 `includeLocked` 레버는 **응답이 모자라는 동안 무위로 끝난다.** 그 사실이
    //    조용히 묻히지 않도록 `deferredIncomplete` 와 **따로** 센다(둘은 서로 배타적이다).
    if (locked && finalized && !complete) {
      protectedFinalized++;
      continue;
    }
    if (locked && !complete) deferredIncomplete++;

    // 락 상태에서 온전히 계산했으면 확정으로 찍고, 락이 풀렸으면 지운다(다시 락될 때 확정
    // 계산을 한 번 더 받게 하려는 것이다 — 안 지우면 옛 값으로 굳는다).
    const shouldFinalize = locked && complete;
    const nextFinalizedAt = shouldFinalize
      ? new Date()
      : locked
        ? camp.cachedPostCloseCancelFinalizedAt ?? null
        : null;
    const needsMarkerWrite = (shouldFinalize && !finalized) || (!locked && finalized);

    // ⛔ `valuesChanged` 만으로 쓰기를 결정하지 말 것 — 값이 그대로인 락 캠페인이 영영
    //    확정되지 않아 90일 내내 재조회된다(그것이 이 작업이 닫은 「수렴하지 않는다」다).
    if (valuesChanged || needsMarkerWrite) {
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
      if (shouldFinalize && !finalized) finalizedLocked++;
    }
  }

  // `campaigns` 는 **창 안의 전체**다. 실제 조회한 것은 `campaigns - skippedLocked` **에서
  // 주문 목록이 빈 캠페인을 뺀 수**이므로 그 뺄셈을 조회 수로 그대로 읽지 말 것.
  return { campaigns: closedCampaigns.length, updated, skippedLocked, finalizedLocked, deferredIncomplete, protectedFinalized };
}
