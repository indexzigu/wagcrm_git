import { formatLastSyncLabel } from "@/lib/date-utils";
import { formatNumber } from "@/lib/format";
import { isOrderSyncStale, type OrderWorkSummary } from "@/lib/order-converter/order-work";

/**
 * 주문 일감의 칸 판정(순수 로직) — 홈 「오늘 처리할 일」 행 빌더(`src/lib/today-work.ts`)와
 * 카드(`today-work-card.tsx`)가 소비한다.
 *
 * 종전엔 `src/components/crm/order-work-card.tsx` 의 「오늘 처리할 주문」 카드 안에 있었다. 그 카드가
 * 2026-10-18 「오늘 처리할 일」로 흡수되면서(애플 UI 리뉴얼 묶음 1-b) 순수 판정만 여기로 옮겼다 —
 * lib 가 components 를 import 하지 않게. 칸 이름은 주문 관리 화면 어휘와 같은 말이 다른 집합을 가리키지 않게 정했다
 * (`order-work.ts` OrderWorkSummaryCounts).
 *
 * 색은 심각도 축만 탄다(P8 §1): 송장·배송 지연과 반품/교환 = urgent(주문 관리의 반품/교환 버튼과
 * 같은 위험색), 발주 대기 중 결제 후 2일 이상 = caution. 평상시 발주 대기와 0 인 칸은 무채색.
 */

export type BucketTone = "urgent" | "caution" | null;

export type Bucket = {
  key: "awaiting-po" | "delayed" | "open-claims";
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

export type OrderSyncState =
  | { kind: "loading" }
  | { kind: "waiting" } // 동기화 기록·스냅샷이 없다
  | { kind: "stale"; daysAgo: number }
  | { kind: "fresh"; label: string };

export function resolveOrderSyncState(data: OrderWorkSummary | undefined, nowMs: number): OrderSyncState {
  if (!data) return { kind: "loading" };
  const noOrderData = data.activeCampaignCount > 0 && !data.hasSnapshot;
  if (!data.lastSyncAt || noOrderData) return { kind: "waiting" };
  if (isOrderSyncStale(data.lastSyncAt, nowMs)) {
    return { kind: "stale", daysAgo: Math.max(1, Math.floor((nowMs - Date.parse(data.lastSyncAt)) / DAY_MS)) };
  }
  return { kind: "fresh", label: formatLastSyncLabel(data.lastSyncAt) };
}
