import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  enumerateSnapshotDateKeys,
  orderToDateKey,
  runChangedSync,
  SNAPSHOT_WINDOW_DAYS,
  toDateKeyKst,
} from '../naver-order-sync';

/**
 * `NaverOrderSnapshot.isDirty` 수명주기 계약 (2026-07-30).
 *
 * **고친 사고:** 무효화(`markAllDirty()`)는 최근 30일 전체를 dirty로 찍는데 dirty를 지우는
 * 주체는 "그 날짜의 upsert" 하나뿐이고, 크론은 CHANGED만 돌아 **변경피드에 잡힌 날짜만**
 * upsert한다. 조용한 과거 날짜의 dirty는 지울 사람이 없어 단조 증가했고, 프로덕션 실측에서
 * **48행 중 47행이 상시 true**(clean은 오늘 1행뿐)가 됐다 — 플래그로 "이 날짜가 정말 재조회가
 * 필요한가"를 물어볼 수 없는 상태. PR #145가 발주 조회 생략 게이트에서 `isDirty`를 제외해야
 * 했던 이유가 이것이다.
 *
 * **여기서 고정하는 불변식은 하나다: 무효화 폭 ⊆ 갱신이 커버하는 폭.**
 * 이게 깨지면 dirty는 반드시 누적된다. 지금까지 이 불변식을 지키는 테스트가 하나도 없어
 * 조용히 깨진 채 방치됐다.
 */

const REPOSITORY_SOURCE_PATH = join(
  process.cwd(),
  'src/repositories/naverOrderSnapshotRepository.ts',
);

describe('enumerateSnapshotDateKeys — 기간 → 날짜키(무효화 입력)', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  // KST 정오로 고정해 자정 경계 계산이 로컬 타임존에 의존하지 않게 한다.
  const now = Date.parse('2026-07-30T03:00:00.000Z'); // = KST 07-30 12:00

  it('구간을 KST 날짜키로 펼친다', () => {
    const start = Date.parse('2026-07-27T15:00:00.000Z'); // = KST 07-28 00:00
    const end = Date.parse('2026-07-29T14:59:59.000Z'); // = KST 07-29 23:59
    expect(enumerateSnapshotDateKeys(start, end, now)).toEqual(['2026-07-28', '2026-07-29']);
  });

  it('구간 끝이 KST 자정 직후여도 그 날짜가 빠지지 않는다 (UTC 자정 전진 버그의 거울상)', () => {
    const start = Date.parse('2026-07-28T15:30:00.000Z'); // = KST 07-29 00:30
    const end = Date.parse('2026-07-29T15:30:00.000Z'); // = KST 07-30 00:30
    expect(enumerateSnapshotDateKeys(start, end, now)).toEqual(['2026-07-29', '2026-07-30']);
  });

  it('스냅샷 보존 창(30일)보다 이른 날짜는 잘라낸다', () => {
    const start = now - 400 * dayMs;
    const keys = enumerateSnapshotDateKeys(start, now, now);
    expect(keys.length).toBeLessThanOrEqual(SNAPSHOT_WINDOW_DAYS + 1);
    expect(keys[0]).toBe(toDateKeyKst(new Date(now - SNAPSHOT_WINDOW_DAYS * dayMs)));
    expect(keys[keys.length - 1]).toBe(toDateKeyKst(new Date(now)));
  });

  it("종료 미정('~ 계속' = 먼 미래)이어도 오늘까지만 찍는다", () => {
    const start = now - 2 * dayMs;
    const keys = enumerateSnapshotDateKeys(start, now + 3650 * dayMs, now);
    expect(keys[keys.length - 1]).toBe(toDateKeyKst(new Date(now)));
    expect(keys).toHaveLength(3);
  });

  it('창 전체가 미래이거나 뒤집힌 구간이면 빈 배열이다 (무효화 no-op)', () => {
    expect(enumerateSnapshotDateKeys(now + dayMs, now + 2 * dayMs, now)).toEqual([]);
    expect(enumerateSnapshotDateKeys(now, now - dayMs, now)).toEqual([]);
    expect(enumerateSnapshotDateKeys(NaN, now, now)).toEqual([]);
  });
});

