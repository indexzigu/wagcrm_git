"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, Play, Radar } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ko } from "date-fns/locale";
import { KNOWN_JOBS, type KnownJob } from "@/lib/cron-jobs";
import { overdueSummary } from "@/lib/cron-staleness";
import { parseNeedsReviewDetail } from "@/lib/system-task-needs-review";

interface TaskStatus {
  id: string;
  jobKey: string;
  status: "SUCCESS" | "ERROR" | "RUNNING";
  lastRunAt: string | null;
  nextExpectedRunAt: string | null;
  lastErrorMessage: string | null;
}

interface CollectHealth {
  monitored: number;
  snapshotsFresh: number;
  intervalDays: number;
  mirrored: number;
}

// 잡 목록·예정 시각·설명은 src/lib/cron-jobs.ts(SSOT)에서 온다 — 수동 실행 API의 허용
// 목록도 같은 파일에서 파생되므로, 여기 행이 있으면 실행 버튼은 반드시 통한다.

interface TaskLogEntry {
  id: string;
  status: "SUCCESS" | "ERROR" | string;
  message: string | null;
  details: unknown;
  createdAt: string;
}

const STATUS_META = {
  SUCCESS: { dotClass: "bg-[var(--status-success)]", label: "정상" },
  ERROR: { dotClass: "bg-[var(--status-urgent)]", label: "실패" },
  OVERDUE: { dotClass: "bg-[var(--status-caution)]", label: "지연" },
  RUNNING: { dotClass: "bg-[var(--status-caution)]", label: "실행 중" },
  NONE: { dotClass: "bg-slate-300", label: "기록 없음" },
} as const;

/**
 * 행의 **실효 심각도**. 저장된 상태값은 "마지막 실행이 어땠는가"만 말하고 "그 실행이 언제였어야
 * 하는가"는 말하지 않는다 — 그래서 안 도는 잡이 마지막 성공(초록)을 그대로 달고 있었다
 * (로컬 레인 전환으로 상시 가능해진 무음 실패, 2026-08-04).
 *
 * 순위는 ERROR > 지연 > 실행중 > 정상이다. **실패가 지연을 이긴다** — 둘 다면 사유가 있는
 * 쪽(실패 메시지)이 오너에게 더 쓸모 있고, 지연은 그 실패의 결과일 뿐이다.
 *
 * ⚠️ 지연과 실행중은 같은 caution 토큰을 쓴다(새 hue 도입 금지 — P8 가드레일 2). 색만으로
 * 구분되지 않으므로 **지연은 텍스트 배지로, 실행중은 pulse 로** 각각 다른 캐리어를 함께 준다.
 */
function statusKey(task: TaskStatus | undefined, overdue = false): keyof typeof STATUS_META {
  if (!task) return "NONE";
  const stored = task.status in STATUS_META ? (task.status as keyof typeof STATUS_META) : "NONE";
  if (stored === "ERROR") return "ERROR";
  if (overdue) return "OVERDUE";
  return stored;
}

/**
 * `label` 은 caution 토큰을 **두 상태가 공유**하기 때문에 있다(지연·실행 중 — 새 hue 를 만들지
 * 않는다는 P8 가드레일 2의 결과). 범례에 같은 색 점을 두 줄로 늘어놓으면 "같은 색 = 같은 의미"가
 * 깨져 보이므로, 그 점 하나에 두 의미를 합쳐 적는다. 행에서는 텍스트 배지와 pulse 가 둘을 가른다.
 */
function LegendDot({ statusKey: key, label }: { statusKey: keyof typeof STATUS_META; label?: string }) {
  const meta = STATUS_META[key];
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden className={`size-1.5 rounded-full ${meta.dotClass}`} />
      <span className="text-[10px] text-muted-foreground/70">{label ?? meta.label}</span>
    </span>
  );
}

