/**
 * `GET /v1/pay-order/seller/product-orders`(조건형 상품 주문 상세 내역 조회)의 **페이징 SSOT**.
 *
 * ## 왜 (확정 근거 2026-07-30)
 *
 * 이 엔드포인트는 **`page` 파라미터로 페이지네이션을 지원한다.** 근거는 네이버 커머스API 공식
 * 기술지원 Discussion #2476 의 실제 요청 예시다 —
 * `{ from, to, rangeType: "ORDERED_DATETIME", pageSize: 300, page: 3, ... }`.
 *
 * 그런데 이 레포의 호출부 5곳(execute · execute/stream · campaign-orders ·
 * closed-campaign-cache · **naver-order-sync runFullSync**)이 전부 `pageSize: 300` 만 주고
 * **`page` 를 한 번도 보내지 않았다** → 항상 1페이지만 받는다 → **창당 300건 초과분이 조용히
 * 유실된다.** 같은 파일의 변경피드는 `more/moreSequence` 를 따라가고 정산 동기화도 페이징하는데
 * 이 경로만 안 했다.
 *
 * 위험의 크기: `runFullSync` 는 **스냅샷 빌더**다. 스냅샷이 절단되면 그것을 근거로 삼는
 * 발주 조회 생략 게이트(`order-fetch-window`)·대시보드·모바일 매출·정산·클레임·재구매가 모두
 * 오염된다. 실측(2026-07-30)상 하루 최대 224건이라 아직 터지지 않았지만 상한의 75%다.
 *
 * ## 이 모듈이 하지 않는 것
 *
 * - **응답 shaping 을 하지 않는다.** 호출부가 두 형태로 갈린다(wrapper `{productOrder, order}`
 *   vs flat `{...order, ...productOrder}`) — 원본 `contents` 를 그대로 돌려주고 shaping 은 각자
 *   유지한다. 이 모듈의 단일 책임은 "한 창의 전 페이지를 빠짐없이 모으는 것"이다.
 * - **`rangeType` 은 호출부가 정한다(생략하면 미전송 = API 기본값).** ⚠️ 이 파라미터가 **어느
 *   날짜 필드로 창을 거르는지**를 정한다(Discussion #3614: `ORDERED_DATETIME` vs
 *   `PAYED_DATETIME` 결과가 다르고, 주문일 익일 결제 건은 `ORDERED_DATETIME` 으로 양쪽 날짜
 *   모두에서 안 잡힌다). **현재 이 레포의 호출부 4곳은 전부 `PAYED_DATETIME` 을 명시한다**
 *   (오너 결정 2026-07-30 — 1단계 발주서 경로 = `order-fetch-window`, 2단계 스냅샷 경로 =
 *   `runFullSync`·`closed-campaign-cache`·`campaign-orders`). 새 호출부도 명시할 것 —
 *   `product-order-range-type.contract.test.ts` 가 누락을 막는다.
 *   - **왜 `PAYED_DATETIME` 인가:** 스냅샷의 날짜 귀속이 이미 `paymentDate` 우선
 *     (`orderToDateKey`)이라, 조회 창의 술어를 결제일로 맞추면 **조회 창과 저장 키가 일치**한다.
 *     `order-fetch-window` 의 날짜별 생략 게이트는 그 일치를 전제로 성립하는데, 지금까지는
 *     그 전제가 "API 기본값이 우연히 맞기를 바라는" 상태였다. P7 의 매출 정의(결제 기준)와도 맞다.
 *   - ✅ **API 기본값은 `PAYED_DATETIME` 이었다(2026-07-30 프로덕션 실측 확정).** 명시 전/후
 *     주문확인의 **불일치 날짜가 `2026-07-12` 로 동일**하다(전=`countMismatchDates` ·
 *     후=`countMismatch`). 따라서 1단계도 2단계도 **동작 변화 0** 인 명시화였고, 스냅샷
 *     귀속 기준이 바뀌지 않아 **재빌드가 불요**했다.
 *     ⛔ 이 근거를 "전/후 `countMismatch` 가 `41/43` 으로 동일"이라고 적지 말 것 — 수치는
 *     #162 가 처음 담았으므로 "전" 쪽 행에는 존재하지 않는다(비교 해상도는 날짜까지. P7 참조).
 *   - ⚠️ **그래도 명시를 되돌리지 말 것.** 네이버가 예고 없이 기본값을 바꾸면
 *     `order-fetch-window` 생략 게이트의 전제(창 술어 == 스냅샷의 `paymentDate` 귀속)가
 *     조용히 깨진다. 명시가 그 리스크를 없앤다.
 *   - **파라미터 자체는 옵셔널로 남긴다** — 앞으로 `DISPATCHED_DATETIME` 처럼 다른 술어가
 *     필요한 호출부가 생길 수 있고, 이 모듈이 술어를 강제하면 그때 우회가 생긴다.
 */

