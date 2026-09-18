import { describe, expect, it } from 'vitest';
import { rankCampaignCardCautions } from '../campaign-card-cautions';

describe('rankCampaignCardCautions — 카드에 펼칠 주의 배지 순위(T-175)', () => {
  it('셋이 겹치면 스토어 기간 → 판매기간 후 주문 → 기간 불일치 순이다(맨 앞 1개만 펼쳐진다)', () => {
    expect(
      rankCampaignCardCautions({
        periodMismatch: true,
        postPeriodOrderCount: 3,
        storePeriodDrift: { scope: 'full' },
      }),
    ).toEqual(['store-drift', 'post-period', 'period-mismatch']);
  });

  it('정산 확정 기간 미반영은 판매기간 후 주문보다 뒤, 기간 불일치보다 앞이다', () => {
    expect(
      rankCampaignCardCautions({ periodMismatch: true, periodFrozenDrift: true, postPeriodOrderCount: 1 }),
    ).toEqual(['post-period', 'frozen-drift', 'period-mismatch']);
  });

  it('마감 카드는 판매기간 후 주문을 내지 않는다(종전 렌더 조건)', () => {
    expect(rankCampaignCardCautions({ isActive: false, postPeriodOrderCount: 5 })).toEqual([]);
  });

  it('켜진 신호가 없으면 빈 배열 — 카드에 칩도 그리지 않는다', () => {
    expect(rankCampaignCardCautions({ postPeriodOrderCount: 0, storePeriodDrift: null })).toEqual([]);
  });
});
