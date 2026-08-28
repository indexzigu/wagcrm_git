import { apiRequest } from './naver-commerce-client';
import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';
import { fetchAllProductOrderPages, PRODUCT_ORDER_RANGE_TYPE_PAYED } from './product-order-paging';
import { isDemoMode } from '@/lib/demo-mode';



// ============================================================================
// 순수 헬퍼 (유닛테스트 대상)
// ============================================================================

/**
 * 평면화된 주문 객체({...order, ...productOrder})에서 결제일 기준 KST 날짜키(YYYY-MM-DD)를 계산한다.
 * paymentDate를 우선하고, 없으면 orderDate, 그마저 없으면 orderCreateDate로 폴백한다.
 * (기존 route.ts의 KST 날짜귀속 규칙을 그대로 이식)
 */
export function orderToDateKey(order: any): string | null {
  const orderTimeStr = order?.paymentDate || order?.orderDate || order?.orderCreateDate;
  if (!orderTimeStr) return null;
  const d = new Date(orderTimeStr);
  if (isNaN(d.getTime())) return null;
  const dKst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = dKst.getUTCFullYear();
  const mm = String(dKst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dKst.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 평면화된 주문 배열에서 상태별 카운트를 집계한다.
 * (기존 route.ts:260-266 규칙과 동일)
 */
export function countStatuses(orders: any[]): { newOrdersCount: number; preparingCount: number; deliveringCount: number } {
  let newOrdersCount = 0;
  let preparingCount = 0;
  let deliveringCount = 0;
  for (const order of orders) {
    const status = order?.productOrderStatus;
    // PRODUCT_READY 동승 근거(2026-07-30): 이 값은 dispatch·delay-dispatch 라우트가
    // "발송 가능 상태"로 실제 취급하는데 세 카운터 어디에도 안 들어가서, 그 상태의 주문이
    // 스냅샷 카운트상 **완전히 보이지 않았다**. 발주 조회 생략 게이트
    // (order-fetch-window.decideChunkSkip)가 newOrdersCount 를 근거로 쓰므로, 빠져 있으면
    // PRODUCT_READY 만 남은 날짜를 "발주 대상 0"으로 오판해 발주서에서 누락시킨다(P0).
    // 실측(전 스냅샷 1,574라인)에서 관측 0건이라 현재 동작 변화는 없다 —
    // order-fetch-window.test.ts 의 계약 테스트가 이 포함 관계를 고정한다.
    if (status === 'PAYED' || status === 'PRODUCT_ORDERED' || status === 'PRODUCT_READY') newOrdersCount++;
    else if (status === 'DISPATCH_WAIT') preparingCount++;
    else if (status === 'DISPATCHED' || status === 'DELIVERING') deliveringCount++;
  }
  return { newOrdersCount, preparingCount, deliveringCount };
}

/**
 * query 응답의 data[] 요소(dataItem) 하나를 기존 평면 계약({...order, ...productOrder})으로 정규화한다.
 * 클레임 관련 원본 데이터(data.return/currentClaim/beforeClaim/completedClaims)는 `__claim` 키에
 * 그대로 보존한다 (B2에서 반품/클레임 추적에 사용할 훅).
 * 네이버 문서상 leaf 필드가 다수 생략돼 있어 방어적으로 옵셔널 체이닝을 사용한다.
 */
export function normalizeQueriedOrder(dataItem: any): any {
  if (!dataItem || !dataItem.productOrder) return null;
  const order = dataItem.order || {};
  const productOrder = dataItem.productOrder || {};

  return {
    ...order,
    ...productOrder,
    __claim: {
      cancel: dataItem.cancel ?? null,
      return: dataItem.return ?? null,
      exchange: dataItem.exchange ?? null,
      beforeClaim: dataItem.beforeClaim ?? null,
      currentClaim: dataItem.currentClaim ?? null,
      completedClaims: dataItem.completedClaims ?? null,
    },
  };
}

/**
 * 기존 주문 배열(existing)에 변경분(changed)을 productOrderId 기준으로 merge한다.
 * 동일 productOrderId가 있으면 교체하고, 없으면 신규 추가한다.
 */
export function mergeOrdersByProductOrderId(existing: any[], changed: any[]): any[] {
  const merged = [...(existing || [])];
  const indexByOrderId = new Map<string, number>();
  merged.forEach((o, i) => {
    if (o?.productOrderId) indexByOrderId.set(String(o.productOrderId), i);
  });

  for (const changedOrder of changed || []) {
    if (!changedOrder?.productOrderId) continue;
    const key = String(changedOrder.productOrderId);
    const idx = indexByOrderId.get(key);
    if (idx !== undefined) {
      merged[idx] = changedOrder;
    } else {
      indexByOrderId.set(key, merged.length);
      merged.push(changedOrder);
    }
  }

  return merged;
}

export interface SnapshotStaleMeta {
  lastCallTime: number;
  isDirty?: boolean;
  newOrdersCount?: number;
  preparingCount?: number;
  deliveringCount?: number;
}

/**
 * 캐시(또는 DB) 스냅샷이 낡았는지(재조회가 필요한지) 판정한다.
 * 기존 route.ts:156-181 shouldFetchNaverApi 로직을 그대로 이식.
 */
export function isSnapshotStale(meta: SnapshotStaleMeta | null | undefined, targetDateKst: Date, forceRefresh: boolean): boolean {
  if (forceRefresh) return true;
  if (!meta || meta.isDirty) return true;

  const now = new Date();
  const nowKst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const targetTime = targetDateKst.getTime();
  const daysAgo = Math.floor((nowKst.getTime() - targetTime) / (1000 * 60 * 60 * 24));
  const minutesSinceLastCall = (now.getTime() - meta.lastCallTime) / (1000 * 60);

  // [1순위] 당일
  if (daysAgo <= 0) return minutesSinceLastCall >= 1;
  // [2순위] 신규주문 방치 건
  if ((meta.newOrdersCount || 0) > 0) return minutesSinceLastCall >= 5;
  // [3순위] 발주확인 대기 건
  if ((meta.preparingCount || 0) > 0) return minutesSinceLastCall >= (6 * 60);
  // [4순위] 배송중 건
  if ((meta.deliveringCount || 0) > 0) return minutesSinceLastCall >= (12 * 60);
  // [5순위] 단말 상태 및 오래된 날짜
  if (daysAgo >= 14) return minutesSinceLastCall >= (72 * 60);
  return minutesSinceLastCall >= (24 * 60);
}

/** 스냅샷 조회·동기화가 공유하는 보존 창(일). runChangedSync·syncOrdersByIds의 30일과 같은 값이다. */
export const SNAPSHOT_WINDOW_DAYS = 30;

/**
 * [startMs, endMs] 구간을 KST 날짜키 배열로 펼치되, 스냅샷 보존 창(오늘 기준 30일) 밖은 잘라낸다.
 *
 * 타깃 무효화(`naverOrderSnapshotRepository.markDirty`)의 입력용 — 호출부가 "캠페인 창"처럼
 * 기간으로만 영향 범위를 아는 경우에 쓴다. 창 밖 날짜를 걸러내는 이유는 그 날짜에 스냅샷 행이
 * 없어 마킹이 무의미하기 때문이고(updateMany가 0행 매칭), 창을 넘겨 받은 캠페인이 무효화 폭을
 * 조용히 넓히는 것을 막기 위해서다. 순수 함수라 DB 없이 계약을 고정할 수 있다.
 */
export function enumerateSnapshotDateKeys(startMs: number, endMs: number, nowMs: number = Date.now()): string[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];

  const dayMs = 24 * 60 * 60 * 1000;
  const earliestMs = nowMs - SNAPSHOT_WINDOW_DAYS * dayMs;

  // 창 밖을 필터로만 거르면 '~ 계속'(종료 미정 → 먼 미래)이나 아주 오래된 시작일에서 루프가
  // 무의미하게 길어진다. 순회 전에 구간 자체를 창으로 좁힌다.
  const from = Math.max(startMs, earliestMs);
  const to = Math.min(endMs, nowMs);
  if (to < from) return [];

  // KST 자정에 정렬한 뒤 하루씩 전진한다 — UTC 자정(= KST 09:00)에서 전진하면 각 청크가
  // 두 날짜에 걸쳐(order-fetch-window의 KST 자정 정렬과 같은 근거) 마지막 날이 통째로 빠진다.
  const firstKstMidnightUtcMs = Math.floor((from + 9 * 60 * 60 * 1000) / dayMs) * dayMs - 9 * 60 * 60 * 1000;

  // 경계는 runChangedSync·syncOrdersByIds와 같은 관용구를 쓴다(구간 끝 '시각'의 날짜키).
  // 자정 정렬은 from 이 속한 날의 00:00부터 시작하므로 그것만으로는 하루 더 이른 키가 새어나온다.
  const earliestKey = toDateKeyKst(new Date(earliestMs));

  const keys: string[] = [];
  for (let t = firstKstMidnightUtcMs; t <= to; t += dayMs) {
    const key = toDateKeyKst(new Date(t));
    if (key < earliestKey) continue;
    keys.push(key);
  }
  return Array.from(new Set(keys));
}

/** Date -> KST YYYY-MM-DD 날짜키 변환 (자정 정렬 없이 순수 변환) */
export function toDateKeyKst(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dt = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dt}`;
}

// ============================================================================
// 네트워크 헬퍼
// ============================================================================

const MAX_CHANGED_STATUS_PAGES = 50; // more/moreSequence 페이징 무한루프 방지용 상한

/**
 * 변경피드(last-changed-statuses)에서 fromIso 이후 변경된 productOrderId 목록을 수집한다.
 * more/moreSequence 페이징을 최대 시도 횟수 제한 하에 따라간다.
 */
export async function fetchChangedProductOrderIds(fromIso: string): Promise<string[]> {
  const ids: string[] = [];
  let currentFrom = fromIso;
  let moreSequence: string | undefined;
  let attempts = 0;

  while (attempts < MAX_CHANGED_STATUS_PAGES) {
    attempts++;
    const query: Record<string, string> = { lastChangedFrom: currentFrom };
    if (moreSequence) query.moreSequence = moreSequence;

    const res = await apiRequest('GET', '/v1/pay-order/seller/product-orders/last-changed-statuses', undefined, query);

    const items = res?.data?.lastChangeStatuses;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item?.productOrderId) ids.push(String(item.productOrderId));
      }
    }

    const more = res?.data?.more;
    if (more?.moreFrom) {
      currentFrom = more.moreFrom;
      moreSequence = more.moreSequence;
    } else {
      break;
    }
  }

  return Array.from(new Set(ids));
}

const QUERY_CHUNK_SIZE = 100;

/**
 * productOrderId 목록의 상세 내역을 100건 청크로 나눠 query API를 호출하고,
 * 정규화된 평면 주문 객체 배열로 반환한다.
 */
export async function queryOrderDetails(productOrderIds: string[]): Promise<any[]> {
  const results: any[] = [];

  for (let i = 0; i < productOrderIds.length; i += QUERY_CHUNK_SIZE) {
    const chunk = productOrderIds.slice(i, i + QUERY_CHUNK_SIZE);
    const res = await apiRequest('POST', '/v1/pay-order/seller/product-orders/query', {
      productOrderIds: chunk,
      quantityClaimCompatibility: true,
    });

    const data = Array.isArray(res?.data) ? res.data : [];
    if (data.length < chunk.length) {
      console.warn(`[naver-order-sync] query 응답 개수(${data.length})가 요청 개수(${chunk.length})보다 적습니다. 일부 productOrderId 조회가 누락됐을 수 있습니다.`);
    }

    for (const item of data) {
      const normalized = normalizeQueriedOrder(item);
      if (normalized) results.push(normalized);
    }
  }

  return results;
}

/**
 * 지정한 productOrderId들의 상세를 ID로 직접 재조회(query-by-id)해 스냅샷에 즉시 반영한다.
 *
 * 배경: 네이버 변경피드(last-changed-statuses)는 "발주확인"(placeOrderStatus NOT_YET→OK)을
 * 변경 이벤트로 내보내지 않는다. 따라서 발주확인 직후 runChangedSync를 돌려도 해당 주문의
 * placeOrderStatus가 스냅샷에 반영되지 않아 대시보드가 계속 "발주확인전"으로 남는다.
 * 이 함수는 변경피드를 우회해, 우리가 방금 확인 처리한 주문ID들의 현재 상태를 query API로
 * 직접 가져와 날짜별 스냅샷에 merge/upsert한다. (커서는 건드리지 않는다 — 변경피드 흐름과 독립)
 *
 * 주의(멀티 인스턴스): L1(in-memory) + DB를 모두 갱신한다. 같은 워밍 인스턴스가 이어서
 * 대시보드 요청을 처리하면 L1로 즉시 반영되고, 콜드/다른 인스턴스는 DB에서 하이드레이션 시
 * 반영된다. (저트래픽 단일 사용자 환경에서는 대개 동일 인스턴스가 처리)
 */
/**
 * merge의 기준이 되는 "기존 주문" 로드 — L1과 DB 스냅샷의 합집합(union)을 돌려준다.
 *
 * 실사고(2026-07-06): naver/sync 라우트는 L1 하이드레이션 없이 runSync를 실행하므로,
 * 콜드 인스턴스에서 L1이 비어 있으면 변경분만으로 merge된 결과가 DB 스냅샷을 덮어써
 * 기존 주문(발주확인된 ~140건)이 스냅샷에서 유실됐다(lost-update). 변경피드 커서는
 * 이미 전진해 유실분은 다시 오지 않는다 → merge 전 반드시 DB를 폴백으로 합친다.
 *
 * 충돌 규칙: 같은 productOrderId면 DB가 이긴다 — 모든 쓰기 경로(runFullSync/
 * runChangedSync/syncOrdersByIds)가 L1과 DB를 함께 쓰므로, 다른 인스턴스의 L1보다
 * DB가 항상 최신이거나 같다(같은 인스턴스면 L1==DB라 무차이).
 */
async function loadExistingOrdersWithDbFallback(dailyCache: Record<string, any>, dateKey: string): Promise<any[]> {
  const l1Orders: any[] = dailyCache[dateKey]?.orders || [];
  try {
    const snap = await naverOrderSnapshotRepository.findOne(dateKey);
    if (snap) {
      const dbOrders = naverOrderSnapshotRepository.parseOrders(snap) as any[];
      return mergeOrdersByProductOrderId(l1Orders, dbOrders);
    }
  } catch (err) {
    console.warn(`[naver-order-sync] Failed to load DB snapshot for merge base (${dateKey}) — falling back to L1 only:`, err);
  }
  return l1Orders;
}

export async function syncOrdersByIds(productOrderIds: string[]): Promise<{ updated: number; affectedDates: string[] }> {
  const uniqueIds = Array.from(new Set((productOrderIds || []).map((id) => String(id).trim()).filter(Boolean)));
  if (uniqueIds.length === 0) return { updated: 0, affectedDates: [] };

  const dailyCache = getDailyCache();
  const now = new Date();
  const normalizedOrders = await queryOrderDetails(uniqueIds);

  // 30일 조회범위 계산 (runChangedSync와 동일 규칙)
  const earliestAllowed = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const earliestAllowedKey = toDateKeyKst(earliestAllowed);
  const todayKey = toDateKeyKst(now);

  const ordersByDate = new Map<string, any[]>();
  for (const order of normalizedOrders) {
    const dateKey = orderToDateKey(order);
    if (!dateKey) continue;
    if (dateKey < earliestAllowedKey || dateKey > todayKey) continue;
    if (!ordersByDate.has(dateKey)) ordersByDate.set(dateKey, []);
    ordersByDate.get(dateKey)!.push(order);
  }

  const affectedDates: string[] = [];
  for (const [dateKey, changedForDate] of ordersByDate) {
    // 콜드 인스턴스 lost-update 방지: L1이 비어 있어도 DB 스냅샷을 merge 기준으로 삼는다
    const existingOrders = await loadExistingOrdersWithDbFallback(dailyCache, dateKey);
    const merged = mergeOrdersByProductOrderId(existingOrders, changedForDate);
    const { newOrdersCount, preparingCount, deliveringCount } = countStatuses(merged);
    const lastCallTime = Date.now();

    try {
      await naverOrderSnapshotRepository.upsertDaily({
        snapshotDate: dateKey,
        orders: merged,
        ordersCount: merged.length,
        newOrdersCount,
        preparingCount,
        deliveringCount,
        isDirty: false,
        lastCallTime: new Date(lastCallTime),
        syncType: 'CHANGED',
        // lastChangeStatusCursor 생략: 변경피드 커서는 전진시키지 않는다.
      });
      dailyCache[dateKey] = {
        lastCallTime,
        orders: merged,
        newOrdersCount,
        preparingCount,
        deliveringCount,
        isDirty: false,
      };
      affectedDates.push(dateKey);
    } catch (err) {
      console.warn(`[naver-order-sync] syncOrdersByIds: Failed to persist snapshot for ${dateKey}:`, err);
    }
  }

  return { updated: normalizedOrders.length, affectedDates };
}

// ============================================================================
// 배송중 → 배송완료 전이 보정(변경피드 갭 우회)
// ============================================================================

// 네이버 변경피드(last-changed-statuses)는 택배사 배송완료 자동전이(DELIVERING→DELIVERED)를
// 이벤트로 안 실어, runChangedSync가 이 전이를 못 잡는다(선례: 발주확인 placeOrderStatus 갭도
// 동형이라 query-by-id로 우회했다). 그 결과 배송완료된 건이 구매확정(PURCHASE_DECIDED, ~8일 후,
// 이건 피드에 뜸) 전까지 '배송중'으로 남아 주문관리에서 false 지연이 된다. 이 함수는 현재 배송중
// 건을 query-by-id로 직접 재조회해 최신 상태를 스냅샷에 강제 반영한다.
//
// 배송완료 반영은 긴급하지 않고 재조회 건수가 많을 수 있어(배송중 수백 건), 인스턴스별 쿨다운으로
// 과호출을 막는다. syncOrdersByIds가 스냅샷 lastCallTime을 갱신하므로 후속 staleness도 자연 진정된다.
let lastDeliveringSweepAt = 0;
const DELIVERING_SWEEP_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3시간




export async function sweepDeliveringOrders(deliveringIds: string[]): Promise<{ swept: number; skipped: boolean }> {
  // 데모 배포: 네이버 재조회 자체가 불가능하므로 no-op (runSync 게이트와 동일 사유).
  if (isDemoMode()) return { swept: 0, skipped: true };

  const ids = Array.from(new Set((deliveringIds || []).map((s) => String(s).trim()).filter(Boolean)));
  if (ids.length === 0) return { swept: 0, skipped: false };

  const now = Date.now();
  if (now - lastDeliveringSweepAt < DELIVERING_SWEEP_COOLDOWN_MS) return { swept: 0, skipped: true };
  lastDeliveringSweepAt = now;

  const { updated } = await syncOrdersByIds(ids);
  console.log(`[naver-order-sync] 배송중 전이 보정 sweep: ${ids.length}건 재조회 요청, ${updated}건 반영`);
  return { swept: ids.length, skipped: false };
}

// ============================================================================
// 진입점: FULL / CHANGED 동기화 및 dedup+쿨다운 래퍼
// ============================================================================

export interface SyncRange {
  startDateKey: string;
  endDateKey: string;
}

export interface RunFullSyncOptions extends SyncRange {
  forceRefresh?: boolean;
}

export interface SyncResult {
  syncType: 'CHANGED' | 'FULL';
  changedProductOrderIds: string[];
  affectedDates: string[];
  fetchedAt: string;
  cursorAdvancedTo?: string;
  skipped: boolean;
  error?: string;
}

function getDailyCache(): Record<string, any> {
  if (!(global as any).__naverDailyCache) {
    (global as any).__naverDailyCache = {};
  }
  return (global as any).__naverDailyCache;
}

/**
 * 지정된 날짜 범위([startDateKey, endDateKey], KST)에 대해 네이버 API로 전체 주문을 재조회하고
 * L1(dailyCache) 갱신 + DB(repo) upsert까지 수행한다.
 * (기존 route.ts:226-311 날짜 루프 로직 이관)
 */
export async function runFullSync(options: RunFullSyncOptions): Promise<SyncResult> {
  const { startDateKey, endDateKey, forceRefresh = false } = options;
  const dailyCache = getDailyCache();
  const affectedDates: string[] = [];

  try {
    // startDateKey ~ endDateKey (KST 날짜키, YYYY-MM-DD) 를 UTC 시각 범위로 환산해 하루 단위로 순회한다.
    const startUtc = new Date(`${startDateKey}T00:00:00+09:00`);
    const endUtc = new Date(`${endDateKey}T23:59:59.999+09:00`);
    const now = new Date();

    let currentFrom = startUtc;
    const fetchPromises: Promise<void>[] = [];

    while (currentFrom <= endUtc) {
      let currentTo = new Date(currentFrom.getTime() + 24 * 60 * 60 * 1000 - 1);
      if (currentTo > now) currentTo = now;
      if (currentTo > endUtc) currentTo = endUtc;

      const dateKey = toDateKeyKst(currentFrom);
      const cacheEntry = dailyCache[dateKey];
      const dateKeyKstMidnight = new Date(`${dateKey}T00:00:00+09:00`);

      if (isSnapshotStale(cacheEntry, dateKeyKstMidnight, forceRefresh)) {
        const fromStr = currentFrom.toISOString();
        const toStr = currentTo.toISOString();
        const capturedDateKey = dateKey;

        fetchPromises.push(
          // 페이징은 product-order-paging SSOT 에 위임한다. ⚠️ 종전엔 `page` 를 안 보내
          // **스냅샷 빌더가 창당 300건에서 절단**됐다 — 스냅샷은 대시보드·모바일 매출·정산·
          // 클레임·재구매, 그리고 발주 조회 생략 게이트(order-fetch-window)의 근거이므로
          // 그 절단은 전 소비자로 번진다(P0). 계약은 공식 Discussion #2476 으로 확정.
          fetchAllProductOrderPages(
            { fromIso: fromStr, toIso: toStr },
            {
              apiRequest: (m, path, body, q) => apiRequest(m, path, body, q),
              // **결제일 기준 명시**(2단계 = 스냅샷 경로, 오너 결정 2026-07-30).
              // 이 순회는 KST 자정 정렬 창을 `orderToDateKey`(= `paymentDate` 우선) 로 귀속시킨다 —
              // 창의 술어를 결제일로 못 박아야 "조회 창 == 저장 키"가 전제가 아니라 계약이 된다.
              // 기본값이 이미 `PAYED_DATETIME` 임은 프로덕션 실측으로 확정됐으므로(헤더 주석
              // 참조) 동작 변화는 없다. 명시하는 이유는 네이버가 기본값을 바꿔도 이 전제가
              // 조용히 깨지지 않게 하는 것이다 — 깨지면 발주 조회 생략 게이트가 다른 날짜의
              // 근거를 보게 된다.
              rangeType: PRODUCT_ORDER_RANGE_TYPE_PAYED,
            },
          ).then(async (paged) => {
            if (paged.hitPageLimit || paged.pageParamSuspect) {
              console.warn(
                `[naver-order-sync] 페이징 경고 ${capturedDateKey}: hitPageLimit=${paged.hitPageLimit} pageParamSuspect=${paged.pageParamSuspect}`,
              );
            }
            const items: any[] = paged.contents
              .map((wrapper: any) => {
                if (!wrapper?.content?.productOrder) return null;
                return {
                  ...(wrapper.content.order || {}),
                  ...wrapper.content.productOrder,
                };
              })
              .filter(Boolean);


            const { newOrdersCount, preparingCount, deliveringCount } = countStatuses(items);
            const lastCallTime = Date.now();

            dailyCache[capturedDateKey] = {
              lastCallTime,
              orders: items,
              newOrdersCount,
              preparingCount,
              deliveringCount,
              isDirty: false,
            };
            affectedDates.push(capturedDateKey);

            // upsertDaily를 await해 Promise.all이 DB 기록 완료까지 대기하게 한다.
            // (fire-and-forget이면 runSync('FULL') 직후 findOne이 옛 스냅샷을 읽는 레이스 발생)
            await naverOrderSnapshotRepository
              .upsertDaily({
                snapshotDate: capturedDateKey,
                orders: items,
                ordersCount: items.length,
                newOrdersCount,
                preparingCount,
                deliveringCount,
                isDirty: false,
                lastCallTime: new Date(lastCallTime),
                syncType: 'FULL',
              })
              .catch((err) => console.warn(`[naver-order-sync] Failed to persist NaverOrderSnapshot for ${capturedDateKey}:`, err));
          }).catch((err: any) => {
            console.warn(`[naver-order-sync] Fetch error for ${capturedDateKey} (${fromStr} ~ ${toStr}):`, err?.message);
          })
        );
      }

      currentFrom = new Date(currentFrom.getTime() + 24 * 60 * 60 * 1000);
    }

    if (fetchPromises.length > 0) {
      await Promise.all(fetchPromises);
    }

    return {
      syncType: 'FULL',
      changedProductOrderIds: [],
      affectedDates,
      fetchedAt: new Date().toISOString(),
      skipped: false,
    };
  } catch (error: any) {
    console.error('[naver-order-sync] runFullSync failed:', error);
    return {
      syncType: 'FULL',
      changedProductOrderIds: [],
      affectedDates,
      fetchedAt: new Date().toISOString(),
      skipped: false,
      error: error?.message || String(error),
    };
  }
}

const CHANGED_SYNC_DEFAULT_LOOKBACK_MIN = 15;

/**
 * 변경피드 기반 증분 동기화. 커서(repo.findLatestCursor)가 없으면 now-15분부터 시작한다.
 * 변경된 productOrderId들의 상세를 조회 -> 날짜별로 귀속 -> merge -> upsert.
 * 조회범위(30일) 밖 날짜는 skip. 빈 결과여도 커서는 전진시킨다.
 */
export async function runChangedSync(): Promise<SyncResult> {
  const dailyCache = getDailyCache();
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    let fromIso: string;
    try {
      const cursorRow = await naverOrderSnapshotRepository.findLatestCursor();
      fromIso = cursorRow?.lastChangeStatusCursor || new Date(now.getTime() - CHANGED_SYNC_DEFAULT_LOOKBACK_MIN * 60 * 1000).toISOString();
    } catch (cursorErr) {
      console.warn('[naver-order-sync] Failed to read cursor, falling back to lookback window:', cursorErr);
      fromIso = new Date(now.getTime() - CHANGED_SYNC_DEFAULT_LOOKBACK_MIN * 60 * 1000).toISOString();
    }

    const changedIds = await fetchChangedProductOrderIds(fromIso);

    const affectedDatesSet = new Set<string>();
    // 날짜별 upsert 중 하나라도 실패하면 true. true인 동안은 커서를 전진시키지 않고
    // SyncResult.error로 부분 실패를 알려 다음 사이클이 같은 fromIso부터 재조회하게 한다.
    let partialFailure = false;

    if (changedIds.length > 0) {
      const normalizedOrders = await queryOrderDetails(changedIds);

      // 30일 조회범위 계산 (오늘 기준)
      const earliestAllowed = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const earliestAllowedKey = toDateKeyKst(earliestAllowed);
      const todayKey = toDateKeyKst(now);

      // 날짜키별로 변경분을 그룹핑
      const ordersByDate = new Map<string, any[]>();
      for (const order of normalizedOrders) {
        const dateKey = orderToDateKey(order);
        if (!dateKey) continue;
        // 조회범위(30일) 밖 날짜는 skip
        if (dateKey < earliestAllowedKey || dateKey > todayKey) continue;
        if (!ordersByDate.has(dateKey)) ordersByDate.set(dateKey, []);
        ordersByDate.get(dateKey)!.push(order);
      }

      // 날짜별 upsert는 커서를 넘기지 않는다(기존 커서값 보존, 수정1 참고). 하나라도 실패하면
      // 커서를 전진시키지 않아야 실패한 날짜의 변경분이 다음 사이클(같은 fromIso부터 재조회)에
      // 다시 반영될 수 있다(at-least-once). upsert는 멱등이라 성공한 날짜가 중복 처리돼도 무해하다.
      for (const [dateKey, changedForDate] of ordersByDate) {
        // 콜드 인스턴스 lost-update 방지: L1이 비어 있어도 DB 스냅샷을 merge 기준으로 삼는다
        // (naver/sync 라우트는 L1 하이드레이션 없이 진입 — 2026-07-06 스냅샷 유실 실사고)
        const existingOrders = await loadExistingOrdersWithDbFallback(dailyCache, dateKey);
        const merged = mergeOrdersByProductOrderId(existingOrders, changedForDate);
        const { newOrdersCount, preparingCount, deliveringCount } = countStatuses(merged);
        const lastCallTime = Date.now();

        try {
          await naverOrderSnapshotRepository.upsertDaily({
            snapshotDate: dateKey,
            orders: merged,
            ordersCount: merged.length,
            newOrdersCount,
            preparingCount,
            deliveringCount,
            isDirty: false,
            lastCallTime: new Date(lastCallTime),
            syncType: 'CHANGED',
            // lastChangeStatusCursor 생략: 날짜별 upsert에서는 커서를 전진시키지 않는다.
          });
          // DB upsert가 성공한 날짜만 L1 캐시에 반영해 L1/DB 정합을 유지한다.
          dailyCache[dateKey] = {
            lastCallTime,
            orders: merged,
            newOrdersCount,
            preparingCount,
            deliveringCount,
            isDirty: false,
          };
          affectedDatesSet.add(dateKey);
        } catch (err) {
          partialFailure = true;
          console.warn(`[naver-order-sync] Failed to persist merged snapshot for ${dateKey}:`, err);
        }
      }

      if (!partialFailure) {
        // 전부 성공했을 때만 커서를 1회 전진시킨다. "빈 결과 시 커서 전진" 경로와 동일하게
        // 최신 스냅샷 1건에 lastChangeStatusCursor를 기록하는 방식으로 통일한다.
        try {
          const latest = await naverOrderSnapshotRepository.findLatestCursor();
          const todayKey = toDateKeyKst(now);

          if (latest) {
            // 커서만 좁게 기록한다 — 종전처럼 최신행 블롭을 읽어 동일 orders를 재기록하면
            // CHANGED 사이클마다 행 크기만큼 egress가 왕복한다(P7 절감, 2026-07-24).
            await naverOrderSnapshotRepository.advanceCursor(latest.snapshotDate, nowIso);
          } else {
            // 커서를 가진 기존 스냅샷이 전혀 없는 최초 실행: 이번에 upsert한 날짜 중
            // 하나(오늘 날짜 우선, 없으면 첫 번째)에 커서를 기록한다.
            const fallbackDate = affectedDatesSet.has(todayKey) ? todayKey : Array.from(affectedDatesSet)[0];
            if (fallbackDate) {
              await naverOrderSnapshotRepository.upsertDaily({
                snapshotDate: fallbackDate,
                orders: dailyCache[fallbackDate]?.orders || [],
                ordersCount: (dailyCache[fallbackDate]?.orders || []).length,
                newOrdersCount: dailyCache[fallbackDate]?.newOrdersCount || 0,
                preparingCount: dailyCache[fallbackDate]?.preparingCount || 0,
                deliveringCount: dailyCache[fallbackDate]?.deliveringCount || 0,
                isDirty: false,
                lastCallTime: new Date(dailyCache[fallbackDate]?.lastCallTime || Date.now()),
                syncType: 'CHANGED',
                lastChangeStatusCursor: nowIso,
              });
            }
          }
        } catch (err) {
          console.warn('[naver-order-sync] Failed to advance cursor after changed sync:', err);
        }
      }
    } else {
      // 변경분이 없어도 커서는 전진시킨다. 이때 "방금 물어봤는데 변경이 없었다"는 사실 자체를
      // 오늘 날짜 스냅샷의 lastCallTime 갱신으로 기록해야, isSnapshotStale의 "당일 1분" 규칙에 의해
      // 다음 GET마다 불필요하게 재동기화가 반복 트리거되는 것을 막을 수 있다.
      const todayKey = toDateKeyKst(now);
      const todayCacheEntry = dailyCache[todayKey];

      if (todayCacheEntry) {
        todayCacheEntry.lastCallTime = Date.now();
        todayCacheEntry.isDirty = false;
        try {
          // 이 경로의 목적은 lastCallTime/커서 전진이지만 orders도 함께 쓰므로,
          // 이 인스턴스 L1이 부분집합일 때 DB를 덮지 않도록 DB와 union 후 기록한다.
          const unionOrders = await loadExistingOrdersWithDbFallback(dailyCache, todayKey);
          const unionCounts = countStatuses(unionOrders);
          todayCacheEntry.orders = unionOrders;
          todayCacheEntry.newOrdersCount = unionCounts.newOrdersCount;
          todayCacheEntry.preparingCount = unionCounts.preparingCount;
          todayCacheEntry.deliveringCount = unionCounts.deliveringCount;
          await naverOrderSnapshotRepository.upsertDaily({
            snapshotDate: todayKey,
            orders: unionOrders,
            ordersCount: unionOrders.length,
            newOrdersCount: unionCounts.newOrdersCount,
            preparingCount: unionCounts.preparingCount,
            deliveringCount: unionCounts.deliveringCount,
            isDirty: false,
            lastCallTime: new Date(todayCacheEntry.lastCallTime),
            syncType: 'CHANGED',
            lastChangeStatusCursor: nowIso,
          });
          affectedDatesSet.add(todayKey);
        } catch (err) {
          console.warn(`[naver-order-sync] Failed to refresh lastCallTime for ${todayKey}:`, err);
        }
      }

      // 커서 자체는 반드시 전진시켜야 한다. 오늘자 스냅샷을 이미 갱신했다면 그걸로 충분하니
      // 중복 upsert를 피하고, 그렇지 않을 때만(오늘자가 L1/DB에 아직 없는 경우) 최신 스냅샷에 커서만 기록한다.
      try {
        const latest = await naverOrderSnapshotRepository.findLatestCursor();
        if (latest && latest.snapshotDate !== todayKey) {
          // 커서만 좁게 기록(위 advanceCursor와 동일 근거 — 블롭 왕복 제거).
          await naverOrderSnapshotRepository.advanceCursor(latest.snapshotDate, nowIso);
        }
      } catch (err) {
        console.warn('[naver-order-sync] Failed to advance cursor on empty changed sync:', err);
      }
    }

    return {
      syncType: 'CHANGED',
      changedProductOrderIds: changedIds,
      affectedDates: Array.from(affectedDatesSet),
      fetchedAt: nowIso,
      // 부분 실패 시 커서를 전진시키지 않았으므로 cursorAdvancedTo도 비워 호출부가
      // "이번 사이클에 커서가 실제로 전진했는지"를 구분할 수 있게 한다.
      ...(partialFailure ? {} : { cursorAdvancedTo: nowIso }),
      skipped: false,
      ...(partialFailure ? { error: '일부 날짜의 변경분 저장에 실패해 커서를 전진시키지 않았습니다.' } : {}),
    };
  } catch (error: any) {
    console.error('[naver-order-sync] runChangedSync failed:', error);
    return {
      syncType: 'CHANGED',
      changedProductOrderIds: [],
      affectedDates: [],
      fetchedAt: nowIso,
      skipped: false,
      error: error?.message || String(error),
    };
  }
}

const SYNC_COOLDOWN_MS = 45 * 1000;

/**
 * dedup + 쿨다운 래퍼. globalThis.__naverSyncInFlight로 동시 실행을 막고(토큰 dedup 패턴과 동일 관용구),
 * 45초 쿨다운으로 과호출을 방지한다. mode='FULL'은 쿨다운을 무시한다.
 */
export async function runSync(mode: 'CHANGED' | 'FULL', range?: SyncRange): Promise<SyncResult> {
  // 데모 배포: 네이버 자격증명이 없고 데이터는 시드된 목업 스냅샷이 전부다 —
  // 모든 호출 지점(campaigns GET SWR·모바일 pulse 등)에서 동기화를 no-op으로 만든다.
  if (isDemoMode()) {
    return {
      syncType: mode,
      changedProductOrderIds: [],
      affectedDates: [],
      fetchedAt: new Date().toISOString(),
      skipped: true,
    };
  }

  const g = global as any;

  // 이미 진행 중인 동기화가 있다면 그 Promise를 그대로 반환 (병렬 요청 방지)
  if (g.__naverSyncInFlight) {
    return g.__naverSyncInFlight as Promise<SyncResult>;
  }

  const lastSyncAt: number | undefined = g.__naverSyncLastAt;
  if (mode !== 'FULL' && lastSyncAt && Date.now() - lastSyncAt < SYNC_COOLDOWN_MS) {
    return {
      syncType: mode,
      changedProductOrderIds: [],
      affectedDates: [],
      fetchedAt: new Date().toISOString(),
      skipped: true,
    };
  }

  g.__naverSyncInFlight = (async () => {
    try {
      if (mode === 'FULL') {
        if (!range) {
          throw new Error('runSync(FULL) requires a range { startDateKey, endDateKey }');
        }
        return await runFullSync(range);
      }
      return await runChangedSync();
    } finally {
      g.__naverSyncLastAt = Date.now();
      g.__naverSyncInFlight = null;
    }
  })();

  return g.__naverSyncInFlight;
}
