// 리스크 플래그 (이식 스펙 §9) — 공개 데이터로 계산 가능한 능동 경고 6종. 순수 함수, throw 금지.
// 원칙: 판단 근거가 없으면 플래그를 만들지 않는다(오탐이 침묵보다 나쁨). 모든 플래그에 실제 수치 근거 필수.
// 임계값은 전부 경험적(ponytail) — 자사 풀 분포·백테스트(Phase C-11)로 교체 예정.

import { normalizeMetrics, erBenchmark, estimateActiveFollowers } from './scores';
import type { PostPreview } from './types';

export interface RiskFlag {
  key:
    | 'phantom-followers'
    | 'brand-account'
    | 'gongu-gap'
    | 'posting-drop'
    | 'gongu-engagement-slump'
    | 'like-comment-mismatch';
  label: string;
  severity: 'danger' | 'warn';
  reason: string;
}

/** analyze 라우트가 aiTags.profileMeta로 저장하는 프로필 스냅샷 */
export interface ProfileMeta {
  followerCount: number | null;
  followingCount: number | null;
  /** 계정 전체 게시물 수 (스크래핑 표본 아님) */
  postsCountTotal: number | null;
  bio: string | null;
}

const BRAND_BIO_KEYWORDS = ['기획전', '공식몰', '공식 스토어', '스토어', '쇼핑몰', '고객센터', 'CS', '배송문의', '입점', 'brand', 'official'];

function daysBetween(aIso: string, bMs: number): number {
  return (bMs - new Date(aIso).getTime()) / 86_400_000;
}