/** 창당 페이지 크기(현행값 유지 — 상한은 문서화되지 않았다). */
export const PRODUCT_ORDER_PAGE_SIZE = 300;

/**
 * `rangeType` 허용값(공식 기술지원 Discussion 실사용에서 관측된 것들 — 전수는 아닐 수 있다):
 * `ORDERED_DATETIME`(#3614) · `PAYED_DATETIME`(#3614) · `DISPATCHED_DATETIME`(#3551) ·
 * `CLAIM_COMPLETED_DATETIME`(#3440).
 */
export type ProductOrderRangeType =
  | 'ORDERED_DATETIME'
  | 'PAYED_DATETIME'
  | 'DISPATCHED_DATETIME'
  | 'CLAIM_COMPLETED_DATETIME';

/**
 * 발주 조회가 쓰는 창 술어 — **결제일 기준**.
 * 스냅샷의 날짜 귀속이 `paymentDate` 우선이라 이 값이 조회 창과 저장 키를 일치시킨다.
 */
export const PRODUCT_ORDER_RANGE_TYPE_PAYED: ProductOrderRangeType = 'PAYED_DATETIME';

/** 한 창에서 따라갈 최대 페이지 수. 300×20 = 6,000라인/창 — 실측 최대(224)의 26배 여유. */
export const PRODUCT_ORDER_MAX_PAGES = 20;

const PAGE_RETRY_ATTEMPTS = 2;
const PAGE_RETRY_DELAY_MS = 1000;
const INTER_PAGE_DELAY_MS = 300;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ProductOrderPagingDeps {
  apiRequest: (
    method: string,
    path: string,
    body: undefined,
    query: Record<string, string>,
  ) => Promise<any>;
  pageSize?: number;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 페이지 사이 대기(레이트리밋 방지). 0 이면 대기 없음. */
  interPageDelayMs?: number;
  /**
   * 창을 어느 날짜 필드로 거를지. **생략하면 보내지 않는다**(= API 기본값 유지).
   * 현행 호출부 4곳은 전부 `PRODUCT_ORDER_RANGE_TYPE_PAYED` 를 넘긴다 — 새 호출부도 명시할 것
   * (헤더 주석 · `product-order-range-type.contract.test.ts`).
   */
  rangeType?: ProductOrderRangeType;
}

export interface ProductOrderPagingResult {
  /** 응답 원본 `data.contents` 항목들을 페이지 순서대로 이어붙인 배열(shaping 없음). */
  contents: any[];
  /** 실제로 조회한 페이지 수. */
  pages: number;
  /** 페이지 상한에 걸려 **더 있을 수 있는데 멈춘** 경우. 호출부는 이를 삼키면 안 된다. */
  hitPageLimit: boolean;
  /**
   * `page` 가 무시된 것으로 의심돼 중단한 경우(같은 페이지가 반복 반환).
   * 이 신호가 뜨면 페이징 계약 가정이 깨진 것이므로 조사 대상이다.
   */
  pageParamSuspect: boolean;
  /** productOrderId 중복으로 버린 라인 수(정상이면 0). */
  duplicatesDropped: number;
}

/** `contents` 항목에서 productOrderId 를 뽑는다(dedup·진행 판정용). */
function readProductOrderId(item: any): string | null {
  const id = item?.content?.productOrder?.productOrderId;
  return id == null ? null : String(id);
}

