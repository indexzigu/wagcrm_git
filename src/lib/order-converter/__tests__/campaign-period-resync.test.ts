import { describe, it, expect } from 'vitest';
import {
  parseStoredPeriodEndMs,
  shouldResyncCampaignPeriod,
  isConcretePeriodString,
  resolveSaleWindowEndMs,
  resolveSaleWindowStartMs,
  resolveCampaignQueryStartMs,
  resolveSalesCampaignWindow,
  parseSalePeriodBounds,
  isSameKstDay,
  startOfKstDayMs,
  endOfKstDayMs,
  isDayBoundaryMs,
  PERIOD_RESYNC_LEAD_MS,
  PERIOD_RESYNC_STALE_GRACE_MS,
  PERIOD_RESYNC_IDLE_INTERVAL_MS,
  usesIdlePeriodCheckInterval,
  resolveStorePeriodDrift,
  formatKstYmd,
} from '../mapping-service';

// KST 자정(23:59:59.999+09:00) 기준 종료 시각.
const endKst = (ymd: string) => new Date(ymd.replace(/\./g, '-') + 'T23:59:59.999+09:00').getTime();
const startKst = (ymd: string) => new Date(ymd.replace(/\./g, '-') + 'T00:00:00.000+09:00').getTime();

describe('parseStoredPeriodEndMs', () => {
  it('salePeriod 문자열의 종료일을 KST 자정 기준으로 파싱', () => {
    expect(parseStoredPeriodEndMs({ salePeriod: '2026.07.06 ~ 2026.07.11' })).toBe(endKst('2026.07.11'));
  });

  it('endDate(DateTime)가 있으면 우선한다', () => {
    const d = new Date('2026-07-13T00:00:00.000Z');
    expect(parseStoredPeriodEndMs({ endDate: d, salePeriod: '2026.07.06 ~ 2026.07.11' })).toBe(d.getTime());
  });

  it("'계속'·미정·null·미등록은 null", () => {
    expect(parseStoredPeriodEndMs({ salePeriod: '2026.07.06 ~ 계속' })).toBeNull();
    expect(parseStoredPeriodEndMs({ salePeriod: '기간 미정' })).toBeNull();
    expect(parseStoredPeriodEndMs({ salePeriod: '미등록' })).toBeNull();
    expect(parseStoredPeriodEndMs({ salePeriod: null })).toBeNull();
    expect(parseStoredPeriodEndMs({})).toBeNull();
  });
});