export function computeRiskFlags(
  metricsInput: unknown,
  profileMeta?: Partial<ProfileMeta> | null,
  postsPreview?: PostPreview[] | null,
  now: Date = new Date()
): RiskFlag[] {
  const m = normalizeMetrics(metricsInput);
  const flags: RiskFlag[] = [];
  const followers =
    typeof profileMeta?.followerCount === 'number' && isFinite(profileMeta.followerCount) && profileMeta.followerCount > 0
      ? profileMeta.followerCount
      : null;
  const following =
    typeof profileMeta?.followingCount === 'number' && isFinite(profileMeta.followingCount) && profileMeta.followingCount >= 0
      ? profileMeta.followingCount
      : null;
  const posts = Array.isArray(postsPreview) ? postsPreview.filter((p) => p && typeof p === 'object') : [];
  const nowMs = now.getTime();

  // 1) 허수 팔로워 의심 — 반응이 팔로워 규모 대비 불균형하게 낮음 (레퍼런스도 동일 경고 제공, 스펙 §4 ordinairement 케이스)
  const er = m.engagement.er;
  if (followers !== null && followers >= 50_000 && er !== null) {
    const bench = erBenchmark(followers);
    if (er < bench * 0.3) {
      // 경고와 함께 "그래서 실질 몇 명짜리 계정인가"를 병기 — 해석을 운영자 암산에 맡기지 않는다(오너 2026-07-16)
      const est = estimateActiveFollowers(followers, er);
      flags.push({
        key: 'phantom-followers',
        label: '허수 팔로워 의심',
        severity: 'danger',
        reason: `팔로워 ${followers.toLocaleString()}명 대비 ER ${(er * 100).toFixed(2)}% (구간 기준 ${(bench * 100).toFixed(1)}%의 30% 미만)${est !== null ? ` · 실질 반응 팔로워 ~${est.toLocaleString()}명 추정` : ''}`,
      });
    }
  }

  // 2) 브랜드·샵 계정 추정 — following≈0(필수) + 브랜드 신호 1개 이상 (스펙 §9: 버리지 말고 재분류)
  if (following !== null && following <= 5 && followers !== null && followers >= 10_000) {
    const bio = profileMeta?.bio ?? '';
    const bioHit = BRAND_BIO_KEYWORDS.find((k) => bio.toLowerCase().includes(k.toLowerCase()));
    const interval = m.cadence.medianIntervalDays;
    const rapidCadence = interval !== null && interval < 0.6;
    const massivePosts =
      typeof profileMeta?.postsCountTotal === 'number' && profileMeta.postsCountTotal > 3000;
    const signals: string[] = [`팔로잉 ${following}명`];
    if (bioHit) signals.push(`소개글 '${bioHit}'`);
    if (rapidCadence) signals.push(`게시 간격 ${interval!.toFixed(1)}일`);
    if (massivePosts) signals.push(`총 게시물 ${profileMeta!.postsCountTotal!.toLocaleString()}개`);
    if (signals.length >= 2) {
      flags.push({
        key: 'brand-account',
        label: '브랜드·샵 계정 추정',
        severity: 'warn',
        reason: `${signals.join(' · ')}: 공구 제안 대상이 아닌 상품 공급측일 수 있음`,
      });
    }
  }

  // 3) 공구 공백 — 표본 내 공구가 없거나 마지막 공구가 90일 이전 (표본이 유의미할 때만)
  if (m.dataSufficiency.postCount >= 10 && m.dataSufficiency.hasTimestamps) {
    const gonguDates = posts
      .filter((p) => p.is_gongu && p.taken_at)
      .map((p) => new Date(p.taken_at as string).getTime())
      .filter((t) => isFinite(t));
    if (m.gongu.gonguCount === 0) {
      flags.push({
        key: 'gongu-gap',
        label: '공구 이력 없음',
        severity: 'warn',
        reason: `분석 ${m.dataSufficiency.postCount}개 게시물 내 공구 게시물 0건`,
      });
    } else if (gonguDates.length > 0) {
      const lastGonguDays = (nowMs - Math.max(...gonguDates)) / 86_400_000;
      if (lastGonguDays > 90) {
        flags.push({
          key: 'gongu-gap',
          label: '공구 공백',
          severity: 'warn',
          reason: `마지막 공구 게시물이 ${Math.round(lastGonguDays)}일 전`,
        });
      }
    }
  }

  // 4) 게시 급감 — 마지막 게시가 평소 주기의 3배 이상 & 14일 초과 (죽은 계정을 살아있는 것처럼 오판 방지, 스펙 §8 신선도)
  const interval = m.cadence.medianIntervalDays;
  const lastPostIso = posts
    .filter((p) => p.taken_at)
    .map((p) => p.taken_at as string)
    .sort()
    .pop();
  if (interval !== null && lastPostIso) {
    const silentDays = daysBetween(lastPostIso, nowMs);
    if (silentDays > Math.max(interval * 3, 14)) {
      flags.push({
        key: 'posting-drop',
        label: '게시 급감',
        severity: 'warn',
        reason: `마지막 게시 ${Math.round(silentDays)}일 전 (평소 간격 ${interval.toFixed(1)}일)`,
      });
    }
  }

  // 5) 공구 반응 침체 — 공구는 계속 발행하는데 공구글의 절대 반응이 규모 기준의 30% 미만.
  // ⚠️ 공구 빈도·비중은 벌점 대상이 아니다(오너 확정 2026-07-16): 이 CRM은 공구하는 계정을
  // 찾는 도구라, 공구를 지속·자주 하는 것은 공구활성도와 연계된 긍정 신호다. 나쁜 신호는
  // "공구는 많은데 좋아요·댓글 같은 액션이 없는 콘텐츠만 계속 발행" = 계정 활성도 저하.
  // 그래서 자기 일반글 대비 상대비교가 아니라 팔로워 규모 벤치마크 대비 절대 기준으로 판정한다.
  // (구 'gongu-fatigue'는 공구ER/일반ER<0.5 상대비교라 "공구를 많이 해서 피로"로 읽혔다 — 폐기.
  //  공구/일반 ER 비교 자체는 collaborationScore '3.홍보+활성' 판정(reviewMapping)에 계속 쓰인다.)
  const gEr = m.gongu.gonguEr;
  if (m.gongu.gonguCount >= 3 && gEr !== null && followers !== null) {
    const gonguBench = erBenchmark(followers);
    if (gEr < gonguBench * 0.3) {
      flags.push({
        key: 'gongu-engagement-slump',
        label: '공구 반응 침체',
        severity: 'warn',
        reason: `공구 ${m.gongu.gonguCount}건을 발행 중이지만 공구글 ER ${(gEr * 100).toFixed(2)}% (구간 기준 ${(gonguBench * 100).toFixed(1)}%의 30% 미만): 반응 없는 발행이 반복되는 계정 활성도 저하 신호`,
      });
    }
  }

  // 6) 좋아요-댓글 불일치 — 좋아요 규모 대비 댓글이 비정상적으로 적음 (좋아요 구매 의심 신호)
  const ratio = m.engagement.commentToLikeRatio;
  const avgLikes = m.engagement.avgLikes;
  if (ratio !== null && avgLikes !== null && avgLikes >= 500 && ratio < 0.002) {
    flags.push({
      key: 'like-comment-mismatch',
      label: '좋아요-댓글 불일치',
      severity: 'warn',
      reason: `평균 좋아요 ${Math.round(avgLikes).toLocaleString()}개 대비 댓글 비율 ${(ratio * 100).toFixed(2)}%`,
    });
  }

  return flags;
}
