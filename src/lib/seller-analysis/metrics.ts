// 결정적(deterministic) 지표 엔진 — 외부 의존성 없는 순수 함수 모듈.
// 원칙: 정량 지표는 코드가 계산하고, LLM은 해석·정성 판단만 한다 (블루프린트 §3.5).
// NaN/Infinity를 절대 반환하지 않는다. 분모가 0이거나 데이터가 없으면 null.

import { LosslessSellerData, MediaType, RawPost } from './types';
import { collapseRepostDuplicates } from './post-dedup';

// ---------- 타입 ----------

export interface EngagementMetrics {
  avgLikes: number | null;
  medianLikes: number | null;
  medianComments: number | null;
  avgComments: number | null;
  /** (평균 좋아요 + 평균 댓글) / 팔로워 수 */
  er: number | null;
  /** (중앙값 좋아요 + 중앙값 댓글) / 팔로워 — 바이럴 이상치에 강건한 ER */
  medianEr: number | null;
  /** 평균 댓글 / 평균 좋아요 */
  commentToLikeRatio: number | null;
}

export interface CadenceMetrics {
  /** 게시 간격 중앙값 (일). taken_at 없는 게시물 제외 */
  medianIntervalDays: number | null;
  postsLast30d: number | null;
  postsLast90d: number | null;
}

export interface AdMetrics {
  adCount: number;
  adShare: number | null;
  adEr: number | null;
  organicEr: number | null;
  /** adEr / organicEr — 광고 성과 유지율 */
  adPerformanceRetention: number | null;
}

/** 한 포맷 안에서의 공구 vs 일반 비교 — 비교 대상이 없으면 null(판정 불가, 0 아님) */
export interface GonguFormatEntry {
  gonguCount: number;
  nonGonguCount: number;
  gonguEr: number | null;
  nonGonguEr: number | null;
  /** gonguEr ÷ nonGonguEr — 같은 포맷 안에서의 공구 반응 유지율 */
  retention: number | null;
}

/**
 * 공구 방어력의 포맷 분해(2026-08-08, 타사 분석 대조에서 채택) — "릴스에서 공구가 터지는
 * 셀러"를 가르려면 유지율을 같은 포맷 안에서 비교해야 한다(통합 유지율은 포맷 간 기저
 * 반응 차이에 희석된다). 분해는 reel/feed(비릴스 전부) 이진 — media_type별 세분화는
 * 셀러당 포맷별 공구 표본이 대체로 얇아 노이즈만 늘린다.
 * 점수 축이 아니라 표시(reasons) 재료다 — 점수 반영은 백테스트 후 별도 오너 결정.
 */
export interface GonguFormatSplit {
  reel: GonguFormatEntry;
  feed: GonguFormatEntry;
}

export interface GonguMetrics {
  gonguCount: number;
  gonguShare: number | null;
  gonguEr: number | null;
  nonGonguEr: number | null;
  formatSplit: GonguFormatSplit;
}

/**
 * 수익성 게시물(광고 ∪ 공구) vs 일상 게시물 — 셀러 평가의 "광고 반응" 항목 근거.
 *
 * 오너 정의(2026-08-04): *"광고 또는 공구 같은 일상게시물이 아닌 **수익성 게시물일 때에도**
 * 사람들 댓글, 좋아요 반응이 좋은가"*. 즉 묻는 것은 **개수가 아니라 반응 유지율**이다.
 *
 * ⚠️ `AdMetrics.adPerformanceRetention`(광고 전용)으로 대신하지 말 것 — 협찬광고 태그가
 * 0건인데 공구는 활발한 셀러가 다수다(2026-08-04 확인). 광고 축만 보면 그 셀러들이 통째로
 * 판정 불가가 된다. 두 축을 합쳐야 오너 정의와 커버리지가 모두 맞는다.
 * 광고 축(`AdMetrics`)은 "협찬을 얼마나 받는가"라는 **다른 질문**이라 그대로 남긴다.
 */
export interface MonetizedMetrics {
  /** 광고 ∪ 공구 게시물 수 (중복 계산 없음) */
  monetizedCount: number;
  monetizedEr: number | null;
  /** 광고도 공구도 아닌 게시물의 ER */
  dailyEr: number | null;
  /** monetizedEr ÷ dailyEr. 어느 한쪽이 0건이면 null(= 판정 불가, 0점 아님) */
  monetizedRetention: number | null;
}