describe('shouldResyncCampaignPeriod', () => {
  const now = endKst('2026.07.12'); // 07.12 마감시점

  it('마감(isActive=false) 캠페인은 절대 재동기화하지 않는다(기간 동결)', () => {
    // 종료가 한참 지났어도 마감이면 false — 스토어가 열려 있어도 창을 늘리지 않는다.
    expect(shouldResyncCampaignPeriod({ isActive: false, salePeriod: '2026.07.06 ~ 2026.07.11' }, now)).toBe(false);
    expect(shouldResyncCampaignPeriod({ isActive: false, salePeriod: '기간 미정' }, now)).toBe(false);
  });

  it('활성 캠페인 + 저장 종료가 이미 지남 → 재동기화(연장 반영 필요)', () => {
    // 07.11 종료인데 지금이 07.12 → stale, 재동기화 후보. (마감 당일 컷오프 실사고 케이스)
    expect(shouldResyncCampaignPeriod({ isActive: true, salePeriod: '2026.07.06 ~ 2026.07.11' }, now)).toBe(true);
  });

  it('활성 + 종료 임박(리드 창 이내) → 재동기화', () => {
    const soon = endKst('2026.07.13'); // 지금(07.12)로부터 하루 뒤 종료 → 리드(2일) 이내
    expect(shouldResyncCampaignPeriod({ isActive: true, salePeriod: '2026.07.06 ~ 2026.07.13' }, now)).toBe(true);
    expect(soon - now).toBeLessThanOrEqual(PERIOD_RESYNC_LEAD_MS);
  });

  it('활성 + 종료가 먼 구간 + 확인 기록 없음 → 재동기화(캠페인 중반 변경을 보려면 한 번은 물어야 한다)', () => {
    // 07.20 종료 → 지금(07.12)로부터 8일 뒤, 리드(2일) 밖. 종전에는 여기서 false 였고 그래서
    // 2주짜리 캠페인 3일차의 기간 연장·단축을 종료 이틀 전까지 못 봤다(오너 신고 2026-09-17).
    expect(shouldResyncCampaignPeriod({ isActive: true, salePeriod: '2026.07.06 ~ 2026.07.20' }, now)).toBe(true);
  });

  it('활성 + 종료가 먼 구간 + 간격 이내 확인 → 재동기화 안 함(상시 네이버 호출 방지)', () => {
    const checkedRecently = new Date(now - PERIOD_RESYNC_IDLE_INTERVAL_MS + 60_000);
    expect(
      shouldResyncCampaignPeriod(
        { isActive: true, salePeriod: '2026.07.06 ~ 2026.07.20', periodCheckedAt: checkedRecently },
        now,
      ),
    ).toBe(false);
  });

  it('활성 + 종료가 먼 구간 + 간격 경과 → 재동기화', () => {
    const checkedLongAgo = new Date(now - PERIOD_RESYNC_IDLE_INTERVAL_MS - 60_000);
    expect(
      shouldResyncCampaignPeriod(
        { isActive: true, salePeriod: '2026.07.06 ~ 2026.07.20', periodCheckedAt: checkedLongAgo },
        now,
      ),
    ).toBe(true);
  });

  it('종료 임박 구간은 방금 확인했어도 재동기화한다(간격이 임박 구간을 막지 않는다)', () => {
    // 집계 경계가 실제로 걸리는 구간이라 촘촘히 따라가야 한다 — 유휴 간격은 여기에 적용되지 않는다.
    expect(
      shouldResyncCampaignPeriod(
        { isActive: true, salePeriod: '2026.07.06 ~ 2026.07.13', periodCheckedAt: new Date(now) },
        now,
      ),
    ).toBe(true);
  });

  it('유예를 지난 오래된 미마감 캠페인은 확인 기록이 없어도 폴링하지 않는다', () => {
    const wellPast = now - PERIOD_RESYNC_STALE_GRACE_MS - 24 * 60 * 60 * 1000;
    expect(shouldResyncCampaignPeriod({ isActive: true, endDate: new Date(wellPast) }, now)).toBe(false);
  });

  it('확인 기록이 읽을 수 없는 값이면 묻는다(모름을 건너뜀으로 기울이지 않는다)', () => {
    expect(
      shouldResyncCampaignPeriod(
        { isActive: true, salePeriod: '2026.07.06 ~ 2026.07.20', periodCheckedAt: 'not-a-date' },
        now,
      ),
    ).toBe(true);
  });

  it('활성 + 기간 미정(파싱 불가)이면 항상 재동기화(최초 확정 필요)', () => {
    expect(shouldResyncCampaignPeriod({ isActive: true, salePeriod: '기간 미정' }, now)).toBe(true);
    expect(shouldResyncCampaignPeriod({ isActive: true, salePeriod: null }, now)).toBe(true);
  });

  it('활성이지만 종료 후 유예(그레이스)를 지난 오래된 캠페인은 폴링 중단(비용 누수 방지)', () => {
    // 유예(7일) 경계 바로 안쪽은 아직 재동기화, 바깥은 중단.
    const justInside = now - PERIOD_RESYNC_STALE_GRACE_MS + 60_000;
    const wellPast = now - PERIOD_RESYNC_STALE_GRACE_MS - 24 * 60 * 60 * 1000; // 8일 전 종료
    expect(shouldResyncCampaignPeriod({ isActive: true, endDate: new Date(justInside) }, now)).toBe(true);
    expect(shouldResyncCampaignPeriod({ isActive: true, endDate: new Date(wellPast) }, now)).toBe(false);
  });
});

describe('usesIdlePeriodCheckInterval — 확인 시각을 찍어야 하는 구간인가', () => {
  const now = endKst('2026.07.12');

  it('종료가 먼 활성 캠페인만 true — 그 구간에서만 판정이 periodCheckedAt 을 읽는다', () => {
    expect(usesIdlePeriodCheckInterval({ isActive: true, salePeriod: '2026.07.06 ~ 2026.07.20' }, now)).toBe(true);
  });

  it('종료 임박·경과 구간은 false — 시각과 무관하게 항상 후보라 찍을 이유가 없다', () => {
    // 매 GET 마다 찍으면 캠페인 수만큼 쓰기가 나간다(P7 egress 규율).
    expect(usesIdlePeriodCheckInterval({ isActive: true, salePeriod: '2026.07.06 ~ 2026.07.13' }, now)).toBe(false);
    expect(usesIdlePeriodCheckInterval({ isActive: true, salePeriod: '2026.07.06 ~ 2026.07.11' }, now)).toBe(false);
  });

  it('기간 미확정·마감은 false', () => {
    expect(usesIdlePeriodCheckInterval({ isActive: true, salePeriod: '기간 미정' }, now)).toBe(false);
    expect(usesIdlePeriodCheckInterval({ isActive: false, salePeriod: '2026.07.06 ~ 2026.07.20' }, now)).toBe(false);
  });
});

describe('formatKstYmd — 날짜 단위 API(판매캠페인 PATCH)에 넘길 값', () => {
  it('KST 달력일을 YYYY-MM-DD 로 — UTC 자정(=KST 09:00)도 같은 KST 날짜', () => {
    expect(formatKstYmd(Date.parse('2026-09-14T00:00:00.000Z'))).toBe('2026-09-14');
    expect(formatKstYmd(endKst('2026.09.19'))).toBe('2026-09-19');
    // KST 자정 직전(UTC 14:59)은 아직 전날이 아니라 그 날이다 — UTC 로 자르면 하루 밀린다.
    expect(formatKstYmd(Date.parse('2026-09-19T15:30:00.000Z'))).toBe('2026-09-20');
  });
});

