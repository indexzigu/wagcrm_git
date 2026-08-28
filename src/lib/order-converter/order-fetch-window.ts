/**
 * 발주 대상 주문 조회의 **창·청크·생략 판정 SSOT**.
 *
 * 주문확인(`execute/stream`)과 발주요청(`execute`)이 각자 복사해 갖고 있던 조회 루프를
 * 여기로 모은다. 두 사본은 이미 어긋나 있었다(상태 필터: stream 은 `PRODUCT_READY` 포함,
 * execute 는 미포함) — 사본이 둘이면 한쪽만 고쳐지는 게 이 코드베이스의 반복 실패다.
 *
 * ## 왜 이 모듈이 생겼나 (실측 baseline 2026-07-30)
 *
 * 주문확인 1클릭이 **19청크·19호출·17초**를 쓰고 "발주 대상 없음"으로 끝났다
 * (`ApiCallLog` `naver_op_confirm_order` 실측: `logicalCalls=19 · elapsedMs=16946`).
 * 캠페인 창 전체를 매번 훑기 때문이고, 스킵 게이트는 있었지만 **죽어 있었다** —
 * `cacheForDate.stats.newOrders` 를 읽는데 `__naverDailyCache` 의 writer 전부가 엔트리
 * 루트에 `newOrdersCount` 로 쓴다(`.stats` writer 0곳). 레포 이관 이후 그 파일은 한 번도
 * 수정되지 않았으니 **이 레포에서 한 번도 작동한 적이 없다.**
 *
 * ## 설계 원칙: "믿음 기반 스킵" → "증거 기반 생략 + 교차검증"
 *
 * 옛 게이트는 "과거니까 안 변했을 것"이라는 이진 규칙이라 **반품/교환으로 과거 날짜가 다시
 * 움직이는 것을 못 따라간다.** 대신 영속 스냅샷(`NaverOrderSnapshot`)이 "이 날짜엔 발주
 * 대상이 없다"고 **적극 증언**할 때만 생략한다. 클레임이 발생하면 변경피드가 스냅샷을
 * 갱신하므로 카운트가 0이 아니게 되고 → 자동으로 다시 조회된다.
 *
 * 그리고 스냅샷을 근거로 끌어들이면 **비교 기준(oracle)** 이 함께 생긴다 — 조회한 날짜의
 * 라인수를 스냅샷과 대조해 "이번 조회가 온전했는가"를 처음으로 물어볼 수 있다.
 */

import { fetchAllProductOrderPages, PRODUCT_ORDER_RANGE_TYPE_PAYED } from './product-order-paging';

/** KST 오프셋(ms). 서버 TZ 와 무관하게 KST 날짜 경계를 계산하기 위한 상수. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 변경피드 커서가 이보다 오래 멈춰 있으면 스냅샷을 생략 근거로 쓰지 않는다.
 * 커서가 멈추면 신규 결제가 스냅샷에 반영되지 않으므로 "발주 대상 0"을 믿을 수 없다.
 */
export const CURSOR_STALE_MS = 6 * 60 * 60 * 1000;