export interface FormatBreakdownEntry {
  count: number;
  share: number;
  avgLikes: number | null;
}

export type ConsistencyLabel = '꾸준함' | '보통' | '들쭉날쭉';

export interface ConsistencyMetrics {
  /** 최대 좋아요 / 중앙값 좋아요 */
  viralMultiple: number | null;
  /** 좋아요 변동계수 (표준편차/평균) */
  likesCv: number | null;
  label: ConsistencyLabel | null;
}

export interface CommentQualityMetrics {
  totalSampled: number;
  /** 한글이 포함된 댓글 비율 */
  hangulRatio: number | null;
  /** 이모지/특수문자만 or 동일단어 반복 댓글 비율 */
  spamRatio: number | null;
  /** 완전 동일 댓글(중복 발생분) 비율 */
  duplicateRatio: number | null;
}

export interface BrandMention {
  handle: string;
  count: number;
}

export interface DataSufficiency {
  postCount: number;
  hasTimestamps: boolean;
  hasComments: boolean;
  hasReels: boolean;
  sourceTier: string | null;
  /** 재업로드 사본으로 판정돼 지표에서 접힌 게시물 수 (postCount는 접힌 후 기준) */
  repostCollapsedCount?: number;
}

export interface SellerMetrics {
  engagement: EngagementMetrics;
  cadence: CadenceMetrics;
  ads: AdMetrics;
  gongu: GonguMetrics;
  monetized: MonetizedMetrics;
  formatBreakdown: Partial<Record<MediaType, FormatBreakdownEntry>>;
  consistency: ConsistencyMetrics;
  commentQuality: CommentQualityMetrics;
  brandMentions: BrandMention[];
  dataSufficiency: DataSufficiency;
}

