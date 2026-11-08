import { describe, expect, it } from 'vitest';
import { computeReachMetrics, computeSellerMetrics, REEL_VIEW_MIN_SAMPLE } from '../metrics';
import { normalizeMetrics, normalizeReach } from '../scores';
import { pickApifyVideoView, pickRapidApiVideoView, type MediaType, type RawPost, type VideoViewSource } from '../types';
import { formatReelViewMultiple, reachReasonWord, reachUnavailableLine } from '../reach-display';

// [셀러분석] 릴스 조회 배수(metrics.reach). 픽스처는 전부 가상 값.

let seq = 0;
function post(
  media_type: MediaType,
  video_view_count: number | null,
  view_source: VideoViewSource | null = video_view_count === null ? null : 'views',
): RawPost {
  seq += 1;
  return {
    // 캡션을 서로 다르게 — 재업로드 사본 접기(post-dedup)에 걸리지 않게
    caption: `가상 게시물 ${seq}`,
    likes: 10,
    comments_count: 1,
    sample_comments: [],
    taken_at: new Date(Date.UTC(2026, 0, 1 + seq)).toISOString(),
    media_type,
    video_view_count,
    view_source,
    is_sponsored: false,
  };
}

describe('computeReachMetrics — 판단 불가 사유', () => {
  it('릴스 0개 → NO_REELS (그 자체가 정보)', () => {
    const r = computeReachMetrics([post('image', null), post('carousel', null)], 1000);
    expect(r).toMatchObject({ reelCount: 0, reelViewMultiple: null, unavailableReason: 'NO_REELS' });
  });

  it('릴스 조회수 전부 null(무료 Graph 경로) → NO_VIEWS + reelsWithoutViews', () => {
    const r = computeReachMetrics([post('reel', null), post('reel', null), post('reel', null)], 1000);
    expect(r).toMatchObject({
      reelCount: 3,
      reelViewSample: 0,
      reelsWithoutViews: 3,
      unavailableReason: 'NO_VIEWS',
      reelViewMultiple: null,
      viewSource: null,
    });
  });

  it(`조회수 있는 릴스 2개 → TOO_FEW (${REEL_VIEW_MIN_SAMPLE}개부터)`, () => {
    const r = computeReachMetrics([post('reel', 500), post('reel', 700), post('reel', null)], 1000);
    expect(r).toMatchObject({ reelViewSample: 2, reelsWithoutViews: 1, unavailableReason: 'TOO_FEW' });
    expect(r.reelViewMultiple).toBeNull();
    expect(r.medianReelViews).toBeNull();
  });

  it('팔로워 0 → NO_FOLLOWERS (조회 중앙값은 남긴다)', () => {
    const r = computeReachMetrics([post('reel', 100), post('reel', 200), post('reel', 300)], 0);
    expect(r.unavailableReason).toBe('NO_FOLLOWERS');
    expect(r.reelViewMultiple).toBeNull();
    expect(r.medianReelViews).toBe(200);
  });
});

describe('computeReachMetrics — 값', () => {
  it('짝수 개 중앙값 = 가운데 두 값의 평균', () => {
    const r = computeReachMetrics(
      [post('reel', 1000), post('reel', 3000), post('reel', 2000), post('reel', 4000)],
      1000,
    );
    expect(r.medianReelViews).toBe(2500);
    expect(r.reelViewMultiple).toBe(2.5);
    expect(r.unavailableReason).toBeNull();
    expect(r.viewSource).toBe('views');
  });

  it('피드(영상·이미지) 조회수는 무시한다', () => {
    const r = computeReachMetrics(
      [post('reel', 1000), post('reel', 1000), post('reel', 1000), post('video', 900_000), post('image', 900_000)],
      1000,
    );
    expect(r.reelCount).toBe(3);
    expect(r.reelViewMultiple).toBe(1);
  });

  it('views/plays 가 섞이면 mixed · 하나뿐이면 그 원천', () => {
    const mixed = computeReachMetrics(
      [post('reel', 100, 'views'), post('reel', 200, 'plays'), post('reel', 300, 'views')],
      100,
    );
    expect(mixed.viewSource).toBe('mixed');
    const plays = computeReachMetrics([post('reel', 100, 'plays'), post('reel', 200, 'plays'), post('reel', 300, 'plays')], 100);
    expect(plays.viewSource).toBe('plays');
  });

  it('computeSellerMetrics 가 dedup 후 게시물로 reach 를 채운다', () => {
    const m = computeSellerMetrics({
      seller_id: 'synthetic',
      profile: { follower_count: 2000 },
      raw_posts: [post('reel', 2000), post('reel', 4000), post('reel', 6000)],
      images: [],
    });
    expect(m.reach).toMatchObject({ reelViewMultiple: 2, reelViewSample: 3, unavailableReason: null });
  });
});

