import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PRODUCT_ORDER_RANGE_TYPE_PAYED } from '../product-order-paging';
import { fetchClosedCampaignOrders } from '../closed-campaign-cache';
import { orderToDateKey, runFullSync } from '../naver-order-sync';

/**
 * `GET /v1/pay-order/seller/product-orders` 의 **창 술어(`rangeType`) 명시 계약**.
 *
 * ## 왜 이 파일이 있나
 *
 * `rangeType` 은 조회 창을 **어느 날짜 필드로 거를지**를 정한다. 이 레포의 스냅샷 귀속은
 * `paymentDate` 우선(`orderToDateKey`)이고, `order-fetch-window` 의 **날짜별 생략 게이트는
 * "조회 창의 술어 == 스냅샷의 귀속 키"를 전제로만 성립**한다. 그래서 호출부 전원이
 * `PAYED_DATETIME` 을 명시해야 그 전제가 가정이 아니라 계약이 된다
 * (오너 결정 2026-07-30 — 1단계 발주서 경로, 2단계 스냅샷 경로).
 *
 * 막으려는 회귀는 **침묵형**이다: 새 호출부(또는 리팩터로 재작성된 기존 호출부)가
 * `rangeType` 을 빼먹어도 조회는 정상 동작하고 테스트도 통과한다. 어긋난 사실은
 * 네이버가 기본값을 바꾸는 날에야, 그것도 "발주서에 주문이 빠졌다"는 형태로 드러난다.
 * 이 레포의 반복 교훈이 정확히 그 지점이다 — 같은 계약을 손으로 다시 쓰는 호출부는
 * 반드시 갈라진다(`deal-claim-context.contract` · `instagram-scrape-callers.contract` 선례).
 *
 * ## 두 층으로 고정한다
 *
 * 1. **소스 스캔** — 헬퍼를 부르는 **모든** 파일의 모든 호출이 상수를 넘기는지. 아직 없는
 *    미래의 호출부까지 덮는 유일한 방법이다.
 * 2. **행위 검증** — 실제로 쿼리에 실려 나가는지. 스캔은 "상수가 쓰였다"까지만 보므로,
 *    blast radius 가 가장 큰 두 경로는 mock 으로 실제 쿼리를 확인한다.
 *
 * 메커니즘(넘기면 실린다 / 생략하면 키가 없다) 자체는 `product-order-paging.test.ts` 소관이다.
 */

const HELPER = 'fetchAllProductOrderPages';
const CONSTANT = 'PRODUCT_ORDER_RANGE_TYPE_PAYED';
const SSOT_FILE = join('src', 'lib', 'order-converter', 'product-order-paging.ts');

/** 이 커밋 시점에 알려진 호출부. 사라지면(=헬퍼 우회) 알아차려야 하므로 하한으로 고정한다. */
const KNOWN_CALLERS = [
  join('src', 'lib', 'order-converter', 'order-fetch-window.ts'),
  join('src', 'lib', 'order-converter', 'naver-order-sync.ts'),
  join('src', 'lib', 'order-converter', 'closed-campaign-cache.ts'),
  join('src', 'lib', 'order-converter', 'campaign-orders.ts'),
];

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, acc);
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** 테스트·SSOT 를 제외한 실제 호출부 목록(레포 상대 경로). */
function findCallerFiles(): string[] {
  const root = process.cwd();
  return walkTsFiles(join(root, 'src'))
    .map((abs) => relative(root, abs))
    .filter((rel) => rel !== SSOT_FILE)
    .filter((rel) => !rel.includes(`__tests__${sep}`) && !/\.test\.tsx?$/.test(rel))
    .filter((rel) => readFileSync(join(root, rel), 'utf8').includes(`${HELPER}(`));
}

/**
 * `fetchAllProductOrderPages(` 부터 **괄호 균형이 맞는 지점**까지의 인자 텍스트를 잘라낸다.
 * 정규식으로 한 줄만 보면 여러 줄에 걸친 deps 리터럴을 놓친다.
 */
function callArgumentTexts(source: string): string[] {
  const out: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const found = source.indexOf(`${HELPER}(`, searchFrom);
    if (found === -1) break;
    let depth = 0;
    let i = found + HELPER.length;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(found, i + 1));
    searchFrom = i + 1;
  }
  return out;
}