// ---------- 수치 유틸 (NaN/Infinity 방지) ----------

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stddev(values: number[]): number | null {
  const m = mean(values);
  if (m === null || values.length === 0) return null;
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** 분모 0/null 안전 나눗셈 */
function safeDiv(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  const result = numerator / denominator;
  return isFinite(result) ? result : null;
}

// ---------- 댓글 유효성 (src/app/sellers/page.tsx의 isValidComment 이관) ----------

export function isValidComment(text: string): boolean {
  if (!text) return false;
  const clean = text.trim();
  if (!clean) return false;
  // 이모티콘이나 특수기호만 있는 경우 제외
  if (/^[^a-zA-Z가-힣0-9]+$/.test(clean)) return false;
  // 동일 단어 단순 반복 제외
  const words = clean.split(/\s+/);
  if (words.length >= 3 && new Set(words).size === 1) return false;
  return true;
}

// ---------- 광고 감지 ----------

const AD_KEYWORDS_KO = ['#광고', '#협찬', '#제공', '#유료광고', '광고입니다', '협찬받'];
// 영문 해시태그는 부분일치 오탐 방지 (#adventure 등)
const AD_HASHTAG_EN = /#(?:ad|sponsored)(?![a-z0-9_])/i;

export function isAdPost(post: Pick<RawPost, 'caption' | 'is_sponsored'>): boolean {
  if (post.is_sponsored === true) return true;
  const caption = post.caption || '';
  if (AD_KEYWORDS_KO.some(k => caption.includes(k))) return true;
  return AD_HASHTAG_EN.test(caption);
}

// ---------- 공구 감지 (광고와 별개 축) ----------

// v3 (2026-07-07): 실코퍼스 100캡션(전업 공구셀러 2인 × 50캡션, Graph 무료 수집)으로
// 재구축. v1("공구/공동구매" 사전)은 재현율 ~10%였음 — 요즘 셀러는 '공구' 대신 "마켓·오픈·마감·
// 최저가·n차·댓글에 정보/링크"로 말함. v3 실측: 셀러A 3→40/50, 셀러B 10→19/50 (잔여는
// 일상글·협찬이벤트=광고축 소관). ponytail: 어휘는 코퍼스 파생 — 셀러 풀 늘면 재검증, LLM 분류 승격 경로 유지
const GONGU_STRONG_KEYWORDS = [
  '공구', '공동구매', '최저가', '구매링크', '할인링크', '주문서', '구매폼', '주문 폼',
  '구매인증', '구매 인증', '주문폭주', '주문 폭주', '선착순',
];
const GONGU_TIME =
  '(?:오늘|내일|모레|곧|이번\\s*[주쥬]|[월화수목금토일]요일|[월화수목금토일]욜|주말|밤|저녁|아침|\\d+시)';
const GONGU_STRONG_PATTERNS: RegExp[] = [
  /마켓(?:은|이|으로|에서)?\s*.{0,10}?(?:오픈|마감|돌아|시작|진행|할인)/, // '가온마켓에서 최대할인', '마켓 오픈'
  new RegExp(GONGU_TIME + '\\s*.{0,16}?(?:마감|오픈)'), // '오늘 마감', '내일은 드디어 5달만에 보바오픈'
  /오픈\s*(?:완료|예정|됩니다|했|합니다|이에요)/,
  /마감\s*(?:입니다|합니다|이에요|임박|이댜|입니댜)/,
  /\d+\s*차\s*(?:마켓|공구|진행|재진행|판매)/, // '2차 마켓', '12차 진행'
];
const GONGU_MEDIUM_KEYWORDS = [
  '마켓', '오픈', '마감', '품절', '재입고', '증정', '판매', '주문', '할인', '연장', '돌아왔', '돌아온',
  '프로필 링크', '프로필링크',
];
const GONGU_MEDIUM_PATTERNS: RegExp[] = [
  /댓글.{0,14}?(?:정보|링크|최저가)/, // '댓글에 정보 남겨주시면'
  /(?:정보|링크).{0,10}?댓글/,
  /(?:정보|링크)\s*(?:공유|남겨|보내|걸어)/,
  /\d+\s*차\b/, // 재진행 차수 단독은 중신호
];

export function isGonguPost(post: Pick<RawPost, 'caption'>): boolean {
  const caption = post.caption || '';
  if (GONGU_STRONG_KEYWORDS.some(k => caption.includes(k))) return true;
  if (GONGU_STRONG_PATTERNS.some(r => r.test(caption))) return true;
  const mediumHits =
    GONGU_MEDIUM_KEYWORDS.filter(k => caption.includes(k)).length +
    GONGU_MEDIUM_PATTERNS.filter(r => r.test(caption)).length;
  return mediumHits >= 2;
}

// ---------- 그룹 ER ----------

function groupEr(posts: RawPost[], followerCount: number): number | null {
  if (posts.length === 0 || followerCount <= 0) return null;
  const avgL = mean(posts.map(p => p.likes || 0));
  const avgC = mean(posts.map(p => p.comments_count || 0));
  if (avgL === null || avgC === null) return null;
  return safeDiv(avgL + avgC, followerCount);
}

// ---------- 메인 ----------

export function computeSellerMetrics(data: LosslessSellerData, now: Date = new Date()): SellerMetrics {
  const rawPosts: RawPost[] = data.raw_posts || [];
  // 재업로드 사본(동일 캡션·같은 media_type·근접 시각)은 콘텐츠 1건으로 접는다 — 접지 않으면
  // 활성도·공구건수는 부풀고 ER·일관성(CV)은 무반응 사본에 희석돼 전 지표가 왜곡된다.
  // 수집 원본·postsPreview는 그대로 두고 지표 계산만 접는다(post-dedup.ts 모듈 헤더 참조).
  const posts: RawPost[] = collapseRepostDuplicates(rawPosts);
  const followerCount: number = Number(data.profile?.follower_count) || 0;
  const postCount = posts.length;

  const likesArr = posts.map(p => p.likes || 0);
  const commentsArr = posts.map(p => p.comments_count || 0);

  // --- engagement ---
  const avgLikes = mean(likesArr);
  const medianLikes = median(likesArr);
  const medianComments = median(commentsArr);
  const avgComments = mean(commentsArr);
  const er =
    postCount === 0 || followerCount <= 0
      ? null
      : safeDiv((avgLikes ?? 0) + (avgComments ?? 0), followerCount);
  const medianEr =
    postCount === 0 || followerCount <= 0
      ? null
      : safeDiv((medianLikes ?? 0) + (medianComments ?? 0), followerCount);
  const engagement: EngagementMetrics = {
    avgLikes,
    medianLikes,
    medianComments,
    avgComments,
    er,
    medianEr,
    commentToLikeRatio: safeDiv(avgComments, avgLikes),
  };

  // --- cadence ---
  const timestamps = posts
    .map(p => (p.taken_at ? new Date(p.taken_at).getTime() : NaN))
    .filter(t => isFinite(t))
    .sort((a, b) => a - b);
  const hasTimestamps = timestamps.length > 0;

  let medianIntervalDays: number | null = null;
  if (timestamps.length >= 2) {
    const intervalsDays: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervalsDays.push((timestamps[i] - timestamps[i - 1]) / (1000 * 60 * 60 * 24));
    }
    medianIntervalDays = median(intervalsDays);
  }

  const nowMs = now.getTime();
  const cadence: CadenceMetrics = {
    medianIntervalDays,
    postsLast30d: hasTimestamps
      ? timestamps.filter(t => nowMs - t <= 30 * 24 * 60 * 60 * 1000 && nowMs - t >= 0).length
      : null,
    postsLast90d: hasTimestamps
      ? timestamps.filter(t => nowMs - t <= 90 * 24 * 60 * 60 * 1000 && nowMs - t >= 0).length
      : null,
  };

  // --- 광고 감지 ---
  const adPosts = posts.filter(isAdPost);
  const organicPosts = posts.filter(p => !isAdPost(p));
  const adEr = groupEr(adPosts, followerCount);
  const organicEr = groupEr(organicPosts, followerCount);
  const ads: AdMetrics = {
    adCount: adPosts.length,
    adShare: postCount > 0 ? adPosts.length / postCount : null,
    adEr,
    organicEr,
    adPerformanceRetention: safeDiv(adEr, organicEr),
  };

  // --- 공구 감지 ---
  const gonguPosts = posts.filter(isGonguPost);
  const nonGonguPosts = posts.filter(p => !isGonguPost(p));
  const gonguFormatEntry = (formatPosts: RawPost[]): GonguFormatEntry => {
    const g = formatPosts.filter(isGonguPost);
    const n = formatPosts.filter(p => !isGonguPost(p));
    const gEr = groupEr(g, followerCount);
    const nEr = groupEr(n, followerCount);
    return {
      gonguCount: g.length,
      nonGonguCount: n.length,
      gonguEr: gEr,
      nonGonguEr: nEr,
      retention: safeDiv(gEr, nEr),
    };
  };
  const gongu: GonguMetrics = {
    gonguCount: gonguPosts.length,
    gonguShare: postCount > 0 ? gonguPosts.length / postCount : null,
    gonguEr: groupEr(gonguPosts, followerCount),
    nonGonguEr: groupEr(nonGonguPosts, followerCount), // 공구/일반 ER 비교는 공구활성화 '3.홍보+활성' 판정(reviewMapping)용 — 경고 플래그가 아님(오너 2026-07-16)
    formatSplit: {
      reel: gonguFormatEntry(posts.filter(p => p.media_type === 'reel')),
      feed: gonguFormatEntry(posts.filter(p => p.media_type !== 'reel')),
    },
  };

  // --- 수익성(광고 ∪ 공구) vs 일상 --- 셀러 평가 "광고 반응" 항목의 근거(오너 정의 2026-08-04)
  // 광고 축·공구 축과 별개로 한 번 더 가르는 이유는 MonetizedMetrics doc 참조 —
  // 두 축을 따로 보면 협찬광고 0건인 공구 셀러가 판정 불가로 빠진다.
  const monetizedPosts = posts.filter(p => isAdPost(p) || isGonguPost(p));
  const dailyPosts = posts.filter(p => !isAdPost(p) && !isGonguPost(p));
  const monetizedEr = groupEr(monetizedPosts, followerCount);
  const dailyEr = groupEr(dailyPosts, followerCount);
  const monetized: MonetizedMetrics = {
    monetizedCount: monetizedPosts.length,
    monetizedEr,
    dailyEr,
    // 어느 한쪽이 0건이면 groupEr 이 null 이라 safeDiv 도 null — 비교 대상이 없으면
    // '판정 불가'이지 0점이 아니다(seller-fit 이 고친 "미입력을 낙제로" 결함의 같은 부류).
    monetizedRetention: safeDiv(monetizedEr, dailyEr),
  };

  // --- formatBreakdown ---
  const formatBreakdown: Partial<Record<MediaType, FormatBreakdownEntry>> = {};
  for (const post of posts) {
    const type: MediaType = post.media_type || 'unknown';
    if (!formatBreakdown[type]) {
      formatBreakdown[type] = { count: 0, share: 0, avgLikes: null };
    }
    formatBreakdown[type]!.count++;
  }
  for (const type of Object.keys(formatBreakdown) as MediaType[]) {
    const entry = formatBreakdown[type]!;
    entry.share = postCount > 0 ? entry.count / postCount : 0;
    entry.avgLikes = mean(posts.filter(p => (p.media_type || 'unknown') === type).map(p => p.likes || 0));
  }

  // --- consistency ---
  const maxLikes = likesArr.length > 0 ? Math.max(...likesArr) : null;
  const viralMultiple = safeDiv(maxLikes, medianLikes);
  const likesSd = stddev(likesArr);
  const likesCv = safeDiv(likesSd, avgLikes);
  // ponytail: CV 임계값(0.35/0.75)은 경험적 감각치 — 통계적 근거 없음. 자사 셀러 풀 분포가 쌓이면 분위수 기반으로 교체
  let label: ConsistencyLabel | null = null;
  if (likesCv !== null) {
    label = likesCv < 0.35 ? '꾸준함' : likesCv < 0.75 ? '보통' : '들쭉날쭉';
  }
  const consistency: ConsistencyMetrics = { viralMultiple, likesCv, label };

  // --- commentQuality (집계만 — 댓글 원문은 반환값에 포함하지 않음) ---
  const allComments: string[] = posts.flatMap(p =>
    (p.sample_comments || []).filter((c): c is string => typeof c === 'string')
  );
  const totalSampled = allComments.length;
  let hangulRatio: number | null = null;
  let spamRatio: number | null = null;
  let duplicateRatio: number | null = null;
  if (totalSampled > 0) {
    const hangulCount = allComments.filter(c => /[가-힣]/.test(c)).length;
    const spamCount = allComments.filter(c => !isValidComment(c)).length;
    const uniqueCount = new Set(allComments.map(c => c.trim())).size;
    hangulRatio = hangulCount / totalSampled;
    spamRatio = spamCount / totalSampled;
    duplicateRatio = (totalSampled - uniqueCount) / totalSampled;
  }
  const commentQuality: CommentQualityMetrics = { totalSampled, hangulRatio, spamRatio, duplicateRatio };

  // --- brandMentions (광고 판정 게시물의 @핸들 추출, 상위 5개) ---
  // 셀러 자기 계정 멘션(부계정 홍보 등)은 협업 브랜드가 아니므로 제외
  const selfHandle = String(data.seller_id || '').toLowerCase();
  const mentionCounts = new Map<string, number>();
  for (const post of adPosts) {
    const matches = (post.caption || '').matchAll(/@([A-Za-z0-9._]+)/g);
    for (const m of matches) {
      const handle = m[1].toLowerCase();
      if (handle === selfHandle) continue;
      mentionCounts.set(handle, (mentionCounts.get(handle) || 0) + 1);
    }
  }
  const brandMentions: BrandMention[] = [...mentionCounts.entries()]
    .map(([handle, count]) => ({ handle, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // --- dataSufficiency ---
  const dataSufficiency: DataSufficiency = {
    postCount,
    hasTimestamps,
    hasComments: totalSampled > 0,
    hasReels: posts.some(p => p.media_type === 'reel'),
    sourceTier: data.source_tier ?? null,
    repostCollapsedCount: rawPosts.length - posts.length,
  };

  return {
    engagement,
    cadence,
    ads,
    gongu,
    monetized,
    formatBreakdown,
    consistency,
    commentQuality,
    brandMentions,
    dataSufficiency,
  };
}
