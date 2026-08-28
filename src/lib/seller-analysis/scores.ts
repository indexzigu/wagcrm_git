// 서브점수 엔진 — metrics.ts의 결정적 지표(SellerMetrics)를 0~100 서브점수 5종 + 종합점수로 변환.
// 원칙 (블루프린트 §3 Phase B-6):
//   - 순수 함수, NaN/Infinity 절대 반환 금지
//   - 데이터 부족은 0점이 아니라 null + statusLabel (판단 불가와 낙제를 구분)
//   - reasons에 실제 수치 근거를 한국어로 기록
// metrics.ts는 수정하지 않는다 — 이 모듈은 소비자다.

import { SellerMetrics } from './metrics';

// ---------- 타입 ----------

export interface SubScore {
  /** 0~100 정수, 계산 불가면 null */
  score: number | null;
  /** null 사유 (예: '공구 이력 없음', '댓글 데이터 없음', '게시 시각 데이터 없음') */
  statusLabel: string | null;
  /** 근거 지표 문자열 (예: '최근 30일 3회 게시', 'ER 0.36% (구간 기준 0.7%의 51%)') */
  reasons: string[];
}

export interface SellerScores {
  activity: SubScore;
  engagementQuality: SubScore;
  audienceQuality: SubScore;
  gonguConsistency: SubScore;
  consistency: SubScore;
  /** 가용 서브점수의 가중평균(가중치 재정규화), 전부 null이면 null */
  composite: number | null;
  confidence: 'high' | 'medium' | 'low';
  confidenceReasons: string[];
}

/** UI·PDF에서 공용으로 쓰는 서브점수 한국어 라벨 (키 순서 = 표시 순서) */
export const SUBSCORE_LABELS: Record<
  'activity' | 'engagementQuality' | 'audienceQuality' | 'gonguConsistency' | 'consistency',
  string
> = {
  activity: '활성도',
  engagementQuality: '반응 질',
  audienceQuality: '오디언스 품질',
  gonguConsistency: '공구 지속력',
  consistency: '성과 일관성',
};

/** confidence 한국어 라벨 */
export const CONFIDENCE_LABELS: Record<SellerScores['confidence'], string> = {
  high: '신뢰도 높음',
  medium: '보통',
  low: '데이터 부족',
};

// ---------- 유틸 ----------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 비율(0~1)을 'NN.N%' 문자열로 */
function fmtPct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/** 0~100 정수로 확정 (NaN 방어 포함 — 방어선일 뿐 입력은 metrics.ts 계약상 유한) */
function toScore(v: number): number {
  if (!isFinite(v)) return 0;
  return Math.round(clamp(v, 0, 100));
}

// ---------- 입력 정규화 (JSONB 경계 방어) ----------
// 콜사이트의 ai_tags.metrics는 JSONB 왕복을 거친 any라서 상위 키 누락(구버전 레코드)·
// 비수치 값·음수 손상이 가능하다. SellerMetrics 계약을 신뢰하지 않고 입구에서 정규화한다.
// (2026-07-06 리뷰 Critical/High 대응 — 크래시 대신 "데이터 부족" 경로로 자연 수렴시킨다)

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 음수가 성립하지 않는 지표(비율·평균·ER)용 — 손상 데이터의 음수를 걸러낸다 */
function nonNegOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n !== null && n >= 0 ? n : null;
}

function countOrZero(v: unknown): number {
  const n = numOrNull(v);
  return n !== null && n >= 0 ? Math.floor(n) : 0;
}

function normalizeGonguFormatEntry(v: unknown): SellerMetrics['gongu']['formatSplit']['reel'] {
  const e = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    gonguCount: countOrZero(e.gonguCount),
    nonGonguCount: countOrZero(e.nonGonguCount),
    gonguEr: nonNegOrNull(e.gonguEr),
    nonGonguEr: nonNegOrNull(e.nonGonguEr),
    retention: nonNegOrNull(e.retention),
  };
}

