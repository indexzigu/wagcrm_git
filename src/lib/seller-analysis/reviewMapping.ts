// "검토 후 CRM 반영" 매핑 (§12-4, 이식 스펙 §7) — AI 지표(SellerMetrics)를 기존 Seller 수동 필드의
// 레벨 어휘로 번역해 사람 검수용 제안을 만든다. 순수 함수, throw 금지.
//
// 원칙:
//  - 근거 없는 제안 금지: 해당 지표가 없으면 suggested=null ("판단 불가") — 0레벨로 오독시키지 않는다.
//  - 자동 체크는 "기계적 근거가 강한" 서브필드만. fitLevel(적합성)은 판단 필드라 절대 자동 체크하지 않는다.
//    category(카테고리)는 기존 태그가 있으면 자동 체크하지 않는다(운영자 큐레이션 보호) — 완전 미입력일 때만.
//  - 레벨 어휘·자동 fitLevel 재계산 규칙(합산 >9 추천 / >6 보류, 미입력 정규화)의 단일 진실 원천은
//    src/lib/seller-fit.ts다. CRM 저장 경로(sellerService.updateSeller, api/sellers/[id] PATCH)가 그 함수를
//    쓰므로, 여기 어휘·문서가 어긋나면 저장은 되지만 의미가 오염된다.

import { SellerMetrics } from './metrics';
import { normalizeMetrics, SellerScores } from './scores';

// ---------- CRM 레벨 어휘 — **단일 진실 원천** ----------
// 셀러 상세의 StepMetricCard 가 이 상수를 직접 import 한다(종전에는 같은 배열을 손으로
// 한 벌 더 적어 두 사본이 갈릴 수 있었다 — 라벨을 고치는 이 작업에서 실제로 위험했다).
//
// ⚠️ 값은 **"N.라벨"** 형태를 지킨다: 저장은 문자열 전체지만 점수 판정(`seller-fit.ts`)과
// 화면의 단계 매칭(`StepMetricCard`)은 **숫자 접두사만** 읽는다. 그래서 라벨 문구를 바꿔도
// 기존 저장값이 화면에서 '미입력'으로 죽지 않는다(문구 개정의 전제 조건이다).
export const LEVELS = {
  collaborationScore: ['0.비노출', '1.소극홍보', '2.적극홍보', '3.홍보+활성'],
  // 2026-08-04 개정: 개수 어휘("5개미만"=협찬 게시물 수) → **반응 유지율** 어휘.
  // 항목이 묻는 것이 "광고를 몇 개 했나"가 아니라 "수익성 글에서도 반응이 좋은가"이기
  // 때문이다(오너 정의). 개수 어휘로 되돌리지 말 것 — suggestAdResponse doc 참조.
  adResponseScore: ['0.반응없음', '1.하락', '2.대체유지', '3.유지·상승'],
  commentResponseScore: ['0.없음', '1.5개미만', '2.10개미만', '3.10개이상'],
  activityFrequency: ['0.주1회이하', '1.주2-3회', '2.주5회', '3.매일'],
} as const;

// 광고 반응 컷 — 수익성(광고∪공구) 글 반응 ÷ 일상 글 반응. 실데이터 분포로 정했다
// (2026-08-04). 이 값을 바꾸면 재분석 시 전 셀러의 평가가 움직인다(오너 승인 사안).
export const AD_RESPONSE_HOLD_RETENTION = 1.0; // 이상 = 3.유지·상승
export const AD_RESPONSE_KEEP_RETENTION = 0.7; // 이상 = 2.대체유지
export const AD_RESPONSE_DROP_RETENTION = 0.4; // 이상 = 1.하락 / 미만 = 0.반응없음

export const FIT_LEVELS = ['미진행', '비추천', '보류', '추천'] as const;

