import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getNaverCallTally, noteNaverHttpAttempt } from '../naver-api-usage';

/**
 * 계획 기반 정산 조회(`runPlannedSettlementSync`)의 호출 계약.
 *
 * 이 경로의 존재 이유는 **호출량**이다 — 종전 고정 달력은 데이터 유무와 무관하게 하루 24콜을
 * 써서 프록시 월 한도를 넘겼다. 그래서 여기서 고정하는 것은 「몇 번, 무엇으로 부르는가」다:
 * 결제일마다 결제일 축 1회 · 정산 여부 필터 없음(정산·미정산·차감이 한 응답에 온다 —
 * 2026-09-10 실호출 검증) · 정산완료일 축은 **안전망 날짜만** · 날짜별 실패 격리 ·
 * HTTP 시도 수는 재시도까지 센다.
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

function plan(dateKeys: string[], completionDates: string[] = []) {
  return {
    dates: dateKeys.map((dateKey) => ({ dateKey, reasons: ['recent-order-date' as const], pendingOrders: 0 })),
    completionDates,
  };
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
  it('계획한 결제일마다 결제일 축으로 한 번씩, 정산 여부 필터 없이 부른다', async () => {
    // ⛔ 「안전하게」 정산·미정산을 나눠 두 번 부르면 같은 데이터에 호출량만 두 배다.
    apiRequestMock.mockResolvedValue(page(2));

    const result = await runPlannedSettlementSync(plan(['2026-09-09', '2026-09-10']));

    expect(queries().map((q) => q.searchDate)).toEqual(['2026-09-09', '2026-09-10']);
    for (const q of queries()) {
      expect(q.periodType).toBe('SETTLE_CASEBYCASE_PAY_DATE');
      expect(q).not.toHaveProperty('settleDecisionType');
    }
    expect(result).toMatchObject({ datesFetched: 2, requests: 2, casesUpserted: 4, failedDates: [] });
  });

  it('안전망 날짜는 정산완료일 축으로 부른다', async () => {
    // 취소 감지가 놓친 반품의 차감은 결제일 계획에 오르지 않는다 — 끝나는 날 이 축에서만 잡힌다.
    const result = await runPlannedSettlementSync(plan([], ['2026-09-08', '2026-09-09']));

    expect(queries()).toEqual([
      expect.objectContaining({ searchDate: '2026-09-08', periodType: 'SETTLE_CASEBYCASE_SETTLE_COMPLETE_DATE' }),
      expect.objectContaining({ searchDate: '2026-09-09', periodType: 'SETTLE_CASEBYCASE_SETTLE_COMPLETE_DATE' }),
    ]);
    expect(result.completionDatesFetched).toBe(2);
  });

  it('부를 날짜가 없으면 네이버를 한 번도 부르지 않는다', async () => {
    const result = await runPlannedSettlementSync(plan([], []));

    expect(apiRequestMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ requests: 0, httpAttempts: 0, casesUpserted: 0 });
  });

  it('한 페이지가 가득 차면 다음 페이지를 따라가고 그 요청도 센다', async () => {
    apiRequestMock.mockResolvedValueOnce(page(1000)).mockResolvedValueOnce(page(3));

    const result = await runPlannedSettlementSync(plan(['2026-09-10']));

    expect(queries().map((q) => q.pageNumber)).toEqual(['1', '2']);
    expect(result.requests).toBe(2);
    expect(result.casesUpserted).toBe(1003);
  });

  it('HTTP 시도 수는 재시도까지 센다(프록시 사용량 대조용)', async () => {
    // `apiRequest` 는 401·429 를 내부에서 재시도한다 — 논리 요청 1건이 HTTP 2건일 수 있다.
    // 여기서는 실제 클라이언트처럼 컨텍스트의 집계기에 시도를 두 번 적는다(배선 검증).
    apiRequestMock.mockImplementation(async () => {
      const tally = getNaverCallTally();
      noteNaverHttpAttempt(tally, 'settle');
      noteNaverHttpAttempt(tally, 'settle');
      return page(1);
    });

    const result = await runPlannedSettlementSync(plan(['2026-09-10']));

    expect(result.requests).toBe(1);
    expect(result.httpAttempts).toBe(2);
  });

  it('한 날짜가 실패해도 나머지 날짜는 계속 부르고, 실패한 날짜만 돌려준다', async () => {
    // 첫 실패에서 전체를 멈추면 결정론적으로 실패하는 옛 날짜 하나가 최근 날짜를 재확인 창 밖으로 민다.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiRequestMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(page(1));

    const result = await runPlannedSettlementSync(plan(['2026-09-09', '2026-09-10'], ['2026-09-08']));

    expect(apiRequestMock).toHaveBeenCalledTimes(3);
    expect(result.failedDates).toEqual(['pay:2026-09-09']);
    expect(result.casesUpserted).toBe(2);
  });
});
