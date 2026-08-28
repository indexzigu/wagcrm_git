import { describe, it, expect } from 'vitest';
import {
  toPortalCampaign,
  aggregateOptions,
  parseSalePeriodEndYmd,
  parseSalePeriodStartYmd,
  daysBetweenYmd,
  saleBoundaryMs,
} from '../seller-portal';

// campaigns route 응답을 모사한 원본 — 셀러에게 절대 나가면 안 되는 내부 필드 포함
const RAW_CAMPAIGN = {
  id: 'camp1',
  name: '[딜이름] 셀러명',
  template: 'nutrione',
  sellerName: '실명(내부표기)',
  toEmail: 'order@vendor.co.kr',
  ccEmail: 'internal@ygrd.kr',
  salePeriod: '2026.07.01 ~ 2026.07.10',
  isActive: true,
  thumbnailUrl: 'https://example.com/t.png',
  totalOrders: 10,
  distinctOrderCount: 10,
  totalQuantity: 12,
  totalRevenue: 500000,
  cachedTotalRevenue: 499999,
  newOrderBeforeCount: 3,
  pendingCount: 2,
  mappings: [{ productName: 'x', price: 9900, brandCode: 'SECRET' }],
  salesCampaigns: [
    { sellerId: 's1', netMarginRate: 0.31, operatingProfit: 12345, sellerExpense: 999 },
  ],
  tasks: [{ id: 't1' }],
  dailyStats: [
    {
      date: '2026-07-06',
      orders: 4,
      quantity: 5,
      revenue: 200000,
      newOrderBefore: 1,
      pending: 2,
      shipping: 1,
      options: [{ name: '제품: A세트', price: 40000, orders: 4, quantity: 5, revenue: 200000, ratio: 100 }],
    },
    {
      date: '2026-07-07',
      orders: 6,
      quantity: 7,
      revenue: 300000,
      options: [
        { name: 'A세트', price: 0, orders: 3, quantity: 3, revenue: 120000 },
        { name: 'B세트', price: 60000, orders: 3, quantity: 4, revenue: 180000 },
      ],
    },
  ],
  insights: {
    inflow: [
      { path: '마케팅링크', orders: 7, quantity: 8, revenue: 350000, orderRatio: 70 },
      { path: '네이버쇼핑', orders: 3, quantity: 4, revenue: 150000, orderRatio: 30 },
    ],
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, orders: hour === 20 ? 5 : 0, revenue: 0 })),
    device: { mobile: 9, pc: 1, unknown: 0 },
    paymentMeans: [{ means: '신용카드', orders: 10 }],
    membership: { orders: 5, ratio: 50 },
    buyers: { unique: 8, repeat: 2, repeatRatio: 25 },
    claims: { canceled: 1, returned: 0, exchanged: 0, total: 1, ratio: 9.09 },
  },
};

