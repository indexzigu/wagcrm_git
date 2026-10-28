import { describe, it, expect, vi } from 'vitest';
import { requestManualOrderSync } from '../useCampaigns';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('requestManualOrderSync — 수동 동기화 실패 판정', () => {
  it('성공 응답이면 던지지 않고 CHANGED 로 요청한다', async () => {
    const f = fakeFetch(200, { syncType: 'CHANGED', skipped: false, changedProductOrderIds: [] });
    await expect(requestManualOrderSync(f)).resolves.toBeUndefined();
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/order-converter/api/naver/sync');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ mode: 'CHANGED' });
  });

  it('쿨다운으로 건너뛴 응답(skipped)은 실패가 아니다', async () => {
    await expect(requestManualOrderSync(fakeFetch(200, { skipped: true }))).resolves.toBeUndefined();
  });

  it('200 이어도 error 필드가 있으면 실패로 던진다 — 라우트가 동기화 실패를 200 으로 싣는다', async () => {
    await expect(requestManualOrderSync(fakeFetch(200, { error: 'fetch failed' }))).rejects.toThrow('fetch failed');
  });

  it('HTTP 오류면 던진다', async () => {
    await expect(requestManualOrderSync(fakeFetch(500, { error: 'Sync failed' }))).rejects.toThrow('Sync failed');
  });
});