describe('resolveStorePeriodDrift — 스토어 기간이 화면 기간과 다른가 (오너 결정 2026-09-17)', () => {
  it('실측 회귀(2026-09-17): 스토어가 09.19 까지인데 화면은 09.17 → 어긋남 + 맞출 날짜', () => {
    // 프로덕션 활성 캠페인 실측값. 화면·집계는 판매관리 일정을 따르므로 스토어 연장이
    // 아무 흔적도 남기지 않았고, 오너는 그것을 "등록 당시 값으로 고정"으로 보았다.
    const drift = resolveStorePeriodDrift({
      salePeriod: '2026.09.14 ~ 2026.09.19',
      windowStartMs: startKst('2026.09.14'),
      windowEndMs: endKst('2026.09.17'),
      productStatus: 'SALE',
      salesCampaigns: [{ id: 'sc-1', status: 'ACTIVE' }],
    });
    expect(drift).toEqual({
      scope: 'full',
      storeLabel: '2026.09.14 ~ 2026.09.19',
      storeStartYmd: '2026-09-14',
      storeEndYmd: '2026-09-19',
      salesCampaignIds: ['sc-1'],
    });
  });

  it('스토어가 더 짧아진 경우(단축)도 어긋남으로 본다', () => {
    const drift = resolveStorePeriodDrift({
      salePeriod: '2026.09.14 ~ 2026.09.16',
      windowStartMs: startKst('2026.09.14'),
      windowEndMs: endKst('2026.09.19'),
      productStatus: 'SALE',
      salesCampaigns: [{ id: 'sc-1', status: 'ACTIVE' }],
    });
    expect(drift?.storeEndYmd).toBe('2026-09-16');
  });

  it('같은 기간이면 null — 저장 형태(UTC 자정 vs KST 종일)가 달라도 같은 달력일이면 같다', () => {
    // 연결 판매캠페인 endDate 는 UTC 자정으로 저장되고 창은 KST 종일로 보정된다. 그 차이를
    // 어긋남으로 읽으면 전 캠페인에 상시 배지가 떠 신호가 죽는다.
    expect(
      resolveStorePeriodDrift({
        salePeriod: '2026.09.14 ~ 2026.09.17',
        windowStartMs: resolveSaleWindowStartMs({ startDate: new Date('2026-09-14T00:00:00.000Z') }),
        windowEndMs: resolveSaleWindowEndMs({ endDate: new Date('2026-09-17T00:00:00.000Z') }),
        productStatus: 'SALE',
      salesCampaigns: [{ id: 'sc-1', status: 'ACTIVE' }],
      }),
    ).toBeNull();
  });

  it("스토어 종료가 '계속'이면 storeEndYmd 는 null — 판매관리 종료일을 맞출 근거가 없다", () => {
    const drift = resolveStorePeriodDrift({
      salePeriod: '2026.09.14 ~ 계속',
      windowStartMs: startKst('2026.09.14'),
      windowEndMs: endKst('2026.09.17'),
      productStatus: 'SALE',
      salesCampaigns: [{ id: 'sc-1', status: 'ACTIVE' }],
    });
    expect(drift?.storeLabel).toBe('2026.09.14 ~ 계속');
    expect(drift?.storeEndYmd).toBeNull();
  });

  it('스토어 관측값이 폴백(미정·미등록·null)이면 null — 비교할 기간이 없다', () => {
    for (const sp of ['기간 미정', '미등록', '', null, undefined]) {
      expect(
        resolveStorePeriodDrift({ salePeriod: sp, windowStartMs: startKst('2026.09.14'), windowEndMs: endKst('2026.09.17'), productStatus: 'SALE', salesCampaigns: [{ id: 'sc-1', status: 'ACTIVE' }] }),
      ).toBeNull();
    }
  });

  it('마감·정산대기 회차는 맞출 수 있다 — 아직 변동 구간이라 창이 얼지 않았다', () => {
    const drift = resolveStorePeriodDrift({
      salePeriod: '2026.09.14 ~ 2026.09.19',
      windowStartMs: startKst('2026.09.14'),
      windowEndMs: endKst('2026.09.17'),
      productStatus: 'SALE',
      salesCampaigns: [
        { id: 'sc-live', status: 'ACTIVE' },
        { id: 'sc-closed', status: 'CLOSED' },
        { id: 'sc-wait', status: 'SETTLEMENT_WAIT' },
      ],
    });
    expect(drift?.salesCampaignIds).toEqual(['sc-live', 'sc-closed', 'sc-wait']);
  });

  it('딜 하나라도 정산 락이면 캠페인 전체를 뺀다 — 창이 얼어 맞춰도 화면이 안 움직인다', () => {
    // 🪤 미락 회차만 골라 PATCH 하면 배지가 눌러도 사라지지 않는 무한 루프가 된다.
    // 호출부(campaigns-handler)의 periodFrozenBySettlement 와 **같은 판정**이라 여기 하나로 둔다.
    for (const locked of ['SETTLEMENT_IN_PROGRESS', 'COMPLETED', 'DROPPED']) {
      expect(
        resolveStorePeriodDrift({
          salePeriod: '2026.09.14 ~ 2026.09.19',
          windowStartMs: startKst('2026.09.14'),
          windowEndMs: endKst('2026.09.17'),
          productStatus: 'SALE',
          salesCampaigns: [{ id: 'sc-live', status: 'ACTIVE' }, { id: 'sc-locked', status: locked }],
        }),
      ).toBeNull();
    }
  });

  it('실사고 회귀(2026-09-17): 판매가 끝난 상태면 스토어 시작일을 쓰지 않는다 — 종료일만', () => {
    // 프로덕션 실측: 09.10~09.16 회차인데 스토어(CLOSE)가 `09.16 ~ 09.17` 을 돌려줬다.
    // 시작일 09.16 은 **원래 종료일**이고, 그 값을 반영해 회차 시작일이 망가지는 사고가 났다.
    const drift = resolveStorePeriodDrift({
      salePeriod: '2026.09.16 ~ 2026.09.17',
      productStatus: 'CLOSE',
      windowStartMs: startKst('2026.09.10'),
      windowEndMs: endKst('2026.09.16'),
      salesCampaigns: [{ id: 'sc-1', status: 'CLOSED' }],
    });
    expect(drift).toEqual({
      scope: 'end-only',
      storeLabel: '2026.09.17', // 기간이 아니라 종료일 하나만 보여준다
      storeStartYmd: null, // ⛔ 시작일은 보내지 않는다 — 이 null 이 사고를 막는 지점이다
      storeEndYmd: '2026-09-17',
      salesCampaignIds: ['sc-1'],
    });
  });

  it('실사고 회귀: 판매 종료 뒤 시작일만 다르고 종료일이 같으면 배지를 내지 않는다', () => {
    // 이 캠페인의 정정 후 상태(창 09.10~09.17, 스토어 09.16~09.17). 시작일 차이를 어긋남으로
    // 세면 **눌러도 사라지지 않는 배지**가 되고, 누르면 다시 시작일이 망가진다.
    expect(
      resolveStorePeriodDrift({
        salePeriod: '2026.09.16 ~ 2026.09.17',
        productStatus: 'CLOSE',
        windowStartMs: startKst('2026.09.10'),
        windowEndMs: endKst('2026.09.17'),
        salesCampaigns: [{ id: 'sc-1', status: 'CLOSED' }],
      }),
    ).toBeNull();
  });

  it('품절도 같은 취급 — 판매중(SALE)만 기간 전체를 신뢰한다', () => {
    // 프로덕션 실측 2건째: 07.06~07.20 회차인데 스토어(OUTOFSTOCK)가 `07.20 ~ 07.20`(하루)로 왔다.
    const drift = resolveStorePeriodDrift({
      salePeriod: '2026.07.20 ~ 2026.07.20',
      productStatus: 'OUTOFSTOCK',
      windowStartMs: startKst('2026.07.06'),
      windowEndMs: endKst('2026.07.19'),
      salesCampaigns: [{ id: 'sc-1', status: 'CLOSED' }],
    });
    expect(drift?.scope).toBe('end-only');
    expect(drift?.storeStartYmd).toBeNull();
    expect(drift?.storeEndYmd).toBe('2026-07-20');
  });

  it('상태를 모르면(null) 보수적으로 종료일만 — 모름을 판매중으로 읽지 않는다', () => {
    const drift = resolveStorePeriodDrift({
      salePeriod: '2026.09.16 ~ 2026.09.17',
      productStatus: null,
      windowStartMs: startKst('2026.09.10'),
      windowEndMs: endKst('2026.09.16'),
      salesCampaigns: [{ id: 'sc-1', status: 'CLOSED' }],
    });
    expect(drift?.scope).toBe('end-only');
  });

  it("판매 종료 + 스토어 종료가 '계속'이면 null — 맞출 종료일이 없다", () => {
    expect(
      resolveStorePeriodDrift({
        salePeriod: '2026.09.16 ~ 계속',
        productStatus: 'CLOSE',
        windowStartMs: startKst('2026.09.10'),
        windowEndMs: endKst('2026.09.16'),
        salesCampaigns: [{ id: 'sc-1', status: 'CLOSED' }],
      }),
    ).toBeNull();
  });

  it('연결이 없으면 null — 그땐 salePeriod 가 이미 화면값이라 어긋날 수가 없다', () => {
    for (const salesCampaigns of [[], null, undefined]) {
      expect(
        resolveStorePeriodDrift({
          salePeriod: '2026.09.14 ~ 2026.09.19',
          windowStartMs: startKst('2026.09.14'),
          windowEndMs: endKst('2026.09.17'),
          productStatus: 'SALE',
          salesCampaigns,
        }),
      ).toBeNull();
    }
  });

  it('창이 없으면(판매캠페인 미연결) null — 그땐 salePeriod 가 이미 화면값이다', () => {
    expect(
      resolveStorePeriodDrift({ salePeriod: '2026.09.14 ~ 2026.09.19', windowStartMs: null, windowEndMs: null, productStatus: 'SALE', salesCampaigns: [{ id: 'sc-1', status: 'ACTIVE' }] }),
    ).toBeNull();
  });
});