/** Date|number → KST YYYY-MM-DD 날짜키. */
export function toKstDateKey(at: Date | number): string {
  const kst = new Date((at instanceof Date ? at.getTime() : at) + KST_OFFSET_MS);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** KST 날짜키 → 그 날 00:00:00.000 KST 의 epoch ms. */
export function kstDayStartMs(dateKey: string): number {
  return Date.parse(`${dateKey}T00:00:00.000+09:00`);
}

/** KST 날짜키 → 그 날 23:59:59.999 KST 의 epoch ms. */
export function kstDayEndMs(dateKey: string): number {
  return Date.parse(`${dateKey}T23:59:59.999+09:00`);
}

/** 날짜키에 일수를 더한다(KST 기준). */
export function addKstDays(dateKey: string, days: number): string {
  return toKstDateKey(kstDayStartMs(dateKey) + days * 24 * 60 * 60 * 1000);
}

export interface OrderChunk {
  /** 이 청크가 귀속되는 KST 날짜키 — 스냅샷 행과 1:1 대응한다. */
  dateKey: string;
  fromIso: string;
  toIso: string;
}

/**
 * 조회 청크를 **KST 자정 경계에 정렬**해 계획한다.
 *
 * ⚠️ 이 정렬이 이 모듈의 전제다. 종전 구현은 `startDate`(UTC 자정 = **KST 09:00**)에서
 * 23.9h 씩 전진해서, "07-12" 라벨이 붙은 청크가 실제로는 `07-12 09:00 ~ 07-13 08:54` 를
 * 덮었다(24h 중 07-12 는 15h 분). 그 위에서 날짜 단위 판정(생략·대조)을 하면 **다른 날짜의
 * 근거를 보게 된다.** `runFullSync` 는 이미 KST 자정 순회라 선례가 있다.
 *
 * 마지막 청크는 `nowMs` 로 잘린다(미래 구간을 조회하지 않는다).
 */
export function planKstDayChunks(startMs: number, nowMs: number): OrderChunk[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs) || startMs > nowMs) return [];

  const chunks: OrderChunk[] = [];
  let dateKey = toKstDateKey(startMs);
  const lastDateKey = toKstDateKey(nowMs);

  // 방어적 상한: 날짜키 산술이 어긋나도 무한 루프에 빠지지 않게 한다(최대 400일).
  for (let guard = 0; guard < 400; guard++) {
    const dayStart = kstDayStartMs(dateKey);
    const dayEnd = kstDayEndMs(dateKey);

    // 첫 청크는 창 시작 시각부터(그 날 자정이 아니라) — 창 밖 주문을 끌어오지 않는다.
    const from = Math.max(dayStart, startMs);
    const to = Math.min(dayEnd, nowMs);

    if (from <= to) {
      chunks.push({
        dateKey,
        fromIso: new Date(from).toISOString(),
        toIso: new Date(to).toISOString(),
      });
    }

    if (dateKey === lastDateKey) break;
    dateKey = addKstDays(dateKey, 1);
  }

  return chunks;
}

// ============================================================================
// 생략 판정 — 스냅샷이 "발주 대상 없음"을 적극 증언할 때만
// ============================================================================

/** 생략 판정에 쓰는 스냅샷 행(경량 — `findRangeCounts` 프로젝션의 부분집합). */
export interface SnapshotCountRow {
  snapshotDate: string;
  ordersCount: number;
  newOrdersCount: number;
  lastCallTime: Date | string;
}

export type SkipReason =
  /** 스냅샷이 발주 대상 0을 증언 → 생략 */
  | 'snapshot-says-no-pending'
  /** 스냅샷 행이 없다 = 모름 → 조회(fail-safe) */
  | 'no-snapshot-row'
  /** 오늘·어제는 항상 조회(경계·타임존 여유, 신규 결제 유입) */
  | 'recent-day'
  /** 스냅샷이 발주 대상 있음을 증언 → 조회 */
  | 'snapshot-has-pending'
  /** 변경피드 커서가 멈춤 → 스냅샷 신뢰 불가 → 전량 조회 */
  | 'cursor-stale';

export interface SkipDecision {
  skip: boolean;
  reason: SkipReason;
}