export function normalizeMetrics(input: unknown): SellerMetrics {
  const m = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const e = m.engagement ?? {};
  const c = m.cadence ?? {};
  const a = m.ads ?? {};
  const g = m.gongu ?? {};
  const mo = m.monetized ?? {};
  const cs = m.consistency ?? {};
  const cq = m.commentQuality ?? {};
  const ds = m.dataSufficiency ?? {};
  return {
    engagement: {
      avgLikes: nonNegOrNull(e.avgLikes),
      medianLikes: nonNegOrNull(e.medianLikes),
      medianComments: nonNegOrNull(e.medianComments),
      avgComments: nonNegOrNull(e.avgComments),
      er: nonNegOrNull(e.er),
      medianEr: nonNegOrNull(e.medianEr),
      commentToLikeRatio: nonNegOrNull(e.commentToLikeRatio),
    },
    cadence: {
      medianIntervalDays: nonNegOrNull(c.medianIntervalDays),
      postsLast30d: nonNegOrNull(c.postsLast30d),
      postsLast90d: nonNegOrNull(c.postsLast90d),
    },
    ads: {
      adCount: countOrZero(a.adCount),
      adShare: nonNegOrNull(a.adShare),
      adEr: nonNegOrNull(a.adEr),
      organicEr: nonNegOrNull(a.organicEr),
      adPerformanceRetention: nonNegOrNull(a.adPerformanceRetention),
    },
    gongu: {
      gonguCount: countOrZero(g.gonguCount),
      gonguShare: nonNegOrNull(g.gonguShare),
      gonguEr: nonNegOrNull(g.gonguEr),
      nonGonguEr: nonNegOrNull(g.nonGonguEr),
      // 2026-08-08 신설 — 이 필드가 없는 과거 분석본은 전부 null/0 으로 떨어지고 reasons 병기가
      // 조용히 생략된다. 0 으로 채우지 말 것(미분석을 낙제로 만드는 그 결함의 같은 부류).
      formatSplit: {
        reel: normalizeGonguFormatEntry(g.formatSplit?.reel),
        feed: normalizeGonguFormatEntry(g.formatSplit?.feed),
      },
    },
    // 2026-08-04 신설 — 이 필드가 없는 **과거 분석본**은 전부 null 로 떨어지고, 소비처
    // (suggestAdResponse)는 그때 '판정 불가'를 돌려준다. 0 으로 채우지 말 것 —
    // 미분석을 낙제(0점)로 만드는 것이 정확히 이 항목이 앓던 병이다.
    monetized: {
      monetizedCount: countOrZero(mo.monetizedCount),
      monetizedEr: nonNegOrNull(mo.monetizedEr),
      dailyEr: nonNegOrNull(mo.dailyEr),
      monetizedRetention: nonNegOrNull(mo.monetizedRetention),
    },
    formatBreakdown:
      m.formatBreakdown && typeof m.formatBreakdown === 'object' ? m.formatBreakdown : {},
    consistency: {
      viralMultiple: nonNegOrNull(cs.viralMultiple),
      likesCv: nonNegOrNull(cs.likesCv),
      label: cs.label === '꾸준함' || cs.label === '보통' || cs.label === '들쭉날쭉' ? cs.label : null,
    },
    commentQuality: {
      totalSampled: countOrZero(cq.totalSampled),
      hangulRatio: nonNegOrNull(cq.hangulRatio),
      spamRatio: nonNegOrNull(cq.spamRatio),
      duplicateRatio: nonNegOrNull(cq.duplicateRatio),
    },
    brandMentions: Array.isArray(m.brandMentions) ? m.brandMentions : [],
    dataSufficiency: {
      postCount: countOrZero(ds.postCount),
      hasTimestamps: ds.hasTimestamps === true,
      hasComments: ds.hasComments === true,
      hasReels: ds.hasReels === true,
      sourceTier: typeof ds.sourceTier === 'string' ? ds.sourceTier : null,
      // 신설 필드(2026-07-23) — 재분석 전의 저장분에는 없으므로 0으로 정규화
      repostCollapsedCount: countOrZero(ds.repostCollapsedCount),
    },
  };
}

// ---------- 서브점수 계산 ----------

function computeActivity(m: SellerMetrics): SubScore {
  if (!m.dataSufficiency.hasTimestamps) {
    return { score: null, statusLabel: '게시 시각 데이터 없음', reasons: [] };
  }
  const posts30 = m.cadence.postsLast30d ?? 0;
  // ponytail: 경험적 임계값, 자사 셀러 풀 분위수로 교체 예정 (30일 10회 = 만점)
  const posts30Score = Math.min(posts30 / 10, 1) * 100;
  const reasons: string[] = [`최근 30일 ${posts30}회 게시`];

  let intervalScore: number | null = null;
  const medianInterval = m.cadence.medianIntervalDays;
  if (medianInterval !== null) {
    // ponytail: 경험적 임계값, 자사 셀러 풀 분위수로 교체 예정 (간격 2일 이하 만점, 14일 이상 0점)
    intervalScore = clamp((14 - medianInterval) / 12, 0, 1) * 100;
    reasons.push(`게시 간격 중앙값 ${medianInterval.toFixed(1)}일`);
  }

  const score =
    intervalScore === null
      ? toScore(posts30Score)
      : toScore(0.6 * posts30Score + 0.4 * intervalScore);
  return { score, statusLabel: null, reasons };
}