// markDirty 자체의 쿼리 계약(prisma 목)은 naverOrderSnapshotRepository.test.ts 에 있다 —
// 이 파일은 `runChangedSync` 를 정적 import 하므로 vi.resetModules() 를 쓸 수 없다(리셋하면
// 정적 참조가 옛 모듈 그래프를 붙들어 스파이가 다른 인스턴스에 걸린다).

describe('무효화 폭 ⊆ 갱신이 커버하는 폭 (소스 계약)', () => {
  const source = readFileSync(REPOSITORY_SOURCE_PATH, 'utf8');

  it('창 전체를 dirty로 찍는 API가 되살아나지 않는다', () => {
    // `markAllDirty()`는 최근 30일을 뭉뚱그려 찍어 dirty를 100%로 수렴시켰다.
    // (주석의 사후 서술은 허용 — 되살아나면 안 되는 건 호출 가능한 메서드다.)
    expect(source).not.toMatch(/^\s*async\s+markAllDirty\s*\(/m);
  });

  it('dirty 마킹은 날짜 목록(in) 기반이며 범위(gte/lte) 기반이 아니다', () => {
    const dirtyWrites = source.match(/data:\s*\{\s*isDirty:\s*true\s*\}/g) ?? [];
    expect(dirtyWrites).toHaveLength(1);

    const markDirtyBody = source.slice(source.indexOf('async markDirty('));
    const whereClause = markDirtyBody.slice(0, markDirtyBody.indexOf('data: { isDirty: true }'));
    expect(whereClause).toContain('snapshotDate: { in: unique }');
    // 범위 술어가 다시 들어오면 "날짜를 모르니 창을 넓히자"로 회귀한 것이다.
    expect(whereClause).not.toMatch(/\bgte\b|\blte\b/);
  });
});

describe('핵심 불변식 — 무효화한 날짜를 동기화가 커버하면 dirty가 해소된다', () => {
  // 이 불변식이 아무 테스트로도 보호되지 않아 조용히 깨진 채 방치됐다.
  const paymentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const dateKey = orderToDateKey({ paymentDate })!;

  beforeEach(() => {
    (global as any).__naverSyncInFlight = null;
    (global as any).__naverSyncLastAt = undefined;
    (global as any).__naverDailyCache = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (global as any).__naverSyncInFlight = null;
    (global as any).__naverSyncLastAt = undefined;
    (global as any).__naverDailyCache = {};
  });

  it('CHANGED 동기화가 그 날짜를 upsert하면 isDirty:false로 되돌린다', async () => {
    const clientModule = await import('@/lib/order-converter/naver-commerce-client');
    const repoModule = await import('@/repositories/naverOrderSnapshotRepository');

    vi.spyOn(clientModule, 'apiRequest').mockImplementation(async (_m: string, path: string) => {
      if (path.includes('last-changed-statuses')) {
        return { data: { lastChangeStatuses: [{ productOrderId: 'PO-1' }] } };
      }
      if (path.includes('/query')) {
        return {
          data: [
            {
              order: { paymentDate },
              productOrder: { productOrderId: 'PO-1', productOrderStatus: 'PAYED' },
            },
          ],
        };
      }
      return { data: {} };
    });

    // 무효화 직후 상태: 그 날짜의 DB 스냅샷이 dirty로 찍혀 있다.
    const dirtyRow = {
      snapshotDate: dateKey,
      orders: [],
      ordersCount: 0,
      newOrdersCount: 0,
      preparingCount: 0,
      deliveringCount: 0,
      isDirty: true,
      lastCallTime: new Date(),
      lastChangeStatusCursor: null,
    } as any;
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findOne').mockResolvedValue(dirtyRow);
    vi.spyOn(repoModule.naverOrderSnapshotRepository, 'findLatestCursor').mockResolvedValue(null);
    const upsertSpy = vi
      .spyOn(repoModule.naverOrderSnapshotRepository, 'upsertDaily')
      .mockResolvedValue({} as any);

    await runChangedSync();

    const call = upsertSpy.mock.calls.find(([arg]: any) => arg.snapshotDate === dateKey);
    expect(call).toBeTruthy();
    expect(call![0].isDirty).toBe(false);
  });
});