// composite(0~100) → 적합성 등급 경계. suggestFitLevel과 표시 계층(ScoreCard의 "거리" 텍스트·
// 점수 밴드 색)이 같은 값을 참조하는 단일 진실 원천 — 규칙과 화면 안내가 어긋나는 드리프트를
// 차단한다 (UX 감사 P0-2).
// ponytail: 분석 13건 분위수(33~71, 중앙값 58) 기반 잠정, 표본 확대 시 분위수 재보정(Phase C-11).
//   → 다만 재보정은 지금 분포로 하지 말 것: 절대평가 축이고 분석 표본이 전체 셀러가 아니다
//     (오너 확정 2026-07-16). 상대평가인 seller-fit.ts의 분위수 재조정과 혼동 금지.
//
// 정의는 src/lib/seller-score-band.ts(의존성 0 leaf)로 옮겼다 — 색 규칙 모듈이 이 파일을 import 하면
// metrics.ts + scores.ts 체인이 셀러 목록 번들까지 딸려온다. 값은 여전히 한 곳에만 있고, 기존
// import 경로(`from './reviewMapping'`)를 유지하기 위해 여기서 re-export 한다.
export {
  COMPOSITE_RECOMMEND_THRESHOLD,
  COMPOSITE_HOLD_THRESHOLD,
} from '../seller-score-band';
import {
  COMPOSITE_RECOMMEND_THRESHOLD,
  COMPOSITE_HOLD_THRESHOLD,
} from '../seller-score-band';

export type ReviewField =
  | 'activityFrequency'
  | 'adResponseScore'
  | 'commentResponseScore'
  | 'collaborationScore'
  | 'category'
  | 'fitLevel';

export const REVIEW_FIELD_LABELS: Record<ReviewField, string> = {
  activityFrequency: '활동 빈도',
  adResponseScore: '광고 반응',
  commentResponseScore: '댓글 반응',
  collaborationScore: '공구 활성화',
  category: '카테고리',
  fitLevel: '적합성',
};

export interface FieldSuggestion {
  field: ReviewField;
  label: string;
  /** 현재 CRM 값 (미입력이면 null) */
  current: string | null;
  /** AI 제안 레벨. 판단 근거 부족이면 null */
  suggested: string | null;
  /** 제안 근거 (실제 수치) — suggested가 null이면 불가 사유 */
  reason: string;
  /** 현재값과 제안이 동일 (변경 없음) */
  match: boolean;
  /** 기본 체크 여부 — 기계적 근거 강한 서브필드 & 변경 있음일 때만 true. fitLevel은 항상 false */
  autoCheck: boolean;
}

export interface ReviewCurrentFields {
  activityFrequency: string | null;
  adResponseScore: string | null;
  commentResponseScore: string | null;
  collaborationScore: string | null;
  /** 콤마 구분 자유 태그 문자열 (예: "공구, 리빙") — 제안은 병합 문자열로 만든다 */
  category: string | null;
  fitLevel: string | null;
}

// ---------- 개별 매핑 ----------

function suggestActivityFrequency(m: SellerMetrics): { level: string | null; reason: string } {
  const interval = m.cadence.medianIntervalDays;
  // 표본 상한(예: Tier2 12개) 때문에 postsLast30d는 하한 왜곡이 있어 게시 간격 중앙값을 1차 신호로 쓴다.
  if (interval !== null) {
    // ponytail: 주N회 어휘를 간격(일)으로 환산한 경계 — 매일≤1.15 / 주5회≈7/5=1.4 / 주2-3회≈7/2.5=2.8
    const level =
      interval <= 1.15 ? '3.매일' : interval <= 1.65 ? '2.주5회' : interval <= 4.0 ? '1.주2-3회' : '0.주1회이하';
    return { level, reason: `게시 간격 중앙값 ${interval.toFixed(1)}일` };
  }
  const p30 = m.cadence.postsLast30d;
  if (p30 !== null) {
    const level = p30 >= 26 ? '3.매일' : p30 >= 18 ? '2.주5회' : p30 >= 8 ? '1.주2-3회' : '0.주1회이하';
    return { level, reason: `최근 30일 ${p30}회 게시` };
  }
  return { level: null, reason: '게시 시각 데이터 없음' };
}