/** 팔로워 구간별 ER 벤치마크. SellerMetrics에 팔로워 수가 없어 er 역산으로 추정한 값을 받는다 (riskFlags에서도 재사용) */
export function erBenchmark(followers: number | null): number {
  // ponytail: 경험적 임계값, 자사 셀러 풀 분위수로 교체 예정 (팔로워 구간별 ER 기준선)
  if (followers === null || followers < 10_000) return 0.04;
  if (followers < 100_000) return 0.02;
  if (followers < 500_000) return 0.01;
  return 0.007;
}

/**
 * 실질 반응 기준 팔로워 예상치 — "이 계정의 반응 수준이라면 건강한 계정 기준 몇 명짜리인가".
 * followers × min(er / erBenchmark(followers), 1). 팔로워 수를 상한으로 캡한다(반응이 기준을
 * 넘어도 "팔로워보다 많은 실질 팔로워"는 성립하지 않음). ER·팔로워가 없으면 null.
 *
 * 휴리스틱 추정치다 — 표시 시 반드시 "~"·"추정"을 병기한다(리포트 §3 거짓 정밀도 금지).
 * 같은 이유로 결과를 유효숫자 2자리로 뭉갠다(12,347명처럼 정밀해 보이는 값 금지).
 */
export function estimateActiveFollowers(
  followers: number | null | undefined,
  er: number | null | undefined,
): number | null {
  if (typeof followers !== 'number' || !isFinite(followers) || followers <= 0) return null;
  if (typeof er !== 'number' || !isFinite(er) || er < 0) return null;
  const est = Math.round(followers * Math.min(er / erBenchmark(followers), 1));
  if (est < 100) return est;
  const mag = 10 ** (Math.floor(Math.log10(est)) - 1);
  return Math.round(est / mag) * mag;
}

function computeEngagementQuality(m: SellerMetrics): SubScore {
  const er = m.engagement.er;
  if (er === null) {
    return { score: null, statusLabel: 'ER 계산 불가', reasons: [] };
  }

  // 팔로워 수 복원: SellerMetrics에 팔로워 수 필드가 없으므로
  // er = (avgLikes + avgComments) / followers 관계를 역산한다 (결정적 복원, er=0이면 불가 → 최소 구간 적용).
  const engagementSum = (m.engagement.avgLikes ?? 0) + (m.engagement.avgComments ?? 0);
  const followers = er > 0 ? engagementSum / er : null;
  const benchmark = erBenchmark(followers);

  const ratio = er / benchmark;
  // ponytail: 경험적 임계값, 자사 셀러 풀 분위수로 교체 예정 (벤치마크 2배 = 만점, 1배 = 50점)
  const erScore = clamp(ratio / 2, 0, 1) * 100;
  const reasons: string[] = [
    `ER ${fmtPct(er, 2)} (구간 기준 ${fmtPct(benchmark, 1)}의 ${Math.round(ratio * 100)}%)`,
  ];

  // 중앙값 ER은 표시 전용 — 점수 산식은 er(평균) 유지. 바이럴 이상치로 평균과 유의미하게
  // 벌어질 때(상대차 20% 이상)만 근거에 병기해 판단 재료로 노출한다.
  const medianEr = m.engagement.medianEr;
  if (medianEr !== null && er > 0 && Math.abs(medianEr - er) / er >= 0.2) {
    reasons.push(`중앙값 ER ${fmtPct(medianEr, 2)}`);
  }

  if (m.dataSufficiency.hasComments) {
    const hangulRatio = m.commentQuality.hangulRatio ?? 0;
    const spamRatio = m.commentQuality.spamRatio ?? 0;
    const commentScore = clamp(hangulRatio * (1 - spamRatio), 0, 1) * 100;
    reasons.push(`한글 댓글 ${fmtPct(hangulRatio)} · 스팸 ${fmtPct(spamRatio)}`);
    return {
      score: toScore(0.7 * erScore + 0.3 * commentScore),
      statusLabel: null,
      reasons,
    };
  }

  reasons.push('댓글 미수집: ER만 반영');
  return { score: toScore(erScore), statusLabel: null, reasons };
}