describe('isConcretePeriodString', () => {
  it('구체 기간만 true — 폴백(미등록/미정)으로 확정 기간을 되돌리지 않기 위함', () => {
    expect(isConcretePeriodString('2026.07.06 ~ 2026.07.13')).toBe(true);
    expect(isConcretePeriodString('2026.07.06 ~ 계속')).toBe(true);
    expect(isConcretePeriodString('미등록')).toBe(false);
    expect(isConcretePeriodString('기간 미정')).toBe(false);
    expect(isConcretePeriodString('')).toBe(false);
    expect(isConcretePeriodString(null)).toBe(false);
  });
});

describe('KST 날짜 경계 헬퍼', () => {
  it('isDayBoundaryMs — UTC 자정·KST 자정(날짜만 저장된 값)은 true, 정밀 시각은 false', () => {
    expect(isDayBoundaryMs(Date.parse('2026-07-13T00:00:00.000Z'))).toBe(true);        // UTC 자정(날짜 피커)
    expect(isDayBoundaryMs(Date.parse('2026-07-13T00:00:00.000+09:00'))).toBe(true);   // KST 자정(스토어 API 날짜 전용)
    expect(isDayBoundaryMs(Date.parse('2026-07-13T23:59:59.999+09:00'))).toBe(false);  // salePeriod 종일값
    expect(isDayBoundaryMs(Date.parse('2026-07-13T18:00:00.000+09:00'))).toBe(false);  // 스토어 정밀 종료
  });

  it('startOfKstDayMs/endOfKstDayMs — 서버 TZ 무관하게 KST 그 날의 시작/끝', () => {
    const anyTimeOn13 = Date.parse('2026-07-13T05:00:00.000Z'); // KST 07-13 14:00
    expect(startOfKstDayMs(anyTimeOn13)).toBe(startKst('2026.07.13'));
    expect(endOfKstDayMs(anyTimeOn13)).toBe(endKst('2026.07.13'));
    // UTC 자정(=KST 09:00) 입력도 같은 KST 날짜로 귀속된다(다음날로 새지 않음).
    expect(endOfKstDayMs(Date.parse('2026-07-13T00:00:00.000Z'))).toBe(endKst('2026.07.13'));
  });
});

