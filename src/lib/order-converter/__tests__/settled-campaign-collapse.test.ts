import { describe, expect, it } from 'vitest';
import {
  COLLAPSED_CAMPAIGN_FIELDS,
  collapseSettledCampaigns,
  isSettledClosedCampaign,
  isSettledRoundStatus,
  SETTLED_ROUND_STATUSES,
} from '../settled-campaign-collapse';

const round = (status: string | null) => ({ status });

describe('isSettledClosedCampaign — 접어도 되는 캠페인인가', () => {
  it('마감 + 전 회차 정산완료면 접는다', () => {
    expect(
      isSettledClosedCampaign({ isActive: false, salesCampaigns: [round('COMPLETED'), round('COMPLETED')] }),
    ).toBe(true);
  });

  it('드랍된 회차도 끝난 것으로 본다', () => {
    expect(isSettledClosedCampaign({ isActive: false, salesCampaigns: [round('COMPLETED'), round('DROPPED')] })).toBe(true);
  });

  it('판매 중이면 접지 않는다 — 마감 여부가 첫 조건이다', () => {
    expect(isSettledClosedCampaign({ isActive: true, salesCampaigns: [round('COMPLETED')] })).toBe(false);
  });

  it('정산 진행중인 회차가 하나라도 있으면 접지 않는다(오너 확정 2026-09-16)', () => {
    // 아직 돈이 오가는 중인 캠페인은 주문관리에 펼쳐 둔다. ⛔ 이 케이스가 `isSalesCampaignLocked`
    // 와 갈리는 지점이다 — 그쪽은 정산중을 '확정'으로 보지만 여기서는 아니다.
    expect(
      isSettledClosedCampaign({ isActive: false, salesCampaigns: [round('COMPLETED'), round('SETTLEMENT_IN_PROGRESS')] }),
    ).toBe(false);
  });

  it('마감됐지만 정산대기·마감 상태 회차가 있으면 접지 않는다', () => {
    expect(isSettledClosedCampaign({ isActive: false, salesCampaigns: [round('SETTLEMENT_WAIT')] })).toBe(false);
    expect(isSettledClosedCampaign({ isActive: false, salesCampaigns: [round('CLOSED')] })).toBe(false);
  });

  it('연결된 회차가 없으면 접지 않는다 — 「정산 끝남」이 아니라 「연결 안 됨」이다', () => {
    expect(isSettledClosedCampaign({ isActive: false, salesCampaigns: [] })).toBe(false);
    expect(isSettledClosedCampaign({ isActive: false, salesCampaigns: null })).toBe(false);
    expect(isSettledClosedCampaign({ isActive: false })).toBe(false);
  });

  it('상태가 비어 있는 회차가 섞이면 접지 않는다(모름은 끝남이 아니다)', () => {
    expect(isSettledClosedCampaign({ isActive: false, salesCampaigns: [round('COMPLETED'), round(null)] })).toBe(false);
  });

  it('상태 문자열의 대소문자·공백은 무시한다(자유 문자열 컬럼이다)', () => {
    expect(isSettledRoundStatus(' completed ')).toBe(true);
    expect(isSettledRoundStatus('Dropped')).toBe(true);
    expect(isSettledRoundStatus('settlement_in_progress')).toBe(false);
  });

  it('제외 목록은 정산 락 목록과 다르다 — 정산중을 포함하지 않는다', () => {
    expect(SETTLED_ROUND_STATUSES).not.toContain('SETTLEMENT_IN_PROGRESS');
  });
});

describe('collapseSettledCampaigns — 목록에서 무엇을 덜어내나', () => {
  const settled = {
    id: 'a',
    name: '끝난 캠페인',
    isActive: false,
    periodLabel: '2026.06.12 ~ 2026.06.18',
    totalRevenue: 1_000,
    distinctOrderCount: 7,
    dailyStats: [{ date: '2026-06-12' }],
    insights: { inflow: [] },
    mappings: [{ id: 'm1' }],
    tasks: [{ id: 't1' }],
    salesCampaigns: [round('COMPLETED')],
    pendingOrders: [{ productOrderId: 'p1' }],
  };
  const live = { id: 'b', name: '판매 중', isActive: true, dailyStats: [{ date: '2026-09-10' }], salesCampaigns: [round('ACTIVE')] };

  it('접힌 줄이 쓰는 값은 남기고 무거운 것은 덜어낸다', () => {
    const [collapsed] = collapseSettledCampaigns([settled]) as Array<Record<string, unknown>>;
    expect(collapsed.isCollapsed).toBe(true);
    expect(collapsed.name).toBe('끝난 캠페인');
    expect(collapsed.periodLabel).toBe('2026.06.12 ~ 2026.06.18');
    expect(collapsed.totalRevenue).toBe(1_000);
    expect(collapsed.distinctOrderCount).toBe(7);

    // 실체는 여기다 — 이 필드들이 초기 로딩에서 빠지는 것이 이 기능이다.
    for (const heavy of ['dailyStats', 'insights', 'mappings', 'tasks', 'salesCampaigns', 'pendingOrders']) {
      expect(collapsed, `${heavy} 가 접힌 요약에 남아 있다`).not.toHaveProperty(heavy);
    }
  });

  it('접히지 않는 캠페인은 원본 객체 그대로 통과시킨다', () => {
    const [passed] = collapseSettledCampaigns([live]);
    expect(passed).toBe(live);
  });

  it('순서를 바꾸지 않는다 — 정렬은 목록 응답의 계약이다', () => {
    const out = collapseSettledCampaigns([settled, live, { ...settled, id: 'c' }]);
    expect(out.map((c) => (c as { id: string }).id)).toEqual(['a', 'b', 'c']);
  });

  it('요약 필드 목록에 무거운 필드가 섞여 들어오지 않는다', () => {
    for (const heavy of ['dailyStats', 'insights', 'mappings', 'tasks', 'salesCampaigns']) {
      expect(COLLAPSED_CAMPAIGN_FIELDS as readonly string[]).not.toContain(heavy);
    }
  });
});