/**
 * 이 청크(=KST 하루)의 조회를 생략해도 되는지 판정한다.
 *
 * 생략 조건은 **전부** 충족해야 한다:
 *  1. 변경피드 커서가 건강하다 — 멈췄으면 스냅샷이 신규 결제를 못 받았을 수 있다.
 *  2. 오늘·어제가 아니다 — 그 두 날은 신규 결제가 계속 유입되고 타임존 경계 여유도 필요하다.
 *  3. 스냅샷 행이 존재한다 — 없으면 "주문 0인 날"일 수도, "동기화가 안 닿은 날"일 수도
 *     있어 구분이 안 된다. **모름은 생략하지 않는다**(fail-safe).
 *  4. `newOrdersCount === 0` — 발주 대상이 없다.
 *
 * ## 왜 `newOrdersCount` 인가 (실측 근거 2026-07-30)
 *
 * 발주 대상 상태의 실값을 전 스냅샷 1,574라인에서 세어봤다:
 * `PURCHASE_DECIDED` 1361 · `CANCELED` 93 · `CANCELED_BY_NOPAYMENT` 53 · `DELIVERED` 48 ·
 * `PAYMENT_WAITING` 10 · `PAYED` 4 · `RETURNED` 4 · `DELIVERING` 1.
 * **`PRODUCT_ORDERED`·`DISPATCH_WAIT`·`PRODUCT_READY` 는 0건**이라, 라우트의 3-상태 필터는
 * 실질 `PAYED` 단일이고 `countStatuses` 의 `newOrdersCount`(=PAYED+PRODUCT_ORDERED)가
 * 정확히 그 상위집합이다. 새 컬럼 신설이 불필요한 이유다.
 *
 * ⚠️ 이건 "현재 미관측"이지 "절대 없음"이 아니다. `PRODUCT_READY` 는 dispatch 라우트가
 * 실제로 취급하는 값이고, `countStatuses` 도 `deriveOrderPipelineBucket` 도 이 값을 세지
 * 않는다 — **관측되기 시작하면 이 게이트가 그 주문을 놓친다.** 그래서
 * `PENDING_FULFILLMENT_STATUSES` 를 이 모듈에 두고 계약 테스트로 고정한다. 이 목록이
 * `newOrdersCount` 의 커버 범위를 벗어나면 테스트가 깨지게 만들어, 다음 사람이 조용히
 * 누락시키는 대신 여기서 멈추게 한다(P7 의 `PAY_WAITING` 오타 실사고 계열).
 *
 * `isDirty` 는 **게이트에 넣지 않는다.** 두 이유는 성격이 다르다:
 * ① **의미가 다른 질문이다** — `isDirty` 는 "FULL 로 다시 받아야 하나"이고 이 게이트는
 *    "이 날짜에 발주 대상이 있나"다. 이건 구조를 고쳐도 그대로다.
 * ② (사실 정정 2026-07-30) 종전 근거였던 "48행 중 45행이 상시 true" 는 무효화가 최근 30일을
 *    뭉뚱그려 찍던 `markAllDirty()` 때문이었고, 그건 타깃 `markDirty(dateKeys)` 로 수리됐다
 *    (실측은 그사이 47/48 까지 악화한 뒤였다). 즉 **②는 더 이상 게이트 제외의 근거가 아니다.**
 *    다만 넣는 것은 **발주서 누락(P0)** 이 걸린 별도 판단이므로 오너 결정 없이 넣지 말 것.
 */
export function decideChunkSkip(args: {
  dateKey: string;
  todayKey: string;
  snapshot: SnapshotCountRow | undefined;
  cursorHealthy: boolean;
}): SkipDecision {
  const { dateKey, todayKey, snapshot, cursorHealthy } = args;

  if (!cursorHealthy) return { skip: false, reason: 'cursor-stale' };

  const yesterdayKey = addKstDays(todayKey, -1);
  if (dateKey === todayKey || dateKey === yesterdayKey) {
    return { skip: false, reason: 'recent-day' };
  }

  if (!snapshot) return { skip: false, reason: 'no-snapshot-row' };

  if (Number(snapshot.newOrdersCount) > 0) {
    return { skip: false, reason: 'snapshot-has-pending' };
  }

  return { skip: true, reason: 'snapshot-says-no-pending' };
}

/**
 * 발주 대상(=주문확인이 손댈 수 있는) `productOrderStatus` 목록.
 *
 * 두 라우트가 어긋나 있던 필터를 여기로 통일한다(stream 은 `PRODUCT_READY` 포함,
 * execute 는 미포함이었다). 생략 게이트가 `newOrdersCount`(=PAYED+PRODUCT_ORDERED)를
 * 근거로 쓰므로, **이 목록이 그 범위를 넘어서면 게이트가 주문을 놓친다** —
 * `order-fetch-window.test.ts` 의 계약 테스트가 그 조건을 고정한다.
 */
export const PENDING_FULFILLMENT_STATUSES = ['PAYED', 'PRODUCT_ORDERED', 'PRODUCT_READY'] as const;

