import { CURSOR_STALE_MS, isCursorHealthy, toKstDateKey } from './order-fetch-window';
import { SNAPSHOT_WINDOW_DAYS } from './naver-order-sync';
import { wrapFlatOrder, type OrderWrapper } from './purchase-order-rows';
import type { SnapshotL1Entry } from './snapshot-l1-cache';

/**
 * 발주서 **준비본** 판정 SSOT(발주 자동화 2단계, 오너 승인 2026-10-06 — 설계 정본
 * `docs/private/specs/2026-10-06-order-automation-phase2.md`).
 *
 * 준비본 = 네이버를 다시 조회하지 않고 **저장된 주문 사본(NaverOrderSnapshot)** 으로 만든 발주서다.
 * 요청 수가 0 인 대신 「마지막 주문 동기화 시각」 이후의 주문·취소를 모른다. 그래서 쓸 수 있는
 * 조건을 여기 한 곳에서 판정하고, 쓸 수 없으면 이유를 사람 말로 돌려준다 — 화면(카드 줄·발주요청
 * 창)과 서버(미리보기·확정)가 모두 이 판정을 쓴다. 판정이 갈리면 카드는 「준비됨」인데 창은 막는
 * 모순이 생긴다(ss-ux 검토 2026-10-06).
 *
 * 기준 시각은 변경피드 커서다(`latestChangeCursor` — 마지막으로 **끝까지 성공한** 변경 동기화의
 * 시작 시각). `lastCallTime` 은 쓰지 않는다: 배송중 보정·액션 직후 정밀 갱신도 그 값을 밀어 올려
 * 변경피드를 안 물었는데도 「방금 동기화함」으로 읽힌다(repository 의 같은 함수 주석).
 */

export type PreparedPoUnavailableReason = 'disabled' | 'no-sync' | 'stale-sync' | 'window-too-old';

export type PreparedPoAvailability =
  | { available: true; asOfIso: string }
  | { available: false; reason: PreparedPoUnavailableReason; asOfIso: string | null };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 준비본을 쓸 수 있는가. 순서가 곧 우선순위다(꺼져 있으면 동기화 상태와 무관하게 「꺼짐」).
 *
 * - `stale-sync`: 커서가 6시간(`CURSOR_STALE_MS`, 발주 조회 생략 게이트와 같은 문턱)보다 낡았다.
 * - `window-too-old`: 조회창 시작일이 스냅샷 갱신 범위(최근 `SNAPSHOT_WINDOW_DAYS`일) 밖이다 —
 *   그보다 오래된 날짜의 주문은 동기화가 더 이상 고쳐 쓰지 않아 상태가 낡았을 수 있다.
 */
export function decidePreparedPoAvailability(input: {
  autoPrepEnabled: boolean;
  cursorIso: string | null | undefined;
  queryStartMs: number;
  nowMs: number;
}): PreparedPoAvailability {
  const asOfIso = input.cursorIso && Number.isFinite(Date.parse(input.cursorIso)) ? input.cursorIso : null;
  if (!input.autoPrepEnabled) return { available: false, reason: 'disabled', asOfIso };
  if (!asOfIso) return { available: false, reason: 'no-sync', asOfIso: null };
  if (!isCursorHealthy(asOfIso, input.nowMs)) return { available: false, reason: 'stale-sync', asOfIso };
  if (toKstDateKey(input.queryStartMs) < earliestMaintainedDateKey(input.nowMs)) {
    return { available: false, reason: 'window-too-old', asOfIso };
  }
  return { available: true, asOfIso };
}

/** 동기화가 아직 고쳐 쓰는 가장 오래된 KST 날짜(`syncOrdersByIds`·`runChangedSync` 와 같은 경계). */
export function earliestMaintainedDateKey(nowMs: number): string {
  return toKstDateKey(nowMs - SNAPSHOT_WINDOW_DAYS * DAY_MS);
}

/** 사람 말 사유 — 발주요청 창에 그대로 보인다. `asOfIso` 는 KST `MM/DD HH:MM` 로 붙인다. */
export function describePreparedPoUnavailable(reason: PreparedPoUnavailableReason, asOfIso: string | null): string {
  switch (reason) {
    case 'disabled':
      return '이 캠페인은 발주서 자동 준비가 꺼져 있습니다. 캠페인 편집에서 켤 수 있습니다.';
    case 'no-sync':
      return '주문 동기화 기록이 없어 준비본을 만들 수 없습니다.';
    case 'stale-sync':
      return `마지막 주문 동기화가 ${CURSOR_STALE_MS / (60 * 60 * 1000)}시간 넘게 지났습니다${
        asOfIso ? ` (${formatKstShort(asOfIso)} 기준)` : ''
      }. 주문 관리를 새로고침한 뒤 다시 열어 주세요.`;
    case 'window-too-old':
      return `조회 기간이 최근 ${SNAPSHOT_WINDOW_DAYS}일을 넘어 준비본을 만들 수 없습니다.`;
  }
}

/** ISO → KST `MM/DD HH:MM`. */
export function formatKstShort(iso: string): string {
  const kst = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(kst.getUTCMonth() + 1)}/${p(kst.getUTCDate())} ${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}`;
}

/** 준비본이 읽을 스냅샷 날짜 범위 — 발주 조회창(`fetchPendingOrderWindow`)과 같은 [시작일, 오늘]. */
export function preparedSnapshotRange(queryStartMs: number, nowMs: number): { startKey: string; endKey: string } {
  return { startKey: toKstDateKey(queryStartMs), endKey: toKstDateKey(nowMs) };
}

/**
 * 스냅샷 메모리 사본(L1)에서 [startKey, endKey] 날짜의 주문을 조회 응답 모양으로 꺼낸다.
 * 같은 상품주문이 두 날짜에 걸쳐 있으면(귀속 날짜가 바뀐 경우) 더 최근에 쓰인 날짜 것을 쓴다 —
 * 발주서에 같은 주문이 두 번 실리면 되돌릴 수 없다(P7 Product-Order Query Paging 의 dedup 과 같은 근거).
 */
export function collectPreparedOrderWrappers(
  l1: Record<string, SnapshotL1Entry>,
  startKey: string,
  endKey: string,
): OrderWrapper[] {
  const latest = new Map<string, { order: any; writtenAt: number }>();
  const anonymous: any[] = [];
  for (const [dateKey, entry] of Object.entries(l1)) {
    if (dateKey < startKey || dateKey > endKey) continue;
    for (const order of entry.orders ?? []) {
      const id = order?.productOrderId ? String(order.productOrderId) : '';
      if (!id) {
        anonymous.push(order);
        continue;
      }
      const prev = latest.get(id);
      if (!prev || entry.lastCallTime > prev.writtenAt) latest.set(id, { order, writtenAt: entry.lastCallTime });
    }
  }
  return [...Array.from(latest.values(), (v) => v.order), ...anonymous].map(wrapFlatOrder);
}