describe('rangeType 계약 — 헬퍼 호출부 전수 스캔', () => {
  const root = process.cwd();
  const callers = findCallerFiles();

  it('호출부를 실제로 찾아낸다(스캔이 0건이면 이 계약은 무력하다)', () => {
    // 경로 규칙이 바뀌어 스캔이 아무것도 못 찾으면 아래 it.each 가 **조용히 통과**한다.
    // 그 상태가 이 파일 전체를 장식으로 만들므로 하한을 명시적으로 못 박는다.
    expect(callers.length).toBeGreaterThanOrEqual(KNOWN_CALLERS.length);
    expect(callers.sort()).toEqual(expect.arrayContaining(KNOWN_CALLERS));
  });

  it.each(KNOWN_CALLERS)('%s 는 헬퍼를 계속 경유한다', (rel) => {
    // 헬퍼를 우회해 `apiRequest` 를 직접 부르면 창당 300건 유실이 재발한다(P7).
    expect(callers).toContain(rel);
  });

  it('모든 호출이 rangeType 을 명시한다 — 상수로만(리터럴 하드코딩 금지)', () => {
    const offenders: string[] = [];
    for (const rel of callers) {
      const source = readFileSync(join(root, rel), 'utf8');
      callArgumentTexts(source).forEach((args, idx) => {
        if (!args.includes(CONSTANT)) offenders.push(`${rel} (호출 #${idx + 1})`);
      });
    }
    // 실패하면 코드를 고친다 — 계약 자체의 변경은 오너 승인 사안이다(P9).
    expect(offenders).toEqual([]);
  });
});

describe('rangeType 계약 — 실제 쿼리에 실린다(blast radius 큰 경로)', () => {
  const productOrdersCalls = (spy: { mock: { calls: any[][] } }) =>
    spy.mock.calls.filter(([, path]) => path === '/v1/pay-order/seller/product-orders');

  beforeEach(() => {
    (global as any).__naverDailyCache = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (global as any).__naverDailyCache = {};
  });

  it('runFullSync(스냅샷 빌더)의 조회 창이 결제일 기준이다', async () => {
    // 스냅샷은 대시보드·모바일 매출·정산·클레임·재구매 + 발주 조회 생략 게이트가 전부
    // 소비한다. 여기 술어가 스냅샷의 `paymentDate` 귀속과 갈리면 오염이 그 전부로 번진다.
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');

    const paymentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const dateKey = orderToDateKey({ paymentDate })!;

    const apiSpy = vi.spyOn(clientModule, 'apiRequest').mockResolvedValue({
      data: {
        contents: [
          { content: { order: { paymentDate }, productOrder: { productOrderId: '1', productOrderStatus: 'PAYED', paymentDate } } },
        ],
      },
    } as any);
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily').mockResolvedValue({} as any);

    await runFullSync({ startDateKey: dateKey, endDateKey: dateKey, forceRefresh: true });

    const calls = productOrdersCalls(apiSpy as any);
    expect(calls.length).toBeGreaterThan(0);
    for (const [, , , query] of calls) {
      expect(query.rangeType).toBe(PRODUCT_ORDER_RANGE_TYPE_PAYED);
    }
  });

  it('fetchClosedCampaignOrders(마감 캐시)의 조회 창이 결제일 기준이다', async () => {
    // 마감 캐시는 이 결과를 매출·수량으로 **굳힌다** — 술어가 매출 정의(결제 기준)와
    // 달라지면 사후 정정 경로가 없다.
    const now = new Date('2026-07-30T05:00:00.000Z');
    const apiRequest = vi.fn(async () => ({ data: { contents: [] } }));

    await fetchClosedCampaignOrders(new Date(now.getTime() - 1000), apiRequest as any, { now, sleepMs: 0 });

    expect(apiRequest).toHaveBeenCalled();
    for (const [, , , query] of apiRequest.mock.calls as any[][]) {
      expect(query.rangeType).toBe(PRODUCT_ORDER_RANGE_TYPE_PAYED);
    }
  });
});
