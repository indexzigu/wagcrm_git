"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DealVocView, VocInsightPayload } from "@/lib/order-converter/voc-store";

/**
 * 딜 상세 "고객 반응" v2 — AI 요약 카드가 1급, 원문은 드릴다운(PR B, 계획 §6-6).
 * 시안: ss-ux-designer(2026-07-17) — 판단 순서 ①조치(미답변·심각불만·기대불일치) ②판매 소재
 * ③브랜드 전달 ④근거 원문. 색은 심각도 축(status 토큰)만 — praises 등 판단 무관 항목은 무채색.
 * 데이터는 GET /api/deals/[id]/voc 스냅샷·집계뿐(LLM 무호출 — I1). 수동 갱신만 POST refresh.
 */

const REFRESH_COOLDOWN_MS = 5 * 60_000; // 서버 게이트(evaluateManualRefreshGate)의 클라 미러

type FetchState = { view: DealVocView | null; loading: boolean; error: string | null };

/** 오늘/어제/N일 전 — 시·분 단위는 과함(시안 P1). */
function relativeDay(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  return `${days}일 전`;
}

/** payload 내부 배열 방어(코드리뷰 LOW2) — 스냅샷 writer(parseInsightPayload)의 불변식이 깨져도 섹션이 죽지 않게. */
function sanitizeInsightPayload(raw: unknown): VocInsightPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Partial<VocInsightPayload>;
  return {
    summary: typeof p.summary === "string" ? p.summary : "",
    praises: Array.isArray(p.praises) ? p.praises : [],
    complaints: Array.isArray(p.complaints) ? p.complaints : [],
    faq: Array.isArray(p.faq) ? p.faq : [],
    mismatchShare: typeof p.mismatchShare === "number" ? p.mismatchShare : null,
    contentAngles: Array.isArray(p.contentAngles) ? p.contentAngles : [],
    brandFeedback: Array.isArray(p.brandFeedback) ? p.brandFeedback : [],
  };
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, mid: 1, low: 2 };
const SEVERITY_LABEL: Record<string, string> = { high: "심각", mid: "주의", low: "경미" };

function severityBadgeVariant(severity: string): "status-urgent" | "status-caution" | "outline" {
  if (severity === "high") return "status-urgent";
  if (severity === "mid") return "status-caution";
  return "outline"; // low = 무채색 랭크 선언(리스크카드 slate 선례)
}

/** 조치 신호 배너(시안 ②) — high 불만 or 기대불일치 임계 이상일 때만. 임계는 P1(실측 후 조정). */
function computeActionSignal(payload: VocInsightPayload): { level: "urgent" | "caution"; text: string } | null {
  const highCount = payload.complaints.filter((c) => c.severity === "high").length;
  const mismatch = payload.mismatchShare;
  const parts: string[] = [];
  if (highCount > 0) parts.push(`심각 불만 ${highCount}건`);
  if (mismatch != null && mismatch >= 0.15) parts.push(`기대불일치 언급 ${Math.round(mismatch * 100)}%`);
  if (parts.length === 0) return null;
  const urgent = highCount > 0 || (mismatch != null && mismatch >= 0.35);
  return { level: urgent ? "urgent" : "caution", text: `${parts.join(" · ")}, 확인 필요` };
}