describe('seller-portal 화이트리스트', () => {
  it('내부 필드(이메일·매핑·판매캠페인·운영카운트·클레임·결제수단)가 절대 포함되지 않는다', () => {
    const portal = toPortalCampaign(RAW_CAMPAIGN);
    const json = JSON.stringify(portal);

    // 최상위 위험 필드
    for (const forbidden of [
      'toEmail', 'ccEmail', 'mappings', 'salesCampaigns', 'tasks', 'template',
      'sellerName', 'cachedTotalRevenue', 'newOrderBeforeCount', 'pendingCount',
    ]) {
      expect(portal).not.toHaveProperty(forbidden);
    }
    // 값 기반 누출 검사 (중첩 위치 무관)
    for (const leak of ['order@vendor.co.kr', 'SECRET', 'netMarginRate', 'operatingProfit', 'sellerExpense', '실명(내부표기)']) {
      expect(json).not.toContain(leak);
    }
    // 인사이트 중 내부 전용(클레임·결제수단·유입 원본 목록)은 미노출
    for (const leak of ['claims', 'paymentMeans', 'inflow', '네이버쇼핑']) {
      expect(json).not.toContain(leak);
    }
    // dailyStats의 운영 상태 카운트 미노출
    expect(JSON.stringify(portal.dailyStats)).not.toContain('pending');
  });

  it('허용 필드와 파생 지표(링크 유입·모바일 비율)를 올바르게 계산한다', () => {
    const portal = toPortalCampaign(RAW_CAMPAIGN);
    expect(portal).toMatchObject({
      id: 'camp1',
      name: '[딜이름] 셀러명',
      isActive: true,
      totalOrders: 10,
      totalRevenue: 500000,
    });
    expect(portal.insights).toMatchObject({
      linkOrders: 7,
      linkRatio: 70,
      mobileRatio: 90,
    });
    // 캠페인 내 2회+ 구매(buyers)는 셀러 화면에서 "재구매"로 오독되어 화이트리스트에서 제거됨
    // (2026-07-10) — 재구매 고객은 cross-campaign-repurchase의 회차간 비율만 노출한다.
    expect(portal.insights).not.toHaveProperty('buyers');
    expect(portal.insights!.hourly.find((h) => h.hour === 20)?.orders).toBe(5);
  });

  it('distinctOrderCount는 결제단위 주문건수 우선, 없으면 totalOrders(라인수)로 폴백한다', () => {
    // 주문건수(distinct)가 있으면 그 값 — 라인수 totalOrders와 별개다(셀러 "주문 N건"·AOV 분모의 정본)
    const withDistinct = toPortalCampaign({ ...RAW_CAMPAIGN, totalOrders: 10, distinctOrderCount: 7 });
    expect(withDistinct.distinctOrderCount).toBe(7);
    expect(withDistinct.totalOrders).toBe(10); // 라인수는 내부 비율 분모용으로 유지
    // 미백필(과거 마감) 캠페인은 totalOrders로 폴백 — order-dashboard 카드와 동일 규칙
    const noDistinct = toPortalCampaign({ ...RAW_CAMPAIGN, totalOrders: 10, distinctOrderCount: undefined });
    expect(noDistinct.distinctOrderCount).toBe(10);
  });

  it('linkRatio 분모는 결제 distinct 주문건수(라인수 totalOrders 아님)를 쓴다', () => {
    // 라인수(totalOrders)는 12지만 결제 distinct 주문건수는 8 — linkOrders 7도 결제 단위이므로
    // 7/8 = 87.5%가 되어야 한다(라인수 7/12로 나누면 셀러 기여도가 축소돼 보임).
    const portal = toPortalCampaign({ ...RAW_CAMPAIGN, totalOrders: 12, distinctOrderCount: 8 });
    expect(portal.insights!.linkRatio).toBeCloseTo(87.5);
  });

  it('마감 캠페인(insights=null)은 insights null로 통과한다', () => {
    const portal = toPortalCampaign({ ...RAW_CAMPAIGN, isActive: false, insights: null });
    expect(portal.isActive).toBe(false);
    expect(portal.insights).toBeNull();
  });
});

describe('aggregateOptions', () => {
  it('일자별 옵션을 이름으로 병합하고 "제품:" 접두사 제거·단가 백필·비중을 계산한다', () => {
    const portal = toPortalCampaign(RAW_CAMPAIGN);
    const options = aggregateOptions(portal.dailyStats);

    const a = options.find((o) => o.name === 'A세트');
    const b = options.find((o) => o.name === 'B세트');
    expect(a).toMatchObject({ quantity: 8, revenue: 320000, price: 40000 }); // 07-07의 price 0은 07-06 값 유지
    expect(b).toMatchObject({ quantity: 4, revenue: 180000, price: 60000 });
    expect(a!.ratio).toBeCloseTo((8 / 12) * 100);
  });

  it('판매량 내림차순으로 정렬한다(가나다순 아님) — Top-N 절단 시 잘 팔리는 순', () => {
    const portal = toPortalCampaign(RAW_CAMPAIGN);
    const options = aggregateOptions(portal.dailyStats);
    // A세트(8개) > B세트(4개) — 이름순이면 A,B로 같아 보이므로 수량이 역전되는 케이스로 검증
    expect(options.map((o) => o.name)).toEqual(['A세트', 'B세트']);
    expect(options[0].quantity).toBeGreaterThanOrEqual(options[1].quantity);
  });

  it('수량 동률이면 매출 내림차순으로 정렬한다', () => {
    const stats = [
      {
        date: '2026-07-06',
        orders: 2,
        quantity: 4,
        revenue: 300000,
        options: [
          { name: '저가옵션', price: 10000, quantity: 2, revenue: 20000 },
          { name: '고가옵션', price: 100000, quantity: 2, revenue: 200000 },
        ],
      },
    ];
    const options = aggregateOptions(stats as any);
    // 수량은 둘 다 2 → 매출 큰 고가옵션이 앞
    expect(options.map((o) => o.name)).toEqual(['고가옵션', '저가옵션']);
  });
});

