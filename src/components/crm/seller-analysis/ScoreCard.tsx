// 서브점수 카드 — scores.ts의 SellerScores를 시각화 (블루프린트 §3 Phase B-6).
// null 서브점수는 0점 바가 아니라 statusLabel 텍스트로 표시해 "판단 불가"와 "낙제"를 구분한다.
// WAGCRM 이식: 원천(influencer-commerce-admin)의 다크 테마 → wag-crm 라이트 토큰(slate/emerald/amber/rose,
// 기존 '평가' 배지 관례와 정합)으로 리스타일. 로직·구조 무변경.
import React from 'react';
import { Gauge } from 'lucide-react';
import { SellerScores, SubScore, SUBSCORE_LABELS, CONFIDENCE_LABELS } from '@/lib/seller-analysis/scores';
import {
  COMPOSITE_RECOMMEND_THRESHOLD,
  COMPOSITE_HOLD_THRESHOLD,
  resolveSellerScoreBand,
  SELLER_SCORE_BAND_TEXT,
  SELLER_SCORE_BAND_TEXT_UNSET,
} from '@/lib/seller-score-band';
import { cn } from '@/lib/utils';

interface ScoreCardProps {
  scores: SellerScores;
  compact?: boolean;
}

const SUBSCORE_KEYS = Object.keys(SUBSCORE_LABELS) as Array<keyof typeof SUBSCORE_LABELS>;

/** 점수별 바 색상: ≥70 emerald / ≥40 amber / 미만 rose */
function barColor(score: number): string {
  if (score >= 70) return 'bg-emerald-500';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-rose-500';
}

/**
 * 신뢰도 배지 색 — 종류별 구분 없이 **단일 무채색 톤**. D2, 오너 승인 2026-07-16.
 *
 * 전엔 high=emerald / medium=amber / low=slate 3색이었다. 배지 안의 `CONFIDENCE_LABELS`
 * ("높음/보통/부족")가 이미 종류를 말하므로 색이 정보를 더하지 않고, 점수 밴드가 색을 받은 뒤로는
 * 이 색이 그 밴드를 묻는다. `followup-engine.ts` 의 `INFO_BADGE_COLOR`(오너 승인 2026-07-09,
 * *"종류는 아이콘/라벨로 구분하고 색은 단일 톤으로 통일"*)와 같은 형태 — 함수가 아니라 **상수**다.
 * 덤: 구 high 의 `emerald-600` 계열은 흰 배경 3.77:1 로 AA 미달이었다.
 *
 * `slate-500` 은 이 카드의 `bg-slate-50` 위 4.55:1 — AA 턱걸이라 **더 흐리게 내리지 말 것**.
 * 강등은 명도가 아니라 채도 0이 만든다(slate-300 은 1.48:1 로 비텍스트 3:1 도 미달).
 */
const CONFIDENCE_BADGE_CLASS = 'bg-slate-100 text-slate-500 border-slate-200';

/**
 * composite와 적합성 경계(reviewMapping SSOT) 사이의 "거리"를 한 줄로 설명한다.
 * 추천 구간이면 도달 사실을, 아니면 다음 등급까지 남은 점수를 노출해 판정 근거를 1차 시야로 끌어올린다.
 * composite===null이면 표시 없음(호출부에서 null 가드).
 */
function fitDistanceLabel(composite: number): string {
  if (composite >= COMPOSITE_RECOMMEND_THRESHOLD) return '추천 구간';
  if (composite >= COMPOSITE_HOLD_THRESHOLD) return `추천까지 ${COMPOSITE_RECOMMEND_THRESHOLD - composite}점`;
  return `보류까지 ${COMPOSITE_HOLD_THRESHOLD - composite}점`;
}

