// [셀러분석] 비슷한 셀러 — 「이 셀러랑 비슷한 사람 또 누가 있지?」 (순수 함수, Prisma 무의존, throw 금지).
//
// similarity = 0.4·카테고리 + 0.4·태그 + 0.2·규모. 축을 못 읽으면 그 축은 null 이고 남은 가중치로
// 재정규화한다(0/0 NaN 금지 — 전 축 null 이면 후보에서 뺀다).
//   - 카테고리(서열형): 주 카테고리 같음 1 · 상대의 주 카테고리가 내 프로필에서 ≥65(또는 그 역) 0.5 · 그 외 0.
//     categoryProfile 은 주 카테고리 100 고정 · 비주 0/40/65/85 계단이라 코사인으로 재면 사실상 0/1 이 된다.
//   - 태그(겹침 수): tags ∪ sub_categories 정규화 집합의 교집합 k → min(1, k/3).
//   - 규모: 1 − min(1, |log10 fa − log10 fb|).
// 임계값 0.45 는 초기값(ponytail) — 「주 카테고리만 같고 태그 0·팔로워 100배 차」(0.40)가 걸러지는 선.
// 실분포가 쌓이면 재조정한다. 설계 정본: docs/private/specs/2026-11-08-seller-reach-similar-compare.md §2.
//
// ⛔ 셀러 포털·공유 카드에 쓰지 말 것 — 다른 셀러 정보다(P0 Seller-Facing).

import { computeCategoryProfile } from './categoryProfile';
import { normalizeKeyword, strArray } from './matcher';
import { computeRiskFlags, type ProfileMeta } from './riskFlags';
import { formatFollowerCount } from '../partner-seller-display';

export const SIMILARITY_WEIGHTS = { category: 0.4, tags: 0.4, scale: 0.2 } as const;
export const SIMILARITY_THRESHOLD = 0.45;
export const SIMILAR_SELLERS_MAX = 6;
/** 분석 셀러가 이보다 적으면 결과 대신 「비교할 수 없습니다」 — 몇 명 중 고르는 건 추천이 아니다 */
export const SIMILAR_POOL_MIN = 8;
/** 규모 축이 이 이상일 때만 팔로워 근거를 reasons 에 적는다 */
const SCALE_REASON_MIN = 0.7;
/** 카테고리 인접 판정 — 상대의 주 카테고리가 내 프로필에서 이 점수 이상이면 0.5 */
const ADJACENT_CATEGORY_MIN = 65;
const TAG_SATURATION = 3;

export interface SimilarityProfile {
  id: string;
  /** aiTags 의 category·tags·sub_categories 경로. 구형 레코드는 태그 문자열 배열 그 자체 */
  aiTags: unknown;
  /** 팔로워 수 — 모르면 null(규모 축 null) */
  followers: number | null;
  /** 브랜드·샵 계정 판정 재료 — metrics(engagement·cadence 만 있어도 된다) */
  metrics: unknown;
  profileMeta: unknown;
}

export interface SimilarityAxes {
  category: number | null;
  tags: number | null;
  scale: number | null;
}

export interface SimilarSellerMatch {
  id: string;
  score: number;
  axes: SimilarityAxes;
  /** 상대의 주 카테고리(표시용) */
  primaryCategory: string | null;
  /** 겹치는 태그(정규화된 낱말, 최대 3개) */
  sharedTags: string[];
  /** 숫자를 담은 근거 문장 */
  reasons: string[];
}

export type SimilarSellersVerdict =
  | { status: 'TARGET_UNANALYZED'; poolSize: number }
  | { status: 'POOL_TOO_SMALL'; poolSize: number }
  | { status: 'OK'; poolSize: number; matches: SimilarSellerMatch[] };

interface Prepared {
  profile: SimilarityProfile;
  primary: string | null;
  /** 카테고리 → 프로필 점수 */
  affinity: Map<string, number>;
  terms: Set<string>;
  followers: number | null;
}

function prepare(profile: SimilarityProfile): Prepared {
  const affinities = computeCategoryProfile(profile.aiTags);
  const primary = affinities.find((a) => a.isPrimary)?.category ?? null;
  const record =
    profile.aiTags && typeof profile.aiTags === 'object' && !Array.isArray(profile.aiTags)
      ? (profile.aiTags as Record<string, unknown>)
      : null;
  // normalizeAiTags(matcher) 는 tags 만 돌려준다 — sub_categories 결합은 이 모듈 책임이다.
  const rawTerms = Array.isArray(profile.aiTags)
    ? strArray(profile.aiTags)
    : [...strArray(record?.tags), ...strArray(record?.sub_categories)];
  const followers =
    typeof profile.followers === 'number' && Number.isFinite(profile.followers) && profile.followers > 0
      ? profile.followers
      : null;
  return {
    profile,
    primary,
    affinity: new Map(affinities.map((a) => [a.category, a.score])),
    terms: new Set(rawTerms.map(normalizeKeyword).filter(Boolean)),
    followers,
  };
}

