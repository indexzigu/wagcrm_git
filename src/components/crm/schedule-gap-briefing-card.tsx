"use client";


import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ScheduleGapBriefing, BucketUrgency } from "@/lib/schedule-gap-briefing";

// ── 스타일 매핑 ─────────────────────────────────────────────
// PALETTE_IMPL_SPEC.md (오너 승인, 2026-07-09): DANGER/URGENT/CAUTION은 원래 서로 다른
// 3개 주황(#B8662D/#C97A40/#E7A567)이 뒤섞여 있었고(예: CAUTION의 tagText가 DANGER의
// 원색을, textColor가 URGENT의 원색을 빌려 씀) — "3개의 무관한 주황"을 하나의
// amber/red 상태 그라데이션으로 수렴: DANGER→urgent, URGENT→pending, CAUTION→caution.
// 각 티어는 이제 자기 자신의 토큰 하나만 사용(하위 5개 속성 전부).
const urgencyConfig: Record<
  BucketUrgency,
  {
    label: string;
    barBg: string;
    barBorder: string;
    tagBg: string;
    tagText: string;
    textColor: string;
    // 폰트 굵기 — 색상/투명도를 낮추지 않고도 티어 간 강도 차이를 표현하는 축(WCAG AA
    // 대비 훼손 없이 위계 유지). 기본은 font-bold, CAUTION만 한 단계 낮춤.
    weight: string;
  }
> = {
  OK: {
    label: "확보",
    barBg: "bg-primary",
    barBorder: "border-transparent",
    tagBg: "bg-primary/8",
    tagText: "text-primary",
    textColor: "text-white",
    weight: "font-bold",
  },
  DANGER: {
    label: "위험",
    barBg: "bg-[var(--status-urgent-bg)]",
    barBorder: "border-[var(--status-urgent-text)]/40",
    tagBg: "bg-[var(--status-urgent-text)]",
    tagText: "text-white",
    textColor: "text-[var(--status-urgent-text)]",
    weight: "font-bold",
  },
  URGENT: {
    label: "긴급",
    barBg: "bg-[var(--status-pending)]/8",
    barBorder: "border-[var(--status-pending)]/30",
    tagBg: "bg-[var(--status-pending)]/15",
    tagText: "text-[var(--status-pending)]",
    textColor: "text-[var(--status-pending)]",
    weight: "font-bold",
  },
  CAUTION: {
    label: "주의",
    barBg: "bg-[var(--status-caution-bg)]",
    barBorder: "border-[var(--status-caution)]/25",
    tagBg: "bg-[var(--status-caution)]/12",
    // 불투명 --status-caution-text(amber-800)로 교체 — 기존 --status-caution/80·/70은
    // 흰 배경 2.96:1, 태그 배경 위 4.26:1로 AA 미달. CAUTION이 URGENT보다 조용해 보여야
    // 한다는 의도는 색이 아니라 아래 weight(font-semibold)로 옮겨 표현.
    tagText: "text-[var(--status-caution-text)]",
    textColor: "text-[var(--status-caution-text)]",
    weight: "font-semibold",
  },
  PREPARE: {
    label: "준비",
    barBg: "bg-slate-50",
    barBorder: "border-black/5",
    tagBg: "bg-slate-100",
    tagText: "text-muted-foreground",
    textColor: "text-muted-foreground/60",
    weight: "font-bold",
  },
};

// 바 높이: 최대 건수 기준 비율 계산
const MAX_BAR_HEIGHT = 120; // px
const MIN_BAR_HEIGHT = 28;  // px (0건일 때도 최소 높이)

function FunnelDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block size-[6px] rounded-full shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

