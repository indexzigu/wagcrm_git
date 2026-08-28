import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * 주문확인(발주서) 스트림 라우트의 **구조 계약**을 고정한다.
 *
 * 왜 이 테스트가 필요한가: 네이버 호출 계측(P7)을 붙이면서 종전에 5곳(조기반환 3 ·
 * 성공 1 · catch 1)에 흩어져 있던 `controller.close()` 를 finally 한 곳으로 모았다.
 * 이 구조가 깨지는 방식이 둘 다 조용하다 —
 *  ① close 가 사라지면 스트림이 안 닫혀 주문확인 버튼이 영원히 "조회 중"에 멈춘다.
 *  ② close 를 계측 기록 **앞으로** 되돌리면 응답 완료 후 DB 쓰기가 잘려 계측이 유실된다.
 * 둘 다 타입체커·린터가 못 잡으므로 여기서 기계로 막는다.
 */

const apiRequestMock = vi.fn();
const recordNaverOperationUsageMock = vi.fn();
const findUniqueCampaignMock = vi.fn();
const findManyCampaignMock = vi.fn();
const findRangeCountsMock = vi.fn();
const findLatestCursorMock = vi.fn();

vi.mock('@/lib/order-converter/naver-commerce-client', () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
}));

vi.mock('@/lib/order-converter/prisma', () => ({
  prisma: {
    orderCampaign: {
      findUnique: (...args: unknown[]) => findUniqueCampaignMock(...args),
      findMany: (...args: unknown[]) => findManyCampaignMock(...args),
    },
    dailyOrderTask: { findUnique: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('@/repositories/naverOrderSnapshotRepository', () => ({
  naverOrderSnapshotRepository: {
    findRangeCounts: (...args: unknown[]) => findRangeCountsMock(...args),
    findLatestCursor: (...args: unknown[]) => findLatestCursorMock(...args),
  },
}));

// 계측 기록만 목으로 가로채고, tally 순수 로직은 실물을 쓴다(카운터가 실제로 도는지 보려고).
vi.mock('@/lib/order-converter/naver-api-usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/order-converter/naver-api-usage')>();
  return {
    ...actual,
    recordNaverOperationUsage: (...args: unknown[]) => recordNaverOperationUsageMock(...args),
  };
});

import { GET } from './route';

function makeRequest() {
  return new NextRequest('http://localhost:3000/order-converter/api/campaigns/c1/execute/stream?action=download');
}

const params = Promise.resolve({ id: 'c1' });

/** 스트림을 끝까지 읽어 SSE 이벤트 객체 배열로 만든다. 닫히지 않으면 여기서 끝나지 않는다. */
async function drain(res: Response): Promise<any[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: any[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

beforeEach(() => {
  apiRequestMock.mockReset();
  recordNaverOperationUsageMock.mockReset();
  recordNaverOperationUsageMock.mockResolvedValue(undefined);
  findUniqueCampaignMock.mockReset();
  findManyCampaignMock.mockReset();
  findManyCampaignMock.mockResolvedValue([]);
  findRangeCountsMock.mockReset();
  findRangeCountsMock.mockResolvedValue([]);
  findLatestCursorMock.mockReset();
  // 커서 신선 — 생략 게이트가 동작할 수 있는 기본 상태.
  findLatestCursorMock.mockResolvedValue({ lastChangeStatusCursor: new Date().toISOString() });
});

/** 캠페인 목 — salesCampaigns 는 조회창 SSOT 가 읽는다. */
function campaignFixture(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    name: '테스트 캠페인',
    template: 'brand-a',
    sellerName: '셀러',
    productId: null,
    startDate: new Date(Date.now() - 60 * 60 * 1000),
    endDate: null,
    salePeriod: null,
    salesCampaigns: [],
    mappings: [],
    ...over,
  };
}

describe('주문확인 스트림 — 조기 반환도 스트림을 닫고 계측을 남긴다', () => {
  it('캠페인이 없으면 error 이벤트 + 스트림 종료 + 실패로 계측', async () => {
    findUniqueCampaignMock.mockResolvedValue(null);

    const res = await GET(makeRequest(), { params });
    // 닫히지 않으면 이 await 가 영원히 안 끝난다 — 그 자체가 회귀 신호다.
    const events = await drain(res);

    expect(events.at(-1)).toMatchObject({ error: expect.stringContaining('찾을 수 없습니다') });
    expect(recordNaverOperationUsageMock).toHaveBeenCalledTimes(1);

    const usage = recordNaverOperationUsageMock.mock.calls[0][0];
    expect(usage.operation).toBe('confirm_order');
    expect(usage.success).toBe(false);
    expect(usage.context).toMatchObject({ campaignId: 'c1' });
    // 캠페인을 못 찾았으니 네이버는 한 번도 부르지 않았다.
    expect(usage.tally.logicalCalls).toBe(0);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it('청크 조회가 실패하면 중단하고 실패로 계측한다(누락 발주서 방지 경로)', async () => {
    findUniqueCampaignMock.mockResolvedValue(campaignFixture());
    apiRequestMock.mockRejectedValue(new Error('네이버 장애'));

    const events = await drain(await GET(makeRequest(), { params }));

    expect(events.at(-1)?.error).toContain('주문 조회 실패');
    const usage = recordNaverOperationUsageMock.mock.calls[0][0];
    expect(usage.success).toBe(false);
    // 조회를 "시도"한 논리 호출은 세어진다 — 최적화 전 베이스라인이 이 값이다.
    expect(usage.tally.logicalCalls).toBeGreaterThan(0);
    expect(usage.tally.skipped).toBe(0);
  });

  it('매칭 주문이 0건이면 error 로 끝나고, 논리 호출 수가 계측된다', async () => {
    findUniqueCampaignMock.mockResolvedValue(campaignFixture());
    // 조회는 성공하지만 이 캠페인에 매칭되는 주문이 없다.
    apiRequestMock.mockResolvedValue({ data: { contents: [] } });

    const events = await drain(await GET(makeRequest(), { params }));

    // 발주 대상이 0건이면 "매핑 문제"가 아니라 "할 일 없음"으로 말한다(baseline 이 드러낸 오해).
    expect(events.at(-1)?.error).toContain('지금 발주할 주문이 없습니다');
    expect(events.at(-1)?.error).toContain('매핑 설정 문제가 아닙니다');

    const usage = recordNaverOperationUsageMock.mock.calls[0][0];
    // no-work 는 실패가 아니다 — 실패율에 "장애"와 "할 일 없음"이 섞이면 지표를 못 쓴다.
    expect(usage.success).toBe(true);
    expect(usage.context).toMatchObject({ outcome: 'no-work' });
    expect(usage.tally.logicalCalls).toBeGreaterThan(0);
  });

  it('발주 대상은 있는데 매핑이 안 맞으면 매핑 문제로 말하고 실패로 센다', async () => {
    findUniqueCampaignMock.mockResolvedValue(
      campaignFixture({ name: '전혀 다른 이름', mappings: [{ productName: '없는상품', optionName: null }] }),
    );
    apiRequestMock.mockResolvedValue({
      data: {
        contents: [
          { content: { productOrder: { productOrderId: 'p1', productOrderStatus: 'PAYED', productName: '무관한상품' }, order: { orderId: 'o1' } } },
        ],
      },
    });

    const events = await drain(await GET(makeRequest(), { params }));

    expect(events.at(-1)?.error).toContain('매핑 룰에 맞는 건이 없습니다');
    const usage = recordNaverOperationUsageMock.mock.calls[0][0];
    expect(usage.success).toBe(false);
    expect(usage.context).toMatchObject({ outcome: 'failure' });
  });
});

describe('조회 범위 최적화 — 스냅샷 근거 생략이 라우트에서 실제로 호출을 줄인다', () => {
  it('발주 대상 0 을 증언한 과거 날짜는 조회하지 않고, skipped 가 계측된다', async () => {
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const toKey = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // 5일 창(오늘 포함). 오늘·어제는 무조건 조회되고, 그 앞 3일은 스냅샷이 0을 증언한다.
    findUniqueCampaignMock.mockResolvedValue(
      campaignFixture({ startDate: new Date(nowMs - 4 * dayMs) }),
    );
    findRangeCountsMock.mockResolvedValue(
      [2, 3, 4].map((back) => ({
        snapshotDate: toKey(nowMs - back * dayMs),
        ordersCount: 5,
        newOrdersCount: 0,
        lastCallTime: new Date(nowMs),
      })),
    );
    apiRequestMock.mockResolvedValue({ data: { contents: [] } });

    await drain(await GET(makeRequest(), { params }));

    // 오늘 + 어제만 조회 = 2회. 종전 구현이라면 5회였다.
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
    const usage = recordNaverOperationUsageMock.mock.calls[0][0];
    expect(usage.tally.logicalCalls).toBe(2);
    expect(usage.tally.skipped).toBe(3);
  });

  it('조회 수가 스냅샷보다 적어도 **차단하지 않는다** — 오탐이 확인된 신호다', async () => {
    // 프로덕션 실측(2026-07-30T06:14Z): 07-12 스냅샷 43건 중 paymentDate 가 null 인 2건
    // 때문에 조회 41 < 기록 43 이 되어 **발주서 생성이 막혔다**. 스냅샷의 날짜 귀속
    // (paymentDate→orderDate→orderCreateDate 폴백)과 범위 조회의 결제일 기준이 달라
    // 두 수는 같은 술어로 센 값이 아니다. 그래서 관측 신호로만 남긴다.
    const nowMs = Date.now();
    const toKey = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

    findUniqueCampaignMock.mockResolvedValue(campaignFixture());
    findRangeCountsMock.mockResolvedValue([
      { snapshotDate: toKey(nowMs), ordersCount: 99, newOrdersCount: 1, lastCallTime: new Date(nowMs) },
    ]);
    apiRequestMock.mockResolvedValue({ data: { contents: [] } }); // 0건 조회 << 99건 기록

    const events = await drain(await GET(makeRequest(), { params }));

    // 차단 문구가 **없어야** 한다 — 여기서 막으면 발주서를 못 만든다.
    expect(events.some((e) => String(e?.error ?? '').includes('주문 조회가 불완전합니다'))).toBe(false);
    // 대신 참고 메시지로 알린다.
    expect(events.some((e) => String(e?.message ?? '').includes('수가 어긋날 수 있습니다'))).toBe(true);

    const usage = recordNaverOperationUsageMock.mock.calls[0][0];
    // 대조 불일치는 계측 metadata 로 관측된다(차단 사유가 아니다).
    // ⚠️ **수치까지** 담는다(`날짜:조회수/기록수`) — rangeType 을 PAYED_DATETIME 으로 명시한
    // 변경의 전후 차이를 관측할 유일한 수단이 이 값이다(API 기본값을 확인할 수 없어 사전
    // 증명이 불가능했다). 날짜만 담으면 delta 를 비교할 수 없다.
    expect(usage.context.countMismatch).toBe(`${toKey(nowMs)}:0/99`);
    // 창 술어가 명시로 바뀐 시점을 행에서 가를 수 있게 표식을 남긴다(로그 보존 1일).
    expect(usage.context.rangeType).toBe('PAYED_DATETIME');
  });
});

describe('계측 기록과 스트림 종료의 순서 계약', () => {
  it('계측 기록이 완료된 **뒤에** 스트림이 닫힌다(응답 완료 후 쓰기 유실 방지)', async () => {
    findUniqueCampaignMock.mockResolvedValue(null);

    let recordResolved = false;
    recordNaverOperationUsageMock.mockImplementation(async () => {
      // 기록이 느린 상황을 흉내낸다. 이게 끝나기 전에 스트림이 닫히면 아래 단정이 깨진다.
      await new Promise((r) => setTimeout(r, 20));
      recordResolved = true;
    });

    await drain(await GET(makeRequest(), { params }));

    expect(recordResolved).toBe(true);
  });

  it('계측 기록이 실패해도 스트림은 정상 종료된다(계측이 기능을 깨지 않는다)', async () => {
    findUniqueCampaignMock.mockResolvedValue(null);
    // 실물 recordNaverOperationUsage 는 내부에서 삼키지만, 만약 던지더라도
    // 스트림이 닫히는지(=버튼이 멈추지 않는지)를 확인한다.
    recordNaverOperationUsageMock.mockRejectedValue(new Error('DB down'));

    const res = await GET(makeRequest(), { params });
    await expect(drain(res)).resolves.toBeDefined();
  });
});
