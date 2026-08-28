import { describe, it, expect } from 'vitest';
import { needsReviewSourceLink, dealStoreLinkResetTargets } from './review-link';

// pickShortLink 자체 케이스는 review-collect.test.ts가 re-export 경유로 계속 커버한다(이전 검증).

describe('needsReviewSourceLink — 리뷰 소스 부재 판정(오너 데이터 경로 ②)', () => {
  const base = { storeLinkStatus: null, productIdMatched: false, hasShortLink: false, reviewCount: 0 };

  it('리뷰가 이미 있으면 어떤 상태든 false(소스 작동 중 — 묶음 리스팅 배분 포함)', () => {
    expect(needsReviewSourceLink({ ...base, reviewCount: 4, storeLinkStatus: 'FAILED' })).toBe(false);
    expect(needsReviewSourceLink({ ...base, reviewCount: 32 })).toBe(false);
  });

  it('해석 FAILED는 true — 전 티어(주문·링크·이름) 실패라 링크가 필요하다', () => {
    expect(needsReviewSourceLink({ ...base, storeLinkStatus: 'FAILED' })).toBe(true);
    // 단축링크가 있어도 FAILED면 true(그 링크가 스토어 밖 상품이거나 로그인벽 — 다른 링크 필요)
    expect(needsReviewSourceLink({ ...base, storeLinkStatus: 'FAILED', hasShortLink: true })).toBe(true);
  });

  it('productId 미매칭 + 단축링크 없음 + 리뷰 0 = true (도메인만 저장된 22딜 코호트)', () => {
    expect(needsReviewSourceLink(base)).toBe(true);
  });

  it('RESOLVED여도 단축링크가 없으면 true — 이름매칭 연결 후 로그인벽으로 수집 0인 실측 코호트(#43)', () => {
    expect(needsReviewSourceLink({ ...base, storeLinkStatus: 'RESOLVED' })).toBe(true);
  });

  it('단축링크 보유(해석 대기)는 false — 다음 크론이 해석한다', () => {
    expect(needsReviewSourceLink({ ...base, hasShortLink: true })).toBe(false);
    expect(needsReviewSourceLink({ ...base, hasShortLink: true, storeLinkStatus: 'RESOLVED' })).toBe(false);
  });

  it('주문검증(productId) 매칭 딜은 false', () => {
    expect(needsReviewSourceLink({ ...base, productIdMatched: true })).toBe(false);
  });
});

describe('dealStoreLinkResetTargets — 캠페인 저장 시 해석 캐시 리셋 대상', () => {
  const prev = { dealId: 'deal-a', baseNaverLink: 'https://smartstore.naver.com' };

  it('링크 실변경 시 그 딜을 반환한다', () => {
    expect(dealStoreLinkResetTargets(prev, { baseNaverLink: 'https://mkt.shopping.naver.com/link/x' })).toEqual([
      'deal-a',
    ]);
  });

  it('같은 값 재제출(폼 저장)·미전달은 빈 배열 — 캐시를 건드리지 않는다', () => {
    expect(dealStoreLinkResetTargets(prev, { baseNaverLink: 'https://smartstore.naver.com' })).toEqual([]);
    expect(dealStoreLinkResetTargets(prev, {})).toEqual([]);
    expect(dealStoreLinkResetTargets(prev, { dealId: 'deal-a' })).toEqual([]);
  });

  it('딜 재배정 시 이전·새 딜을 모두 반환한다(링크가 새 딜로 따라감)', () => {
    expect(dealStoreLinkResetTargets(prev, { dealId: 'deal-b' }).sort()).toEqual(['deal-a', 'deal-b']);
    expect(
      dealStoreLinkResetTargets(prev, { dealId: 'deal-b', baseNaverLink: 'https://mkt.shopping.naver.com/link/x' }).sort(),
    ).toEqual(['deal-a', 'deal-b']);
  });

  it('previous 링크가 null이어도 새 링크가 오면 변경으로 본다', () => {
    expect(
      dealStoreLinkResetTargets({ dealId: 'deal-a', baseNaverLink: null }, { baseNaverLink: 'https://smartstore.naver.com' }),
    ).toEqual(['deal-a']);
  });
});
