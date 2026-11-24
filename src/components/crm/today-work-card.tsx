"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { markUnverifiedOrderRows, type TodayWorkRow, type TodayWorkTone } from "@/lib/today-work";
import type { OrderSyncState } from "@/lib/order-converter/order-work-buckets";
import { StatusDot } from "./status-dot";

/**
 * 홈 「오늘 처리할 일」 (확정안 Style B)
 *
 * - 카드 헤더: 순수 <h2> 제목(text-[13.5px] font-semibold tracking-[-0.01em] text-foreground)만 둔다.
 * - 헤더 아래 긴급도 분포 스택 바(4px)
 * - 밑줄 필터 탭(전체, 정산, 주문, 운영·점검)
 * - 행 스타일(Style B, 닷 없음, ~~하기 버튼 없음): 단일 Link 행, 텍스트 색상 심각도, 우측 끝 ChevronRight
 * - 하단 푸터: SyncNote 및 건수 요약
 */

const LABEL_TEXT: Record<TodayWorkTone, string> = {
  urgent: "text-status-urgent-text font-semibold",
  caution: "text-status-caution-text font-semibold",
  info: "text-primary font-semibold",
  neutral: "text-muted-foreground font-medium",
};

const COUNT_TEXT: Record<TodayWorkTone, string> = {
  urgent: "text-status-urgent-text",
  caution: "text-status-caution-text",
  info: "text-status-info",
  neutral: "text-muted-foreground",
};

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
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <StatusDot tone="caution" label="주문 확인불가" className="min-w-0 font-semibold text-status-caution-text" />
        <span className="text-xs font-semibold tabular-nums text-status-caution-text">마지막 동기화 {sync.daysAgo}일 전</span>
      </span>
    );
  }
  return <span className="text-xs tabular-nums text-muted-foreground">주문 마지막 동기화 {sync.label}</span>;
}

type FilterCategory = "all" | "settlement" | "order" | "ops";

function getRowCategory(key: string): "settlement" | "order" | "ops" {
  if (key === "settlement-delayed") return "settlement";
  if (key.startsWith("orders-")) return "order";
  return "ops";
}

