"use client";

// 향후 14일 일정 — 가로 타임라인 레일(날짜 노드) + 활성일 카드. 종전 dashboard-home 인라인
// 블록을 컴포넌트로 추출(오너 2026-07-24, 일정 커버리지와 탭으로 묶기 위함). bare 는 Card·제목
// 없이 본문만(탭 패널용), full 은 Card+제목까지.

import Link from "next/link";
import { Banknote } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface UpcomingEvent {
  date: string;
  type: string;
  label: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isMoney = (type: string) => type.includes("입금") || type.includes("지급");
/**
 * 이미 오간 돈인가 — 완료된 대금은 실제 이체일에 이 카드로 들어온다(당겨 지급 등).
 * ⛔ 완료 줄을 주의색으로 그리지 말 것: 「완료」라는 글자와 「주의」 색이 함께 뜨고,
 * 아직 할 일과 같은 무게로 읽힌다(P8 §1 — 심각도와 완료는 다른 축이다).
 */
const isSettled = (type: string) => type.includes("완료");
const moneyTone = (type: string) =>
  isSettled(type) ? "var(--status-success)" : "var(--status-caution-text)";

// 타임라인 레일 + 활성일 카드(본문만). thisWeekLabel/nextWeekLabel 은 상단 주차 앵커.
export function UpcomingScheduleBody({
  events,
  thisWeekLabel,
  nextWeekLabel,
}: {
  events: UpcomingEvent[];
  thisWeekLabel: string;
  nextWeekLabel: string;
}) {
  if (events.length === 0) {
    return <p className="py-4 text-[11px] text-muted-foreground/70">향후 14일 내 주요 일정이 없습니다.</p>;
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const groups = new Map<number, UpcomingEvent[]>();
  events.forEach((event) => {
    const offset = Math.min(14, Math.max(0, Math.floor((new Date(event.date).getTime() - todayStart.getTime()) / DAY_MS)));
    const list = groups.get(offset);
    if (list) list.push(event);
    else groups.set(offset, [event]);
  });
  const sorted = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  const xPct = (offset: number) => 3 + (offset / 14) * 94;
  const stepPct = 94 / 14;
  const todayDow = todayStart.getDay();

  return (
    <div>
      {/* 상단 시간축 레일 — 위치감 전용(이벤트 상세는 아래 활성일 카드). 오늘·주 경계·주말만 표시 */}
      <div className="relative h-[30px]">
        <span className="absolute left-[3%] top-0 text-[10px] font-semibold text-muted-foreground/60">이번 주 · {thisWeekLabel}</span>
        <span className="absolute top-0 text-[10px] font-semibold text-muted-foreground/60" style={{ left: `${xPct(7)}%` }}>다음 주 · {nextWeekLabel}</span>
        <div className="absolute left-0 right-0 top-[22px] h-px bg-slate-200" />
        {Array.from({ length: 15 }, (_, i) => i).map((i) => {
          const dow = (todayDow + i) % 7;
          if (dow !== 0 && dow !== 6) return null;
          return (
            <span
              key={`weekend-${i}`}
              aria-hidden="true"
              className="absolute top-[18px] h-2 -translate-x-1/2 rounded-sm bg-slate-100"
              style={{ left: `${xPct(i)}%`, width: `${stepPct}%` }}
            />
          );
        })}
        <div className="absolute top-[18px] h-2 w-px bg-slate-300" style={{ left: `${xPct(7)}%` }} />
        {Array.from({ length: 15 }, (_, i) => i).map((i) => {
          if (i === 0 || i === 7) return null;
          return (
            <span
              key={`tick-${i}`}
              aria-hidden="true"
              className="absolute top-[19px] h-1 w-px -translate-x-1/2 bg-slate-300"
              style={{ left: `${xPct(i)}%` }}
            />
          );
        })}
        {sorted.map(([offset, dayEvents]) => {
          const money = dayEvents.some((e) => isMoney(e.type));
          const isEnd = !money && dayEvents[0].type.includes("종료");
          return (
            <span
              key={`node-${offset}`}
              className={`absolute top-[22px] -translate-y-1/2 -translate-x-1/2 block size-2.5 rounded-full ${isEnd ? "border-2 bg-white" : ""}`}
              style={{
                left: `${xPct(offset)}%`,
                backgroundColor: isEnd ? undefined : money ? "var(--accent-gold)" : "var(--primary)",
                borderColor: isEnd ? "var(--primary)" : undefined,
              }}
            />
          );
        })}
        <div className="absolute top-[22px] -translate-y-1/2 -translate-x-1/2" style={{ left: `${xPct(0)}%` }}>
          <span className="today-marker-ping relative block size-3 rounded-full border-2 border-[var(--accent-gold)] bg-white" />
        </div>
        <span className="absolute top-[26px] -translate-x-1/2 text-[9px] font-bold text-[var(--status-caution-text)]" style={{ left: `${xPct(0)}%` }}>오늘</span>
      </div>

      {/* 활성일 카드 — auto-fit 흘림 배치, max-h+세로 스크롤로 총높이 고정(오너 2026-07-14) */}
      <div className="mt-3 grid gap-2 max-h-[260px] overflow-y-auto pr-0.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        {sorted.map(([offset, dayEvents]) => {
          const dateLabel = dayEvents[0].date.slice(5, 10).replace("-", ".");
          const dow = ["일", "월", "화", "수", "목", "금", "토"][(todayDow + offset) % 7];
          const isToday = offset === 0;
          return (
            <div key={`card-${offset}`} className="rounded-lg border border-black/5 bg-[#FAF9F6] px-2.5 py-2">
              <div className="mb-1.5 flex items-baseline justify-between gap-1 border-b border-black/5 pb-1.5">
                <span className={`text-[11px] font-bold tabular-nums ${isToday ? "text-[var(--status-caution-text)]" : "text-[#1F2A30]"}`}>
                  {dateLabel} <span className="font-medium text-muted-foreground/60">({dow})</span>
                </span>
                <span className={`text-[9px] font-semibold ${isToday ? "text-[var(--status-caution-text)]" : "text-muted-foreground/50"}`}>
                  {isToday ? "오늘" : `D+${offset}`}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {dayEvents.map((event, i) => (
                  <div key={`${event.date}-${event.label}-${i}`} className="flex items-start gap-1.5" title={`${event.type} · ${event.label}`}>
                    <span
                      aria-hidden="true"
                      className="mt-1 inline-block size-1.5 shrink-0 rounded-full"
                      // 완료된 대금은 캘린더 완료 도트와 같은 성공색을 쓴다 — 골드는
                      // 「아직 남은 대금」 쪽에만 남는다(가드레일 3: 골드 사용을 넓히지 않는다).
                      style={{
                        backgroundColor: isMoney(event.type)
                          ? isSettled(event.type)
                            ? "var(--status-success)"
                            : "var(--accent-gold)"
                          : "var(--primary)",
                      }}
                    />
                    <div className="min-w-0">
                      <p className="text-[9px] font-semibold leading-tight" style={{ color: isMoney(event.type) ? moneyTone(event.type) : "var(--primary)" }}>
                        {event.type}
                      </p>
                      <p className="truncate text-[11px] font-medium text-[#1F2A30] leading-tight">{event.label}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 연동 상태 배지 — 탭 헤더/카드 헤더 공용.
export function CalendarSyncBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <Badge variant="outline" className="py-0.5 px-2 text-[10px] font-semibold bg-status-success-bg text-status-success border-status-success/20">
      연동 정상
    </Badge>
  ) : (
    <Link href="/settings/integrations">
      <Badge variant="outline" className="py-0.5 px-2 text-[10px] font-semibold bg-status-caution-bg text-status-caution border-status-caution/20 cursor-pointer hover:border-status-caution/40 transition-colors">
        연동 실패
      </Badge>
    </Link>
  );
}

// 풀폭 카드(단독 사용 시). 일정 커버리지와 탭으로 묶으면 대신 UpcomingScheduleBody 를 직접 쓴다.
export function UpcomingScheduleCard({
  events,
  thisWeekLabel,
  nextWeekLabel,
  googleCalendarConnected,
}: {
  events: UpcomingEvent[];
  thisWeekLabel: string;
  nextWeekLabel: string;
  googleCalendarConnected: boolean;
}) {
  return (
    <Card className="border-black/5 bg-white/85 shadow-soft-sm">
      <CardContent className="px-4 py-3">
        <div className="flex items-center gap-2.5 flex-wrap">
          <Banknote className="size-4 shrink-0 text-[var(--primary)]" />
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold tracking-wide text-[var(--primary)]">다가올 14일 일정</p>
            <CalendarSyncBadge connected={googleCalendarConnected} />
          </div>
          <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">진행 예정인 정산 및 주요 마일스톤</p>
        </div>
        <div className="mt-4">
          <UpcomingScheduleBody events={events} thisWeekLabel={thisWeekLabel} nextWeekLabel={nextWeekLabel} />
        </div>
      </CardContent>
    </Card>
  );
}