// bare 본문 — Card·제목 없이 서브텍스트+바+퍼널만(탭 패널용, 오너 2026-07-24). 향후 14일 일정과
// 탭으로 묶을 때 탭 패널이 직접 소비한다. 배지(N구간 확보 필요)는 탭 배지로 옮겨간다.
export function ScheduleGapBriefingBody({ data }: { data: ScheduleGapBriefing }) {
  const { buckets, gaps, funnel } = data;
  const maxCount = Math.max(...buckets.map((b) => b.confirmedCount), 1);
  // 확보 필요(위험/긴급) 날짜 구간 — 주간 버킷이 아니라 일 단위 갭 기준(item 10).
  const riskyGaps = gaps.filter((g) => g.urgency === "DANGER" || g.urgency === "URGENT");

  return (
    <div>
      <p className="text-[11px] leading-relaxed text-muted-foreground/70">
        향후 12주 확정 캠페인 현황 - 주간 단위
      </p>

        {/* ── 바 차트 타임라인 ──────────────────── */}
        <div className="mt-5">
          <div className="flex gap-1.5">
            {buckets.map((bucket) => {
              const config = urgencyConfig[bucket.urgency];
              const barHeight =
                bucket.confirmedCount === 0
                  ? MIN_BAR_HEIGHT
                  : Math.max(
                      MIN_BAR_HEIGHT,
                      (bucket.confirmedCount / maxCount) * MAX_BAR_HEIGHT,
                    );
              const isEmpty = bucket.confirmedCount === 0;

              return (
                <TooltipProvider key={bucket.startDate} delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex-1 flex flex-col items-center gap-1.5 group cursor-default">
                        {/* 날짜 레이블 */}
                        <span className="text-[9px] font-medium text-muted-foreground/50 tracking-tight whitespace-nowrap">
                          {bucket.label}
                        </span>

                        {/* 바 컨테이너 — 아래 정렬 */}
                        <div
                          className="w-full flex items-end justify-center"
                          style={{ height: `${MAX_BAR_HEIGHT}px` }}
                        >
                          <div
                            className={`
                              w-full rounded-lg border transition-[height,scale,opacity,background-color,border-color] duration-300
                              flex items-center justify-center
                              ${isEmpty
                                ? `${config.barBg} ${config.barBorder} border-dashed`
                                : `${config.barBg} border-transparent`
                              }
                              ${isEmpty ? "group-hover:scale-[1.03]" : "group-hover:opacity-90"}
                            `}
                            style={{ height: `${barHeight}px` }}
                          >
                            <span
                              className={`text-sm ${isEmpty ? config.weight : "font-bold"} ${
                                isEmpty ? config.textColor : "text-white"
                              }`}
                            >
                              {bucket.confirmedCount}
                            </span>
                          </div>
                        </div>

                        {/* 긴급도 태그 (공백 구간만) */}
                        {isEmpty ? (
                          <span
                            className={`
                              inline-flex items-center rounded-md px-1.5 py-[2px]
                              text-[9px] ${config.weight} tracking-wide
                              ${config.tagBg} ${config.tagText}
                            `}
                          >
                            {config.label}
                          </span>
                        ) : (
                          <span className="text-[9px] font-medium text-muted-foreground">
                            확보
                          </span>
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      className="flex flex-col items-start gap-1.5 p-3 min-w-[160px] max-w-[240px] bg-slate-950 border border-slate-800 text-white shadow-overlay"
                    >
                      <p className="text-xs font-semibold text-white whitespace-nowrap">
                        {bucket.label}
                      </p>
                      <p className="text-[11px] text-slate-300 whitespace-nowrap">
                        {bucket.confirmedCount > 0
                          ? `확정 ${bucket.confirmedCount}건`
                          : "확정 일정 없음"}
                      </p>
                      {bucket.campaigns.length > 0 && (
                        <ul className="mt-1.5 w-full border-t border-slate-800 pt-1.5 space-y-1">
                          {bucket.campaigns.slice(0, 3).map((c) => (
                            <li
                              key={c.id}
                              className="text-[10px] text-slate-300 truncate w-full"
                            >
                              {c.label}
                            </li>
                          ))}
                        </ul>
                      )}
                      {bucket.actionLabel && (
                        <p className="mt-1.5 text-[10px] font-semibold text-orange-400 whitespace-nowrap">
                          → {bucket.actionLabel}
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            })}
          </div>

          {/* ── 확보 필요 날짜 구간 요약 (위험/긴급만) — 일 단위 갭 기준(item 10) ─── */}
          {/* PALETTE_IMPL_SPEC.md (2026-07-09): border + per-row day-count/action text
              still a single static urgent-token accent for the whole box (unchanged
              logic — this box mixes DANGER+URGENT rows under one accent, same as
              before); bg-[#FBF7F0] cream wash is unrelated and left as-is. */}
          {riskyGaps.length > 0 && (
            <div className="mt-3 rounded-lg border border-[var(--status-urgent-text)]/10 bg-[#FBF7F0]/60 px-3 py-2">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {riskyGaps.map((g) => (
                  <div key={g.startDate} className="flex items-baseline gap-1.5">
                    <span
                      className={`text-[10px] font-bold ${urgencyConfig[g.urgency].tagText} ${urgencyConfig[g.urgency].tagBg} rounded px-1 py-[1px]`}
                    >
                      {g.label}
                    </span>
                    <span className="text-[10px] text-[var(--status-urgent-text)]">{g.dayCount}일</span>
                    <span className="text-[10px] font-medium text-[var(--status-urgent-text)]">{g.actionLabel}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── 캠페인 퍼널 ──────── */}
        <div className="mt-4 flex items-center border-t border-black/5 pt-3">
          <div className="flex items-center gap-3 text-[11px]">
            <span className="font-semibold text-muted-foreground/70 shrink-0">
              캠페인
            </span>
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="inline-flex items-center gap-1">
                <FunnelDot color="var(--primary)" />
                <span className="text-muted-foreground/80">확정 대기</span>
                <span className="font-bold text-[#1F2A30]">{funnel.readyDeals}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <FunnelDot color="#2E7D9B" />
                <span className="text-muted-foreground/80">제안</span>
                <span className="font-bold text-[#1F2A30]">{funnel.proposedTasks}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <FunnelDot color="#C97A40" />
                <span className="text-muted-foreground/80">협의·테스트</span>
                <span className="font-bold text-[#1F2A30]">{funnel.negotiatingTasks}</span>
                {funnel.stagnantTasks > 0 && (
                  // PALETTE_IMPL_SPEC.md (2026-07-09): 지연 경고 = urgent 의미 → urgent 토큰.
                  <span className="ml-0.5 inline-flex items-center justify-center rounded bg-[var(--status-urgent-text)]/10 px-1.5 py-0.5 text-[9px] font-bold text-[var(--status-urgent-text)]">
                    지연 {funnel.stagnantTasks}건
                  </span>
                )}
              </span>
              <span className="inline-flex items-center gap-1">
                <FunnelDot color="#5D9B6E" />
                <span className="text-muted-foreground/80">승인</span>
                <span className="font-bold text-[#1F2A30]">{funnel.pendingApproval}</span>
              </span>
            </div>
          </div>
        </div>
    </div>
  );
}

// 풀폭 카드 래퍼는 삭제됨(오너 2026-07-24, ss-ux 지적) — 다가올 14일 일정과 탭으로 묶으면서
// 프로덕션·테스트 어디서도 참조되지 않는 고아가 됐다. 헤더(제목·N구간 배지)는 SegmentedTabCard 의
// 탭 라벨·카운트 배지가 대신하고, 본문은 위 ScheduleGapBriefingBody 를 직접 소비한다.