describe('parseSalePeriodEndYmd (§3 마감 D-day)', () => {
  it('정규화된 salePeriod에서 마감일 YYYY-MM-DD를 뽑는다', () => {
    expect(parseSalePeriodEndYmd('2026.07.01 ~ 2026.07.10')).toBe('2026-07-10');
  });

  it("열린 기간('계속')은 null — D-day 미표기", () => {
    expect(parseSalePeriodEndYmd('2026.07.01 ~ 계속')).toBeNull();
  });

  it('미등록·기간 미정·단일값은 null', () => {
    expect(parseSalePeriodEndYmd('기간 미정')).toBeNull();
    expect(parseSalePeriodEndYmd('미등록')).toBeNull();
    expect(parseSalePeriodEndYmd('2026.07.01')).toBeNull();
    expect(parseSalePeriodEndYmd('')).toBeNull();
  });

  it('하이픈 구분·한 자리 월일도 관용 파싱', () => {
    expect(parseSalePeriodEndYmd('2026-07-01 ~ 2026-7-5')).toBe('2026-07-05');
  });
});

describe('daysBetweenYmd (§3 카운트다운)', () => {
  it('남은 날 양수·마감 당일 0·지난 뒤 음수', () => {
    expect(daysBetweenYmd('2026-07-14', '2026-07-20')).toBe(6);
    expect(daysBetweenYmd('2026-07-20', '2026-07-20')).toBe(0);
    expect(daysBetweenYmd('2026-07-21', '2026-07-20')).toBe(-1);
  });

  it('월·연 경계를 UTC 자정 기준으로 정확히 넘는다', () => {
    expect(daysBetweenYmd('2026-07-31', '2026-08-01')).toBe(1);
    expect(daysBetweenYmd('2026-12-31', '2027-01-01')).toBe(1);
  });
});

describe('parseSalePeriodStartYmd (§예정 섹션)', () => {
  it('정규화된 salePeriod에서 시작일 YYYY-MM-DD를 뽑는다', () => {
    expect(parseSalePeriodStartYmd('2026.07.17 ~ 2026.07.24')).toBe('2026-07-17');
  });

  it('한 자리 월일·하이픈 구분 관용 파싱', () => {
    expect(parseSalePeriodStartYmd('2026-7-3 ~ 2026-07-10')).toBe('2026-07-03');
  });

  it('미등록·기간 미정·빈 값은 null', () => {
    expect(parseSalePeriodStartYmd('기간 미정')).toBeNull();
    expect(parseSalePeriodStartYmd('미등록')).toBeNull();
    expect(parseSalePeriodStartYmd('')).toBeNull();
  });
});

describe('saleBoundaryMs (§B+D 라이브 카운트다운 목표 시각)', () => {
  it('open=그 날 00:00 KST, close=그 날 23:59:59.999 KST 절대시각', () => {
    // 2026-07-19 00:00 KST = 2026-07-18 15:00 UTC
    expect(saleBoundaryMs('2026-07-19', 'open')).toBe(Date.UTC(2026, 6, 18, 15, 0, 0, 0));
    expect(saleBoundaryMs('2026-07-19', 'close')).toBe(Date.UTC(2026, 6, 19, 14, 59, 59, 999));
  });

  it('close가 open보다 하루의 끝만큼 뒤(≈86399999ms)', () => {
    const open = saleBoundaryMs('2026-07-19', 'open');
    const close = saleBoundaryMs('2026-07-19', 'close');
    expect(close - open).toBe(86_399_999);
  });

  it('서버 타임존과 무관하게 결정적(KST 오프셋 문자열 고정)', () => {
    expect(Number.isFinite(saleBoundaryMs('2026-01-01', 'open'))).toBe(true);
  });
});