function computeAudienceQuality(m: SellerMetrics): SubScore {
  if (!m.dataSufficiency.hasComments) {
    return { score: null, statusLabel: '댓글 데이터 없음', reasons: [] };
  }
  const hangulRatio = m.commentQuality.hangulRatio ?? 0;
  const spamRatio = m.commentQuality.spamRatio ?? 0;
  const duplicateRatio = m.commentQuality.duplicateRatio ?? 0;
  // ponytail: 경험적 임계값, 자사 셀러 풀 분위수로 교체 예정 (한글 0.6 / 비스팸 0.3 / 비중복 0.1 가중)
  const raw = clamp(hangulRatio * 0.6 + (1 - spamRatio) * 0.3 + (1 - duplicateRatio) * 0.1, 0, 1);
  return {
    score: toScore(raw * 100),
    statusLabel: null,
    reasons: [
      `한글 비율 ${fmtPct(hangulRatio)}`,
      `스팸 비율 ${fmtPct(spamRatio)}`,
      `중복 비율 ${fmtPct(duplicateRatio)}`,
    ],
  };
}

function computeGonguConsistency(m: SellerMetrics): SubScore {
  const gonguCount = m.gongu.gonguCount;
  if (gonguCount === 0) {
    return { score: null, statusLabel: '공구 이력 없음', reasons: [] };
  }
  // 정상 데이터라면 gonguCount > 0 → gonguShare non-null이지만, 구버전/손상 JSONB에서는
  // 깨질 수 있으므로 share가 없으면 비중 점수를 생략한다 (0으로 오독시키지 않음 — 리뷰 Medium 대응)
  const share = m.gongu.gonguShare;
  let shareScore: number | null = null;
  const reasons: string[] = [];
  if (share !== null) {
    // ponytail: 경험적 임계값, 자사 셀러 풀 분위수로 교체 예정 (공구 비중 10~40%가 건강 구간)
    if (share < 0.1) {
      shareScore = (share / 0.1) * 100;
    } else if (share <= 0.4) {
      shareScore = 100;
    } else {
      shareScore = clamp((0.8 - share) / 0.4, 0, 1) * 100;
    }
    reasons.push(`공구 게시물 ${gonguCount}건 (비중 ${fmtPct(share)})`);
  } else {
    reasons.push(`공구 게시물 ${gonguCount}건 (비중 데이터 없음)`);
  }

  let retScore: number | null = null;
  const gonguEr = m.gongu.gonguEr;
  const nonGonguEr = m.gongu.nonGonguEr;
  if (gonguEr !== null && nonGonguEr !== null && nonGonguEr > 0) {
    const retention = gonguEr / nonGonguEr;
    // ponytail: 경험적 임계값, 자사 셀러 풀 분위수로 교체 예정 (유지율 1.2배 이상 = 만점)
    retScore = (clamp(retention, 0, 1.2) / 1.2) * 100;
    reasons.push(`공구글 ER 유지율 ${Math.round(retention * 100)}% (공구 ${fmtPct(gonguEr, 2)} / 일반 ${fmtPct(nonGonguEr, 2)})`);
  } else {
    reasons.push('공구/일반 ER 비교 불가');
  }

  // 포맷별 유지율 병기(2026-08-08) — 표시 재료일 뿐 아래 점수 구성에는 넣지 않는다
  // (점수 반영은 백테스트 후 별도 오너 결정). null 포맷은 조용히 생략 = 판정 불가.
  const formatLabels: Array<[label: string, entry: SellerMetrics['gongu']['formatSplit']['reel']]> = [
    ['릴스', m.gongu.formatSplit.reel],
    ['피드', m.gongu.formatSplit.feed],
  ];
  for (const [label, entry] of formatLabels) {
    if (entry.retention !== null && entry.gonguEr !== null && entry.nonGonguEr !== null) {
      reasons.push(
        `${label} 공구 ER 유지율 ${Math.round(entry.retention * 100)}% (공구 ${fmtPct(entry.gonguEr, 2)} / 일반 ${fmtPct(entry.nonGonguEr, 2)})`,
      );
    }
  }

  // 가용한 축만으로 점수 구성: 둘 다 있으면 0.5/0.5, 하나만 있으면 그것만, 둘 다 없으면 판단 불가
  if (shareScore !== null && retScore !== null) {
    return { score: toScore(0.5 * shareScore + 0.5 * retScore), statusLabel: null, reasons };
  }
  if (shareScore !== null) {
    return { score: toScore(shareScore), statusLabel: null, reasons };
  }
  if (retScore !== null) {
    return { score: toScore(retScore), statusLabel: null, reasons };
  }
  return { score: null, statusLabel: '공구 지표 불완전', reasons };
}