/**
 * 광고 반응 = **수익성 게시물(광고 ∪ 공구)에서도 댓글·좋아요 반응이 유지되는가**(오너 정의
 * 2026-08-04). 컷은 유지율(수익성 ER ÷ 일상 ER)이며 근거는 실데이터 분포다(2026-08-04,
 * `seller-fit.ts` 가 컷을 재보정한 것과 같은 절차) — 네 구간에 고르게 흩어짐을 확인했다.
 *
 * ⛔ **개수를 세지 말 것.** 종전 구현은 `m.ads.adCount`(협찬 게시물 **개수**)를 셌다.
 * 그래서 ①묻는 것과 다른 것을 재고 ②방향이 반대였으며(광고를 많이 올릴수록 고점)
 * ③컷이 `10건 이상 = 3점`이라 공구 셀러는 구조적으로 3점 도달이 불가능했다. 그 결과 이
 * 항목만 최저점에 눌려 4필드 합산이 낮게 갇혔고, 운영자가 판정을 손으로 되돌리는 패턴이
 * 생겼다(fitLevel 수동 덮어쓰기의 직접 원인). 이 항목을 다시 개수 기반으로 되돌리지 말 것.
 */
function suggestAdResponse(m: SellerMetrics): { level: string | null; reason: string } {
  const r = m.monetized.monetizedRetention;
  if (r === null) {
    // 수익성 글이 없거나 일상 글이 없어 **비교 자체가 불가능**한 경우다. 0점(낙제)이
    // 아니라 미입력으로 남긴다 — 평가하지 않은 것과 나쁜 것은 다르다.
    return {
      level: null,
      reason:
        m.monetized.monetizedCount === 0
          ? '수익성(광고·공구) 게시물이 없어 비교 불가'
          : '비교할 일상 게시물이 없어 판정 불가',
    };
  }
  const level =
    r >= AD_RESPONSE_HOLD_RETENTION
      ? '3.유지·상승'
      : r >= AD_RESPONSE_KEEP_RETENTION
        ? '2.대체유지'
        : r >= AD_RESPONSE_DROP_RETENTION
          ? '1.하락'
          : '0.반응없음';
  return {
    level,
    reason: `수익성 글 ${m.monetized.monetizedCount}건의 반응이 일상 글의 ${Math.round(r * 100)}%`,
  };
}

function suggestCommentResponse(m: SellerMetrics): { level: string | null; reason: string } {
  const avg = m.engagement.avgComments;
  if (avg === null) {
    return { level: null, reason: '댓글 수 데이터 없음' };
  }
  const level = avg < 0.5 ? '0.없음' : avg < 5 ? '1.5개미만' : avg < 10 ? '2.10개미만' : '3.10개이상';
  return { level, reason: `게시물당 평균 댓글 ${avg.toFixed(1)}개` };
}

function suggestCollaboration(m: SellerMetrics): { level: string | null; reason: string } {
  if (!m.dataSufficiency.postCount) {
    return { level: null, reason: '게시물 데이터 없음' };
  }
  const count = m.gongu.gonguCount;
  if (count === 0) {
    return { level: '0.비노출', reason: `분석 ${m.dataSufficiency.postCount}개 게시물 중 공구 게시물 없음` };
  }
  const share = m.gongu.gonguShare;
  const gonguEr = m.gongu.gonguEr;
  const nonGonguEr = m.gongu.nonGonguEr;
  const retention = gonguEr !== null && nonGonguEr !== null && nonGonguEr > 0 ? gonguEr / nonGonguEr : null;
  const shareTxt = share !== null ? ` (비중 ${(share * 100).toFixed(1)}%)` : '';
  // ponytail: 비중 10% 미만=소극, 이상=적극, 적극+ER유지율 80% 이상=홍보+활성
  if (share !== null && share < 0.1) {
    return { level: '1.소극홍보', reason: `공구 ${count}건${shareTxt}` };
  }
  if (retention !== null && retention >= 0.8) {
    return {
      level: '3.홍보+활성',
      reason: `공구 ${count}건${shareTxt} · 공구글 ER 유지율 ${Math.round(retention * 100)}%`,
    };
  }
  return {
    level: '2.적극홍보',
    reason: `공구 ${count}건${shareTxt}${retention !== null ? ` · ER 유지율 ${Math.round(retention * 100)}%` : ''}`,
  };
}

