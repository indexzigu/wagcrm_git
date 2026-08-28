// 공구 방어력 포맷 분해(릴스 vs 피드) 계약 — 타사 분석 대조 검토(2026-08-08, 오너 승인 1층)에서
// 나온 축이다: "릴스에서 공구가 터지는 셀러"를 가르려면 공구 ER 유지율을 포맷 안에서 비교해야
// 한다(전체 통합 유지율은 포맷 간 기저 반응 차이에 희석된다).
//
// 계약 3줄:
// - 분해는 reel / feed(비릴스 전부) 이진이다 — media_type별 세분화는 셀러당 포맷별 공구
//   표본이 대체로 얇아 노이즈만 늘린다.
// - 유지율 비교는 **같은 포맷 안에서만** 한다(릴스 공구 vs 릴스 일반). 비교 대상이 없으면
//   null = 판정 불가이지 0이 아니다(미입력을 낙제로 만들던 결함의 같은 부류).
// - composite 산식·가중치는 불변이다 — 이 분해는 표시(reasons) 재료이지 점수 축이 아니다
//   (점수 반영은 백테스트 후 별도 오너 결정).

import { describe, it, expect } from 'vitest';
import { computeSellerMetrics } from '../metrics';
import { computeSubScores, normalizeMetrics } from '../scores';
import type { LosslessSellerData, RawPost, MediaType } from '../types';

const FOLLOWERS = 10_000;

function post(
  caption: string,
  likes: number,
  comments: number,
  mediaType: MediaType,
  idx: number,
): RawPost {
  return {
    caption,
    likes,
    comments_count: comments,
    sample_comments: [],
    // 재업로드 접기(post-dedup)에 걸리지 않게 게시 간격을 하루씩 벌린다
    taken_at: new Date(Date.UTC(2026, 0, 1 + idx)).toISOString(),
    media_type: mediaType,
    video_view_count: null,
    is_sponsored: false,
    shortcode: `code${idx}`,
  };
}

function data(posts: RawPost[]): LosslessSellerData {
  return {
    seller_id: 'test_seller',
    profile: { follower_count: FOLLOWERS },
    raw_posts: posts,
    images: [],
  };
}

const GONGU = '오늘 마켓 오픈합니다 최저가 링크는 댓글에';
const DAILY = '일상 사진이에요';

