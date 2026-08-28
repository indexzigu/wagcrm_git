"use client";

// 딜↔셀러 후보 행의 공통 표시 규약 — 두 진입점이 같은 어휘·같은 색을 쓰게 한다.
//
// 색 규약(P8): 「거래 리듬」은 셀러 목록 열과 동일하게 **휴면만 유채색**, 건강·제외는
// 무채색, 판정 불가는 대시다. 이 행에는 이미 사유 배지와 우선순위 배지가 있어 세 번째
// hue 를 상시로 얹으면 D2 가 회수한 "행당 무지개"가 재발한다.
// ⛔ `fitLevel` 과 거래 리듬을 하나의 점수로 합치지 않는다(D10) — 나란히 둔다.

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MATCH_REASON_LABEL, type MatchReason } from "@/lib/deal-seller-matching";
import { DORMANCY_TIER_LABEL, type DormancyVerdict } from "@/lib/seller-dormancy";

export function MatchReasonBadge({ reason }: { reason: MatchReason }) {
  return (
    <Badge
      variant="outline"
      className="h-5 px-1.5 text-[10px] font-normal text-muted-foreground bg-slate-50 border-border/70 rounded-md shrink-0"
    >
      {MATCH_REASON_LABEL[reason]}
    </Badge>
  );
}

/** D3 — 쌍 매출이 문턱 이상. 정렬 상단 + 이 배지까지가 전부다(필터 아님). */
export function PriorityBadge() {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-status-caution-bg text-status-caution shrink-0">
      적극 검토
    </span>
  );
}

export function DormancyBadge({ verdict }: { verdict: DormancyVerdict }) {
  if (verdict.tier === "UNKNOWN") {
    // 과거 진행 0건은 '판정 불가'다 — 0일(=건강)로 그리지 않는다.
    return (
      <span className="text-[10px] text-slate-500" title="판정에 필요한 과거 진행 기록이 없습니다">
        —
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold shrink-0",
        verdict.tier === "DORMANT"
          ? "bg-status-caution-bg text-status-caution"
          : "border border-slate-200 bg-slate-100 text-slate-500",
      )}
      title={`마지막 진행 시작 후 ${verdict.daysSinceLastRun}일 경과`}
    >
      {DORMANCY_TIER_LABEL[verdict.tier]}
    </span>
  );
}

/**
 * 만원 단위 표기.
 * ⚠️ **미입력(null)일 때 호출부가 아예 부르지 않는다** — 0원으로 그리면 "실적 없음"으로
 * 오독된다(판정 보류와 실적 0은 다르다).
 */
export function formatPairSales(amount: number): string {
  return `${Math.round(amount / 10_000).toLocaleString()}만원`;
}

/** 경과일 표기. 이력이 없으면 호출부가 부르지 않는다. */
export function formatElapsed(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return `${days.toLocaleString()}일 전`;
}
