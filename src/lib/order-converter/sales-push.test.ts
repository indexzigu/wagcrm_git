import { describe, expect, it } from 'vitest';
import { shouldSkipDealPush } from './sales-push';

describe('shouldSkipDealPush — 취소로 인한 0 vs 매핑 미스매치 구분', () => {
  it('매칭 라인이 아예 0건이면 스킵(매핑 미스매치 → 기존값 보존)', () => {
    expect(shouldSkipDealPush({ orders: 0, matchedLines: 0 })).toBe(true);
  });

  it('매핑은 맞았지만 전부 취소돼 유효 0이면 스킵하지 않는다(0을 반영해 합계 최신화)', () => {
    // 이 케이스를 스킵하면 취소 전 낡은 매출이 CampaignDeal·정산 합계에 남는다(회귀 방지 핵심).
    expect(shouldSkipDealPush({ orders: 0, matchedLines: 3 })).toBe(false);
  });

  it('유효주문이 있으면 당연히 반영', () => {
    expect(shouldSkipDealPush({ orders: 5, matchedLines: 5 })).toBe(false);
  });
});