/**
 * `countStatuses` 의 `newOrdersCount` 가 커버하는 상태 — 게이트 근거의 실제 범위.
 * `naver-order-sync.countStatuses` 와 손으로 맞춰야 하는 미러이므로,
 * 계약 테스트가 (1)이 목록이 발주 대상의 상위집합인지 (2)구현이 정말 그렇게 세는지를
 * **양쪽 다** 검증한다 — 미러만 고치고 구현을 안 고치는(또는 그 반대) 드리프트를 막는다.
 */
export const NEW_ORDERS_COUNT_STATUSES = ['PAYED', 'PRODUCT_ORDERED', 'PRODUCT_READY'] as const;

/** 변경피드 커서가 생략 판정을 뒷받침할 만큼 최신인가. */
export function isCursorHealthy(cursorIso: string | null | undefined, nowMs: number): boolean {
  if (!cursorIso) return false;
  const cursorMs = Date.parse(cursorIso);
  if (!Number.isFinite(cursorMs)) return false;
  return nowMs - cursorMs <= CURSOR_STALE_MS;
}

// ============================================================================
// 조회 온전성 대조 — 스냅샷을 oracle 로 쓴다
// ============================================================================

export interface ChunkIntegrityIssue {
  dateKey: string;
  fetched: number;
  snapshot: number;
  kind: 'under-fetch';
}

/**
 * 조회 결과가 불완전할 신호를 찾는다. 지금까지 이 경로엔 **비교 대상이 아예 없었다** —
 * 조회가 온전했는지 물어볼 방법이 없어 절단·부분 실패가 조용히 발주서 누락으로 이어졌다.
 *
 *  - `under-fetch`: 그 날 조회 라인수 < 스냅샷 `ordersCount`.
 *
 *    ⚠️ **이 신호는 정확하지 않다. 절대 차단(중단) 근거로 쓰지 말 것** —
 *    프로덕션 실측(2026-07-30T06:14Z)에서 곧바로 오탐이 나 발주서 생성을 막았다:
 *    07-12 스냅샷 43건 중 **`paymentDate` 가 null 인 2건**이 있었고 조회는 41건이었다.
 *    스냅샷은 날짜를 `paymentDate → orderDate → orderCreateDate` **폴백**으로 귀속하는데
 *    범위 조회(`?from=&to=`)는 결제일 기준이라 결제일 없는 건을 그 창에서 돌려주지 않는다.
 *    즉 **두 수는 같은 술어로 센 값이 아니다** — "정상 운영에서 줄어들 이유가 없다"는
 *    최초 전제가 틀렸다. 스냅샷이 CHANGED 병합으로 라인을 더 갖는 경우도 같은 축이다.
 *
 *    그래서 이 값은 **관측 신호로만** 쓴다(로그 + 계측 metadata). 실제 절단 방어는 아래
 *    `page-size-suspect`(창 이분 재조회)가 담당한다 — 그쪽은 스냅샷과의 비교에 의존하지
 *    않아 이 결함의 영향을 받지 않는다.
 *  - (구) `page-size-suspect` 는 제거됐다 — 페이징 계약이 확정돼(`page` 파라미터 실존, 공식
 *    Discussion #2476) 창 이분 우회 대신 `product-order-paging` 이 전 페이지를 정직하게
 *    따라간다. 절단 방어의 실체는 이제 그쪽이다.
 */
export function findChunkIntegrityIssues(
  fetchedByDate: Record<string, number>,
  snapshots: SnapshotCountRow[],
): ChunkIntegrityIssue[] {
  const byDate = new Map(snapshots.map((s) => [s.snapshotDate, s]));
  const issues: ChunkIntegrityIssue[] = [];

  for (const [dateKey, fetched] of Object.entries(fetchedByDate)) {
    const snap = byDate.get(dateKey);
    if (!snap) continue; // 스냅샷이 없으면 대조 불가(생략도 안 했으므로 조회는 온전히 돌았다)
    const snapshotCount = Number(snap.ordersCount);
    if (fetched < snapshotCount) {
      issues.push({ dateKey, fetched, snapshot: snapshotCount, kind: 'under-fetch' });
    }
  }

  return issues;
}

