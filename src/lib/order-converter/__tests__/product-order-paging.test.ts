import { describe, it, expect, vi } from 'vitest';
import {
  PRODUCT_ORDER_MAX_PAGES,
  PRODUCT_ORDER_PAGE_SIZE,
  PRODUCT_ORDER_RANGE_TYPE_PAYED,
  fetchAllProductOrderPages,
} from '../product-order-paging';

const WINDOW = { fromIso: '2026-07-06T15:00:00.000Z', toIso: '2026-07-07T14:59:59.999Z' };

/** `contents` 항목 1개(응답 원본 형태). */
const item = (id: string) => ({
  content: { productOrder: { productOrderId: id, productOrderStatus: 'PAYED' }, order: { orderId: `o-${id}` } },
});

/** n개 항목을 만든다(id 는 prefix 로 페이지 구분). */
const page = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => item(`${prefix}-${i}`));

function deps(over: Record<string, unknown> = {}) {
  return { apiRequest: vi.fn(), sleep: vi.fn(async () => {}), ...over } as any;
}

describe('fetchAllProductOrderPages — page 파라미터를 따라간다', () => {
  it('page 를 1부터 보내고, pageSize 미만이 오면 멈춘다(정산 동기화와 같은 관용구)', async () => {
    const d = deps({
      pageSize: 3,
      apiRequest: vi.fn(async (_m, _p, _b, q: any) => {
        const p = Number(q.page);
        // 1,2 페이지는 꽉 차고 3페이지는 1건 → 마지막
        return { data: { contents: p === 1 ? page('a', 3) : p === 2 ? page('b', 3) : page('c', 1) } };
      }),
    });

    const res = await fetchAllProductOrderPages(WINDOW, d);

    expect(res.pages).toBe(3);
    expect(res.contents).toHaveLength(7);
    expect(res.hitPageLimit).toBe(false);
    expect(res.pageParamSuspect).toBe(false);
    // page 파라미터가 실제로 실려 나갔는지 — 이게 이 PR 의 핵심이다.
    expect(d.apiRequest.mock.calls.map((c: any[]) => c[3].page)).toEqual(['1', '2', '3']);
    // pageSize 도 함께
    expect(d.apiRequest.mock.calls[0][3]).toMatchObject({ pageSize: '3', from: WINDOW.fromIso, to: WINDOW.toIso });
  });

  it('첫 페이지가 pageSize 미만이면 1회 호출로 끝난다(대부분의 정상 케이스)', async () => {
    const d = deps({
      pageSize: 300,
      apiRequest: vi.fn(async () => ({ data: { contents: page('a', 5) } })),
    });

    const res = await fetchAllProductOrderPages(WINDOW, d);

    expect(d.apiRequest).toHaveBeenCalledTimes(1);
    expect(res.pages).toBe(1);
    expect(res.contents).toHaveLength(5);
  });

  it('정확히 pageSize 만큼 온 뒤 빈 페이지가 오면 거기서 끝(경계)', async () => {
    const d = deps({
      pageSize: 2,
      apiRequest: vi.fn(async (_m, _p, _b, q: any) =>
        Number(q.page) === 1 ? { data: { contents: page('a', 2) } } : { data: { contents: [] } },
      ),
    });

    const res = await fetchAllProductOrderPages(WINDOW, d);

    expect(res.contents).toHaveLength(2);
    expect(res.pages).toBe(2);
    expect(res.hitPageLimit).toBe(false);
  });

  it('종전 동작 회귀 방지: 300건이 꽉 찬 창에서 1페이지만 받고 끝나지 않는다', async () => {
    // 이게 이 PR 이 고치는 결함이다 — page 미전송 시 301번째 이후가 조용히 유실됐다.
    const d = deps({
      apiRequest: vi.fn(async (_m, _p, _b, q: any) =>
        Number(q.page) === 1
          ? { data: { contents: page('full', PRODUCT_ORDER_PAGE_SIZE) } }
          : { data: { contents: page('tail', 7) } },
      ),
    });

    const res = await fetchAllProductOrderPages(WINDOW, d);

    expect(res.contents).toHaveLength(PRODUCT_ORDER_PAGE_SIZE + 7);
    expect(res.pages).toBe(2);
  });
});

/**
 * 이 블록은 **메커니즘만** 고정한다 — "호출부가 넘기면 실리고, 안 넘기면 키 자체가 없다".
 * 어느 호출부가 실제로 무엇을 넘기는지(현재는 4곳 전부 `PAYED_DATETIME`)는 정책이고,
 * `product-order-range-type.contract.test.ts` 가 고정한다. 두 관심사를 한 테스트에 섞으면
 * 정책이 바뀔 때 메커니즘 가드까지 삭제하게 된다(1단계 → 2단계에서 실제로 그럴 뻔했다).
 */
