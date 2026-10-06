// 스냅샷 주문 블롭의 프로세스 메모리 사본(L1, `global.__naverDailyCache`) 하이드레이션.
//
// 주문 관리 카드(`campaigns-handler.ts`)가 쓰던 2단 조회를 그대로 옮겨, 홈 「오늘 처리할 주문」
// 요약(`order-work-summary.ts`)이 **같은 사본**을 읽게 한다 — 두 표면이 같은 데이터로 판정하고,
// 블롭은 한 번만 DB 에서 끌어온다(P7 Snapshot Blob Egress Discipline).
//
// ①경량 메타(snapshotDate·lastCallTime)로 신선도를 판정하고 ②L1에 없거나 DB가 더 최신인 날짜만
// 블롭을 가져와 L1을 갱신한다. 웜 프로세스의 폴링은 보통 0~1행(오늘)만 끌어온다.
// ⛔ 전 기간 블롭을 먼저 받고 나서 비교하지 말 것 — 그 폴링이 DB 풀러 egress 의 주 원인이었다.
//
// 이 모듈은 네이버를 부르지 않는다(DB 읽기뿐). 부트스트랩 FULL 동기화·백그라운드 보정은
// 주문 관리 핸들러만의 몫이다.

import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';

export type SnapshotL1Entry = {
  lastCallTime: number;
  orders: any[];
  newOrdersCount?: number | null;
  preparingCount?: number | null;
  deliveringCount?: number | null;
  isDirty?: boolean | null;
};

/** 프로세스 전역 L1 — `naver-order-sync`(쓰기)·발송처리 라우트와 같은 객체를 공유한다. */
export function getSnapshotL1Cache(): Record<string, SnapshotL1Entry> {
  if (!(global as any).__naverDailyCache) {
    (global as any).__naverDailyCache = {};
  }
  return (global as any).__naverDailyCache;
}

/**
 * [startDateKey, endDateKey](KST) 범위를 L1 에 맞춘다. 실패는 **던진다** — 삼킬지 말지는
 * 호출부가 정한다(주문 관리 카드는 낡은 L1 로 계속 그리고, 홈 요약은 오류로 드러낸다).
 *
 * @returns metaCount DB 에 그 범위 스냅샷 행이 몇 개 있었는가(0 이면 「스냅샷 전무」)
 */
export async function hydrateSnapshotL1(
  startDateKey: string,
  endDateKey: string,
  logTag: string,
): Promise<{ metaCount: number }> {
  const dailyCache = getSnapshotL1Cache();
  const metas = await naverOrderSnapshotRepository.findRangeMeta(startDateKey, endDateKey);
  const datesToFetch = metas
    .filter((meta) => {
      const l1Entry = dailyCache[meta.snapshotDate];
      return !l1Entry || new Date(meta.lastCallTime).getTime() > (l1Entry.lastCallTime || 0);
    })
    .map((meta) => meta.snapshotDate);
  const snapshots = await naverOrderSnapshotRepository.findByDates(datesToFetch);
  // L3 egress 계측(2026-07-21) — 이 하이드레이션이 DB에서 당긴 블롭 근사 바이트.
  // 웜 폴링은 보통 rows=0~1이어야 정상이고, 콜드스타트는 전 기간이 실린다.
  if (snapshots.length > 0) {
    const hydrateBytes = snapshots.reduce((sum, s) => {
      const text = typeof s.orders === 'string' ? s.orders : JSON.stringify(s.orders ?? null);
      return sum + Buffer.byteLength(text ?? '', 'utf8');
    }, 0);
    console.log(`[egress] ${logTag} hydrate: rows=${snapshots.length} bytes=${hydrateBytes}`);
  }
  for (const snapshot of snapshots) {
    const l1Entry = dailyCache[snapshot.snapshotDate];
    const dbCallTime = new Date(snapshot.lastCallTime).getTime();
    if (!l1Entry || dbCallTime > (l1Entry.lastCallTime || 0)) {
      dailyCache[snapshot.snapshotDate] = {
        lastCallTime: dbCallTime,
        orders: naverOrderSnapshotRepository.parseOrders(snapshot),
        newOrdersCount: snapshot.newOrdersCount,
        preparingCount: snapshot.preparingCount,
        deliveringCount: snapshot.deliveringCount,
        isDirty: snapshot.isDirty,
      };
    }
  }
  return { metaCount: metas.length };
}