// ============================================================================
// 조회 오케스트레이션 — 의존성은 전부 주입받는다(prisma·네이버 import 없음 = 테스트 용이)
// ============================================================================

export interface FetchPendingOrdersDeps {
  /** 네이버 상품주문 조회. 라우트는 `apiRequest` 를, 테스트는 페이크를 넘긴다. */
  apiRequest: (
    method: string,
    path: string,
    body: undefined,
    query: Record<string, string>,
  ) => Promise<any>;
  /** 날짜 범위의 스냅샷 카운트(블롭 미포함) — `findRangeCounts` 프로젝션. */
  loadSnapshotCounts: (startDateKey: string, endDateKey: string) => Promise<SnapshotCountRow[]>;
  /** 변경피드 커서 ISO — 생략 판정의 신뢰 근거. */
  loadLatestCursorIso: () => Promise<string | null>;
  /** 진행률 보고(스트림 라우트의 sendEvent 연결용). */
  onProgress?: (info: { index: number; total: number; dateKey: string; skipped: boolean }) => void;
  /** 계측 훅 — 논리 호출 1건. */
  onLogicalCall?: () => void;
  /** 계측 훅 — 생략 1건. */
  onSkipped?: () => void;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: number;
}

export interface FetchPendingOrdersResult {
  /** 라우트가 소비하는 wrapper 배열: `{ productOrder, order }`. */
  items: any[];
  chunks: OrderChunk[];
  /** 날짜별 조회 라인수 — 스냅샷 대조의 좌변. */
  fetchedByDate: Record<string, number>;
  skippedDateKeys: string[];
  /** 조회 온전성 경고(비어 있으면 대조 통과). */
  integrityIssues: ChunkIntegrityIssue[];
  /** 청크 조회가 재시도 후에도 실패해 중단된 경우 — 호출부는 발주서를 만들면 안 된다. */
  failure: { dateKey: string; message: string } | null;
  /** 생략 판정이 왜 그렇게 났는지(진단·로그용). */
  skipReasons: Record<string, SkipReason>;
}

const INTER_CHUNK_DELAY_MS = 300;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 발주 대상 주문을 캠페인 창만큼 조회한다 — **KST 자정 정렬 · 스냅샷 근거 생략 · 온전성 대조**.
 *
 * 실패 처리는 종전 두 라우트와 같다: 청크당 1회 재시도 후에도 실패하면 **중단**하고
 * `failure` 를 채운다. 조회 실패를 삼키면 그 날짜 주문이 발주서에서 통째로 빠진 채 파일만
 * 정상 생성된다(브랜드사 전달 문서에서 주문 누락 = 배송 누락, P0).
 */