describe('resolveSaleWindowEndMs — 집계 컷오프(마감 당일 매출 누락 방지)', () => {
  it('마감 당일 컷오프 실사고: 날짜만 저장된 종료값(UTC 자정=KST 09:00)을 KST 종일로 보정', () => {
    // 연결 판매캠페인 endDate가 2026-07-13T00:00:00Z(=KST 07-13 09:00)로 저장 → 컷오프가 오전 9시로
    // 잘려 07-13 오후 배송완료 주문이 매출/수량에서 누락됐다. 보정 후 KST 07-13 23:59:59.999 포함.
    expect(resolveSaleWindowEndMs({ endDate: new Date('2026-07-13T00:00:00.000Z') }))
      .toBe(endKst('2026.07.13'));
  });

  it('salePeriod 문자열 종료일은 KST 종일(23:59:59.999)로 해석', () => {
    expect(resolveSaleWindowEndMs({ salePeriod: '2026.07.06 ~ 2026.07.13' })).toBe(endKst('2026.07.13'));
  });

  it('스토어 API가 KST 자정(날짜 전용)으로 준 종료값도 KST 종일로 보정(과소집계 방지)', () => {
    // 네이버 saleEndDate가 07-13 00:00 KST로 오면 그대로 쓰면 07-13 하루가 통째로 빠진다 → 종일 보정.
    expect(resolveSaleWindowEndMs({ endDate: new Date('2026-07-13T00:00:00.000+09:00') }))
      .toBe(endKst('2026.07.13'));
  });

  it('스토어 API 정밀 종료시각(시:분 존재)은 보정 없이 그대로 존중', () => {
    const precise = new Date('2026-07-13T18:30:00.000+09:00');
    expect(resolveSaleWindowEndMs({ endDate: precise })).toBe(precise.getTime());
  });

  it("'계속'·미정·null은 null(호출부에서 무한대 허용)", () => {
    expect(resolveSaleWindowEndMs({ salePeriod: '2026.07.06 ~ 계속' })).toBeNull();
    expect(resolveSaleWindowEndMs({ salePeriod: '기간 미정' })).toBeNull();
    expect(resolveSaleWindowEndMs({})).toBeNull();
  });
});

