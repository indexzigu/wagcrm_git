"use client";

import { Activity, RefreshCwIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useMobilePulse } from "@/hooks/useMobilePulse";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * 홈 "오늘의 펄스" 카드 — 모바일 홈 재구성 안 C (오너 승인 2026-07-15).
 *
 * 판단 지원(P3): "오늘 장사가 지금 어떻게 돌아가고 있나"를 홈 진입 즉시 확인.
 * - 오늘 매출·오늘 주문 2칸 스탯 + 오늘 주문이 있는 캠페인 상위 3건 미니 리스트.
 * - 데이터는 useMobilePulse 공용 훅(일정탭 요약 바와 캐시 공유 — 탭 전환 재마운트가
 *   중복 요청을 만들지 않는다). 자동 폴링 금지(오너 확정)는 훅이 보장하고,
 *   재조회는 우측 수동 새로고침 버튼(refetch)으로만.
 * - byCampaign 은 API 가 이미 오늘 주문 내림차순 정렬 — 여기선 0건 행만 걸러
 *   상위 3건을 취한다(P2 Decision-Value: 0원 행 나열은 판단 가치가 없다).
 * - 데이터는 즉시 렌더(카운트업 금지 — P8, 히어로의 AnimatedNumber 예외와 무관).
 */
export function MobileHomePulseCard() {
  const { data, error, isPending, isFetching, refetch } = useMobilePulse();

  // 기존 계약 유지: 실패 시 화면에 실패 문구 명시(에러 삼킴 금지 — 콘솔 로그는 훅 담당).
  const errorMessage = error ? "오늘의 펄스를 불러오지 못했습니다" : null;
  const initialLoading = isPending && errorMessage === null;
  const topCampaigns = (data?.byCampaign ?? [])
    .filter((entry) => entry.todayOrders > 0 || entry.todayRevenue > 0)
    .slice(0, 3);

  return (
    <Card className="border-black/5 bg-white shadow-soft-sm p-0">
      <CardContent className="px-4 py-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <Activity className="size-4 shrink-0 text-[var(--primary)]" />
            <p className="text-sm font-semibold tracking-tight text-[var(--primary)]">오늘의 펄스</p>
          </div>
          {/* 터치 타깃 44px(size-11) — 네거티브 마진으로 헤더 시각 높이는 유지 */}
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-label="오늘의 펄스 새로고침"
            className="-my-3 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors duration-150 active:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <RefreshCwIcon className={cn("size-4", isFetching && "animate-spin")} />
          </button>
        </div>

        {initialLoading ? (
          <div
            aria-busy="true"
            aria-label="오늘의 펄스 불러오는 중"
            className="mt-3 grid grid-cols-2 gap-2"
          >
            <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
            <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
          </div>
        ) : errorMessage || !data ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {errorMessage ?? "오늘의 펄스 데이터가 없습니다"}
          </p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="flex min-h-16 flex-col items-start gap-1 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2.5">
                <span className="text-[11px] font-medium text-slate-500">오늘 매출</span>
                <span className="text-[15px] font-bold tabular-nums tracking-tight text-slate-800">
                  ₩{formatCurrency(data.today.revenue)}
                </span>
              </div>
              <div className="flex min-h-16 flex-col items-start gap-1 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2.5">
                <span className="text-[11px] font-medium text-slate-500">오늘 주문</span>
                <span className="text-[15px] font-bold tabular-nums tracking-tight text-slate-800">
                  {data.today.orders}건
                </span>
              </div>
            </div>

            {topCampaigns.length > 0 ? (
              <ul className="mt-2 flex flex-col">
                {topCampaigns.map((entry) => (
                  <li
                    key={entry.campaignId}
                    className="flex items-center justify-between gap-3 border-b border-slate-100 py-1.5 last:border-0 last:pb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-slate-800">{entry.dealName}</p>
                      <p className="truncate text-[11px] text-slate-500">{entry.sellerName}</p>
                    </div>
                    <span className="shrink-0 text-[13px] font-bold tabular-nums text-slate-800">
                      ₩{formatCurrency(entry.todayRevenue)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[11px] text-muted-foreground">오늘 들어온 주문이 아직 없습니다</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
