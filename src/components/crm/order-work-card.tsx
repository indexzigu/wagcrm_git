"use client";

import Link from "next/link";
import { ChevronRight, PackageIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrderWorkSummary } from "@/hooks/useOrderWorkSummary";
import { formatLastSyncLabel } from "@/lib/date-utils";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isOrderSyncStale, type OrderWorkSummary } from "@/lib/order-converter/order-work";

/**
 * 홈 「오늘 처리할 주문」 — 주문 관리 화면을 열기 전에 「오늘 주문 일이 있는가」를 한 줄로 답한다.
 *
 * 판단 순서(P2): ① 일이 있는가(전부 0 이면 조용한 한 줄) ② 어느 칸에 몇 건, 몇 캠페인에 걸쳐 있는가
 * ③ 그중 늦은 것이 있는가. 판정은 주문 관리 카드와 같은 함수이고, 칸 이름은 주문 관리 화면 어휘와
 * 같은 말이 다른 집합을 가리키지 않게 정했다(`order-work.ts` OrderWorkSummaryCounts).
 *
 * 색은 심각도 축만 탄다(P8 §1): 송장·배송 지연과 반품/교환 = urgent(주문 관리의 반품/교환 버튼과
 * 같은 위험색), 발주 대기 중 결제 후 2일 이상 = caution. 평상시 발주 대기와 0 인 칸은 무채색.
 *
 * 카드 전체가 링크 **하나**다(탭 정지 1회) — 세 칸과 헤더가 모두 같은 곳(주문 관리)으로 가므로
 * 링크를 나누면 키보드 사용자가 같은 목적지를 네 번 지난다. 이름은 보이는 글자 그대로다.
 * 로딩 중에는 헤더 한 줄만 그린다 — 조용한 날(한 줄)과 높이가 같아 홈이 튀지 않는다.
 * 데이터는 사이드바 「주문 관리」 배지와 한 캐시를 쓴다(요청 1회). 서버는 네이버를 부르지 않는다.
 */

type BucketTone = "urgent" | "caution" | null;

const DOT_CLASS: Record<Exclude<BucketTone, null>, string> = {
  urgent: "bg-status-urgent",
  caution: "bg-status-caution",
};

const DETAIL_TEXT_CLASS: Record<Exclude<BucketTone, null>, string> = {
  urgent: "text-status-urgent-text",
  caution: "text-status-caution-text",
};

type Bucket = {
  key: string;
  label: string;
  lines: number;
  campaigns: number;
  tone: BucketTone;
  detail: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildOrderWorkBuckets(summary: OrderWorkSummary): Bucket[] {
  const { awaitingPo, delayed, openClaims } = summary;
  const delayedParts = [
    delayed.invoiceLines > 0 ? `송장 지연 ${formatNumber(delayed.invoiceLines)}건` : null,
    delayed.shippingLines > 0 ? `배송 지연 ${formatNumber(delayed.shippingLines)}건` : null,
  ].filter(Boolean);
  return [
    {
      key: "awaiting-po",
      label: "발주 대기",
      lines: awaitingPo.lines,
      campaigns: awaitingPo.campaigns,
      // 발주 대기는 평상시 일감이라 그 자체로는 색을 받지 않는다 — 결제 후 2일 이상인 건이 있을 때만 주의.
      tone: awaitingPo.delayedLines > 0 ? "caution" : null,
      detail: awaitingPo.delayedLines > 0 ? `결제 후 2일 이상 ${formatNumber(awaitingPo.delayedLines)}건` : null,
    },
    {
      // 주문 관리의 「송장 지연」(배송대기 2일 이상)·「배송 지연」(배송중 5일 이상)을 한 칸에 묶는다.
      key: "delayed",
      label: "송장·배송 지연",
      lines: delayed.lines,
      campaigns: delayed.campaigns,
      tone: delayed.lines > 0 ? "urgent" : null,
      detail: delayedParts.length > 0 ? delayedParts.join(" · ") : null,
    },
    {
      key: "open-claims",
      label: "반품/교환",
      lines: openClaims.lines,
      campaigns: openClaims.campaigns,
      tone: openClaims.lines > 0 ? "urgent" : null,
      detail: openClaims.unmatchedLines > 0 ? `캠페인 못 찾은 ${formatNumber(openClaims.unmatchedLines)}건` : null,
    },
  ];
}

function BucketCell({ bucket }: { bucket: Bucket }) {
  const active = bucket.lines > 0;
  return (
    <div className="flex min-w-0 flex-col gap-1 px-3 py-2" data-bucket={bucket.key}>
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {bucket.tone ? (
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[bucket.tone])} />
        ) : null}
        {bucket.label}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span
          data-slot="bucket-count"
          className={cn(
            "tabular-nums tracking-tight",
            active ? "text-lg font-bold text-foreground" : "text-sm font-medium text-slate-500",
          )}
        >
          {formatNumber(bucket.lines)}
        </span>
        <span className={cn("text-xs", active ? "text-slate-600" : "text-slate-500")}>건</span>
        {active ? (
          <span className="text-xs text-muted-foreground">· 캠페인 {formatNumber(bucket.campaigns)}개</span>
        ) : null}
      </span>
      {active && bucket.detail ? (
        <span className={cn("truncate text-xs font-medium", bucket.tone ? DETAIL_TEXT_CLASS[bucket.tone] : "text-muted-foreground")}>
          {bucket.detail}
        </span>
      ) : null}
    </div>
  );
}