describe('resolveSaleWindowStartMs', () => {
  it('날짜만 저장된 시작값(UTC 자정)은 KST 자정 시작으로 보정', () => {
    expect(resolveSaleWindowStartMs({ startDate: new Date('2026-07-06T00:00:00.000Z') }))
      .toBe(startKst('2026.07.06'));
  });
  it('salePeriod 시작일은 KST 자정 시작으로 해석', () => {
    expect(resolveSaleWindowStartMs({ salePeriod: '2026.07.06 ~ 2026.07.13' })).toBe(startKst('2026.07.06'));
  });
  it('미정/미등록/없음은 null', () => {
    expect(resolveSaleWindowStartMs({ salePeriod: '기간 미정' })).toBeNull();
    expect(resolveSaleWindowStartMs({})).toBeNull();
  });
});

describe('resolveSalesCampaignWindow — 집계 창 정본은 판매관리 일정(오너 확정 2026-07-15)', () => {
  const sc = (start: string, end: string) => ({
    startDate: new Date(start + 'T00:00:00.000Z'),
    endDate: new Date(end + 'T00:00:00.000Z'),
  });

  it('딜별 판매캠페인이 여럿이면 min(시작)~max(종료) 합성', () => {
    // 실측: 한 주문캠페인에 딜별 판매캠페인 4~5개가 물리는 게 표준이다.
    const w = resolveSalesCampaignWindow([sc('2026-06-15', '2026-06-30'), sc('2026-06-15', '2026-06-30')]);
    expect(w).not.toBeNull();
    expect(w!.startMs).toBe(Date.parse('2026-06-15T00:00:00.000Z'));
    expect(w!.endMs).toBe(Date.parse('2026-06-30T00:00:00.000Z'));
  });

  it('기간이 전부 같으면 어긋남 아님', () => {
    const w = resolveSalesCampaignWindow([sc('2026-06-15', '2026-06-30'), sc('2026-06-15', '2026-06-30')]);
    expect(w!.hasPeriodMismatch).toBe(false);
  });

  it('실측 사례 회귀: 딜 하나만 짧게 운영하면 어긋남으로 표시(합성 창은 그 딜에 정확하지 않다)', () => {
    // prod 실측: 3개는 06-15~06-30인데 딜 하나만 06-22~06-25. 오너 결정 = "합성하되 어긋나면 경고".
    const w = resolveSalesCampaignWindow([
      sc('2026-06-15', '2026-06-30'),
      sc('2026-06-15', '2026-06-30'),
      sc('2026-06-22', '2026-06-25'),
    ]);
    expect(w!.startMs).toBe(Date.parse('2026-06-15T00:00:00.000Z'));
    expect(w!.endMs).toBe(Date.parse('2026-06-30T00:00:00.000Z'));
    expect(w!.hasPeriodMismatch).toBe(true);
  });

  it('저장 형태(UTC 자정 vs KST 자정)가 섞여도 같은 KST 날짜면 어긋남 아님', () => {
    const w = resolveSalesCampaignWindow([
      { startDate: new Date('2026-06-15T00:00:00.000Z'), endDate: new Date('2026-06-30T00:00:00.000Z') },
      { startDate: new Date('2026-06-15T00:00:00.000+09:00'), endDate: new Date('2026-06-30T00:00:00.000+09:00') },
    ]);
    expect(w!.hasPeriodMismatch).toBe(false);
  });

  it('연결이 없으면 null (스토어 salePeriod 폴백은 호출부가 처리)', () => {
    expect(resolveSalesCampaignWindow([])).toBeNull();
    expect(resolveSalesCampaignWindow(null)).toBeNull();
    expect(resolveSalesCampaignWindow(undefined)).toBeNull();
  });
});