/**
 * 한 시간 창의 **모든 페이지**를 모아 반환한다.
 *
 * 종료 조건은 `naver-settlement-sync` 의 선례를 따른다 — 반환 수가 `pageSize` 보다 적으면
 * 마지막 페이지다(응답에 총건수 메타가 있는지 확인할 수 없어 이 방식이 계약 가정을 가장 적게 한다).
 *
 * 방어 2종(실 API 로 검증할 수 없는 환경이라 필수):
 *  1. **중복 페이지 감지** — `page` 가 무시되면 같은 1페이지가 무한 반복된다. 직전 페이지의 첫
 *     productOrderId 가 같으면 즉시 멈추고 `pageParamSuspect` 를 켠다.
 *  2. **productOrderId dedup** — 중복 라인이 발주서에 실리면 **같은 주문이 두 번 발송**된다.
 *     페이지 경계에서 겹치더라도 여기서 걸러 그 사고를 원천 차단한다.
 *
 * 페이지 조회 실패는 1회 재시도 후 **throw** 한다 — 호출부마다 실패 정책이 달라서
 * (중단 vs 부분 허용) 여기서 삼키지 않는다.
 */
export async function fetchAllProductOrderPages(
  window: { fromIso: string; toIso: string },
  deps: ProductOrderPagingDeps,
): Promise<ProductOrderPagingResult> {
  const {
    apiRequest,
    pageSize = PRODUCT_ORDER_PAGE_SIZE,
    maxPages = PRODUCT_ORDER_MAX_PAGES,
    sleep = defaultSleep,
    interPageDelayMs = INTER_PAGE_DELAY_MS,
    rangeType,
  } = deps;

  const contents: any[] = [];
  const seenIds = new Set<string>();
  let duplicatesDropped = 0;
  let pages = 0;
  let hitPageLimit = false;
  let pageParamSuspect = false;
  let previousFirstId: string | null = null;

  for (let page = 1; page <= maxPages; page++) {
    let pageItems: any[] | null = null;
    let lastErr: any = null;

    for (let attempt = 1; attempt <= PAGE_RETRY_ATTEMPTS && pageItems === null; attempt++) {
      try {
        const res = await apiRequest('GET', '/v1/pay-order/seller/product-orders', undefined, {
          from: window.fromIso,
          to: window.toIso,
          pageSize: String(pageSize),
          page: String(page),
          // 생략 시 키 자체를 넣지 않는다 — 빈 문자열을 보내면 API 가 잘못된 값으로 볼 수 있다.
          ...(rangeType ? { rangeType } : {}),
        });
        const raw = res?.data?.contents;
        pageItems = Array.isArray(raw) ? raw : [];
      } catch (err: any) {
        lastErr = err;
        console.warn(
          `[product-order-paging] page ${page} 조회 실패(attempt ${attempt}) ${window.fromIso}~${window.toIso}:`,
          err?.message || err,
        );
        if (attempt < PAGE_RETRY_ATTEMPTS) await sleep(PAGE_RETRY_DELAY_MS);
      }
    }

    if (pageItems === null) throw lastErr ?? new Error('네이버 API 오류');

    pages = page;
    if (pageItems.length === 0) break;

    // 방어 1: page 가 무시돼 같은 페이지가 다시 온 것인지.
    const firstId = readProductOrderId(pageItems[0]);
    if (page > 1 && firstId !== null && firstId === previousFirstId) {
      pageParamSuspect = true;
      console.warn(
        `[product-order-paging] page ${page} 가 직전 페이지와 같은 첫 주문(${firstId})을 반환 — page 파라미터 무시 의심, 중단`,
      );
      break;
    }
    previousFirstId = firstId;

    // 방어 2: productOrderId dedup — 중복이 발주서에 실리면 이중 발송이 된다.
    for (const item of pageItems) {
      const id = readProductOrderId(item);
      if (id !== null) {
        if (seenIds.has(id)) {
          duplicatesDropped++;
          continue;
        }
        seenIds.add(id);
      }
      contents.push(item);
    }

    // 마지막 페이지 판정(정산 동기화와 같은 관용구).
    if (pageItems.length < pageSize) break;

    if (page === maxPages) {
      hitPageLimit = true;
      console.warn(
        `[product-order-paging] 페이지 상한(${maxPages}) 도달 — 더 있을 수 있다 ${window.fromIso}~${window.toIso}`,
      );
      break;
    }

    if (interPageDelayMs > 0) await sleep(interPageDelayMs);
  }

  if (duplicatesDropped > 0) {
    console.warn(
      `[product-order-paging] productOrderId 중복 ${duplicatesDropped}건 제거 ${window.fromIso}~${window.toIso}`,
    );
  }

  return { contents, pages, hitPageLimit, pageParamSuspect, duplicatesDropped };
}