export async function fetchPendingOrderWindow(
  startMs: number,
  deps: FetchPendingOrdersDeps,
): Promise<FetchPendingOrdersResult> {
  const {
    apiRequest,
    loadSnapshotCounts,
    loadLatestCursorIso,
    onProgress,
    onLogicalCall,
    onSkipped,
    sleep = defaultSleep,
    nowMs = Date.now(),
  } = deps;

  const chunks = planKstDayChunks(startMs, nowMs);
  const result: FetchPendingOrdersResult = {
    items: [],
    chunks,
    fetchedByDate: {},
    skippedDateKeys: [],
    integrityIssues: [],
    failure: null,
    skipReasons: {},
  };
  if (chunks.length === 0) return result;

  const todayKey = toKstDateKey(nowMs);

  // 생략 근거 2종을 먼저 확보한다. 실패하면 **생략 없이 전량 조회**로 안전 강등한다 —
  // 근거를 못 읽은 것을 "발주 대상 없음"으로 오독하면 발주서가 비어 나간다.
  let snapshots: SnapshotCountRow[] = [];
  let cursorHealthy = false;
  try {
    snapshots = await loadSnapshotCounts(chunks[0].dateKey, chunks[chunks.length - 1].dateKey);
    const cursorIso = await loadLatestCursorIso();
    cursorHealthy = isCursorHealthy(cursorIso, nowMs);
  } catch (err) {
    console.warn('[order-fetch-window] 생략 근거 로드 실패 — 전량 조회로 강등:', err);
    snapshots = [];
    cursorHealthy = false;
  }
  const snapshotByDate = new Map(snapshots.map((s) => [s.snapshotDate, s]));

  /**
   * 한 창의 **모든 페이지**를 조회한다. 페이징은 `product-order-paging` SSOT 에 위임한다 —
   * 종전에는 계약을 몰라 "정확히 pageSize 만큼 오면 창을 이분해 재조회"하는 우회를 썼는데,
   * `page` 파라미터 실존이 확정돼(공식 Discussion #2476) 정직한 페이징으로 교체했다.
   */
  async function fetchRange(fromIso: string, toIso: string): Promise<any[]> {
    const paged = await fetchAllProductOrderPages(
      { fromIso, toIso },
      {
        apiRequest,
        sleep,
        interPageDelayMs: INTER_CHUNK_DELAY_MS,
        // **결제일 기준으로 명시**(오너 결정 2026-07-30, 1단계 = 발주서 경로).
        // 이 모듈의 날짜별 생략 게이트는 "조회 창의 술어 == 스냅샷의 날짜 귀속"을 전제로
        // 성립한다. 스냅샷은 `paymentDate` 우선으로 귀속하므로(orderToDateKey) 창도 결제일로
        // 맞춰야 전제가 참이 된다. 종전엔 API 기본값에 맡겨 그 전제가 운에 달려 있었다.
        // 스냅샷을 만드는 경로(runFullSync 등)도 2단계에서 같은 값을 명시했으므로, 이제
        // 이 전제는 양쪽 모두에서 계약이다(`product-order-range-type.contract.test.ts`).
        rangeType: PRODUCT_ORDER_RANGE_TYPE_PAYED,
      },
    );
    // 페이지 상한·page 무시 의심은 삼키지 않는다 — 발주서 누락으로 직결되는 신호다.
    if (paged.hitPageLimit || paged.pageParamSuspect) {
      console.warn(
        `[order-fetch-window] 페이징 경고 ${fromIso}~${toIso}: hitPageLimit=${paged.hitPageLimit} pageParamSuspect=${paged.pageParamSuspect}`,
      );
    }
    return paged.contents
      .map((wrapper: any) => {
        if (!wrapper?.content?.productOrder) return null;
        return { productOrder: wrapper.content.productOrder, order: wrapper.content.order };
      })
      .filter(Boolean);
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const decision = decideChunkSkip({
      dateKey: chunk.dateKey,
      todayKey,
      snapshot: snapshotByDate.get(chunk.dateKey),
      cursorHealthy,
    });
    result.skipReasons[chunk.dateKey] = decision.reason;

    onProgress?.({ index: i, total: chunks.length, dateKey: chunk.dateKey, skipped: decision.skip });

    if (decision.skip) {
      result.skippedDateKeys.push(chunk.dateKey);
      onSkipped?.();
      continue; // 생략한 청크엔 레이트리밋 대기도 붙이지 않는다 — 지연 절감의 실체가 여기다.
    }

    onLogicalCall?.();
    try {
      const wrappers = await fetchRange(chunk.fromIso, chunk.toIso);
      result.items.push(...wrappers);
      result.fetchedByDate[chunk.dateKey] = (result.fetchedByDate[chunk.dateKey] || 0) + wrappers.length;
    } catch (err: any) {
      result.failure = { dateKey: chunk.dateKey, message: err?.message || '네이버 API 오류' };
      return result;
    }

    if (i < chunks.length - 1) await sleep(INTER_CHUNK_DELAY_MS);
  }

  result.integrityIssues = findChunkIntegrityIssues(result.fetchedByDate, snapshots);
  if (result.integrityIssues.length > 0) {
    // ⚠️ 경고만 남긴다. 차단하지 않는다 — 위 findChunkIntegrityIssues 주석의 오탐 실사고.
    console.warn(
      '[order-fetch-window] 조회 수 대조 불일치(관측 신호 — 차단 아님):',
      JSON.stringify(result.integrityIssues),
    );
  }

  return result;
}