describe('resolveCampaignQueryStartMs — 주문 조회창 시작일 기여값', () => {
  it('실사고 회귀(2026-07-15): startDate가 null이어도 salePeriod로 기여한다', () => {
    // 이 캠페인이 null을 반환하면 조회창이 '오늘-7일'로 떨어져 판매 시작일 이전 주문이 아예 조회되지 않는다.
    // 화면 판매기간은 멀쩡한데 매출만 뒤늦게 시작되고, 그 시작일이 매일 하루씩 밀렸다.
    expect(
      resolveCampaignQueryStartMs({
        startDate: null,
        salePeriod: '2026.07.06 ~ 2026.07.13',
        salesCampaigns: [], // 연결이 없는 캠페인 — 스토어 폴백만 남는다
      }),
    ).toBe(startKst('2026.07.06'));
  });

  it('불변식: 조회창은 컷오프보다 이르거나 같다 — 저장 창과 판매관리 창이 다르면 이른 쪽', () => {
    // 동결(정산 락)로 startDate가 옛 창에 멈춰 있거나 동기화가 아직 안 닿은 과도기. 넓게 조회한 뒤
    // 컷오프가 걸러내므로 결과는 정확하고, 좁게 잡아 놓치는 실사고만 막는다.
    expect(
      resolveCampaignQueryStartMs({
        startDate: new Date('2026-07-06T00:00:00.000Z'),
        salesCampaigns: [{ startDate: new Date('2026-07-02T00:00:00.000Z'), endDate: new Date('2026-07-13T00:00:00.000Z') }],
      }),
    ).toBe(startKst('2026.07.02'));

    // 반대로 판매관리가 더 늦으면 저장 창(이른 쪽)을 쓴다.
    expect(
      resolveCampaignQueryStartMs({
        startDate: new Date('2026-07-02T00:00:00.000Z'),
        salesCampaigns: [{ startDate: new Date('2026-07-06T00:00:00.000Z'), endDate: new Date('2026-07-13T00:00:00.000Z') }],
      }),
    ).toBe(startKst('2026.07.02'));
  });

  it('스토어 정밀 시각(시:분)은 그대로 존중', () => {
    const precise = new Date('2026-07-06T10:30:00.000+09:00');
    expect(resolveCampaignQueryStartMs({ startDate: precise, salePeriod: '2026.07.06 ~ 2026.07.13' })).toBe(precise.getTime());
  });

  it('연결된 판매캠페인이 여럿이면 가장 이른 시작일', () => {
    expect(
      resolveCampaignQueryStartMs({
        salesCampaigns: [
          { startDate: new Date('2026-07-09T00:00:00.000Z'), endDate: new Date('2026-07-13T00:00:00.000Z') },
          { startDate: new Date('2026-07-03T00:00:00.000Z'), endDate: new Date('2026-07-13T00:00:00.000Z') },
        ],
      }),
    ).toBe(startKst('2026.07.03'));
  });

  it('한쪽 후보가 없으면 반대쪽으로 흘러내린다(null이 조용히 기여 0이 되지 않게)', () => {
    // 판매캠페인 연결이 없음 → 스토어 salePeriod라도 쓴다.
    expect(resolveCampaignQueryStartMs({ salePeriod: '2026.07.06 ~ 2026.07.13', salesCampaigns: [] })).toBe(
      startKst('2026.07.06'),
    );
    // 스토어 기간이 미정 → 판매관리 창이라도 쓴다.
    expect(
      resolveCampaignQueryStartMs({
        salePeriod: '기간 미정',
        salesCampaigns: [{ startDate: new Date('2026-07-04T00:00:00.000Z'), endDate: new Date('2026-07-13T00:00:00.000Z') }],
      }),
    ).toBe(startKst('2026.07.04'));
  });

  it('정말 아무 기간도 없을 때만 null(호출부가 기본 창 + 경고)', () => {
    expect(resolveCampaignQueryStartMs({ salePeriod: '기간 미정', salesCampaigns: [] })).toBeNull();
    expect(resolveCampaignQueryStartMs({})).toBeNull();
  });

  it('실사고 회귀(2026-09-16): 끝난 회차는 조회창 시작일을 앞으로 끌지 못한다', () => {
    // 2차 주문캠페인(9/10~)에 1차 판매캠페인 3건(6/12 시작, 완료·정산중)이 아직 연결돼 있었다.
    // 창이 연결 전체의 min이라 주문확인이 6/12부터 97일을 훑었다(실측: 조회 13회 + 생략 84일 · 53초).
    // 화면에 뜨는 캠페인 기간은 9/10인데 조회만 석 달을 거슬러 올라가는 게 이 결함의 지문이다.
    expect(
      resolveCampaignQueryStartMs({
        startDate: new Date('2026-09-10T00:00:00.000Z'),
        salesCampaigns: [
          { startDate: new Date('2026-09-10T00:00:00.000Z'), endDate: new Date('2026-09-16T00:00:00.000Z'), status: 'ACTIVE' },
          { startDate: new Date('2026-06-12T00:00:00.000Z'), endDate: new Date('2026-06-18T00:00:00.000Z'), status: 'COMPLETED' },
          { startDate: new Date('2026-06-12T00:00:00.000Z'), endDate: new Date('2026-06-18T00:00:00.000Z'), status: 'SETTLEMENT_IN_PROGRESS' },
        ],
      }),
    ).toBe(startKst('2026.09.10'));
  });

  it('마감·정산대기 회차는 빼지 않는다 — 판매 종료 직후 결제분이 아직 발주 대상이다', () => {
    expect(
      resolveCampaignQueryStartMs({
        startDate: new Date('2026-09-10T00:00:00.000Z'),
        salesCampaigns: [
          { startDate: new Date('2026-09-10T00:00:00.000Z'), endDate: new Date('2026-09-16T00:00:00.000Z'), status: 'ACTIVE' },
          { startDate: new Date('2026-09-02T00:00:00.000Z'), endDate: new Date('2026-09-08T00:00:00.000Z'), status: 'CLOSED' },
          { startDate: new Date('2026-09-04T00:00:00.000Z'), endDate: new Date('2026-09-09T00:00:00.000Z'), status: 'SETTLEMENT_WAIT' },
        ],
      }),
    ).toBe(startKst('2026.09.02'));
  });

  it('전부 끝난 회차면 아무것도 빼지 않는다(창이 기본값으로 떨어져 발주서가 비는 것을 막는다)', () => {
    // 제외가 후보를 0으로 만들면 호출부가 '오늘-14일' 기본 창으로 떨어진다 — 좁히는 것은
    // 살아있는 회차가 창을 붙들고 있을 때뿐이라는 뜻이다(P0: 발주서 주문 누락).
    expect(
      resolveCampaignQueryStartMs({
        salesCampaigns: [
          { startDate: new Date('2026-06-12T00:00:00.000Z'), endDate: new Date('2026-06-18T00:00:00.000Z'), status: 'COMPLETED' },
          { startDate: new Date('2026-06-23T00:00:00.000Z'), endDate: new Date('2026-06-30T00:00:00.000Z'), status: 'DROPPED' },
        ],
      }),
    ).toBe(startKst('2026.06.12'));
  });

  it('status가 없으면(select 누락 등) 좁히지 않는다 — 모름은 끝난 회차가 아니다', () => {
    expect(
      resolveCampaignQueryStartMs({
        startDate: new Date('2026-09-10T00:00:00.000Z'),
        salesCampaigns: [
          { startDate: new Date('2026-09-10T00:00:00.000Z'), endDate: new Date('2026-09-16T00:00:00.000Z') },
          { startDate: new Date('2026-06-12T00:00:00.000Z'), endDate: new Date('2026-06-18T00:00:00.000Z') },
        ],
      }),
    ).toBe(startKst('2026.06.12'));
  });

  it('저장 창은 거르지 않는다 — 끝난 회차를 빼도 컷오프 바닥 아래로는 내려가지 않는다', () => {
    // 불변식(조회창 ≤ 컷오프)의 바닥은 캠페인이 스스로 선언한 창이다. 연결이 전부 종결돼도
    // 저장 창이 더 이르면 그대로 쓴다.
    expect(
      resolveCampaignQueryStartMs({
        startDate: new Date('2026-08-01T00:00:00.000Z'),
        salesCampaigns: [
          { startDate: new Date('2026-09-10T00:00:00.000Z'), endDate: new Date('2026-09-16T00:00:00.000Z'), status: 'ACTIVE' },
          { startDate: new Date('2026-06-12T00:00:00.000Z'), endDate: new Date('2026-06-18T00:00:00.000Z'), status: 'COMPLETED' },
        ],
      }),
    ).toBe(startKst('2026.08.01'));
  });
});

