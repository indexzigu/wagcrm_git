import { describe, expect, it } from 'vitest';
import {
  SIMILARITY_THRESHOLD,
  SIMILAR_POOL_MIN,
  SIMILAR_SELLERS_MAX,
  combineSimilarity,
  findSimilarSellers,
  scoreSimilarity,
  type SimilarityProfile,
} from '../similarity';

// [셀러분석] 비슷한 셀러 유사도 — 순수 함수. 픽스처는 전부 가상 값.

const NOW = new Date('2026-06-15T00:00:00Z');

function profile(
  id: string,
  opts: {
    category?: string | null;
    tags?: string[];
    sub?: string[];
    followers?: number | null;
    aiTags?: unknown;
    metrics?: unknown;
    profileMeta?: unknown;
  } = {},
): SimilarityProfile {
  return {
    id,
    aiTags: opts.aiTags ?? { category: opts.category ?? '리빙', tags: opts.tags ?? [], sub_categories: opts.sub ?? [] },
    followers: opts.followers === undefined ? 10_000 : opts.followers,
    metrics: opts.metrics ?? { engagement: { er: 0.02 }, cadence: { medianIntervalDays: 2 } },
    profileMeta: opts.profileMeta ?? null,
  };
}

/** 대상과 전혀 무관한 채움용 후보 — 풀 크기만 맞춘다 */
function filler(i: number): SimilarityProfile {
  return profile(`filler${i}`, { category: '스포츠', tags: [`가상운동${i}`], followers: 10 ** 7 });
}

function poolWith(...profiles: SimilarityProfile[]): SimilarityProfile[] {
  const fill = Math.max(0, SIMILAR_POOL_MIN - profiles.length);
  return [...profiles, ...Array.from({ length: fill }, (_, i) => filler(i))];
}

describe('scoreSimilarity — 산식', () => {
  it('주 카테고리만 같고 태그 0 · 팔로워 100배 차 → 0.40 → 임계값 미만(비노출)', () => {
    const m = scoreSimilarity(
      profile('a', { tags: ['수납'], followers: 10_000 }),
      profile('b', { tags: ['캠핑'], followers: 1_000_000 }),
    )!;
    expect(m.axes).toEqual({ category: 1, tags: 0, scale: 0 });
    expect(m.score).toBeCloseTo(0.4, 5);
    expect(m.score).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it('주 카테고리 같음 + 태그 1개 + 규모 비슷 → ≈0.71 노출, reasons 에 숫자', () => {
    const m = scoreSimilarity(
      profile('a', { tags: ['#수납', '주방'], followers: 12_000 }),
      profile('b', { tags: ['수납'], followers: 15_100 }),
    )!;
    expect(m.score).toBeGreaterThan(0.7);
    expect(m.reasons).toEqual(['주 카테고리 같음(리빙)', '겹치는 태그 1개: 수납', '팔로워 1.2만 / 1.5만']);
    expect(m.reasons.every((r) => /\d|같음/.test(r))).toBe(true);
  });

  it('sub_categories 도 태그 집합에 합친다 · 3개 이상 겹치면 태그 축 1', () => {
    const m = scoreSimilarity(
      profile('a', { tags: ['살림'], sub: ['수납', '주방'] }),
      profile('b', { tags: ['주방', '수납'], sub: ['살림'] }),
    )!;
    expect(m.axes.tags).toBe(1);
    expect(m.sharedTags).toHaveLength(3);
  });

  it('상대의 주 카테고리가 내 프로필에서 ≥65 면 카테고리 0.5', () => {
    // 대상: 리빙 주 + 식품 키워드 2개(65점)
    const m = scoreSimilarity(
      profile('a', { category: '리빙', tags: ['레시피', '요리'] }),
      profile('b', { category: '식품', tags: [] }),
    )!;
    expect(m.axes.category).toBe(0.5);
  });

  it('구형 배열 aiTags → 카테고리 축 null, 남은 축으로 재정규화(NaN 없음)', () => {
    const m = scoreSimilarity(
      profile('a', { aiTags: ['수납', '살림', '주방'] }),
      profile('b', { tags: ['수납', '살림', '주방'] }),
    )!;
    expect(m.axes.category).toBeNull();
    expect(Number.isNaN(m.score)).toBe(false);
    expect(m.score).toBeCloseTo(1, 5);
  });

  it('팔로워 미상 → 규모 축 null · 전 축 null 이면 점수를 만들지 않는다', () => {
    expect(scoreSimilarity(profile('a', { followers: null }), profile('b'))!.axes.scale).toBeNull();
    expect(combineSimilarity({ category: null, tags: null, scale: null })).toBeNull();
  });
});

describe('findSimilarSellers — 풀·제외·정렬', () => {
  const target = profile('target', { tags: ['수납', '살림'], followers: 10_000 });

  it(`분석 셀러가 ${SIMILAR_POOL_MIN}명 미만이면 풀 부족 상태`, () => {
    const pool = [target, profile('b'), profile('c')];
    expect(findSimilarSellers('target', pool, NOW)).toEqual({ status: 'POOL_TOO_SMALL', poolSize: 3 });
  });

  it('대상이 풀에 없으면(미분석) TARGET_UNANALYZED', () => {
    expect(findSimilarSellers('nobody', poolWith(target), NOW).status).toBe('TARGET_UNANALYZED');
  });

  it('자기 자신은 결과에 없다', () => {
    const twin = profile('twin', { tags: ['수납', '살림'], followers: 10_000 });
    const verdict = findSimilarSellers('target', poolWith(target, twin), NOW);
    expect(verdict.status).toBe('OK');
    if (verdict.status !== 'OK') return;
    expect(verdict.matches.map((m) => m.id)).toEqual(['twin']);
  });

  it('브랜드·샵 계정 추정은 뺀다(computeRiskFlags)', () => {
    const brand = profile('brand', {
      tags: ['수납', '살림'],
      followers: 50_000,
      profileMeta: { followerCount: 50_000, followingCount: 0, bio: '가상 공식몰', postsCountTotal: 100 },
    });
    const verdict = findSimilarSellers('target', poolWith(target, brand), NOW);
    if (verdict.status !== 'OK') throw new Error('expected OK');
    expect(verdict.matches.map((m) => m.id)).not.toContain('brand');
  });

  it(`점수 내림차순 최대 ${SIMILAR_SELLERS_MAX}명 · 임계값 미만 제외`, () => {
    const close = Array.from({ length: 8 }, (_, i) =>
      profile(`close${i}`, { tags: ['수납', '살림'], followers: 10_000 + i * 1000 }),
    );
    const verdict = findSimilarSellers('target', [target, ...close, filler(0)], NOW);
    if (verdict.status !== 'OK') throw new Error('expected OK');
    expect(verdict.matches).toHaveLength(SIMILAR_SELLERS_MAX);
    expect(verdict.matches.map((m) => m.id)).not.toContain('filler0');
    const scores = verdict.matches.map((m) => m.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(verdict.poolSize).toBe(10);
  });

  it('결과 0명이어도 OK(화면이 「N명 중 없음」을 말한다)', () => {
    const verdict = findSimilarSellers('target', poolWith(target), NOW);
    expect(verdict).toMatchObject({ status: 'OK', matches: [] });
  });
});