export function ScoreCard({ scores, compact = false }: ScoreCardProps) {
  const confidenceTitle = scores.confidenceReasons.join(' · ');
  // 종합점수 색 — fitDistanceLabel이 이미 말로 하던 등급("추천 구간")을 색으로도 표현한다.
  // 같은 경계(seller-score-band.ts)를 쓰므로 텍스트와 색이 어긋날 수 없다. compact/full 공용.
  const compositeBand = resolveSellerScoreBand(scores.composite);

  if (compact) {
    // 카드 목록용: 종합점수 + confidence 배지 + 5개 미니바만
    //
    // ⚠️ 이 분기는 **현재 렌더에 도달하지 않는다**(2026-07-16 실측): `<ScoreCard` 호출부 2곳
    // (`app/sellers/[id]/page.tsx` · `SellerAiAnalysis.tsx`)이 전부 compact 를 안 넘겨 기본값
    // false 가 적용된다. 이 PR 의 색 변경은 full 분기에서만 실제로 보인다 — "두 표면 다 됐다"고
    // 읽지 말 것(PR #178 이 죽은 코드를 고치고도 green 을 받았던 것과 같은 종류의 착시).
    // 그래도 같은 밴드를 적용해 둔다: 되살아났을 때 혼자 옛 규칙으로 남지 않게 하려는 것이다.
    return (
      <div className="flex items-center gap-2" title={confidenceTitle}>
        <span
          className={cn(
            'text-sm font-bold tabular-nums',
            compositeBand ? SELLER_SCORE_BAND_TEXT[compositeBand] : SELLER_SCORE_BAND_TEXT_UNSET,
          )}
        >
          {scores.composite !== null ? `${scores.composite}점` : '-'}
        </span>
        <span
          className={`text-[9px] px-1.5 py-0.5 rounded border ${CONFIDENCE_BADGE_CLASS}`}
        >
          {CONFIDENCE_LABELS[scores.confidence]}
        </span>
        <div className="flex items-end gap-0.5 ml-auto">
          {SUBSCORE_KEYS.map(key => {
            const sub: SubScore = scores[key];
            return (
              <div
                key={key}
                className="w-2 h-5 bg-slate-100 rounded-sm overflow-hidden flex flex-col justify-end"
                title={`${SUBSCORE_LABELS[key]}: ${sub.score !== null ? `${sub.score}점` : sub.statusLabel ?? '-'}`}
              >
                {sub.score !== null && (
                  <div className={barColor(sub.score)} style={{ height: `${Math.max(sub.score, 4)}%` }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-4">
      {/* 상단: 종합점수 + confidence 배지 */}
      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
        <div className="flex items-center gap-3">
          <Gauge className="w-5 h-5 text-slate-400" />
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider">지표 종합 점수</div>
            <div
              className={cn(
                'text-2xl font-bold tabular-nums leading-tight',
                compositeBand ? SELLER_SCORE_BAND_TEXT[compositeBand] : SELLER_SCORE_BAND_TEXT_UNSET,
              )}
            >
              {scores.composite !== null ? scores.composite : '-'}
              {/* "/ 100"은 단위라 밴드를 타지 않는다 — 색은 값에만 (styleseed: 숫자 2:1 단위) */}
              <span className="text-xs font-normal text-slate-500 ml-1">/ 100</span>
            </div>
            {/* 적합성 경계까지의 "거리" — 규칙(reviewMapping SSOT)과 동일 컷 기준, 판정 근거 1차 노출 */}
            {scores.composite !== null && (
              <div className="text-[10px] text-slate-500 leading-tight">{fitDistanceLabel(scores.composite)}</div>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {/* 표본 크기 승격: confidenceReasons[0](대개 "게시물 N개 수집")을 1차 가시화 — 신뢰도 판단의 핵심 근거.
              전체 근거 목록은 title로 보존한다. */}
          {scores.confidenceReasons.length > 0 && (
            <span className="text-[10px] text-slate-500 tabular-nums" title={confidenceTitle}>
              {scores.confidenceReasons[0]}
            </span>
          )}
          <span
            className={`inline-block text-[10px] px-2 py-1 rounded border ${CONFIDENCE_BADGE_CLASS}`}
            title={confidenceTitle}
          >
            {CONFIDENCE_LABELS[scores.confidence]}
          </span>
          {/* 나머지 근거(댓글 없음·게시시각 없음 등)는 9px 보조로 격하 — 표본 크기와 중복 없이 */}
          {scores.confidenceReasons.length > 1 && (
            <div className="text-[9px] text-slate-500 max-w-[220px] text-right">
              {scores.confidenceReasons.slice(1).join(' · ')}
            </div>
          )}
        </div>
      </div>

      {/* 서브점수 5행 */}
      <div className="space-y-2.5">
        {SUBSCORE_KEYS.map(key => {
          const sub: SubScore = scores[key];
          return (
            <div key={key}>
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-slate-600 w-20 shrink-0">{SUBSCORE_LABELS[key]}</span>
                {sub.score !== null ? (
                  <>
                    <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${barColor(sub.score)}`}
                        style={{ width: `${sub.score}%` }}
                      />
                    </div>
                    <span className="text-[11px] font-semibold text-slate-900 tabular-nums w-7 text-right shrink-0">
                      {sub.score}
                    </span>
                  </>
                ) : (
                  <span className="flex-1 text-[11px] text-slate-500">{sub.statusLabel}</span>
                )}
              </div>
              {sub.reasons.length > 0 && (
                <div className="text-[10px] text-slate-500 pl-[92px] mt-0.5 truncate" title={sub.reasons.join(' · ')}>
                  {sub.reasons.join(' · ')}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