function WorkRow({ row }: { row: TodayWorkRow }) {
  return (
    <li className="border-b border-slate-100 last:border-b-0">
      <Link
        href={row.href}
        data-row={row.key}
        aria-label={`${row.label} ${formatNumber(row.count)}건${row.detail ? `, ${row.detail}` : ""}`}
        className="group flex min-w-0 items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-3">
          <span className={cn("shrink-0 text-xs sm:w-20", LABEL_TEXT[row.tone])}>
            {row.label}
          </span>
          {row.detail ? (
            <span className={cn("break-keep text-xs font-medium", DETAIL_TEXT[row.tone])}>
              {row.detail}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span
            data-slot="today-work-count"
            className={cn("tabular-nums text-xs font-semibold", COUNT_TEXT[row.tone])}
          >
            {formatNumber(row.count)}
          </span>
          <span className="text-xs text-muted-foreground font-medium">건</span>
        </div>
        <ChevronRight
          className="size-4 shrink-0 text-slate-400 transition-[color,transform] group-hover:translate-x-0.5 group-hover:text-primary"
          aria-hidden="true"
        />
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
  const [filter, setFilter] = useState<FilterCategory>("all");
  const ordersUnverified = orderSync?.kind === "stale" || orderSync?.kind === "waiting";
  const confirmedEmpty = rows.length === 0 && !loading && failedSources.length === 0 && !ordersUnverified;
  const shownRows = markUnverifiedOrderRows(rows, orderSync);

  const countsByTone = {
    urgent: shownRows.filter((r) => r.tone === "urgent").reduce((sum, r) => sum + r.count, 0),
    caution: shownRows.filter((r) => r.tone === "caution").reduce((sum, r) => sum + r.count, 0),
    info: shownRows.filter((r) => r.tone === "info").reduce((sum, r) => sum + r.count, 0),
    neutral: shownRows.filter((r) => r.tone === "neutral").reduce((sum, r) => sum + r.count, 0),
  };
  const totalCount = Object.values(countsByTone).reduce((a, b) => a + b, 0);

  const settlementCount = shownRows
    .filter((r) => getRowCategory(r.key) === "settlement")
    .reduce((acc, r) => acc + r.count, 0);
  const orderCount = shownRows
    .filter((r) => getRowCategory(r.key) === "order")
    .reduce((acc, r) => acc + r.count, 0);
  const opsCount = shownRows
    .filter((r) => getRowCategory(r.key) === "ops")
    .reduce((acc, r) => acc + r.count, 0);

  const categoryCounts: Record<FilterCategory, number> = {
    all: totalCount,
    settlement: settlementCount,
    order: orderCount,
    ops: opsCount,
  };
  const effectiveFilter = filter !== "all" && categoryCounts[filter] === 0 ? "all" : filter;

  const displayedRows =
    effectiveFilter === "all" ? shownRows : shownRows.filter((r) => getRowCategory(r.key) === effectiveFilter);

  return (
    <Card className="border-border bg-card shadow-soft-sm p-0 flex flex-col">
      <CardContent className="p-0 flex flex-col flex-1">
        {/* 카드 헤더: 순수 <h2> 제목만 둔다 */}
        <div className="flex flex-wrap items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
            오늘 처리할 일
          </h2>
        </div>

        {/* 4px 긴급도 분포 스택 바 */}
        {rows.length > 0 && totalCount > 0 ? (
          <div className="px-4 pt-2.5 pb-2" aria-hidden="true">
            <div className="flex h-1 gap-0.5 overflow-hidden rounded-full bg-slate-100">
              {countsByTone.urgent > 0 ? (
                <div
                  style={{ width: `${(countsByTone.urgent / totalCount) * 100}%` }}
                  className="bg-[var(--status-urgent)]"
                />
              ) : null}
              {countsByTone.caution > 0 ? (
                <div
                  style={{ width: `${(countsByTone.caution / totalCount) * 100}%` }}
                  className="bg-[var(--status-caution)]"
                />
              ) : null}
              {countsByTone.info > 0 ? (
                <div
                  style={{ width: `${(countsByTone.info / totalCount) * 100}%` }}
                  className="bg-primary"
                />
              ) : null}
              {countsByTone.neutral > 0 ? (
                <div
                  style={{ width: `${(countsByTone.neutral / totalCount) * 100}%` }}
                  className="bg-slate-300"
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 밑줄 필터 탭 */}
        {rows.length > 0 ? (
          <div className="flex items-center gap-4 border-b border-slate-100 px-4" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={effectiveFilter === "all"}
              onClick={() => setFilter("all")}
              className={cn(
                "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                effectiveFilter === "all"
                  ? "text-foreground font-semibold after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              전체 <span className="tabular-nums font-semibold">{formatNumber(totalCount)}</span>
            </button>
            {settlementCount > 0 ? (
              <button
                type="button"
                role="tab"
                aria-selected={effectiveFilter === "settlement"}
                onClick={() => setFilter("settlement")}
                className={cn(
                  "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                  effectiveFilter === "settlement"
                    ? "text-foreground font-semibold after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                정산 <span className="tabular-nums font-semibold text-status-urgent-text">{settlementCount}</span>
              </button>
            ) : null}
            {orderCount > 0 ? (
              <button
                type="button"
                role="tab"
                aria-selected={effectiveFilter === "order"}
                onClick={() => setFilter("order")}
                className={cn(
                  "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                  effectiveFilter === "order"
                    ? "text-foreground font-semibold after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                주문 <span className="tabular-nums font-semibold">{orderCount}</span>
              </button>
            ) : null}
            {opsCount > 0 ? (
              <button
                type="button"
                role="tab"
                aria-selected={effectiveFilter === "ops"}
                onClick={() => setFilter("ops")}
                className={cn(
                  "relative py-2 text-xs font-medium transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                  effectiveFilter === "ops"
                    ? "text-foreground font-semibold after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                운영·점검 <span className="tabular-nums font-semibold">{opsCount}</span>
              </button>
            ) : null}
          </div>
        ) : null}

        {/* 본문 행 목록 */}
        {rows.length > 0 ? (
          <ul className="flex-1 divide-y divide-slate-100">
            {displayedRows.map((row) => (
              <WorkRow key={row.key} row={row} />
            ))}
          </ul>
        ) : null}

        {/* 빈 상태 문구 (본문) */}
        {confirmedEmpty ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            오늘 처리할 일이 없습니다
          </div>
        ) : null}

        {/* 불러오기 실패 알림 */}
        {failedSources.length > 0 ? (
          <div className="mx-4 my-2 flex items-center gap-3 border-t border-slate-100 pt-2" role="alert">
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

        {/* 하단 푸터: SyncNote 및 동기화/스켈레톤 상태 */}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2.5 text-xs text-muted-foreground">
          {loading && rows.length === 0 ? (
            <Skeleton className="h-3 w-24 bg-slate-200" data-slot="skeleton" />
          ) : (
            <SyncNote sync={orderSync} />
          )}
          {rows.length > 0 ? (
            <span className="text-[11px] text-muted-foreground">
              총 {rows.length}개 항목
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
