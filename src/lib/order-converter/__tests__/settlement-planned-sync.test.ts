import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 계획 기반 정산 조회(`runPlannedSettlementSync`)의 호출 계약.
 *
 * 이 경로의 존재 이유는 **호출량**이다 — 종전 고정 달력은 데이터 유무와 무관하게 하루 24콜을
 * 써서 프록시 월 한도를 넘겼다. 그래서 여기서 고정하는 것은 전부 「몇 번, 무엇으로 부르는가」다:
 * 계획한 날짜마다 결제일 축 1회 · 정산 여부 필터 없음(정산·미정산·차감이 한 응답에 온다 —
 * 2026-09-10 실호출 검증) · 정산완료일 축 없음 · 빈 계획이면 0회.
 */

const apiRequestMock = vi.fn();
const upsertMock = vi.fn();

vi.mock('../naver-commerce-client', () => ({
  apiRequest: (...a: unknown[]) => apiRequestMock(...a),
}));
vi.mock('@/lib/order-converter/prisma', () => ({
  prisma: { naverSettlementCase: { upsert: (...a: unknown[]) => upsertMock(...a) } },
}));
vi.mock('../naver-order-sync', () => ({ queryOrderDetails: vi.fn() }));

import { runPlannedSettlementSync } from '../naver-settlement-sync';

function plan(...dateKeys: string[]) {
  return { dates: dateKeys.map((dateKey) => ({ dateKey, reasons: ['recent-order-date' as const], pendingOrders: 0 })) };
}

/** settle/case 한 페이지 응답(행 n개). */
function page(n: number) {
  return {
    data: {
      elements: Array.from({ length: n }, (_, i) => ({
        productOrderId: `po-${i}`,
        settleType: 'QUICK_SETTLE_ORIGINAL',
        payDate: '2026-09-10',
        settleExpectAmount: 1000,
      })),
    },
  };
}

type Query = Record<string, string>;
const queries = () => apiRequestMock.mock.calls.map((c) => c[3] as Query);

beforeEach(() => {
  vi.clearAllMocks();
  apiRequestMock.mockResolvedValue(page(0));
  upsertMock.mockResolvedValue({});
});

describe('runPlannedSettlementSync', () => {
  it('계획한 날짜마다 결제일 축으로 한 번씩 부르고, 정산 여부 필터·정산완료일 축은 쓰지 않는다', async () => {
    // ⛔ 「안전하게」 정산·미정산을 나눠 두 번 부르면 같은 데이터에 호출량만 두 배다.
    apiRequestMock.mockResolvedValue(page(2));

    const result = await runPlannedSettlementSync(plan('2026-09-09', '2026-09-10'));

    expect(queries().map((q) => q.searchDate)).toEqual(['2026-09-09', '2026-09-10']);
    for (const q of queries()) {
      expect(q.periodType).toBe('SETTLE_CASEBYCASE_PAY_DATE');
      expect(q).not.toHaveProperty('settleDecisionType');
    }
    expect(result).toEqual({ datesFetched: 2, calls: 2, casesUpserted: 4 });
  });

  it('계획이 비면 네이버를 한 번도 부르지 않는다', async () => {
    // 대기 주문이 없는 날의 값 — 종전 고정 달력은 이런 날에도 24콜을 썼다.
    const result = await runPlannedSettlementSync({ dates: [] });

    expect(apiRequestMock).not.toHaveBeenCalled();
    expect(result).toEqual({ datesFetched: 0, calls: 0, casesUpserted: 0 });
  });

  it('한 페이지가 가득 차면 다음 페이지를 따라가고 그 호출도 센다', async () => {
    // `calls` 는 프록시 사용량과 대조하는 값이라 논리 날짜 수가 아니라 실제 HTTP 호출 수여야 한다.
    apiRequestMock.mockResolvedValueOnce(page(1000)).mockResolvedValueOnce(page(3));

    const result = await runPlannedSettlementSync(plan('2026-09-10'));

    expect(queries().map((q) => q.pageNumber)).toEqual(['1', '2']);
    expect(result.calls).toBe(2);
    expect(result.casesUpserted).toBe(1003);
  });
});