describe('rangeType — 호출부가 정한다(생략 가능한 파라미터)', () => {
  it('생략하면 쿼리에 rangeType 키가 **아예 없다**(빈 문자열을 보내지 않는다)', () => {
    // 빈 문자열·`undefined` 를 실어 보내면 API 가 잘못된 값으로 해석할 수 있다.
    // 술어를 안 정한 호출부는 "안 보낸다"가 되어야 API 기본값이 그대로 적용된다.
    const d = deps({ pageSize: 300, apiRequest: vi.fn(async () => ({ data: { contents: [] } })) });
    return fetchAllProductOrderPages(WINDOW, d).then(() => {
      const q = d.apiRequest.mock.calls[0][3];
      expect('rangeType' in q).toBe(false);
    });
  });

  it('넘기면 그 값이 쿼리에 실린다', async () => {
    const d = deps({
      pageSize: 300,
      rangeType: 'PAYED_DATETIME',
      apiRequest: vi.fn(async () => ({ data: { contents: [] } })),
    });

    await fetchAllProductOrderPages(WINDOW, d);

    expect(d.apiRequest.mock.calls[0][3]).toMatchObject({ rangeType: 'PAYED_DATETIME' });
  });

  it('상수가 결제일 기준을 가리킨다(스냅샷의 paymentDate 귀속과 일치시키는 값)', () => {
    expect(PRODUCT_ORDER_RANGE_TYPE_PAYED).toBe('PAYED_DATETIME');
  });
});

describe('방어 1: page 가 무시되는 경우', () => {
  it('같은 페이지가 반복 반환되면 중단하고 pageParamSuspect 를 켠다', async () => {
    // 실 API 로 계약을 검증할 수 없는 환경이라(로컬에 Commerce 자격증명 없음) 이 방어가 필수다.
    // 없으면 page 가 무시될 때 같은 300건을 maxPages 만큼 반복 누적한다.
    const d = deps({
      pageSize: 2,
      apiRequest: vi.fn(async () => ({ data: { contents: page('same', 2) } })), // page 무시
    });

    const res = await fetchAllProductOrderPages(WINDOW, d);

    expect(res.pageParamSuspect).toBe(true);
    expect(res.pages).toBe(2); // 2페이지에서 감지하고 멈춘다
    expect(res.contents).toHaveLength(2); // 중복은 쌓이지 않는다
  });
});

describe('방어 2: productOrderId dedup — 이중 발송 차단', () => {
  it('페이지 경계에서 겹친 라인은 한 번만 담긴다', async () => {
    // 중복이 발주서에 실리면 같은 주문이 두 번 발송된다 — 되돌릴 수 없는 사고다.
    const d = deps({
      pageSize: 2,
      apiRequest: vi.fn(async (_m, _p, _b, q: any) =>
        Number(q.page) === 1
          ? { data: { contents: [item('x-1'), item('x-2')] } }
          : { data: { contents: [item('x-2'), item('x-3')] } }, // x-2 겹침, 그리고 1건 부족 → 종료
      ),
    });

    const res = await fetchAllProductOrderPages(WINDOW, d);

    expect(res.contents.map((c) => c.content.productOrder.productOrderId)).toEqual(['x-1', 'x-2', 'x-3']);
    expect(res.duplicatesDropped).toBe(1);
  });

  it('productOrderId 가 없는 항목은 dedup 대상이 아니라 그대로 담긴다', async () => {
    const d = deps({
      pageSize: 300,
      apiRequest: vi.fn(async () => ({ data: { contents: [{ content: {} }, { content: {} }] } })),
    });

    const res = await fetchAllProductOrderPages(WINDOW, d);

    expect(res.contents).toHaveLength(2);
    expect(res.duplicatesDropped).toBe(0);
  });
});

describe('상한·실패 처리', () => {
  it('페이지 상한에 걸리면 hitPageLimit 을 켠다(호출부가 삼키면 안 되는 신호)', async () => {
    const d = deps({
      pageSize: 1,
      maxPages: 3,
      apiRequest: vi.fn(async (_m, _p, _b, q: any) => ({ data: { contents: [item(`p${q.page}`)] } })),
    });

    const res = await fetchAllProductOrderPages(WINDOW, d);

    expect(res.pages).toBe(3);
    expect(res.hitPageLimit).toBe(true);
    expect(res.contents).toHaveLength(3);
  });

  it('페이지 조회는 1회 재시도 후 throw 한다 — 실패 정책은 호출부가 정한다', async () => {
    const d = deps({ apiRequest: vi.fn(async () => { throw new Error('네이버 장애'); }) });

    await expect(fetchAllProductOrderPages(WINDOW, d)).rejects.toThrow('네이버 장애');
    expect(d.apiRequest).toHaveBeenCalledTimes(2);
  });

  it('재시도로 성공하면 정상 진행한다', async () => {
    let calls = 0;
    const d = deps({
      pageSize: 300,
      apiRequest: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('일시 장애');
        return { data: { contents: page('a', 2) } };
      }),
    });

    const res = await fetchAllProductOrderPages(WINDOW, d);

    expect(res.contents).toHaveLength(2);
    expect(res.pages).toBe(1);
  });

  it('빈 응답·비배열 응답을 방어한다', async () => {
    for (const body of [{}, { data: {} }, { data: { contents: null } }]) {
      const d = deps({ apiRequest: vi.fn(async () => body) });
      const res = await fetchAllProductOrderPages(WINDOW, d);
      expect(res.contents).toEqual([]);
    }
  });

  it('기본 상한 상수가 실측 물량(하루 최대 224건)에 대해 충분한 여유를 갖는다', () => {
    expect(PRODUCT_ORDER_PAGE_SIZE * PRODUCT_ORDER_MAX_PAGES).toBeGreaterThan(224 * 10);
  });
});
