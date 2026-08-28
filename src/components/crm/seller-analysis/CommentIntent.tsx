// 댓글 구매의도 분포 카드 — gemini comment_analysis(의도 분포·키워드)를 시각화 (스펙 §4 무기 #2).
// 순수 컴포넌트(훅 없음): T2(SellerAiAnalysis, client)와 T3(풀페이지, RSC) 양쪽에서 사용.
// 댓글이 수집된 Tier1 분석에만 데이터가 존재하며, LLM 분류라 '추정'을 명시한다.
import React from "react";
import { MessageSquareText } from "lucide-react";

export interface CommentAnalysis {
  intent_distribution?: {
    inquiry?: number;
    purchase?: number;
    social?: number;
    bot_or_irrelevant?: number;
  };
  top_keywords?: string[];
}

export function readCommentAnalysis(aiTags: unknown): CommentAnalysis | null {
  if (!aiTags || typeof aiTags !== "object") return null;
  const ca = (aiTags as Record<string, unknown>).comment_analysis;
  if (!ca || typeof ca !== "object") return null;
  return ca as CommentAnalysis;
}

/**
 * 댓글 미수집(Tier2 등) 시 섹션이 조용히 사라지지 않도록 명시적 빈 상태를 그린다.
 * ScoreCard/CategoryProfile과 동일한 카드 셸을 유지해 "데이터 없음"과 "0%"를 시각적으로 구분한다 (UX 감사 P0-2).
 */
export function CommentIntentEmpty() {
  return (
    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 flex items-start gap-2.5">
      <MessageSquareText className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
      <div className="space-y-0.5">
        <div className="text-[11px] text-slate-500 font-medium">댓글 데이터 없음</div>
        <div className="text-[10px] text-slate-500">
          댓글을 수집한 분석(Tier1)에서만 구매의도를 제공합니다
        </div>
      </div>
    </div>
  );
}

export function CommentIntent({ analysis }: { analysis: CommentAnalysis }) {
  const d = analysis.intent_distribution;
  if (!d) return null;
  const rows = [
    { label: "문의", v: d.inquiry ?? 0, cls: "bg-blue-500" },
    { label: "구매", v: d.purchase ?? 0, cls: "bg-emerald-500" },
    { label: "친목", v: d.social ?? 0, cls: "bg-slate-400" },
    { label: "봇·무관", v: d.bot_or_irrelevant ?? 0, cls: "bg-rose-400" },
  ];
  const buyIntent = (d.inquiry ?? 0) + (d.purchase ?? 0);
  return (
    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-2.5">
      <div className="flex items-center gap-2 border-b border-slate-100 pb-2.5">
        <MessageSquareText className="w-4 h-4 text-slate-400" />
        <span className="text-[11px] text-slate-600 font-medium">댓글 구매의도</span>
        <span className="text-[10px] text-slate-500">(LLM 분류 · 추정)</span>
        <span className="ml-auto text-[11px] font-bold text-emerald-700 tabular-nums">
          구매신호 {buyIntent}%
        </span>
      </div>
      <div className="flex h-2 rounded-full overflow-hidden bg-slate-100">
        {rows.map((r) => (
          <div
            key={r.label}
            className={r.cls}
            style={{ width: `${Math.max(0, Math.min(100, r.v))}%` }}
            title={`${r.label} ${r.v}%`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {rows.map((r) => (
          <span key={r.label} className="text-[10px] text-slate-500">
            <span className={`inline-block w-2 h-2 rounded-sm mr-1 align-middle ${r.cls}`} />
            {r.label} {r.v}%
          </span>
        ))}
      </div>
      {analysis.top_keywords && analysis.top_keywords.length > 0 && (
        <div className="text-[10px] text-slate-500 truncate" title={analysis.top_keywords.join(" · ")}>
          키워드: {analysis.top_keywords.join(" · ")}
        </div>
      )}
    </div>
  );
}