// 행 클릭 인박스 팝오버 본문 — Radix Popover(포털)로 전환(오너 2026-07-24: 팝업이 페이지 밖으로
// 잘리던 문제). 이전 수제 absolute 배치는 useLayoutEffect가 "열림 시점 1회"만 측정해, 스켈레톤
// 상태(짧음)로 열린 뒤 로그가 도착해 본문이 자라면 재교정 없이 뷰포트 아래로 넘쳤다. Radix는
// autoUpdate(크기 변화 관찰)로 flip/shift를 계속 재계산하고, 포털이라 조상 overflow 클리핑도 없다.
// 어느 방향에도 다 안 들어가는 극단은 available-height 캡 + 내부 스크롤로 흡수한다.
// 설명 섹션은 KNOWN_JOBS.desc를 그대로 쓰고, 작동 로그는 열릴 때마다 /api/system/task-log를
// fetch한다(빈도 낮은 행 클릭이라 재조회 허용 — Popover는 열림 시에만 마운트되므로 계약 유지).
function JobDetailPopoverContent({ job, onClose }: { job: KnownJob; onClose: () => void }) {
  const [logs, setLogs] = useState<TaskLogEntry[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLogs(null);
    setLogError(null);
    fetch(`/api/system/task-log?jobKey=${encodeURIComponent(job.key)}`)
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        if (json?.success) setLogs(Array.isArray(json.data) ? json.data : []);
        else setLogError(typeof json?.error === "string" ? json.error : "실행 로그를 불러오지 못했습니다.");
      })
      .catch(() => {
        if (!cancelled) setLogError("실행 로그를 불러오지 못했습니다.");
      });
    return () => {
      cancelled = true;
    };
  }, [job.key]);

  /**
   * 「확인 필요」는 **가장 최근 실행 1건에서만** 읽는다 — 이 섹션은 이력이 아니라 지금 상태다.
   * 지난 실행들의 같은 목록을 로그 줄마다 되풀이하면 매일 같은 2건이 20번 쌓여 신호가 죽고,
   * 최신 실행이 실패해 상세가 없을 때 옛 목록을 끌어다 쓰면 "지금 확인할 것"이라고 거짓말한다
   * (그 경우 섹션은 사라지고 로그의 실패 줄이 남는 게 맞다).
   */
  const needsReview = parseNeedsReviewDetail(logs?.[0]?.details);

  return (
    <PopoverContent
      align="start"
      sideOffset={6}
      collisionPadding={12}
      aria-label={`${job.name} 상세`}
      // 포털 밖이어도 React 이벤트는 트리(레이더 행)로 버블된다 — 행 토글까지 번지지 않게 차단
      onClick={(e) => e.stopPropagation()}
      className="flex w-[340px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-overlay max-h-[min(480px,var(--radix-popover-content-available-height))]"
    >
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-3.5 py-2.5">
          <div className="flex min-w-0 items-start gap-2">
            <span aria-hidden className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--primary)]" />
            <div className="min-w-0">
              <p className="truncate text-[12px] font-bold text-slate-700">{job.name}</p>
              <p className="text-[10px] text-slate-500">{job.cycle} {job.timeKst} KST</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 p-0.5 text-slate-500 hover:text-slate-600" aria-label="닫기">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="shrink-0 px-3.5 py-2.5">
          <p className="text-[11px] leading-relaxed text-slate-600">{job.desc}</p>
        </div>

        {needsReview.items.length > 0 && (
          <section
            aria-label="확인 필요"
            className="min-h-0 shrink-0 border-t border-slate-100 px-3.5 py-2.5"
          >
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              확인 필요 {needsReview.total}건
            </p>
            {/* 스크롤 영역은 키보드로도 닿아야 한다 — 포커스가 안 가면 마우스 없이는 아래 건을 못 본다. */}
            <ul tabIndex={0} className="max-h-[148px] space-y-2 overflow-y-auto pr-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring">
              {needsReview.items.map((item) => (
                <li key={item.key} className="flex items-start gap-2">
                  {/* 심각도 마커 — 지연·실행중과 같은 caution 토큰(새 hue 금지, P8 가드레일 2).
                      「확인 필요」는 실패(urgent)가 아니라 사람 판단을 기다리는 상태다. */}
                  <span
                    aria-hidden
                    className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--status-caution)]"
                  />
                  <div className="min-w-0 flex-1">
                    {/* 잘린 캠페인명으로 두 건을 구분 못 하면 판단 정보가 사라진다 — 전체는 title 로. */}
                    <p
                      title={item.campaignLabel ?? undefined}
                      className="truncate text-[11px] font-medium text-slate-700"
                    >
                      {item.campaignLabel ?? "이름 없는 캠페인"}
                    </p>
                    {(item.counterpartLabel || item.channelLabel) && (
                      <p
                        title={[item.counterpartLabel, item.channelLabel].filter(Boolean).join(" · ")}
                        className="truncate text-[10px] text-slate-500"
                      >
                        {[item.counterpartLabel, item.channelLabel].filter(Boolean).join(" · ")}
                      </p>
                    )}
                    {item.reasons.map((reason, index) => (
                      <p
                        key={`${item.key}:${reason.code}:${index}`}
                        className="mt-0.5 text-[10px] leading-snug text-slate-600"
                      >
                        {reason.message}
                      </p>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            {needsReview.capped && (
              <p className="mt-1.5 text-[10px] text-slate-500">
                기록 용량 때문에 {needsReview.items.length}건만 표시했습니다.
              </p>
            )}
          </section>
        )}

        {/* 로그 섹션만 flex-1·min-h-0 — available-height 캡이 걸리는 극단에서 이 목록이 줄며 스크롤로 흡수 */}
        <div className="flex min-h-0 flex-1 flex-col border-t border-slate-100 px-3.5 py-2.5">
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">작동 로그</p>
          {logError ? (
            <p className="text-[11px] text-[var(--status-urgent-text)]">{logError}</p>
          ) : logs === null ? (
            <div className="space-y-1.5">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="size-1.5 shrink-0 rounded-full bg-slate-200 animate-pulse" />
                  <span className="h-2.5 flex-1 rounded bg-slate-100 animate-pulse" />
                </div>
              ))}
            </div>
          ) : logs.length === 0 ? (
            <p className="text-[11px] text-slate-500">아직 기록된 실행 로그가 없습니다.</p>
          ) : (
            <div
              tabIndex={0}
              aria-label="작동 로그 목록"
              className="min-h-0 flex-1 max-h-[220px] space-y-1.5 overflow-y-auto pr-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
            >
              {logs.map((log) => (
                <div key={log.id} className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={`mt-1 size-1.5 shrink-0 rounded-full ${log.status === "SUCCESS" ? "bg-[var(--status-success)]" : "bg-[var(--status-urgent)]"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-[11px] leading-snug text-slate-700">
                      {log.message || (log.status === "SUCCESS" ? "정상 완료" : "오류 발생")}
                    </p>
                    <p className="text-[9px] tabular-nums text-slate-500">
                      {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true, locale: ko })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
    </PopoverContent>
  );
}

export function SystemRadarCard() {
  const [statuses, setStatuses] = useState<Record<string, TaskStatus>>({});
  const [health, setHealth] = useState<CollectHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // 인박스 팝오버는 한 번에 한 행만 — 상호 배타(오너 지시 3c)
  const [openJob, setOpenJob] = useState<string | null>(null);

  const fetchRadar = useCallback(async () => {
    try {
      const res = await fetch("/api/system/radar");
      if (!res.ok) throw new Error("시스템 레이더를 불러오지 못했습니다.");
      const json = await res.json();
      if (json.success) {
        const statusMap = json.data.reduce((acc: Record<string, TaskStatus>, curr: TaskStatus) => {
          acc[curr.jobKey] = curr;
          return acc;
        }, {});
        setStatuses(statusMap);
        setHealth(json.collectHealth ?? null);
        setError(null);
      } else {
        throw new Error(json.error || "알 수 없는 오류");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRadar();
  }, [fetchRadar]);

  // 수동 재실행 — GHA 스케줄 지연·누락 시 오너가 클릭 한 번으로 발화. 시크릿은 서버 라우트가
  // 대신 행사한다. 성공은 무음(대시보드 무음 계약) — 상태 점·시각 갱신으로만 표현하고,
  // 실패만 텍스트로 표면화한다.
  const runJob = useCallback(
    async (jobKey: string, jobName: string) => {
      setRunningJob(jobKey);
      setRunError(null);
      try {
        const res = await fetch("/api/system/cron-run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobKey }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) {
          const detail =
            (typeof json?.result?.error === "string" && json.result.error) ||
            (typeof json?.error === "string" && json.error) ||
            `HTTP ${json?.status ?? res.status}`;
          throw new Error(detail);
        }
        await fetchRadar();
      } catch (err: unknown) {
        setRunError(`${jobName} 수동 실행 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`);
      } finally {
        setRunningJob(null);
      }
    },
    [fetchRadar],
  );

  return (
    // 인박스 팝오버가 Radix Popover(포털)로 옮겨가 카드 overflow와 무관해짐 — 구 overflow-visible 오버라이드 제거
    <Card className="border-black/5 bg-white/85 shadow-soft-sm">
      <CardContent className="px-4 py-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Radar className="size-4 text-[var(--primary)]" />
            <h3 className="text-sm font-bold text-[var(--primary)] tracking-tight">시스템 레이더</h3>
            <p className="text-[10px] text-muted-foreground/70">자동화 스케줄 · 예정(KST) 대비 실제 작동</p>
          </div>
          <div className="flex items-center gap-3">
            <LegendDot statusKey="SUCCESS" />
            <LegendDot statusKey="ERROR" />
            <LegendDot statusKey="RUNNING" label="실행 중 · 지연" />
            <LegendDot statusKey="NONE" />
          </div>
        </div>

        {error && (
          <p className="mt-2 text-[11px] text-[var(--status-urgent)]">{error} 상태 점은 기록 없음으로 표시됩니다.</p>
        )}
        {runError && <p className="mt-2 text-[11px] text-[var(--status-urgent)]">{runError}</p>}

        {/* 2행 밀도(이름 줄 + 서브텍스트 줄)에 맞춰 열을 줄여 셀 폭을 확보 — 이름 잘림 해소(오너 3a) */}
        <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-1">
          {loading
            ? KNOWN_JOBS.map((job) => (
                <div key={job.key} className="flex items-start gap-1 py-1.5">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="size-2 rounded-full bg-slate-200 animate-pulse shrink-0" />
                      <span className="h-3 w-2/3 rounded bg-slate-100 animate-pulse" />
                    </div>
                    <span className="ml-4 block h-2.5 w-1/2 rounded bg-slate-100 animate-pulse" />
                  </div>
                </div>
              ))
            : KNOWN_JOBS.map((job) => {
                const task = statuses[job.key];
                // 지연 = 한 회차를 통째로 걸렀다. 판정 SSOT 는 cron-staleness(유예·주기별 임계).
                // 사유 문자열이 곧 지연 여부다(지연이 아니면 null) — 판정을 두 번 돌리지 않는다.
                const overdueText = overdueSummary(job, task?.lastRunAt ?? null);
                const key = statusKey(task, overdueText !== null);
                const meta = STATUS_META[key];
                const lastRunText = task?.lastRunAt
                  ? formatDistanceToNow(new Date(task.lastRunAt), { addSuffix: true, locale: ko })
                  : "기록 없음";
                const isRunningThis = runningJob === job.key;
                const isOpen = openJob === job.key;
                return (
                  <Popover key={job.key} open={isOpen} onOpenChange={(open) => setOpenJob(open ? job.key : null)}>
                    <div className="relative min-w-0">
                    <div className="group flex items-start gap-1">
                      {/* 행 클릭 → 인박스 팝오버(오너 3c). 이름을 첫 줄에 온전히 두고 메타는
                          서브텍스트로 내린다(오너 3a) — ▶ 버튼은 형제 요소라 중첩 인터랙티브 없음.
                          aria-haspopup/expanded는 Radix Trigger가 자동 부여 */}
                      <PopoverTrigger asChild>
                      <button
                        type="button"
                        title={`${job.name} 상세 · 클릭하여 설명·로그 보기`}
                        className="min-w-0 flex-1 -mx-1.5 rounded-lg px-1.5 py-1 text-left transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-[var(--primary)] focus-visible:outline-offset-1"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          {/* RUNNING만 live-indicator pulse — 종결 상태(SUCCESS/ERROR/NONE)는 정적 유지 */}
                          <span aria-hidden className={`size-2 rounded-full shrink-0 ${meta.dotClass}${key === "RUNNING" ? " pulse-beat-dot" : ""}`} />
                          <span className="sr-only">{meta.label}</span>
                          <span className="text-xs font-semibold text-slate-700">{job.name}</span>
                        </span>
                        {/* 실패 메시지는 행에 인라인으로 펼치지 않는다(오너 2026-07-24 2차 — 옆으로 너무
                            길어짐). 대신 서브텍스트에 "실패 사유" 앵커만 두고 전문은 hover 툴팁으로,
                            상세는 기존대로 행 클릭 팝오버로 본다. 행 높이는 상태와 무관하게 균일 유지. */}
                        <span className="mt-0.5 block pl-4 text-[10.5px] text-slate-500 truncate">
                          {job.cycle} {job.timeKst} <span aria-hidden>·</span> 마지막{" "}
                          <span className={key === "NONE" ? "font-normal" : "font-medium text-slate-600"}>{lastRunText}</span>
                          {/* 지연은 색 하나로 말하지 않는다 — caution 점은 '실행 중'과 같은 토큰이라
                              (P8 가드레일 2: 새 hue 금지) 텍스트 캐리어를 함께 준다. 사유는 툴팁으로
                              내려 행 높이를 상태와 무관하게 균일 유지한다(실패 사유 앵커와 같은 형태). */}
                          {key === "OVERDUE" && overdueText && (
                            <>
                              {" "}<span aria-hidden>·</span>{" "}
                              <TooltipProvider delayDuration={150}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span title="" className="font-medium text-[var(--status-caution-text)] underline decoration-dotted underline-offset-2 cursor-help">지연</span>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" align="start" className="max-w-[280px] break-words text-[11px]">
                                    {overdueText}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </>
                          )}
                          {key === "ERROR" && task?.lastErrorMessage && (
                            <>
                              {" "}<span aria-hidden>·</span>{" "}
                              <TooltipProvider delayDuration={150}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    {/* title="" 로 조상 button 의 네이티브 title 이 이 앵커 hover 시 겹쳐 뜨는 것을
                                        억제한다(Radix 툴팁만 보이게) — code-reviewer 지적 반영 */}
                                    <span title="" className="font-medium text-[var(--status-urgent-text)] underline decoration-dotted underline-offset-2 cursor-help">실패 사유</span>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" align="start" className="max-w-[280px] break-words text-[11px]">
                                    {task.lastErrorMessage}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </>
                          )}
                        </span>
                      </button>
                      </PopoverTrigger>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); runJob(job.key, job.name); }}
                        disabled={runningJob !== null}
                        aria-label={`${job.name} 지금 실행`}
                        title={`${job.name} 지금 실행 (스케줄 누락·지연 시 수동 발화)`}
                        className={`mt-1.5 shrink-0 rounded p-1 text-slate-500 transition-[color,background-color,opacity] duration-150 hover:bg-slate-100 hover:text-slate-700 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--primary)] disabled:pointer-events-none disabled:opacity-40 ${
                          // 상시 노출은 레이더 밀도를 해친다 — 데스크톱(mouse)은 행 hover/키보드 focus 시에만
                          // 드러나되, 터치(coarse pointer)는 hover가 없으므로 항상 노출한다. 실행 중인 버튼은
                          // 마우스가 벗어나도 스피너가 사라지면 안 되므로 hover 여부와 무관하게 강제 노출한다.
                          isRunningThis ? "opacity-100" : "opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
                        }`}
                      >
                        {runningJob === job.key ? (
                          <Loader2 aria-hidden className="size-3 animate-spin" />
                        ) : (
                          <Play aria-hidden className="size-3" />
                        )}
                      </button>
                    </div>
                    {/* Radix가 열림 시에만 마운트 — 마운트 시 로그 fetch 계약 유지 */}
                    <JobDetailPopoverContent job={job} onClose={() => setOpenJob(null)} />
                    </div>
                  </Popover>
                );
              })}
        </div>

        {/* 수집 건강 — 상태 점(돌았나)과 별개로 "결과물이 쌓였나". 크론이 매일 돌며 갱신일이
            주기(기본 7일)를 넘긴 셀러만 수집하므로, 정상이면 이 값은 monitored에 붙어 있다.
            떨어져 있으면 특정 셀러가 계속 실패·이월되고 있다는 신호다. */}
        {!loading && health && health.monitored > 0 && (
          <p
            className="mt-2.5 border-t border-slate-100 pt-2 text-[11px] text-slate-500"
            title={`감시 IG 셀러 기준 · 최근 ${health.intervalDays}일 안에 갱신된 수(정상이면 전원) · 미러링 = 프로필 이미지가 내부 저장소로 영구 보존된 수`}
          >
            최근 {health.intervalDays}일 갱신{" "}
            <span className="font-semibold tabular-nums text-slate-700">
              {health.snapshotsFresh}/{health.monitored}
            </span>
            <span aria-hidden className="mx-1.5 text-slate-300">·</span>
            프로필 미러링{" "}
            <span className="font-semibold tabular-nums text-slate-700">
              {health.mirrored}/{health.monitored}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