type SyncState =
  | { kind: "loading" }
  | { kind: "waiting" } // 동기화 기록·스냅샷이 없다
  | { kind: "stale"; daysAgo: number }
  | { kind: "fresh"; label: string };

function resolveSyncState(data: OrderWorkSummary | undefined, nowMs: number): SyncState {
  if (!data) return { kind: "loading" };
  const noOrderData = data.activeCampaignCount > 0 && !data.hasSnapshot;
  if (!data.lastSyncAt || noOrderData) return { kind: "waiting" };
  if (isOrderSyncStale(data.lastSyncAt, nowMs)) {
    return { kind: "stale", daysAgo: Math.max(1, Math.floor((nowMs - Date.parse(data.lastSyncAt)) / DAY_MS)) };
  }
  return { kind: "fresh", label: formatLastSyncLabel(data.lastSyncAt) };
}

export function OrderWorkCard() {
  const { data, dataUpdatedAt, isError, error, refetch, isFetching } = useOrderWorkSummary();
  // 낡음 판정의 「지금」은 데이터를 받은 시각이다 — 렌더 중 Date.now() 는 순수하지 않고,
  // 5분 재조회가 이 기준을 앞으로 민다.
  const sync = resolveSyncState(data, dataUpdatedAt);
  const quiet = !!data && data.total === 0;

  // 왼쪽 상태 한 마디 — 일이 있으면 아래 칸이 말하므로 비운다. 동기화 대기 중이면 오른쪽 한 마디로 충분하다.
  let status: { text: string; tone: "caution" | null } | null = null;
  if (quiet && sync.kind === "stale") status = { text: "확인 필요", tone: "caution" };
  else if (quiet && sync.kind === "fresh") status = { text: "처리할 주문 없음", tone: null };

  const header = (
    <div className="flex items-center gap-2">
      <PackageIcon className="size-4 shrink-0 text-[var(--primary)]" aria-hidden="true" />
      <h2 className="shrink-0 text-[13px] font-semibold tracking-tight text-[var(--primary)]">오늘 처리할 주문</h2>
      {status ? (
        <span
          className={cn(
            "min-w-0 truncate text-xs",
            status.tone === "caution" ? "font-semibold text-status-caution-text" : "text-slate-600",
          )}
        >
          {status.text}
        </span>
      ) : null}
      <span className="ml-auto shrink-0 text-xs tabular-nums">
        {sync.kind === "loading" ? (
          isError ? null : <Skeleton className="inline-block h-3 w-24 align-middle bg-slate-200" />
        ) : sync.kind === "waiting" ? (
          <span className="text-muted-foreground">동기화 대기 중</span>
        ) : sync.kind === "stale" ? (
          <span className="font-semibold text-status-caution-text">마지막 동기화 {sync.daysAgo}일 전</span>
        ) : (
          <span className="text-muted-foreground">마지막 동기화 {sync.label}</span>
        )}
      </span>
      <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-[var(--primary)] group-hover:underline">
        주문 관리
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </span>
    </div>
  );

  return (
    <Card className="border-black/5 bg-white/85 shadow-soft-sm p-0">
      <CardContent className="p-0">
        <Link
          href="/order-converter"
          className="group block rounded-xl px-4 py-3 transition-colors duration-150 hover:bg-slate-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {header}
          {data && !quiet ? (
            <div className="mt-2 grid grid-cols-3 gap-2 border-t border-slate-100 pt-2">
              {buildOrderWorkBuckets(data).map((bucket) => (
                <BucketCell key={bucket.key} bucket={bucket} />
              ))}
            </div>
          ) : null}
        </Link>
        {isError ? (
          // 링크 밖에 둔다 — 링크 안의 버튼은 중첩 상호작용이라 키보드·스크린리더가 갈린다.
          <div className="flex items-center gap-3 border-t border-slate-100 px-4 py-2" role="alert">
            <p className="text-xs text-status-urgent-text">
              {error instanceof Error ? error.message : "오늘 처리할 주문을 불러오지 못했습니다."}
            </p>
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="crm-hit-area h-7 shrink-0 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              다시 불러오기
            </button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
