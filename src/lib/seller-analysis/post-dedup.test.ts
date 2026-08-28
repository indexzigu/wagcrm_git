// 재업로드 사본 접기 계약 테스트 — 접힘 3조건(캡션 지문·media_type·시간 근접)과
// 보수 원칙(지문/시각 없으면 접지 않음), 지표·댓글타깃 배선까지 고정한다.
import { describe, expect, it } from 'vitest';

import { collapseRepostDuplicates, normalizeCaptionKey, REPOST_WINDOW_HOURS } from './post-dedup';
import { computeSellerMetrics } from './metrics';
import { pickCommentTargets } from './apifyComments';
import type { LosslessSellerData, RawPost } from './types';

const T0 = new Date('2026-07-20T09:00:00.000Z').getTime();
const hoursAfterT0 = (h: number) => new Date(T0 + h * 60 * 60 * 1000).toISOString();

function post(overrides: Partial<RawPost> = {}): RawPost {
  return {
    caption: '',
    likes: 0,
    comments_count: 0,
    sample_comments: [],
    taken_at: null,
    media_type: 'reel',
    video_view_count: null,
    is_sponsored: false,
    shortcode: null,
    ...overrides,
  };
}

describe('normalizeCaptionKey', () => {
  it('NFC/NFD·zero-width·공백·대소문자 차이를 흡수한다', () => {
    const nfc = '임신 준비 영양제 세팅법 Best';
    const nfd = ('\u200B' + '임신  준비\n영양제 세팅법 BEST' + '\uFEFF').normalize('NFD');
    expect(normalizeCaptionKey(nfd)).toBe(normalizeCaptionKey(nfc));
  });

  it('빈 입력은 빈 지문("")을 반환한다', () => {
    expect(normalizeCaptionKey(null)).toBe('');
    expect(normalizeCaptionKey('  \u200B ')).toBe('');
  });
});

describe('collapseRepostDuplicates', () => {
  const CAPTION = '임신 준비 영양제 남녀 완벽 세팅법';

  it('근접 재업로드 쌍은 참여(좋아요+댓글) 최고 변형만 남긴다', () => {
    const high = post({ caption: CAPTION, likes: 104, comments_count: 38, taken_at: hoursAfterT0(0) });
    const low = post({ caption: CAPTION, likes: 3, comments_count: 0, taken_at: hoursAfterT0(2) });
    expect(collapseRepostDuplicates([high, low])).toEqual([high]);
    expect(collapseRepostDuplicates([low, high])).toEqual([high]);
  });

  it('참여 동점이면 이른 게시물(원본)을 대표로 유지한다', () => {
    const first = post({ caption: CAPTION, likes: 10, taken_at: hoursAfterT0(0), shortcode: 'FIRST' });
    const second = post({ caption: CAPTION, likes: 10, taken_at: hoursAfterT0(1), shortcode: 'SECOND' });
    expect(collapseRepostDuplicates([second, first])).toEqual([first]);
  });

  it('시간창(72h) 밖의 같은 캡션은 시리즈로 보고 접지 않는다', () => {
    const a = post({ caption: CAPTION, likes: 100, taken_at: hoursAfterT0(0) });
    const b = post({ caption: CAPTION, likes: 5, taken_at: hoursAfterT0(REPOST_WINDOW_HOURS + 1) });
    expect(collapseRepostDuplicates([a, b])).toEqual([a, b]);
  });

  it('연쇄 재업로드(0h→48h→96h)는 인접 간격이 창 이내라 한 클러스터로 접힌다', () => {
    const a = post({ caption: CAPTION, likes: 100, taken_at: hoursAfterT0(0) });
    const b = post({ caption: CAPTION, likes: 2, taken_at: hoursAfterT0(48) });
    const c = post({ caption: CAPTION, likes: 1, taken_at: hoursAfterT0(96) });
    expect(collapseRepostDuplicates([a, b, c])).toEqual([a]);
  });

  it('빈 캡션은 지문이 없어 근접해도 접지 않는다 (보수 원칙)', () => {
    const a = post({ caption: '', likes: 100, taken_at: hoursAfterT0(0) });
    const b = post({ caption: '', likes: 5, taken_at: hoursAfterT0(1) });
    expect(collapseRepostDuplicates([a, b])).toEqual([a, b]);
  });

  it('taken_at 없는 게시물은 근접 검증이 불가해 접지 않는다', () => {
    const a = post({ caption: CAPTION, likes: 100, taken_at: hoursAfterT0(0) });
    const b = post({ caption: CAPTION, likes: 5, taken_at: null });
    expect(collapseRepostDuplicates([a, b])).toEqual([a, b]);
  });

  it('media_type이 다르면 교차 게시(이미지+릴스)로 보고 접지 않는다', () => {
    const reel = post({ caption: CAPTION, media_type: 'reel', likes: 100, taken_at: hoursAfterT0(0) });
    const image = post({ caption: CAPTION, media_type: 'image', likes: 5, taken_at: hoursAfterT0(1) });
    expect(collapseRepostDuplicates([reel, image])).toEqual([reel, image]);
  });

  it('대표들은 입력 순서를 보존하고 입력 배열은 변경하지 않는다', () => {
    const p1 = post({ caption: '첫 글', likes: 1, taken_at: hoursAfterT0(0) });
    const dupHigh = post({ caption: CAPTION, likes: 50, taken_at: hoursAfterT0(1) });
    const p2 = post({ caption: '둘째 글', likes: 2, taken_at: hoursAfterT0(2) });
    const dupLow = post({ caption: CAPTION, likes: 3, taken_at: hoursAfterT0(3) });
    const input = [p1, dupHigh, p2, dupLow];
    const snapshot = [...input];
    expect(collapseRepostDuplicates(input)).toEqual([p1, dupHigh, p2]);
    expect(input).toEqual(snapshot);
  });
});