describe('normalizeMetrics — reach', () => {
  it('reach 가 없는 과거 분석본 → 값 null + LEGACY (0 으로 채우지 않는다)', () => {
    const m = normalizeMetrics({ engagement: { er: 0.02 } });
    expect(m.reach).toEqual({
      reelViewMultiple: null,
      medianReelViews: null,
      reelViewSample: 0,
      reelsWithoutViews: 0,
      reelCount: 0,
      viewSource: null,
      unavailableReason: 'LEGACY',
    });
  });

  it('저장된 reach 는 왕복 후 그대로 · 손상값은 걸러진다', () => {
    const stored = computeReachMetrics([post('reel', 100), post('reel', 200), post('reel', 300)], 100);
    expect(normalizeMetrics({ reach: JSON.parse(JSON.stringify(stored)) }).reach).toEqual(stored);
    const broken = normalizeReach({ reelViewMultiple: -1, viewSource: 'other', unavailableReason: 'WHAT' });
    expect(broken.reelViewMultiple).toBeNull();
    expect(broken.viewSource).toBeNull();
    expect(broken.unavailableReason).toBe('LEGACY');
  });
});

describe('조회수 원천 기록 — 기존 폴백 순서 유지', () => {
  it('Apify: videoViewCount → engagement.video_view_count → videoPlayCount', () => {
    expect(pickApifyVideoView({ videoViewCount: 10, videoPlayCount: 99 })).toEqual({ count: 10, source: 'views' });
    expect(pickApifyVideoView({ engagement: { video_view_count: 11 }, videoPlayCount: 99 })).toEqual({
      count: 11,
      source: 'views',
    });
    expect(pickApifyVideoView({ videoPlayCount: 12 })).toEqual({ count: 12, source: 'plays' });
    expect(pickApifyVideoView({})).toEqual({ count: null, source: null });
  });

  it('RapidAPI: play_count → view_count', () => {
    expect(pickRapidApiVideoView({ play_count: 5, view_count: 9 })).toEqual({ count: 5, source: 'plays' });
    expect(pickRapidApiVideoView({ view_count: 9 })).toEqual({ count: 9, source: 'views' });
    expect(pickRapidApiVideoView({ play_count: 'x' })).toEqual({ count: null, source: null });
  });
});

describe('표시 문구', () => {
  it('리포트 카드 사유 한 줄 — 대시 없이 사유를 말한다', () => {
    const noViews = computeReachMetrics([post('reel', null), post('reel', null)], 1000);
    expect(reachUnavailableLine(noViews)).toBe('조회수 미수집 (릴스 2개)');
    expect(reachUnavailableLine(computeReachMetrics([post('image', null)], 1000))).toBe('릴스 없음');
    expect(reachUnavailableLine(computeReachMetrics([post('reel', 1), post('reel', 2)], 1000))).toBe(
      '릴스 2개 · 3개부터 계산',
    );
    expect(reachUnavailableLine(normalizeReach(undefined))).toBe('재분석하면 표시');
    expect(reachUnavailableLine(computeReachMetrics([post('reel', 1), post('reel', 2), post('reel', 3)], 1))).toBeNull();
  });

  it('배수 숫자와 비교표 사유 낱말', () => {
    expect(formatReelViewMultiple(2.345)).toBe('2.3');
    expect(formatReelViewMultiple(0.042)).toBe('0.04');
    expect(formatReelViewMultiple(12.6)).toBe('13');
    expect(reachReasonWord(normalizeReach(undefined))).toBe('미수집');
    expect(reachReasonWord(computeReachMetrics([post('image', null)], 1))).toBe('릴스 없음');
  });
});