/** seller.category(콤마 구분 자유 태그 문자열)를 태그 배열로 파싱 (trim, 빈 항목 제거) */
function parseCategoryTags(category: string | null): string[] {
  if (!category) return [];
  return category
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** buildFieldSuggestions 4번째 인자 — 콜사이트가 aiTags에서 꺼내 넘긴다 (순수함수 유지) */
export interface AiCategoryInput {
  /** LLM이 판정한 주 카테고리 (ai_tags.category). 없으면 null */
  category: string | null;
  /** 근거 표시용 상위 카테고리 성향 (score>0만, 선택) */
  topAffinities?: Array<{ category: string; score: number }>;
}

// 병합 의미론: seller.category는 운영자가 큐레이션하는 자유 태그 문자열이다. 기존 태그는 절대 제거하지
// 않고, LLM 주 카테고리가 목록에 없을 때만 "기존 ∪ {LLM}"의 전체 문자열을 제안한다(PATCH가 그대로 저장 가능).
// 이미 있으면 level=현재값 그대로 → 진입점의 match=true(변경 없음)로 수렴한다.
function suggestCategory(
  currentCategory: string | null,
  aiCategory: AiCategoryInput | null
): { level: string | null; reason: string } {
  const ai = aiCategory?.category?.trim() ?? '';
  if (!ai) {
    return { level: null, reason: 'AI 카테고리 판정 없음' };
  }
  const affinityTxt =
    aiCategory?.topAffinities && aiCategory.topAffinities.length > 0
      ? ` · 성향 ${aiCategory.topAffinities.map((a) => `${a.category} ${a.score}`).join(' · ')}`
      : '';
  const base = `AI 주 카테고리 판정 '${ai}'${affinityTxt}`;

  const tags = parseCategoryTags(currentCategory);
  const exists = tags.some((t) => t.toLowerCase() === ai.toLowerCase());
  if (exists) {
    return { level: currentCategory, reason: `${base}: 이미 태그에 포함` };
  }
  const merged = [...tags, ai].join(', ');
  return {
    level: merged,
    reason: tags.length === 0 ? base : `${base}: 기존 태그 유지·병합`,
  };
}

function suggestFitLevel(scores: SellerScores): { level: string | null; reason: string } {
  if (scores.composite === null) {
    return { level: null, reason: '종합점수 산출 불가 (데이터 부족)' };
  }
  // 경계는 COMPOSITE_*_THRESHOLD 상수에서 파생 — ScoreCard "거리" 표시와 동일 원천(SSOT)
  const level =
    scores.composite >= COMPOSITE_RECOMMEND_THRESHOLD
      ? '추천'
      : scores.composite >= COMPOSITE_HOLD_THRESHOLD
        ? '보류'
        : '비추천';
  return { level, reason: `지표 종합 ${scores.composite}점 · 신뢰도 ${scores.confidence}` };
}

// ---------- 진입점 ----------

export function buildFieldSuggestions(
  current: ReviewCurrentFields,
  metricsInput: SellerMetrics | unknown,
  scores: SellerScores,
  aiCategory?: AiCategoryInput | null
): FieldSuggestion[] {
  const m = normalizeMetrics(metricsInput);

  const rows: Array<{
    field: ReviewField;
    s: { level: string | null; reason: string };
    /** 이 필드에 자동 체크가 허용되는가 (변경 존재 여부와 별개의 필드 정책) */
    autoCheckable: boolean;
  }> = [
    { field: 'activityFrequency', s: suggestActivityFrequency(m), autoCheckable: true },
    { field: 'adResponseScore', s: suggestAdResponse(m), autoCheckable: true },
    { field: 'commentResponseScore', s: suggestCommentResponse(m), autoCheckable: true },
    { field: 'collaborationScore', s: suggestCollaboration(m), autoCheckable: true },
    {
      field: 'category',
      s: suggestCategory(current.category, aiCategory ?? null),
      // 병합도 사람 확인 — 기존 태그가 있으면 자동 체크 금지(운영자 큐레이션 보호), 완전 미입력일 때만 허용
      autoCheckable: parseCategoryTags(current.category).length === 0,
    },
    // fitLevel은 판단 필드 — 자동 체크 금지 (스펙 §7: 등급 변경은 수동 확인)
    { field: 'fitLevel', s: suggestFitLevel(scores), autoCheckable: false },
  ];

  return rows.map(({ field, s, autoCheckable }) => {
    const cur = current[field] ?? null;
    const match = s.level !== null && cur === s.level;
    return {
      field,
      label: REVIEW_FIELD_LABELS[field],
      current: cur,
      suggested: s.level,
      reason: s.reason,
      match,
      autoCheck: autoCheckable && s.level !== null && !match,
    };
  });
}