describe('지표·댓글타깃 배선 (재업로드 이중계상 방지)', () => {
  const GONGU_CAPTION = '코큐텐 공구 오픈합니다';

  function lossless(raw_posts: RawPost[]): LosslessSellerData {
    return {
      seller_id: 'tester',
      profile: { follower_count: 10_000 },
      raw_posts,
      images: [],
    };
  }

  it('computeSellerMetrics: 사본은 공구건수·평균·게시건수에서 1건으로 접히고 접힌 수를 남긴다', () => {
    const original = post({ caption: GONGU_CAPTION, likes: 100, comments_count: 20, taken_at: hoursAfterT0(0) });
    const repost = post({ caption: GONGU_CAPTION, likes: 2, comments_count: 0, taken_at: hoursAfterT0(3) });
    const daily = post({ caption: '오늘 하늘 예쁘다', likes: 50, comments_count: 10, taken_at: hoursAfterT0(24) });
    const now = new Date(T0 + 48 * 60 * 60 * 1000);

    const metrics = computeSellerMetrics(lossless([original, repost, daily]), now);

    expect(metrics.dataSufficiency.postCount).toBe(2);
    expect(metrics.dataSufficiency.repostCollapsedCount).toBe(1);
    expect(metrics.gongu.gonguCount).toBe(1);
    expect(metrics.cadence.postsLast30d).toBe(2);
    // 무반응 사본(likes 2)이 평균에서 빠져야 한다: (100+50)/2
    expect(metrics.engagement.avgLikes).toBe(75);
  });

  it('pickCommentTargets: 사본은 유료 댓글 수집 슬롯을 잠식하지 않는다', () => {
    const original = post({ caption: GONGU_CAPTION, likes: 100, taken_at: hoursAfterT0(0), shortcode: 'AAA' });
    const repost = post({ caption: GONGU_CAPTION, likes: 2, taken_at: hoursAfterT0(3), shortcode: 'BBB' });
    const otherGongu = post({ caption: '마감 임박 주문서 링크', likes: 10, taken_at: hoursAfterT0(24), shortcode: 'CCC' });

    const targets = pickCommentTargets([original, repost, otherGongu], 2);
    expect(targets.map((t) => t.shortcode)).toEqual(['AAA', 'CCC']);
  });
});