function computeConsistency(m: SellerMetrics): SubScore {
  const cv = m.consistency.likesCv;
  if (cv === null) {
    return { score: null, statusLabel: '좋아요 데이터 부족', reasons: [] };
  }
  // ponytail: 경험적 임계값, 자사 셀러 풀 분위수로 교체 예정 (CV 0.35 이하 만점, 1.5 이상 0점)
  let raw: number;
  if (cv <= 0.35) {
    raw = 100;
  } else if (cv >= 1.5) {
    raw = 0;
  } else {
    raw = ((1.5 - cv) / (1.5 - 0.35)) * 100;
  }
  const reasons: string[] = [
    `좋아요 변동계수 ${cv.toFixed(2)}${m.consistency.label ? ` (${m.consistency.label})` : ''}`,
  ];
  if (m.consistency.viralMultiple !== null) {
    reasons.push(`바이럴 배수 ${m.consistency.viralMultiple.toFixed(1)}x`);
  }
  return { score: toScore(raw), statusLabel: null, reasons };
}

// ---------- 종합 ----------

// ponytail: 경험적 임계값, 자사 셀러 풀 분위수로 교체 예정 (서브점수 가중치 — 백테스트 Phase C-11로 검증)
const COMPOSITE_WEIGHTS: Array<
  [keyof typeof SUBSCORE_LABELS, number]
> = [
  ['engagementQuality', 0.3],
  ['activity', 0.2],
  ['audienceQuality', 0.2],
  ['gonguConsistency', 0.2],
  ['consistency', 0.1],
];

/**
 * 서브점수 계산 진입점. 입력을 unknown으로 받아 내부에서 정규화한다 —
 * 콜사이트(ai_tags.metrics)가 JSONB 왕복된 any이므로 어떤 형태가 와도 throw하지 않고,
 * 누락 데이터는 null 서브점수 + confidence 'low'로 자연 수렴한다.
 */
export function computeSubScores(metricsInput: SellerMetrics | unknown): SellerScores {
  const metrics = normalizeMetrics(metricsInput);
  const activity = computeActivity(metrics);
  const engagementQuality = computeEngagementQuality(metrics);
  const audienceQuality = computeAudienceQuality(metrics);
  const gonguConsistency = computeGonguConsistency(metrics);
  const consistency = computeConsistency(metrics);

  const subScores = { activity, engagementQuality, audienceQuality, gonguConsistency, consistency };

  // composite: null 서브점수는 제외하고 가중치 재정규화
  let weightSum = 0;
  let acc = 0;
  for (const [key, weight] of COMPOSITE_WEIGHTS) {
    const s = subScores[key].score;
    if (s !== null) {
      acc += weight * s;
      weightSum += weight;
    }
  }
  const composite = weightSum > 0 ? toScore(acc / weightSum) : null;

  // confidence
  const { postCount, hasTimestamps, hasComments, sourceTier } = metrics.dataSufficiency;
  // ponytail: 경험적 임계값, 자사 셀러 풀 분위수로 교체 예정 (게시물 10개/5개 기준)
  let confidence: SellerScores['confidence'];
  if (postCount >= 10 && hasTimestamps && hasComments) {
    confidence = 'high';
  } else if (postCount < 5 || (!hasTimestamps && !hasComments)) {
    confidence = 'low';
  } else {
    confidence = 'medium';
  }

  const confidenceReasons: string[] = [`게시물 ${postCount}개 수집`];
  if (!hasComments) {
    confidenceReasons.push(sourceTier ? `${sourceTier} 수집: 댓글 없음` : '댓글 없음');
  }
  if (!hasTimestamps) {
    confidenceReasons.push('게시 시각 데이터 없음');
  }
  if (confidence === 'high') {
    confidenceReasons.push('게시 시각·댓글 모두 확보');
  }

  return {
    ...subScores,
    composite,
    confidence,
    confidenceReasons,
  };
}
