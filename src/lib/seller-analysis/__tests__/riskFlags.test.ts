// 리스크 플래그 계약 — 특히 '공구 반응 침체'(구 '공구 피로 신호')의 재정의를 고정한다.
//
// 오너 확정 2026-07-16: 이 CRM은 공구하는 계정을 찾는 도구다. 공구를 자주·지속하는 것은
// 공구활성도와 연계된 긍정 신호라 벌점 대상이 아니고, 나쁜 신호는 "공구는 많은데
// 좋아요·댓글 액션이 없는 콘텐츠만 계속 발행"(계정 활성도 저하)뿐이다. 그래서 판정은
// 자기 일반글 대비 상대비교(구 규칙)가 아니라 팔로워 규모 벤치마크 대비 절대 기준이다.

import { describe, it, expect } from 'vitest';
import { computeRiskFlags } from '../riskFlags';
import { estimateActiveFollowers } from '../scores';

/** 표본 10건 미만으로 잡아 gongu-gap 등 무관 플래그의 동시 발화를 차단한 최소 metrics. */
function baseMetrics(overrides: {
  er?: number | null;
  avgLikes?: number | null;
  avgComments?: number | null;
  gonguCount?: number;
  gonguShare?: number | null;
  gonguEr?: number | null;
  nonGonguEr?: number | null;
}) {
  return {
    engagement: {
      er: overrides.er ?? null,
      avgLikes: overrides.avgLikes ?? null,
      avgComments: overrides.avgComments ?? null,
    },
    gongu: {
      gonguCount: overrides.gonguCount ?? 0,
      gonguShare: overrides.gonguShare ?? null,
      gonguEr: overrides.gonguEr ?? null,
      nonGonguEr: overrides.nonGonguEr ?? null,
    },
    dataSufficiency: { postCount: 9, hasTimestamps: false, hasComments: false },
  };
}

describe('공구 반응 침체 (gongu-engagement-slump)', () => {
  // 팔로워 30,000 → 벤치마크 ER 2% → 침체선(30%) = 0.6%
  const meta = { followerCount: 30_000, followingCount: 500, postsCountTotal: 800, bio: null };

  it('공구를 지속 발행하는데 공구글 ER이 벤치마크의 30% 미만이면 발화한다', () => {
    const flags = computeRiskFlags(
      baseMetrics({ gonguCount: 5, gonguShare: 0.3, gonguEr: 0.004, nonGonguEr: 0.005 }),
      meta,
    );
    const slump = flags.find((f) => f.key === 'gongu-engagement-slump');
    expect(slump).toBeDefined();
    expect(slump!.label).toBe('공구 반응 침체');
    expect(slump!.reason).toContain('공구 5건');
  });

  it('공구가 많아도(비중 높아도) 반응이 건강하면 발화하지 않는다 — 빈도는 벌점이 아니다', () => {
    const flags = computeRiskFlags(
      baseMetrics({ gonguCount: 12, gonguShare: 0.6, gonguEr: 0.02, nonGonguEr: 0.03 }),
      meta,
    );
    expect(flags.find((f) => f.key === 'gongu-engagement-slump')).toBeUndefined();
  });

  it('구 규칙(일반글 대비 절반 미만)만으로는 발화하지 않는다 — 상대비교 폐기 가드', () => {
    // gonguEr 1.2% / nonGonguEr 3% = 유지율 40% (구 규칙이면 발화). 절대값은 침체선(0.6%) 위.
    const flags = computeRiskFlags(
      baseMetrics({ gonguCount: 5, gonguShare: 0.2, gonguEr: 0.012, nonGonguEr: 0.03 }),
      meta,
    );
    expect(flags.find((f) => f.key === 'gongu-engagement-slump')).toBeUndefined();
    // 키 자체가 사라졌는지도 고정 — 되살리면 여기서 컴파일/단언이 깨진다.
    expect(flags.map((f) => f.key as string)).not.toContain('gongu-fatigue');
  });

  it('팔로워 수를 모르면 벤치마크를 세울 수 없어 발화하지 않는다 (오탐 < 침묵)', () => {
    const flags = computeRiskFlags(
      baseMetrics({ gonguCount: 5, gonguShare: 0.3, gonguEr: 0.001, nonGonguEr: 0.005 }),
      { followerCount: null, followingCount: null, postsCountTotal: null, bio: null },
    );
    expect(flags.find((f) => f.key === 'gongu-engagement-slump')).toBeUndefined();
  });
});

describe('허수 팔로워 의심 — 실질 반응 팔로워 추정 병기', () => {
  it('경고 reason에 실질 반응 팔로워 추정치가 함께 실린다', () => {
    // 팔로워 100,000 → 벤치마크 1% → ER 0.2%면 발화 + 추정 ~20,000명
    const flags = computeRiskFlags(
      baseMetrics({ er: 0.002, avgLikes: 190, avgComments: 10 }),
      { followerCount: 100_000, followingCount: 300, postsCountTotal: 1_000, bio: null },
    );
    const phantom = flags.find((f) => f.key === 'phantom-followers');
    expect(phantom).toBeDefined();
    expect(phantom!.reason).toContain('실질 반응 팔로워 ~20,000명 추정');
  });
});

describe('estimateActiveFollowers — 실질 반응 팔로워 추정 헬퍼', () => {
  it('ER/벤치마크 비율로 역산한다', () => {
    // 100,000명 · ER 0.2% · 벤치마크 1% → 20% → ~20,000
    expect(estimateActiveFollowers(100_000, 0.002)).toBe(20_000);
  });

  it('반응이 벤치마크를 넘어도 팔로워 수를 넘지 않는다 (상한 캡)', () => {
    // 10,000명 구간 벤치마크 2%, ER 10% → 비율 5지만 캡 → 10,000
    expect(estimateActiveFollowers(10_000, 0.1)).toBe(10_000);
  });

  it('유효숫자 2자리로 뭉갠다 — 추정치의 거짓 정밀도 금지', () => {
    // 33,333 × (0.011/0.02) = 18,333.15 → ~18,000
    expect(estimateActiveFollowers(33_333, 0.011)).toBe(18_000);
  });

  it('입력이 없거나 손상이면 null (0으로 오독시키지 않는다)', () => {
    expect(estimateActiveFollowers(null, 0.02)).toBeNull();
    expect(estimateActiveFollowers(5_000, null)).toBeNull();
    expect(estimateActiveFollowers(5_000, -1)).toBeNull();
    expect(estimateActiveFollowers(0, 0.02)).toBeNull();
    expect(estimateActiveFollowers(Number.NaN, 0.02)).toBeNull();
  });
});
