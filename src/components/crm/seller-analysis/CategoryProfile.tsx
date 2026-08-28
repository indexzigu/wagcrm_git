// 셀러 카테고리 성향 카드 — categoryProfile.ts의 CategoryAffinity[]를 시각화.
// matcher의 "선택한 상품 카테고리 적합도"(상품 관점)와 다른 축 — 이건 "이 셀러가 커머스
// 카테고리별로 몇 점 부합하는지"(셀러 관점 프로필)다. 태그 기반 휴리스틱이라 '추정'임을 명시한다.
// 택소노미 10개 확장(2026-07-07)으로 전체 바는 과밀 — 신호 있는 항목(score>0 또는 주 카테고리)만
// 최대 5개 표시한다. 표시할 것이 없으면 카드 자체를 숨긴다(소비처의 length>0 게이트와 같은 의미).
// WAGCRM 이식: 다크 테마 → wag-crm 라이트 토큰으로 리스타일.
import React from 'react';
import { Tags } from 'lucide-react';
import { CategoryAffinity } from '@/lib/seller-analysis/categoryProfile';

interface CategoryProfileProps {
  affinities: CategoryAffinity[];
}

/** 점수별 바 색상: ≥70 emerald / ≥40 amber / >0 rose / 0 slate */
function barColor(score: number): string {
  if (score >= 70) return 'bg-emerald-500';
  if (score >= 40) return 'bg-amber-500';
  if (score > 0) return 'bg-rose-500';
  return 'bg-slate-300';
}

export function CategoryProfile({ affinities }: CategoryProfileProps) {
  // 입력은 score 내림차순(categoryProfile.ts 계약)이므로 filter 후 slice가 곧 상위 N이다.
  const visible = affinities.filter((a) => a.score > 0 || a.isPrimary).slice(0, 5);
  // 전부 0점(신호 없음)이면 빈 바 무더기 대신 카드를 숨긴다 — 판단 가치 없는 표시 배제
  if (visible.length === 0) return null;
  return (
    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-3">
      {/* 상단 소제목 — '추정'임을 명시 */}
      <div className="flex items-center gap-2 border-b border-slate-100 pb-2.5">
        <Tags className="w-4 h-4 text-slate-400" />
        <span className="text-[11px] text-slate-600 font-medium">카테고리 성향</span>
        <span className="text-[10px] text-slate-500">(태그 기반 추정)</span>
      </div>

      {/* 카테고리 바 — 신호 있는 항목만 최대 5행 */}
      <div className="space-y-2.5">
        {visible.map((a) => (
          <div key={a.category}>
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-slate-600 w-14 shrink-0 flex items-center gap-1">
                {a.category}
                {a.isPrimary && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 leading-none">
                    주
                  </span>
                )}
              </span>
              <div
                className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden"
                role="progressbar"
                aria-valuenow={a.score}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${a.category} 적합도`}
              >
                <div
                  className={`h-full rounded-full ${barColor(a.score)}`}
                  style={{ width: `${Math.min(100, Math.max(0, a.score))}%` }}
                />
              </div>
              <span className="text-[11px] font-semibold text-slate-900 tabular-nums w-7 text-right shrink-0">
                {a.score}
              </span>
            </div>
            {a.matchedTerms.length > 0 && (
              <div
                className="text-[10px] text-slate-500 pl-[68px] mt-0.5 truncate"
                title={a.matchedTerms.join(' · ')}
              >
                {a.matchedTerms.join(' · ')}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
