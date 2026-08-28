"use client";

// D2② 셀러 → 딜 — "이 셀러에게 무엇을 제안할까".
// 셀러 상세에는 지금까지 딜 섹션이 아예 없었다 — 이 컴포넌트가 그 자리를 만든다.
//
// 랭킹·사유 판정은 `deal-seller-matching.ts` SSOT 가 하고 여기는 표시와 기안 트리거만 한다.
// 기안은 딜 상세 쪽 섹션과 **같은 엔드포인트**를 쓴다(방향만 다르고 만드는 것은 같은
// (셀러 × 딜) 기안이다) — 두 표면이 서로 다른 기안을 만들면 dedup 이 갈린다.

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { DealCandidate } from "@/lib/deal-seller-matching";
import {
  MatchReasonBadge,
  PriorityBadge,
  formatElapsed,
  formatPairSales,
} from "./match-candidate-row";

type CandidateView = DealCandidate & {
  /** 같은 (셀러, 사유, 딜) 조합의 열린 기안이 이미 있다 */
  proposed: boolean;
};

const VISIBLE_LIMIT = 8;

export function SellerDealCandidates({ sellerId }: { sellerId: string }) {
  const [candidates, setCandidates] = React.useState<CandidateView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [proposed, setProposed] = React.useState<Set<string>>(() => new Set());
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/sellers/${sellerId}/deal-candidates`);
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "제안 후보 딜을 불러오지 못했습니다.");
        if (!cancelled) {
          const list: CandidateView[] = data.candidates ?? [];
          setCandidates(list);
          setProposed(new Set(list.filter((c) => c.proposed).map((c) => c.dealId)));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "조회 중 오류가 발생했습니다.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sellerId]);

  // 사유 코드는 **서버가 재계산해 정한다** — 사유가 dedup 키의 축이라 클라이언트가
  // 정하게 두면 키를 우회할 수 있다. 그래서 (셀러, 딜)만 보낸다.
  const handlePropose = async (dealId: string, dealName: string) => {
    if (pendingId) return;
    setPendingId(dealId);
    try {
      const res = await fetch("/api/recampaign-proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerId, dealId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "기안 생성에 실패했습니다.");
      setProposed((prev) => new Set(prev).add(dealId));
      toast.success(
        data?.skipped
          ? `${dealName}: 이미 승인 대기 중인 기안이 있습니다.`
          : `${dealName} 제안 기안을 승인함에 올렸습니다.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "기안 생성 중 오류가 발생했습니다.");
    } finally {
      setPendingId(null);
    }
  };

  if (error) {
    return <p className="text-[11px] text-[var(--status-urgent)]">제안 후보 딜: {error}</p>;
  }
  if (candidates === null) return null;

  return (
    <div className="space-y-2 rounded-2xl border border-border/70 bg-white/90 p-4">
      <h3 className="text-xs font-semibold text-foreground">
        제안 후보 딜 ({candidates.length}건)
      </h3>

      {candidates.length === 0 ? (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-slate-200 p-6 bg-slate-50/30">
          <p className="text-xs text-slate-500">제안 후보 딜이 없습니다</p>
        </div>
      ) : (
        <div className="space-y-1">
          {candidates.slice(0, VISIBLE_LIMIT).map((c) => (
            <div key={c.dealId} className="rounded-xl border border-border/50 bg-white p-3">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[11px] font-semibold text-foreground">
                  {c.dealName}
                </span>
                <MatchReasonBadge reason={c.reason} />
                {c.priority && <PriorityBadge />}
                <span className="ml-auto shrink-0">
                  {proposed.has(c.dealId) ? (
                    <span className="text-[10px] font-semibold text-[var(--primary)]">
                      기안됨 · 승인함에서 확인
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      disabled={pendingId === c.dealId}
                      onClick={() => handlePropose(c.dealId, c.dealName)}
                    >
                      {pendingId === c.dealId ? "기안 중..." : "기안"}
                    </Button>
                  )}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                {c.brandName && <span>{c.brandName}</span>}
                {c.pairLastRunStartAt && (
                  <span>· 마지막 진행 {formatElapsed(c.pairLastRunStartAt)}</span>
                )}
                {c.pairRunCount != null && <span>· 진행 {c.pairRunCount}회</span>}
                {/* 미입력(null)은 그리지 않는다 — 0원 표기는 실적 없음으로 오독된다 */}
                {c.pairSalesTotal != null && <span>· {formatPairSales(c.pairSalesTotal)}</span>}
              </div>
            </div>
          ))}
          {candidates.length > VISIBLE_LIMIT && (
            <p className="text-[10px] text-muted-foreground/70">
              외 {candidates.length - VISIBLE_LIMIT}건
            </p>
          )}
        </div>
      )}
    </div>
  );
}