export function DealVocSection({ dealId }: { dealId: string }) {
  const [{ view, loading, error }, setState] = useState<FetchState>({ view: null, loading: true, error: null });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // 쿨다운은 불리언 상태 + 만료 타이머 1회로 표현한다(렌더에서 Date.now() 비교 금지 — react purity).
  const [cooldownActive, setCooldownActive] = useState(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // await 가능해야 한다 — 갱신 버튼이 GET 완료까지 refreshing 라벨을 유지(ss-ux 레이스 지적).
  // useEffect 취소는 flag 객체로(이 함수가 cleanup을 반환하면 effect가 promise를 cleanup으로 오인).
  const load = useCallback(
    async (flag?: { cancelled: boolean }) => {
      setState((s) => ({ ...s, loading: s.view == null, error: null }));
      try {
        const res = await fetch(`/api/deals/${dealId}/voc`);
        if (!res.ok) throw new Error("고객 반응을 불러오지 못했습니다.");
        const data = (await res.json()) as Partial<DealVocView>;
        if (flag?.cancelled) return;
        // 방어적 정규화 — 예상 밖 응답이 섹션(및 패널)을 크래시시키지 않게 한다.
        setState({
          view: {
            qnas: Array.isArray(data?.qnas) ? data.qnas : [],
            unansweredQnaCount: typeof data?.unansweredQnaCount === "number" ? data.unansweredQnaCount : 0,
            reviewSummaries: Array.isArray(data?.reviewSummaries) ? data.reviewSummaries : [],
            reviewSource: { needsLink: data?.reviewSource?.needsLink === true },
            insight:
              data?.insight && typeof data.insight === "object"
                ? {
                    payload: sanitizeInsightPayload(data.insight.payload),
                    generatedAt: data.insight.generatedAt ?? null,
                    lastError: data.insight.lastError ?? null,
                    totalVoc: typeof data.insight.totalVoc === "number" ? data.insight.totalVoc : 0,
                    minInitial: typeof data.insight.minInitial === "number" ? data.insight.minInitial : 5,
                  }
                : { payload: null, generatedAt: null, lastError: null, totalVoc: 0, minInitial: 5 },
          },
          loading: false,
          error: null,
        });
      } catch (e) {
        if (!flag?.cancelled)
          setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : "불러오기 실패" }));
      }
    },
    [dealId],
  );

  useEffect(() => {
    const flag = { cancelled: false };
    void load(flag);
    return () => {
      flag.cancelled = true;
    };
  }, [load]);
  useEffect(
    () => () => {
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    },
    [],
  );

  /** 쿨다운 시작 — 만료 시점에 1회 타이머로 버튼 재활성(인터벌 카운트다운 금지 — 시안 ③). */
  const armCooldown = useCallback((ms: number) => {
    setCooldownActive(true);
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = setTimeout(() => setCooldownActive(false), ms);
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/voc/refresh`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSec?: number };
      if (res.status === 429) {
        armCooldown(Math.max(1, body.retryAfterSec ?? 60) * 1000);
        return;
      }
      if (res.status === 400) {
        // below-min — 서버도 쿨다운을 안 걸므로 로컬 쿨다운 없이 사유만 표시(코드리뷰 LOW4)
        setRefreshError(body.error ?? "분석할 문의·리뷰가 아직 부족합니다.");
        return;
      }
      if (!res.ok) {
        setRefreshError(body.error ?? "분석 갱신에 실패했습니다.");
        armCooldown(REFRESH_COOLDOWN_MS); // 실패도 쿨다운(연타로 LLM 낭비 방지 — 서버 게이트 미러)
        return;
      }
      armCooldown(REFRESH_COOLDOWN_MS);
      // 성공 무음 — 갱신된 요약 렌더가 피드백(P2 토스트 소유 규칙). GET 완료까지 refreshing 유지
      // (라벨이 stale 문구로 잠깐 되돌아가는 레이스 방지 — ss-ux 지적).
      await load();
    } catch {
      setRefreshError("분석 갱신에 실패했습니다.");
    } finally {
      setRefreshing(false);
    }
  }, [dealId, armCooldown, load]);

  const insight = view?.insight ?? null;
  const payload = insight?.payload ?? null;
  const qnas = view?.qnas ?? [];
  const reviewRows = view?.reviewSummaries.filter((r) => r.reviewCount > 0) ?? [];
  const reviewTotal = reviewRows.reduce((sum, r) => sum + r.reviewCount, 0);
  const qnaTotal = Math.max(0, (insight?.totalVoc ?? qnas.length) - reviewTotal);
  const belowMin = insight != null && insight.totalVoc < insight.minInitial;
  const actionSignal = payload ? computeActionSignal(payload) : null;
  const sortedComplaints = payload
    ? [...payload.complaints].sort(
        (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
      )
    : [];

  return (
    <div className="space-y-3 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      {/* 헤더 — 제목+보조 액션만, 판단 신호 없음(시안 P0) */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-foreground">고객 반응</h3>
        {/* 전역 프로바이더 없음 — 컴포넌트 로컬 래핑이 이 레포 관례(inline-edit-field 등 5곳 선례) */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* disabled 버튼은 hover 이벤트가 죽어 툴팁이 안 뜬다 — span 래핑으로 트리거 유지 */}
              <span>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={refreshing || cooldownActive || belowMin || loading}
                  onClick={handleRefresh}
                  aria-label="AI 요약 다시 분석"
                >
                  {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {belowMin
                ? `문의·리뷰 ${insight?.minInitial ?? 5}건 이상부터 분석할 수 있어요`
                : cooldownActive
                  ? "잠시 후 다시 시도할 수 있어요 (약 5분 간격)"
                  : "AI 요약 다시 분석"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-white/80 p-3">
          <p className="text-xs text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={() => load()} className="shrink-0">
            다시 시도
          </Button>
        </div>
      )}

      {!loading && !error && view != null && insight != null && (
        <>
          {/* 메타 행 — 정량(실시간·미답변만 색) + AI 신선도 */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              문의 {qnaTotal.toLocaleString("ko-KR")}건
              {view.unansweredQnaCount > 0 && (
                <Badge variant="status-caution">미답변 {view.unansweredQnaCount}</Badge>
              )}
              {reviewTotal > 0 && <span>· 리뷰 {reviewTotal.toLocaleString("ko-KR")}건</span>}
            </span>
            {payload != null && insight.generatedAt != null && (
              <span className="flex items-center gap-1 text-[11px]">
                <Sparkles className="size-3 text-muted-foreground" aria-hidden />
                {refreshing ? "AI 요약 갱신 중…" : `AI 요약 · ${relativeDay(insight.generatedAt)} 분석`}
              </span>
            )}
          </div>

          {/* 리뷰 소스 부재 안내(오너 데이터 경로 ②) — 판단 무관 시스템 노트라 무채색
              (lastError 노트와 동일 어휘, ss-ux 판정). 링크 입력 UI는 캠페인 패널 소관 — 안내만. */}
          {view.reviewSource.needsLink && (
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <AlertCircle className="size-3 shrink-0" aria-hidden />
              리뷰 수집 소스가 아직 연결되지 않았습니다. 캠페인에 공구 상품 링크를 입력하면 다음
              자동 수집부터 리뷰를 가져옵니다.
            </p>
          )}

          {/* 직전 실패 메모 — 파이프라인 상태라 status 축 안 씀(시안 P0). 이전 요약은 보존 표시 */}
          {insight.lastError != null && payload != null && (
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <AlertCircle className="size-3 shrink-0" aria-hidden />
              최근 갱신 시도가 실패해 이전 요약을 보여주고 있습니다.
            </p>
          )}
          {refreshError != null && (
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <AlertCircle className="size-3 shrink-0" aria-hidden />
              {refreshError}
            </p>
          )}

          {/* ── AI 요약 본문 ── */}
          {payload != null && (
            <div className="space-y-3">
              {/* 조치 신호 배너 — 캐리어 3중(배경 tint+아이콘+텍스트, 시안 P0) */}
              {actionSignal != null && (
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium",
                    // 배너(박스형 알림)의 색 페어링은 schedule-gap-summary-strip 관용구를 따른다
                    // (ss-ux 검토: /10 틴트는 badge의 urgent 한정 관례 — 배너·caution엔 -bg 고정 토큰이 정본)
                    actionSignal.level === "urgent"
                      ? "bg-status-urgent-bg text-status-urgent-text"
                      : "bg-status-caution-bg text-status-caution",
                  )}
                >
                  <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                  <span>{actionSignal.text}</span>
                </div>
              )}

              {/* 총평 — 카드의 리드 */}
              {payload.summary && <p className="text-sm text-foreground">{payload.summary}</p>}

              {/* 불만·이슈 — severity 내림차순 재정렬(시안 P0), 색을 받는 유일한 목록 */}
              {sortedComplaints.length > 0 && (
                <section className="space-y-1.5">
                  <h4 className="text-[11px] font-medium text-muted-foreground">불만·이슈</h4>
                  <ul className="space-y-1.5">
                    {sortedComplaints.map((c, i) => (
                      <li key={`${i}-${c.label}`} className="rounded-lg border border-border/60 bg-white/80 p-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm text-foreground">
                            {c.label} <span className="text-muted-foreground">({c.count}건)</span>
                          </span>
                          <Badge variant={severityBadgeVariant(c.severity)} className="shrink-0">
                            {SEVERITY_LABEL[c.severity] ?? c.severity}
                          </Badge>
                        </div>
                        {c.quotes[0] && (
                          <p className="mt-1 border-l-2 border-border/50 pl-2 text-[11px] italic text-muted-foreground">
                            “{c.quotes[0]}”
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* 판매 소재(판단②) — 무채색 고정(시안 P0) */}
              {payload.praises.length > 0 && (
                <section className="space-y-1">
                  <h4 className="text-[11px] font-medium text-muted-foreground">소구 포인트</h4>
                  <ul className="divide-y divide-border/40">
                    {payload.praises.map((p, i) => (
                      <li key={`${i}-${p.label}`} className="py-1.5">
                        <span className="text-sm text-foreground">{p.label}</span>
                        <span className="ml-1 text-xs text-muted-foreground">({p.count}건)</span>
                        {p.quotes[0] && (
                          <p className="mt-0.5 border-l-2 border-border/50 pl-2 text-[11px] italic text-muted-foreground">
                            “{p.quotes[0]}”
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {payload.contentAngles.length > 0 && (
                <section className="space-y-1">
                  <h4 className="text-[11px] font-medium text-muted-foreground">콘텐츠 소재</h4>
                  <ul className="list-disc space-y-1 pl-4 text-sm text-foreground marker:text-slate-300">
                    {payload.contentAngles.map((a, i) => (
                      <li key={`${i}-${a.slice(0, 20)}`}>{a}</li>
                    ))}
                  </ul>
                </section>
              )}

              {payload.brandFeedback.length > 0 && (
                <section className="space-y-1">
                  <h4 className="text-[11px] font-medium text-muted-foreground">브랜드사 전달 후보</h4>
                  <ul className="list-disc space-y-1 pl-4 text-sm text-foreground marker:text-slate-300">
                    {payload.brandFeedback.map((b, i) => (
                      <li key={`${i}-${b.slice(0, 20)}`}>{b}</li>
                    ))}
                  </ul>
                </section>
              )}

              {payload.faq.length > 0 && (
                <section className="space-y-2">
                  <h4 className="text-[11px] font-medium text-muted-foreground">자주 묻는 질문</h4>
                  {payload.faq.map((f, i) => (
                    <div key={`${i}-${f.q.slice(0, 20)}`} className="text-sm">
                      <p className="text-foreground">Q. {f.q}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{f.a ? `A. ${f.a}` : "(미답변)"}</p>
                    </div>
                  ))}
                </section>
              )}
            </div>
          )}

          {/* 분석 전 상태 — 대기(최소치 미만) / 분석 전(충족·크론 대기) */}
          {payload == null && (
            <div className="rounded-lg border border-dashed border-border/60 bg-white/80 p-3">
              <p className="text-xs text-muted-foreground">
                {belowMin
                  ? `문의·리뷰를 합쳐 ${insight.minInitial}건 미만이라 아직 요약할 내용이 없습니다. 데이터가 쌓이면 자동으로 분석합니다.`
                  : "아직 분석 전입니다. 매일 아침 자동 분석되며, 위 갱신 버튼으로 지금 분석할 수도 있습니다."}
              </p>
            </div>
          )}

          {/* 원문 드릴다운(판단④) — v1 마크업 이관, Accordion으로 접근성 확보(시안 P0) */}
          {(qnas.length > 0 || reviewRows.length > 0) && (
            <Accordion type="single" collapsible>
              <AccordionItem value="raw" className="border-b-0">
                <AccordionTrigger className="py-1 text-xs text-muted-foreground hover:no-underline">
                  원문 전체 보기 ({qnas.length}건{reviewTotal > 0 ? ` · 리뷰 ${reviewTotal}건` : ""})
                </AccordionTrigger>
                <AccordionContent className="space-y-2 pb-1">
                  {reviewRows.map((r) => (
                    <ReviewSummaryRow key={r.channel} summary={r} />
                  ))}
                  {qnas.length > 0 && (
                    <ul className="space-y-2">
                      {qnas.map((q) => (
                        <li key={q.questionId} className="rounded-lg border border-border/60 bg-white/80 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm text-foreground">{q.question}</p>
                            <Badge variant={q.answered ? "secondary" : "status-caution"} className="shrink-0">
                              {q.answered ? "답변완료" : "미답변"}
                            </Badge>
                          </div>
                          {q.answer && (
                            <p className="mt-2 border-l-2 border-border/60 pl-2 text-xs text-muted-foreground">
                              {q.answer}
                            </p>
                          )}
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {new Date(q.createDate).toLocaleDateString("ko-KR")}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
        </>
      )}
    </div>
  );
}

function ReviewSummaryRow({ summary }: { summary: DealVocView["reviewSummaries"][number] }) {
  const total = summary.reviewCount;
  return (
    <div className="rounded-lg border border-border/60 bg-white/80 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-foreground">
          리뷰 {total.toLocaleString("ko-KR")}건
          {summary.avgRating != null && (
            <span className="ml-2 text-muted-foreground">평균 {summary.avgRating.toFixed(1)}점</span>
          )}
        </span>
        {summary.photoCount > 0 && (
          <span className="text-xs text-muted-foreground">포토 {summary.photoCount}</span>
        )}
      </div>
      {/* 평점 분포 — 5점부터 1점까지 중립 막대(색 판단 신호 아님, 비율만) */}
      <div className="mt-2 space-y-1">
        {[5, 4, 3, 2, 1].map((star) => {
          const n = summary.ratingCounts[String(star)] ?? 0;
          const pct = total > 0 ? Math.round((n / total) * 100) : 0;
          return (
            <div key={star} className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="w-6 shrink-0">{star}점</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-slate-400" style={{ width: `${pct}%` }} />
              </div>
              <span className="w-8 shrink-0 text-right">{n}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
