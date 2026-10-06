"use client";

import Link from "next/link";
import { ChevronRight, PackageIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrderWorkSummary } from "@/hooks/useOrderWorkSummary";
import { formatLastSyncLabel } from "@/lib/date-utils";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OrderWorkSummary } from "@/lib/order-converter/order-work";

/**
 * 홈 「오늘 처리할 주문」 — 주문 관리 화면을 열기 전에 「오늘 주문 일이 있는가」를 한 줄로 답한다.
 *
 * 판단 순서(P2): ① 일이 있는가(전부 0 이면 조용한 한 줄) ② 어느 칸에 몇 건, 몇 캠페인에 걸쳐 있는가
 * ③ 그중 늦은 것이 있는가. 숫자는 주문 관리 카드와 같은 판정·같은 단위(상품주문 라인)다 —
 * 클릭하면 주문 관리로 가서 같은 숫자를 다시 보게 된다.
 *
 * 색은 심각도 축만 탄다(P8 §1): 배송 지연 = urgent, 발주 대기 중 2일 넘은 건 = caution,
 * 진행 중 클레임 = pending. 0 인 칸은 무채색으로 물러난다(강조는 0 이 아닌 칸만).
 * 데이터는 사이드바 「주문 관리」 배지와 한 캐시를 쓴다(요청 1회). 서버는 네이버를 부르지 않는다.
 */

type BucketTone = "urgent" | "caution" | "pending" | null;

const DOT_CLASS: Record<Exclude<BucketTone, null>, string> = {
  urgent: "bg-status-urgent",
  caution: "bg-status-caution",
  pending: "bg-status-pending",
};

const DETAIL_TEXT_CLASS: Record<Exclude<BucketTone, null>, string> = {
  urgent: "text-status-urgent-text",
  caution: "text-status-caution-text",
  pending: "text-status-pending-text",
};

type Bucket = {
  key: string;
  label: string;
  lines: number;
  campaigns: number;
  tone: BucketTone;
  detail: string | null;
};

export function buildOrderWorkBuckets(summary: OrderWorkSummary): Bucket[] {
  const { awaitingPo, delayed, openClaims } = summary;
  const delayedParts = [
    delayed.invoiceLines > 0 ? `송장 미회신 ${formatNumber(delayed.invoiceLines)}` : null,
    delayed.shippingLines > 0 ? `배송 5일 이상 ${formatNumber(delayed.shippingLines)}` : null,
  ].filter(Boolean);
  return [
    {
      key: "awaiting-po",
      label: "발주 대기",
      lines: awaitingPo.lines,
      campaigns: awaitingPo.campaigns,
      // 발주 대기는 평상시 일감이라 그 자체로는 색을 받지 않는다 — 결제 후 2일 넘은 건이 있을 때만 주의.
      tone: awaitingPo.delayedLines > 0 ? "caution" : null,
      detail: awaitingPo.delayedLines > 0 ? `그중 2일 넘은 ${formatNumber(awaitingPo.delayedLines)}건` : null,
    },
    {
      key: "delayed",
      label: "배송 지연",
      lines: delayed.lines,
      campaigns: delayed.campaigns,
      tone: delayed.lines > 0 ? "urgent" : null,
      detail: delayedParts.length > 0 ? delayedParts.join(" · ") : null,
    },
    {
      key: "open-claims",
      label: "진행 중 클레임",
      lines: openClaims.lines,
      campaigns: openClaims.campaigns,
      tone: openClaims.lines > 0 ? "pending" : null,
      detail: openClaims.unmatchedLines > 0 ? `캠페인 미매칭 ${formatNumber(openClaims.unmatchedLines)}` : null,
    },
  ];
}

function BucketCell({ bucket }: { bucket: Bucket }) {
  const active = bucket.lines > 0;
  return (
    <Link
      href="/order-converter"
      aria-label={`${bucket.label} ${bucket.lines}건, 주문 관리에서 보기`}
      className="group flex min-w-0 flex-col gap-1 rounded-lg px-3 py-2 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {bucket.tone ? (
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[bucket.tone])} />
        ) : null}
        {bucket.label}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span
          className={cn(
            "tabular-nums tracking-tight",
            active ? "text-lg font-bold text-foreground" : "text-sm font-medium text-slate-500",
          )}
        >
          {formatNumber(bucket.lines)}
        </span>
        <span className={cn("text-xs", active ? "text-slate-600" : "text-slate-500")}>건</span>
        {active ? (
          <span className="text-[11px] text-muted-foreground">· 캠페인 {formatNumber(bucket.campaigns)}개</span>
        ) : null}
      </span>
      {active && bucket.detail ? (
        <span className={cn("truncate text-[11px] font-medium", bucket.tone ? DETAIL_TEXT_CLASS[bucket.tone] : "text-muted-foreground")}>
          {bucket.detail}
        </span>
      ) : null}
    </Link>
  );
}

export function OrderWorkCard() {
  const { data, isLoading, isError, error, refetch, isFetching } = useOrderWorkSummary();

  const syncLabel = data?.lastSyncAt ? formatLastSyncLabel(data.lastSyncAt) : "";
  const noOrderData = !!data && data.activeCampaignCount > 0 && !data.hasSnapshot;
  const quiet = !!data && data.total === 0;

  return (
    <Card className="border-black/5 bg-white/85 shadow-soft-sm p-0" aria-labelledby="order-work-title">
      <CardContent className="px-4 py-3">
        <div className="flex items-center gap-2">
          <PackageIcon className="size-4 shrink-0 text-[var(--primary)]" aria-hidden="true" />
          <h2 id="order-work-title" className="shrink-0 text-[13px] font-semibold tracking-tight text-[var(--primary)]">
            오늘 처리할 주문
          </h2>
          {quiet && !noOrderData ? (
            <span className="min-w-0 truncate text-[12px] text-slate-600">처리할 주문 없음</span>
          ) : null}
          {noOrderData ? (
            <span className="min-w-0 truncate text-[12px] text-slate-600">아직 동기화된 주문이 없습니다</span>
          ) : null}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {syncLabel ? `마지막 동기화 ${syncLabel}` : data ? "동기화 기록 없음" : ""}
          </span>
          <Link
            href="/order-converter"
            className="crm-hit-area inline-flex shrink-0 items-center gap-0.5 rounded text-[11px] font-medium text-[var(--primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            주문 관리
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>

        {isLoading ? (
          <div className="mt-2 grid grid-cols-3 gap-2 border-t border-slate-100 pt-2" aria-hidden="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-1.5 px-3 py-2">
                <Skeleton className="h-3 w-16 bg-slate-200" />
                <Skeleton className="h-5 w-12 bg-slate-200" />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="mt-2 flex items-center gap-3 border-t border-slate-100 pt-2" role="alert">
            <p className="text-xs text-status-urgent-text">
              {error instanceof Error ? error.message : "오늘 처리할 주문을 불러오지 못했습니다."}
            </p>
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="crm-hit-area h-7 shrink-0 rounded-md border border-slate-200 bg-white px-3 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              다시 불러오기
            </button>
          </div>
        ) : data && !quiet ? (
          <div className="mt-2 grid grid-cols-3 gap-2 border-t border-slate-100 pt-2">
            {buildOrderWorkBuckets(data).map((bucket) => (
              <BucketCell key={bucket.key} bucket={bucket} />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