describe('gonguFormatSplit — 포맷 안에서의 공구 ER 유지율', () => {
  it('릴스/피드 각각에서 공구·일반 ER과 유지율을 계산한다', () => {
    const m = computeSellerMetrics(
      data([
        post(GONGU, 200, 0, 'reel', 0), // 릴스 공구 ER 2%
        post(DAILY, 100, 0, 'reel', 1), // 릴스 일반 ER 1%
        post(GONGU, 50, 0, 'image', 2), // 피드 공구 ER 0.5%
        post(DAILY, 100, 0, 'image', 3), // 피드 일반 ER 1%
      ]),
    );
    expect(m.gongu.formatSplit.reel.gonguCount).toBe(1);
    expect(m.gongu.formatSplit.reel.nonGonguCount).toBe(1);
    expect(m.gongu.formatSplit.reel.gonguEr).toBeCloseTo(0.02, 6);
    expect(m.gongu.formatSplit.reel.nonGonguEr).toBeCloseTo(0.01, 6);
    expect(m.gongu.formatSplit.reel.retention).toBeCloseTo(2.0, 6);
    expect(m.gongu.formatSplit.feed.gonguEr).toBeCloseTo(0.005, 6);
    expect(m.gongu.formatSplit.feed.retention).toBeCloseTo(0.5, 6);
  });

  it('feed 는 비릴스 전부다 — image·carousel·video 가 함께 접힌다', () => {
    const m = computeSellerMetrics(
      data([
        post(GONGU, 100, 0, 'image', 0),
        post(GONGU, 200, 0, 'carousel', 1),
        post(DAILY, 100, 0, 'video', 2),
      ]),
    );
    expect(m.gongu.formatSplit.feed.gonguCount).toBe(2);
    expect(m.gongu.formatSplit.feed.nonGonguCount).toBe(1);
    // 공구 평균 (100+200)/2 = 150 → ER 1.5%
    expect(m.gongu.formatSplit.feed.gonguEr).toBeCloseTo(0.015, 6);
    expect(m.gongu.formatSplit.reel.gonguCount).toBe(0);
    expect(m.gongu.formatSplit.reel.gonguEr).toBeNull();
  });

  it('같은 포맷에 비교 대상이 없으면 유지율은 null (0 이 아니다)', () => {
    const m = computeSellerMetrics(
      data([
        post(GONGU, 200, 0, 'reel', 0), // 릴스엔 공구뿐
        post(DAILY, 100, 0, 'image', 1), // 일반은 피드에만
      ]),
    );
    expect(m.gongu.formatSplit.reel.gonguEr).toBeCloseTo(0.02, 6);
    expect(m.gongu.formatSplit.reel.nonGonguEr).toBeNull();
    expect(m.gongu.formatSplit.reel.retention).toBeNull();
    expect(m.gongu.formatSplit.feed.retention).toBeNull();
  });

  it('normalizeMetrics — 이 필드가 없는 과거 분석본은 전부 null/0 으로 떨어진다', () => {
    const m = normalizeMetrics({ gongu: { gonguCount: 3, gonguShare: 0.1 } });
    expect(m.gongu.formatSplit.reel.gonguCount).toBe(0);
    expect(m.gongu.formatSplit.reel.gonguEr).toBeNull();
    expect(m.gongu.formatSplit.reel.retention).toBeNull();
    expect(m.gongu.formatSplit.feed.retention).toBeNull();
  });

  it('normalizeMetrics — 손상값(음수·비수치)은 걸러진다', () => {
    const m = normalizeMetrics({
      gongu: {
        formatSplit: {
          reel: { gonguCount: -3, gonguEr: 'x', nonGonguEr: -0.1, retention: 1.2, nonGonguCount: 2 },
        },
      },
    });
    expect(m.gongu.formatSplit.reel.gonguCount).toBe(0);
    expect(m.gongu.formatSplit.reel.gonguEr).toBeNull();
    expect(m.gongu.formatSplit.reel.nonGonguEr).toBeNull();
    expect(m.gongu.formatSplit.reel.retention).toBeCloseTo(1.2, 6);
    expect(m.gongu.formatSplit.reel.nonGonguCount).toBe(2);
  });
});

describe('computeGonguConsistency reasons — 포맷별 유지율 병기', () => {
  it('유지율이 산출되는 포맷은 reasons 에 병기된다', () => {
    const m = computeSellerMetrics(
      data([
        post(GONGU, 200, 0, 'reel', 0),
        post(DAILY, 100, 0, 'reel', 1),
        post(GONGU, 50, 0, 'image', 2),
        post(DAILY, 100, 0, 'image', 3),
      ]),
    );
    const s = computeSubScores(m);
    const joined = s.gonguConsistency.reasons.join(' | ');
    expect(joined).toContain('릴스 공구 ER 유지율 200%');
    expect(joined).toContain('피드 공구 ER 유지율 50%');
  });

  it('유지율이 null 인 포맷은 reasons 에 나타나지 않는다', () => {
    const m = computeSellerMetrics(
      data([
        post(GONGU, 200, 0, 'reel', 0), // 릴스: 비교 불가
        post(GONGU, 50, 0, 'image', 1),
        post(DAILY, 100, 0, 'image', 2),
      ]),
    );
    const s = computeSubScores(m);
    const joined = s.gonguConsistency.reasons.join(' | ');
    expect(joined).not.toContain('릴스 공구 ER 유지율');
    expect(joined).toContain('피드 공구 ER 유지율');
  });

  it('점수 산식은 불변이다 — 포맷 분해값을 지워도 score 가 같다', () => {
    const m = computeSellerMetrics(
      data([
        post(GONGU, 200, 0, 'reel', 0),
        post(DAILY, 100, 0, 'reel', 1),
        post(GONGU, 50, 0, 'image', 2),
        post(DAILY, 100, 0, 'image', 3),
      ]),
    );
    const withSplit = computeSubScores(m);
    const withoutSplit = computeSubScores({ ...m, gongu: { ...m.gongu, formatSplit: undefined } });
    expect(withSplit.gonguConsistency.score).toBe(withoutSplit.gonguConsistency.score);
    expect(withSplit.composite).toBe(withoutSplit.composite);
  });
});