describe('parseSalePeriodBounds — 판매기간 문자열 → 정본(startDate/endDate)', () => {
  it('구체 기간은 KST 자정 시작 ~ KST 종일 종료로 파싱', () => {
    expect(parseSalePeriodBounds('2026.07.06 ~ 2026.07.13')).toEqual({
      startMs: startKst('2026.07.06'),
      endMs: endKst('2026.07.13'),
      hasOpenEnd: false,
    });
  });

  it("'계속'은 종료 미정 — endMs=null + hasOpenEnd(옛 종료값을 지워야 조기 절단 안 됨)", () => {
    expect(parseSalePeriodBounds('2026.07.06 ~ 계속')).toEqual({
      startMs: startKst('2026.07.06'),
      endMs: null,
      hasOpenEnd: true,
    });
  });

  it('미정·미등록·null은 전부 빈 결과(정본을 건드리지 않음)', () => {
    for (const sp of ['기간 미정', '미등록', '', null, undefined]) {
      expect(parseSalePeriodBounds(sp)).toEqual({ startMs: null, endMs: null, hasOpenEnd: false });
    }
  });

  it('저장된 startDate/endDate를 보지 않는다(문자열만의 해석)', () => {
    // resolveSaleWindowStartMs와 달리 DateTime 우선순위가 없어야 편집 문자열을 정본에 반영할 수 있다.
    expect(parseSalePeriodBounds('2026.07.06 ~ 2026.07.13').startMs).toBe(startKst('2026.07.06'));
  });
});

describe('isSameKstDay — 날짜 단위 편집이 스토어 정밀 시각을 뭉개지 않게 하는 게이트', () => {
  it('같은 KST 날짜면 true(정밀 시각 보존 → 덮어쓰지 않음)', () => {
    expect(isSameKstDay(new Date('2026-07-06T10:30:00.000+09:00'), startKst('2026.07.06'))).toBe(true);
    // UTC 자정(=KST 09:00)도 같은 KST 날짜로 본다.
    expect(isSameKstDay(new Date('2026-07-06T00:00:00.000Z'), startKst('2026.07.06'))).toBe(true);
  });

  it('다른 날짜면 false(정본 갱신 필요)', () => {
    expect(isSameKstDay(new Date('2026-07-08T00:00:00.000+09:00'), startKst('2026.07.06'))).toBe(false);
  });

  it('기존 값이 null이면 false — 정본이 비어 있으면 반드시 채운다', () => {
    expect(isSameKstDay(null, startKst('2026.07.06'))).toBe(false);
    expect(isSameKstDay(undefined, startKst('2026.07.06'))).toBe(false);
  });
});
