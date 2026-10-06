import { describe, expect, it, vi } from 'vitest';
import { CONFIRM_CHUNK_SIZE, confirmPlaceOrders } from '../place-order-confirm';

/**
 * 발주확인 일괄 처리 — 주문확인과 발주요청 확정이 공유한다. 실사고 장치(청크 30 · 429 재시도 ·
 * 잔여 자동 재시도 · 시간 예산)를 행위로 고정한다. sleep 은 즉시 끝나는 가짜를 쓴다.
 */

const instantSleep = async () => {};

function okResponse(ids: string[]) {
  return { data: { successProductOrderInfos: ids.map((productOrderId) => ({ productOrderId })), failProductOrderInfos: [] } };
}

describe('confirmPlaceOrders', () => {
  it('30건씩 나눠 보낸다', async () => {
    const ids = Array.from({ length: CONFIRM_CHUNK_SIZE + 5 }, (_, i) => `P${i}`);
    const apiRequest = vi.fn(async (_m: string, _p: string, body: any) => okResponse(body.productOrderIds));
    const res = await confirmPlaceOrders(ids, { apiRequest, sleep: instantSleep });
    expect(apiRequest.mock.calls.map((c) => (c[2] as any).productOrderIds.length)).toEqual([CONFIRM_CHUNK_SIZE, 5]);
    expect(res.succeeded.size).toBe(ids.length);
    expect(res.pending).toEqual([]);
  });

  it('네이버가 조용히 빠뜨린 id 는 다음 라운드에 그 id 만 다시 보낸다', async () => {
    const apiRequest = vi
      .fn()
      .mockResolvedValueOnce(okResponse(['A']))
      .mockResolvedValueOnce(okResponse(['B']));
    const res = await confirmPlaceOrders(['A', 'B'], { apiRequest, sleep: instantSleep });
    expect((apiRequest.mock.calls[1][2] as any).productOrderIds).toEqual(['B']);
    expect([...res.succeeded].sort()).toEqual(['A', 'B']);
  });

  it('사유가 붙은 실패는 재시도하지 않고 첫 사유를 남긴다', async () => {
    const apiRequest = vi.fn(async () => ({
      data: { successProductOrderInfos: [], failProductOrderInfos: [{ productOrderId: 'A', code: 'X', message: '불가' }] },
    }));
    const res = await confirmPlaceOrders(['A'], { apiRequest, sleep: instantSleep });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect([...res.failedHard]).toEqual(['A']);
    expect(res.firstError).toContain('불가');
  });

  it('429 는 같은 청크를 한 번 더 보낸다', async () => {
    const apiRequest = vi.fn().mockRejectedValueOnce(new Error('HTTP 429')).mockResolvedValueOnce(okResponse(['A']));
    const res = await confirmPlaceOrders(['A'], { apiRequest, sleep: instantSleep });
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(res.succeeded.has('A')).toBe(true);
  });

  it('재시도 시간 예산(12초)을 넘기면 잔여를 남긴 채 멈춘다', async () => {
    let clock = 0;
    const apiRequest = vi.fn(async () => {
      clock += 13_000; // 한 라운드가 예산을 다 쓴다
      return { data: { successProductOrderInfos: [{ productOrderId: 'other' }], failProductOrderInfos: [] } };
    });
    const res = await confirmPlaceOrders(['A'], { apiRequest, sleep: instantSleep, nowMs: () => clock });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(res.pending).toEqual(['A']);
  });
});
