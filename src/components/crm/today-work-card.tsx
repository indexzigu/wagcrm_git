"use client";

import Link from "next/link";
import { ChevronRight, ListChecks } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { badgeSizeClassName } from "@/components/ui/badge";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TodayWorkRow, TodayWorkTone } from "@/lib/today-work";
import type { OrderSyncState } from "./order-work-card";
import { StatusDot } from "./status-dot";
import { TONE_BADGE } from "./segmented-tab-card";

/**
 * 홈 「오늘 처리할 일」 — 그날 손이 가야 하는 일을 한 목록으로 답한다(행 빌더 `src/lib/today-work.ts`).
 *
 * 판단 순서(P2): ① 일이 있는가(전부 0 이면 한 줄로 접힌다) ② 어느 일이 몇 건 ③ 늦은 것이 있는가(색).
 * 행 전체가 그 일을 처리하는 화면으로 가는 링크 **하나**다(라벨·건수·세부 줄이 곧 링크 이름).
 * 이 카드는 fetch 하지 않는다 — 원천(주문 요약·`/api/agenda`·승인대기 수·데이터 점검)은 홈이 모아 준다.
 *
 * 「없다」는 확인됐을 때만 말한다: 처음 불러오는 중·원천 실패·주문 동기화 낡음/대기 중에는 0 을
 * 믿을 수 없으므로 접힘 문구를 내지 않는다(종전 「오늘 처리할 주문」 카드의 「확인불가」 규칙 승계).
 */

const DETAIL_TEXT: Record<TodayWorkTone, string> = {
  urgent: "text-status-urgent-text",
  caution: "text-status-caution-text",
  info: "text-muted-foreground",
  neutral: "text-muted-foreground",
};

function SyncNote({ sync }: { sync: OrderSyncState | null }) {
  if (!sync || sync.kind === "loading") return null;
  if (sync.kind === "waiting") return <span className="text-xs text-muted-foreground">주문 동기화대기</span>;
  if (sync.kind === "stale") {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot tone="caution" label="주문 확인불가" className="min-w-0 font-semibold" />
        <span className="shrink-0 text-xs font-semibold tabular-nums text-status-caution-text">마지막 동기화 {sync.daysAgo}일 전</span>
      </span>
    );
  }
  return <span className="text-xs tabular-nums text-muted-foreground">주문 마지막 동기화 {sync.label}</span>;
}

function WorkRow({ row }: { row: TodayWorkRow }) {
  return (
    <li>
      <Link
        href={row.href}
        data-row={row.key}
        className="group flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-slate-700">{row.label}</span>
          {row.detail ? (
            <span className={cn("truncate text-xs font-medium", DETAIL_TEXT[row.tone])}>{row.detail}</span>
          ) : null}
        </span>
        <span
          data-slot="today-work-count"
          className={cn("inline-flex shrink-0 items-center justify-center", badgeSizeClassName.count, TONE_BADGE[row.tone])}
        >
          {formatNumber(row.count)}
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-slate-400 transition-colors group-hover:text-slate-600" aria-hidden="true" />
      </Link>
    </li>
  );
}

export function TodayWorkCard({
  rows,
  loading,
  failedSources,
  onRetry,
  orderSync,
}: {
  rows: TodayWorkRow[];
  /** 원천 중 하나라도 처음 불러오는 중인가. */
  loading: boolean;
  /** 불러오지 못한 원천 이름(예: 「주문」「영업·정산」「승인대기」). */
  failedSources: string[];
  onRetry: () => void;
  orderSync: OrderSyncState | null;
}) {
  const ordersUnverified = orderSync?.kind === "stale" || orderSync?.kind === "waiting";
  const confirmedEmpty = rows.length === 0 && !loading && failedSources.length === 0 && !ordersUnverified;

  return (
    <Card className="border-black/5 bg-white/85 shadow-soft-sm p-0">
      <CardContent className="px-4 py-3">
        <div className="flex items-center gap-2">
          <ListChecks className="size-4 shrink-0 text-[var(--primary)]" aria-hidden="true" />
          <h2 className="shrink-0 text-[13px] font-semibold tracking-tight text-[var(--primary)]">오늘 처리할 일</h2>
          {confirmedEmpty ? <span className="min-w-0 truncate text-xs text-slate-600">오늘 처리할 일이 없습니다</span> : null}
          <span className="ml-auto flex min-w-0 shrink-0 items-center">
            {loading && rows.length === 0 ? (
              <Skeleton className="inline-block h-3 w-24 align-middle bg-slate-200" />
            ) : (
              <SyncNote sync={orderSync} />
            )}
          </span>
        </div>

        {rows.length > 0 ? (
          <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-3 gap-y-0.5 border-t border-slate-100 pt-2">
            {rows.map((row) => (
              <WorkRow key={row.key} row={row} />
            ))}
          </ul>
        ) : null}

        {failedSources.length > 0 ? (
          <div className="mt-2 flex items-center gap-3 border-t border-slate-100 pt-2" role="alert">
            <p className="text-xs text-status-urgent-text">{failedSources.join("·")} 건수를 불러오지 못했습니다.</p>
            <button
              type="button"
              onClick={onRetry}
              className="crm-hit-area h-7 shrink-0 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              다시 불러오기
            </button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
