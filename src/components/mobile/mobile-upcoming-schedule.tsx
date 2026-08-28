"use client";

import React from "react";
import { UserRoundIcon } from "lucide-react";
import { StatusBadge } from "@/components/crm/status-badge";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { CampaignStatus } from "@/lib/crm-types";
import type { MobileCalendarItem } from "@/lib/mobile-calendar-groups";

/**
 * 일정탭 최하단 "다가오는 일정" 선별 규칙: 오늘(포함) 이후 시작하는 일정을
 * 시작일 오름차순으로 최대 limit건. 그룹은 buildMobileCalendarItems가 이미
 * 그룹 단위 1건으로 접어 두므로 여기서는 추가 그룹핑을 하지 않는다.
 * 데이터 범위는 호출자가 보유한 월 캐시(현재 월 + 방문한 월)로 한정된다 —
 * 별도 API 조회 없음.
 *
 * excludeStartYmd(선택일): 그 날짜에 시작하는 일정은 바로 위 일별 리스트가
 * 이미 보여주므로 제외한다 — 같은 카드가 연달아 두 번 보이는 중복 방지
 * (ss 검토 P1, 2026-07-15).
 */
export function selectUpcomingItems(
  items: MobileCalendarItem[],
  todayYmd: string,
  limit = 3,
  excludeStartYmd?: string,
): MobileCalendarItem[] {
  if (!todayYmd) return [];
  return [...items]
    .filter((item) => {
      const startYmd = item.startDate.slice(0, 10);
      if (startYmd < todayYmd) return false;
      if (excludeStartYmd && startYmd === excludeStartYmd) return false;
      return true;
    })
    .sort(
      (a, b) =>
        a.startDate.localeCompare(b.startDate) || a.dealName.localeCompare(b.dealName, "ko"),
    )
    .slice(0, limit);
}

function formatPeriod(startIso: string, endIso: string): string {
  const [, sm, sd] = startIso.slice(0, 10).split("-").map(Number);
  const [, em, ed] = endIso.slice(0, 10).split("-").map(Number);
  return `${sm}.${sd} – ${em}.${ed}`;
}

type MobileUpcomingScheduleProps = {
  items: MobileCalendarItem[];
  onOpenCampaign: (campaignKey: string) => void;
};

export const MobileUpcomingSchedule = React.memo(function MobileUpcomingSchedule({
  items,
  onOpenCampaign,
}: MobileUpcomingScheduleProps) {
  return (
    <section className="rounded-2xl border border-white/60 bg-white/85 backdrop-blur-lg shadow-soft-sm">
      <div className="flex min-h-11 items-center px-6 py-2">
        <h2 className="text-[13px] font-medium text-foreground">다가오는 일정</h2>
      </div>

      {items.length === 0 ? (
        <Empty className="border-t border-slate-100 py-5">
          <EmptyHeader>
            <EmptyTitle>다가오는 일정이 없습니다.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onOpenCampaign(item.key)}
              className="flex min-h-11 w-full items-center gap-2 border-t border-slate-100 px-6 py-3 text-left transition-colors duration-150 active:bg-slate-50/70"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {item.dealName}
                  </span>
                  <UserRoundIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="truncate text-xs text-muted-foreground">
                    {item.sellerName}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                  {formatPeriod(item.startDate, item.endDate)}
                </div>
              </div>
              <StatusBadge
                status={item.status as CampaignStatus}
                className="shrink-0 text-[11px]"
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
});
