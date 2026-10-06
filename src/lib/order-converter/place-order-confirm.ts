/**
 * 네이버 발주확인(`POST /v1/pay-order/seller/product-orders/confirm`) 일괄 처리 SSOT.
 *
 * 주문확인(`execute/stream`)이 갖고 있던 루프를 그대로 옮겼다 — 발주 자동화 2단계의 확정 단계
 * (`purchase-order` POST)가 같은 쓰기를 하게 되면서 사본을 만들지 않으려고.
 *
 * 실사고에서 나온 장치 셋(되돌리지 말 것):
 * - **청크 30**: 청크 100 이 제한·레이트리밋에 걸려 전멸했는데 경고 로그로 삼켜져 파일만 정상
 *   다운로드됐다(스토어는 발주전 그대로). 응답 본문의 성공·실패 목록을 집계한다.
 * - **429 는 청크당 1회 재시도**, 그 밖의 호출 실패는 확정하지 않고 다음 라운드로 남긴다.
 * - **잔여 자동 재시도(2026-07-13)**: 네이버가 일부 id 를 성공·실패 어디에도 담지 않고 조용히
 *   누락하는 경우가 있다(제출 17 중 9만 확인). 최대 3라운드, 재시도 단계 총 12초 예산 안에서
 *   잔여만 다시 보낸다 — 실행시간 한도에 걸려 중간에 끊기는 것을 막는 상한이다.
 */

export const CONFIRM_CHUNK_SIZE = 30;
export const MAX_CONFIRM_ROUNDS = 3;
export const CONFIRM_RETRY_DELAY_MS = 2000;
export const CONFIRM_RETRY_TIME_BUDGET_MS = 12000;
const RATE_LIMIT_BACKOFF_MS = 1200;
const INTER_CHUNK_DELAY_MS = 300;

export type ConfirmProgress =
  | { kind: 'chunk'; offset: number; done: number; total: number }
  | { kind: 'retry'; pending: number; round: number; maxRounds: number };

export type ConfirmResult = {
  /** 네이버가 발주확인 성공으로 돌려준 id. */
  succeeded: Set<string>;
  /** 네이버가 사유와 함께 실패로 돌려준 id — 재시도 무의미. */
  failedHard: Set<string>;
  /** 재시도 후에도 성공·실패 어디에도 안 담긴 잔여(대개 0). */
  pending: string[];
  /** 첫 실패 사유(표시용). 없으면 빈 문자열. */
  firstError: string;
};

type ApiRequest = (method: string, path: string, body?: unknown) => Promise<unknown>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function confirmPlaceOrders(
  ids: readonly string[],
  deps: {
    apiRequest: ApiRequest;
    onProgress?: (progress: ConfirmProgress) => void;
    sleep?: (ms: number) => Promise<void>;
    nowMs?: () => number;
  },
): Promise<ConfirmResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const nowMs = deps.nowMs ?? Date.now;
  const succeeded = new Set<string>();
  const failedHard = new Set<string>();
  let firstError = '';

  // 한 라운드: ids 를 청크로 발주확인하고 성공·명시적 실패를 집합에 반영한다. 어느 목록에도 안 담긴
  // id·네트워크/서버 오류 청크는 확정하지 않아 다음 라운드 재시도 대상(pending)에 남는다.
  const runRound = async (roundIds: string[]) => {
    for (let i = 0; i < roundIds.length; i += CONFIRM_CHUNK_SIZE) {
      deps.onProgress?.({ kind: 'chunk', offset: i, done: Math.min(i + CONFIRM_CHUNK_SIZE, roundIds.length), total: roundIds.length });
      const chunk = roundIds.slice(i, i + CONFIRM_CHUNK_SIZE);
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res: any = await deps.apiRequest('POST', '/v1/pay-order/seller/product-orders/confirm', {
            productOrderIds: chunk,
          });
          const body = res?.data ?? res ?? {};
          // 실측 스키마(2026-07-07): { successProductOrderInfos: [{productOrderId, ...}], failProductOrderInfos: [] }
          const okInfos: any[] = body.successProductOrderInfos || body.data?.successProductOrderInfos || [];
          const failInfos: any[] = body.failProductOrderInfos || body.data?.failProductOrderInfos || [];
          if (okInfos.length === 0 && failInfos.length === 0) {
            // 목록이 둘 다 비면(스키마 상이) 청크 전체 성공으로 간주 — 무한 재시도 방지
            chunk.forEach((id) => succeeded.add(id));
          } else {
            for (const info of okInfos) if (info?.productOrderId) succeeded.add(String(info.productOrderId));
            for (const info of failInfos) if (info?.productOrderId) failedHard.add(String(info.productOrderId));
            if (failInfos.length > 0 && !firstError) {
              firstError = `${failInfos[0]?.productOrderId || ''} ${failInfos[0]?.code || ''} ${failInfos[0]?.message || ''}`.trim();
              console.warn('[발주확인 부분 실패]', JSON.stringify(failInfos).slice(0, 500));
            }
          }
          break;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const isRateLimit = msg.includes('429') || msg.toUpperCase().includes('RATE');
          if (isRateLimit && attempt < 2) {
            await sleep(RATE_LIMIT_BACKOFF_MS);
            continue;
          }
          if (!firstError) firstError = msg.slice(0, 200);
          console.warn(`발주 확인 호출 실패 (chunk ${i}, ${chunk.length}건):`, msg);
          break;
        }
      }
      await sleep(INTER_CHUNK_DELAY_MS); // 청크 간 레이트리밋 완화
    }
  };

  const phaseStart = nowMs();
  let pending = Array.from(new Set(ids.map(String).filter(Boolean)));
  for (let round = 0; round < MAX_CONFIRM_ROUNDS && pending.length > 0; round++) {
    if (round > 0) {
      if (nowMs() - phaseStart > CONFIRM_RETRY_TIME_BUDGET_MS) break;
      deps.onProgress?.({ kind: 'retry', pending: pending.length, round, maxRounds: MAX_CONFIRM_ROUNDS });
      await sleep(CONFIRM_RETRY_DELAY_MS);
    }
    await runRound(pending);
    pending = pending.filter((id) => !succeeded.has(id) && !failedHard.has(id));
  }

  return { succeeded, failedHard, pending, firstError };
}
