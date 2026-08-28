"use client";

// D2① 딜 → 셀러 — "이 딜에 누구를 제안할까". 읽기 전용이고, 제안 액션은 딜 상세가
// 이미 쓰는 아웃리치 생성 경로를 그대로 호출한다(**새 쓰기 경로 없음**).
//
// 매칭 키에 카테고리를 쓰지 않는 것은 의도다 — 근거는 `deal-seller-matching.ts` 주석.
// 랭킹·사유 판정은 전부 그 SSOT 가 하고 이 컴포넌트는 표시만 한다.

import * as React from "react";
import { UserPlusIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { SellerCandidate } from "@/lib/deal-seller-matching";
import {
  DormancyBadge,
  MatchReasonBadge,
  PriorityBadge,
  formatElapsed,
  formatPairSales,
} from "./match-candidate-row";

type CandidateView = SellerCandidate & {
  name: string;
  snsHandle: string;
  snsType: string;
  fitLevel: string | null;
  currentFollowers: number;
  /** 같은 (셀러, 사유, 딜) 조합의 열린 기안이 이미 있다 */
  proposed: boolean;
};

const VISIBLE_LIMIT = 8;

export function DealSellerCandidates({
  dealId,
  dealName,
  onPropose,
}: {
  dealId: string;
  dealName: string;
  onPropose: (dealId: string, dealName: string) => void;
}) {
  const [candidates, setCandidates] = React.useState<CandidateView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // 서버가 알던 기안 + 이번 세션에서 방금 올린 것을 합쳐 버튼 상태를 관리
  const [proposed, setProposed] = React.useState<Set<string>>(() => new Set());
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/deals/${dealId}/seller-candidates`);
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "제안 후보를 불러오지 못했습니다.");
        if (!cancelled) {
          const list: CandidateView[] = data.candidates ?? [];
          setCandidates(list);
          setProposed(new Set(list.filter((c) => c.proposed).map((c) => c.sellerId)));
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
  }, [dealId]);

  // 후보 하나를 승인 대기 기안으로 올린다. 사유 코드는 **서버가 재계산해 정하므로**
  // 클라이언트는 (셀러, 딜)만 보낸다 — 사유가 dedup 키의 축이라 여기서 정하면 키를 우회한다.
  const handlePropose = async (sellerId: string, sellerName: string) => {
    if (pendingId) return;
    setPendingId(sellerId);
    try {
      const res = await fetch("/api/recampaign-proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerId, dealId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "기안 생성에 실패했습니다.");
      // created 든 skipped(이미 존재)든 결과적으로 열린 기안이 있다
      setProposed((prev) => new Set(prev).add(sellerId));
      toast.success(
        data?.skipped
          ? `${sellerName}: 이미 승인 대기 중인 기안이 있습니다.`
          : `${sellerName} 제안 기안을 승인함에 올렸습니다.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "기안 생성 중 오류가 발생했습니다.");
    } finally {
      setPendingId(null);
    }
  };

  if (error) {
    return <p className="text-[11px] text-[var(--status-urgent)]">제안 후보 셀러: {error}</p>;
  }
  // 로딩 중엔 skeleton 대신 null — 곧 사라질 자리를 잡았다 놓는 깜빡임이 더 나쁘다
  // (재캠페인 적기 카드와 같은 규약).
  if (candidates === null) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-foreground">
          제안 후보 셀러 ({candidates.length}명)
        </h3>
        <Button
          variant="outline"
          className="h-6 text-[10px] px-2 py-0 gap-0.5 rounded-md border-border/70 text-muted-foreground inline-flex items-center"
          onClick={() => onPropose(dealId, dealName)}
        >
          <UserPlusIcon className="size-2.5" />
          <span>제안</span>
        </Button>
      </div>

      {candidates.length === 0 ? (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-slate-200 p-6 bg-slate-50/30">
          <p className="text-xs text-slate-500">제안 후보가 없습니다</p>
        </div>
      ) : (
        <div className="space-y-1">
          {candidates.slice(0, VISIBLE_LIMIT).map((c) => (
            <div
              key={c.sellerId}
              className="rounded-xl border border-border/50 bg-white p-3"
            >
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[11px] font-semibold text-foreground">{c.name}</span>
                <MatchReasonBadge reason={c.reason} />
                {c.priority && <PriorityBadge />}
                <span className="ml-auto shrink-0">
                  {proposed.has(c.sellerId) ? (
                    <span className="text-[10px] font-semibold text-[var(--primary)]">
                      기안됨 · 승인함에서 확인
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      disabled={pendingId === c.sellerId}
                      onClick={() => handlePropose(c.sellerId, c.name)}
                    >
                      {pendingId === c.sellerId ? "기안 중..." : "기안"}
                    </Button>
                  )}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                {/* 거래 실적 축(거래 리듬)과 계정 신호 축(평가)을 나란히 — 합산하지 않는다(D10) */}
                <DormancyBadge verdict={c.dormancy} />
                <span>진행 {c.runCount}회</span>
                {c.fitLevel && <span>· 평가 {c.fitLevel}</span>}
                {c.pairLastRunStartAt && <span>· 이 딜 {formatElapsed(c.pairLastRunStartAt)}</span>}
                {/* 미입력(null)은 아예 그리지 않는다 — 0원으로 보이면 실적 없음으로 오독된다 */}
                {c.pairSalesTotal != null && <span>· {formatPairSales(c.pairSalesTotal)}</span>}
              </div>
            </div>
          ))}
          {candidates.length > VISIBLE_LIMIT && (
            <p className="text-[10px] text-muted-foreground/70">
              외 {candidates.length - VISIBLE_LIMIT}명
            </p>
          )}
        </div>
      )}
    </div>
  );
}
