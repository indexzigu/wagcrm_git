// T2 "AI 분석" 패널 (§12-4) — 저장된 SellerAiProfile을 조회해 ScoreCard/CategoryProfile로 렌더하고,
// "재분석" 버튼으로 분석 라우트(POST /api/sellers/[id]/analyze)를 호출한다. 자체 완결형이라
// seller-detail-content.tsx엔 이 컴포넌트 한 줄만 배선한다(공유 파일 편집 최소화).
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Equal, ExternalLink, Loader2, RefreshCw, Sparkles, UserCheck } from "lucide-react";
import { CommentIntent, CommentIntentEmpty, readCommentAnalysis } from "./CommentIntent";
import { toast } from "sonner";
import { ScoreCard } from "./ScoreCard";
import { CategoryProfile } from "./CategoryProfile";
import { deriveSellerAiView, type SellerAiView } from "@/lib/seller-analysis/adapter";
import { analysisStaleLabel } from "@/lib/seller-analysis/staleness";
import {
  buildFieldSuggestions,
  type ReviewCurrentFields,
  type ReviewField,
} from "@/lib/seller-analysis/reviewMapping";
import { FIT_HOLD_THRESHOLD, FIT_RECOMMEND_THRESHOLD } from "@/lib/seller-fit";

interface Props {
  sellerId: string;
  snsType: string;
  /** AI 제안과 대조할 기존 수동 필드의 현재값 (없으면 반영 내역 패널 숨김) */
  current?: ReviewCurrentFields;
  /**
   * 서버가 분석 완료 시 자동 반영한 지표(오너 확정 2026-07-16)를 부모 상태에 되비추는 콜백.
   * PATCH는 서버(analyze 라우트)가 이미 끝냈다 — 여기서는 화면 상태만 동기화한다.
   */
  onAutoApplied?: (patch: Partial<Record<ReviewField, string>> & { fitLevel?: string }) => void;
}

interface AiProfile {
  aiTags: unknown;
  compositeScore: number | null;
  confidence: string | null;
  sourceTier: string | null;
  analyzedAt: string | null;
  updatedAt: string;
}

function analyzedLabel(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "오늘 분석";
  return `${days}일 전 분석`;
}