function categoryAxis(a: Prepared, b: Prepared): number | null {
  if (a.primary === null || b.primary === null) return null;
  if (a.primary === b.primary) return 1;
  const adjacent =
    (a.affinity.get(b.primary) ?? 0) >= ADJACENT_CATEGORY_MIN ||
    (b.affinity.get(a.primary) ?? 0) >= ADJACENT_CATEGORY_MIN;
  return adjacent ? 0.5 : 0;
}

function scaleAxis(a: Prepared, b: Prepared): number | null {
  if (a.followers === null || b.followers === null) return null;
  const gap = Math.abs(Math.log10(a.followers) - Math.log10(b.followers));
  return Number.isFinite(gap) ? 1 - Math.min(1, gap) : null;
}

/** 가용 축 가중평균. 전 축 null 이면 null(점수를 지어내지 않는다). */
export function combineSimilarity(axes: SimilarityAxes): number | null {
  let weighted = 0;
  let weightSum = 0;
  for (const key of ['category', 'tags', 'scale'] as const) {
    const v = axes[key];
    if (v === null || !Number.isFinite(v)) continue;
    weighted += SIMILARITY_WEIGHTS[key] * v;
    weightSum += SIMILARITY_WEIGHTS[key];
  }
  if (weightSum === 0) return null;
  const score = weighted / weightSum;
  return Number.isFinite(score) ? score : null;
}

/** 두 셀러의 유사도 — 축·점수·근거. 같은 셀러끼리도 계산은 하지만 호출부(findSimilarSellers)가 뺀다. */
export function scoreSimilarity(target: SimilarityProfile, candidate: SimilarityProfile): SimilarSellerMatch | null {
  return scorePrepared(prepare(target), prepare(candidate));
}

function scorePrepared(a: Prepared, b: Prepared): SimilarSellerMatch | null {
  const shared = [...a.terms].filter((t) => b.terms.has(t));
  const axes: SimilarityAxes = {
    category: categoryAxis(a, b),
    tags: Math.min(1, shared.length / TAG_SATURATION),
    scale: scaleAxis(a, b),
  };
  const score = combineSimilarity(axes);
  if (score === null) return null;

  const reasons: string[] = [];
  if (axes.category === 1 && b.primary) reasons.push(`주 카테고리 같음(${b.primary})`);
  else if (axes.category === 0.5 && a.primary && b.primary) reasons.push(`카테고리 인접(${a.primary} · ${b.primary})`);
  const sharedTags = shared.slice(0, 3);
  if (shared.length > 0) reasons.push(`겹치는 태그 ${shared.length}개: ${sharedTags.join('·')}`);
  if (axes.scale !== null && axes.scale >= SCALE_REASON_MIN && a.followers !== null && b.followers !== null) {
    reasons.push(`팔로워 ${formatFollowerCount(a.followers)} / ${formatFollowerCount(b.followers)}`);
  }

  return { id: b.profile.id, score, axes, primaryCategory: b.primary, sharedTags, reasons };
}

function isBrandAccount(profile: SimilarityProfile, now: Date): boolean {
  const meta =
    profile.profileMeta && typeof profile.profileMeta === 'object'
      ? (profile.profileMeta as Partial<ProfileMeta>)
      : null;
  return computeRiskFlags(profile.metrics, meta, [], now).some((f) => f.key === 'brand-account');
}

/**
 * 후보 풀(분석된 셀러 전원, 대상 포함)에서 대상과 비슷한 셀러를 고른다.
 * 제외: 자기 자신 · 브랜드·샵 계정 추정(computeRiskFlags) · 임계값 미만. 점수 내림차순 최대 6명.
 */
export function findSimilarSellers(
  targetId: string,
  pool: readonly SimilarityProfile[],
  now: Date = new Date(),
): SimilarSellersVerdict {
  const poolSize = pool.length;
  const target = pool.find((p) => p.id === targetId);
  if (!target) return { status: 'TARGET_UNANALYZED', poolSize };
  if (poolSize < SIMILAR_POOL_MIN) return { status: 'POOL_TOO_SMALL', poolSize };

  const preparedTarget = prepare(target);
  const matches: SimilarSellerMatch[] = [];
  for (const candidate of pool) {
    if (candidate.id === targetId) continue;
    if (isBrandAccount(candidate, now)) continue;
    const match = scorePrepared(preparedTarget, prepare(candidate));
    if (match && match.score >= SIMILARITY_THRESHOLD) matches.push(match);
  }
  matches.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
  return { status: 'OK', poolSize, matches: matches.slice(0, SIMILAR_SELLERS_MAX) };
}