export function SellerAiAnalysis({ sellerId, snsType, current, onAutoApplied }: Props) {
  const [profile, setProfile] = useState<AiProfile | null>(null);
  const [view, setView] = useState<SellerAiView | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 반영 내역 대조: 저장된 metrics + 현재 CRM 값 → 필드별 제안(read-only 근거 표시용).
  // 반영 자체는 서버(analyze 라우트)가 분석 완료 시 자동으로 끝낸다 — 체크박스 게이트는 폐기됐다.
  const suggestions = useMemo(() => {
    if (!view || !profile || !current) return null;
    const aiTags = profile.aiTags as Record<string, unknown> | null;
    // 카테고리 제안 입력은 여기서 꺼내 넘긴다 — buildFieldSuggestions를 순수 함수로 유지
    return buildFieldSuggestions(current, aiTags?.metrics, view.scores, {
      category: typeof aiTags?.category === "string" ? aiTags.category : null,
      topAffinities: view.affinities.filter((a) => a.score > 0).slice(0, 2),
    });
  }, [view, profile, current]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sellers/${sellerId}/ai-profile`);
      if (!res.ok) throw new Error(`AI 프로필 조회 실패 (${res.status})`);
      const data = (await res.json()) as { profile: AiProfile | null };
      setProfile(data.profile);
      setView(data.profile ? deriveSellerAiView(data.profile.aiTags) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI 프로필 조회 중 오류가 발생했습니다");
    } finally {
      setLoading(false);
    }
  }, [sellerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isInstagram = (snsType || "").toUpperCase() === "INSTAGRAM";

  // 분석은 60~300초 걸린다 — 클릭 시점 클로저의 onAutoApplied(=그때의 seller)를 완료 시점에
  // 부르면, 그 사이 사용자가 저장한 다른 필드를 낡은 값으로 되덮어 화면이 되돌아간다
  // (code-review MEDIUM — DB는 정상, 화면만 낡음). latest-ref 패턴으로 항상 최신 렌더의
  // 콜백을 부른다.
  const onAutoAppliedRef = useRef(onAutoApplied);
  useEffect(() => {
    onAutoAppliedRef.current = onAutoApplied;
  });

  const runAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const res = await fetch(`/api/sellers/${sellerId}/analyze`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `분석 실패 (${res.status})`);
      await load();
      // 서버 자동반영 결과를 부모 셀러 상태에 되비춘다 — 안 하면 위 평가 카드·'현재' 컬럼이 낡은
      // 값으로 남아 "반영됐다는데 화면은 그대로"가 된다. fitLevel은 서버 합산 규칙의 재계산 값.
      const applied = data?.data?.applied ?? null;
      if (applied?.fields && Object.keys(applied.fields).length > 0) {
        onAutoAppliedRef.current?.({
          ...applied.fields,
          ...(applied.fitLevel ? { fitLevel: applied.fitLevel } : {}),
        });
        toast.success(`분석 완료 · AI 지표 ${Object.keys(applied.fields).length}건 자동 반영`);
      }
      // 자동반영 실패는 분석 성공과 별개로 표면화한다(P0 — 조용히 넘어가면 지표가 낡은 채 남는다)
      if (data?.data?.autoApplyError) {
        setError(`지표 자동반영 실패: ${data.data.autoApplyError}. 재분석으로 다시 시도할 수 있습니다`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "분석 중 오류가 발생했습니다");
    } finally {
      setAnalyzing(false);
    }
  }, [sellerId, load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
        <Loader2 className="size-3.5 animate-spin" /> AI 분석 불러오는 중…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="text-[11px] text-rose-600 bg-rose-50 border border-rose-200 rounded px-2.5 py-1.5">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        {profile?.analyzedAt && (
          // 4주 이상 경과하면 앰버로 강조해 재분석을 유도 (자동 재분석 대신 사람 트리거 — staleness.ts 참조)
          <span
            className={`text-[11px] ${
              analysisStaleLabel(profile.analyzedAt) ? "font-medium text-amber-600" : "text-slate-500"
            }`}
          >
            {analyzedLabel(profile.analyzedAt)}
            {analysisStaleLabel(profile.analyzedAt) && " · 재분석 권장"}
          </span>
        )}
        {profile?.sourceTier && <span className="text-[10px] text-slate-500">· {profile.sourceTier}</span>}
        <button
          type="button"
          onClick={runAnalyze}
          disabled={analyzing || !isInstagram}
          title={isInstagram ? "" : "현재 인스타그램 계정만 분석할 수 있습니다"}
          className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {analyzing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {profile ? "재분석" : "분석 시작"}
        </button>
      </div>

      {!profile && !analyzing && (
        <div className="flex flex-col items-center gap-1.5 py-6 text-center">
          <Sparkles className="size-5 text-slate-300" />
          <div className="text-xs text-slate-500">아직 AI 분석 전입니다.</div>
          {!isInstagram && <div className="text-[10px] text-slate-500">현재 인스타그램 계정만 분석할 수 있습니다.</div>}
        </div>
      )}

      {view && (
        <div className="space-y-3">
          {/* 리스크 플래그 (스펙 §9) — 능동 경고, 근거 툴팁 */}
          {view.riskFlags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {view.riskFlags.map((f) => (
                <span
                  key={f.key}
                  title={f.reason}
                  className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full border cursor-help ${
                    f.severity === "danger"
                      ? "bg-rose-50 text-rose-700 border-rose-200"
                      : "bg-amber-50 text-amber-700 border-amber-200"
                  }`}
                >
                  <AlertTriangle className="size-3" />
                  {f.label}
                </span>
              ))}
            </div>
          )}

          <ScoreCard scores={view.scores} />
          {view.affinities.length > 0 && <CategoryProfile affinities={view.affinities} />}

          {/* 댓글 구매의도 (우리 무기 #2, 스펙 §4) — 댓글 수집(Tier1) 분석에만 존재.
              미수집 시 조용히 사라지지 않고 명시적 빈 상태로 "왜 없는지"를 알린다 (UX 감사 P0-2). */}
          {(() => {
            const ca = readCommentAnalysis(profile?.aiTags);
            return ca ? <CommentIntent analysis={ca} /> : <CommentIntentEmpty />;
          })()}

          {/* AI 지표 반영 내역 (오너 확정 2026-07-16) — 반영은 서버가 분석 완료 시 자동으로 끝낸다.
              이 패널은 확정 게이트가 아니라 근거 대장(어떤 값이 왜 반영됐나)이다. 체크박스·확정
              버튼은 폐기 — 수동 조정이 필요하면 위 평가 카드(StepMetricCard)에서 직접 고친다. */}
          {suggestions && (
            <div className="p-4 bg-white rounded-lg border border-blue-200 space-y-3">
              <div className="flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-blue-500" />
                <span className="text-[12px] font-semibold text-slate-800">AI 지표 반영</span>
                <span className="text-[10px] text-slate-500">
                  분석 완료 시 자동 반영 · 카테고리는 미입력일 때만
                </span>
              </div>

              <div>
                {/* 적합성(fitLevel) 행은 제외한다(ss-ux P0, 2026-07-16): 이 행의 제안값은
                    composite 65/48 경계(suggestFitLevel)인데, 실제 반영은 updateSeller가
                    4개 평가 합산(seller-fit)으로 재계산하는 별개 경로다 — 그리면 "재분석 시
                    반영됩니다"가 거짓이 된다. 재계산 결과는 상단 적합성 배지가 이미 보여준다. */}
                {suggestions.filter((s) => s.field !== "fitLevel").map((s) => {
                  // 근거(reason)를 제안값과 같은 줄에서 다투게 하지 않고 아래 2번째 줄로 내려 전체 폭을 준다.
                  // 좁은 패널에서 truncate로 근거가 잘리던 문제 완화 (UX 감사 §C). 병합 제안 truncate(max-w-160)는 상단 줄에 그대로 유지.
                  const showReasonBelow = s.suggested !== null && !s.match;
                  return (
                    <div key={s.field} className="py-2 border-t border-slate-100">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-slate-700 w-[72px] shrink-0">{s.label}</span>
                        <span className="text-[11px] text-slate-500 truncate max-w-[88px]" title={s.current ?? undefined}>
                          {s.current ?? "— 미입력"}
                        </span>
                        {s.suggested === null ? (
                          <span className="text-[11px] text-slate-500 flex-1 truncate" title={s.reason}>
                            판단 불가: {s.reason}
                          </span>
                        ) : s.match ? (
                          <>
                            <Equal className="w-3 h-3 text-slate-300 shrink-0" />
                            <span className="text-[11px] text-slate-500 flex-1 truncate" title={s.reason}>
                              일치, 반영됨
                            </span>
                          </>
                        ) : (
                          <>
                            <ArrowRight className="w-3 h-3 text-slate-300 shrink-0" />
                            {/* 카테고리 병합 제안처럼 긴 문자열은 잘라 표시 — 전체는 title로 */}
                            <span
                              className="text-[11px] font-semibold text-emerald-700 shrink-0 truncate max-w-[160px]"
                              title={s.suggested}
                            >
                              {s.suggested}
                            </span>
                            <span className="flex-1" />
                          </>
                        )}
                      </div>
                      {showReasonBelow && (
                        <div className="text-[10px] text-slate-500 pl-[80px] mt-0.5 break-words" title={s.reason}>
                          {s.reason}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="pt-1 border-t border-slate-100">
                <span className="text-[10px] text-slate-500 block">
                  {/* 경계값은 seller-fit.ts 상수에서 파생 — 규칙과 안내문의 어긋남 방지 (UX 감사 P0-2) */}
                  적합성은 4개 평가 합산으로 자동 재계산 ({FIT_RECOMMEND_THRESHOLD + 1}점 이상 추천 ·{" "}
                  {FIT_HOLD_THRESHOLD + 1}~{FIT_RECOMMEND_THRESHOLD} 보류) · 변경 이력은 감사 로그에 기록 ·
                  제안과 현재가 다르면 재분석 시 반영됩니다
                </span>
              </div>
            </div>
          )}

          {/* T3 전체 분석 리포트 (딥다이브·피드 프리뷰) */}
          <a
            href={`/sellers/${sellerId}`}
            className="flex items-center justify-center gap-1.5 text-[11px] font-semibold text-blue-600 border border-blue-200 rounded-lg py-2 hover:bg-blue-50"
          >
            <ExternalLink className="size-3" />
            전체 분석 리포트 열기
          </a>
        </div>
      )}
    </div>
  );
}
