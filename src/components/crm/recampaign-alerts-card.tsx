"use client";

// F1 재캠페인 적기 카드 (GROWTH_FLYWHEEL_PLAN.md §F1) — 읽기 전용 알림 + 승인함 기안(Phase B).
// DUE 셀러는 "기안" 버튼으로 ActionProposal(add_entity_memo)을 승인 대기함에 올린다. 승인 시
// 셀러에 재접촉 결정이 메모로 기록되고, 이미 열린 기안이 있으면 버튼 대신 "기안됨"으로 표시한다.
// 대시보드에서 영업 관리(/outreach)로 이관되며 GET /api/recampaign-alerts에서 스스로 데이터를 조회한다.

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RecampaignAlert } from "@/lib/recampaign-timing";

export function RecampaignAlertsCard({ className }: { className?: string }) {
  const [alerts, setAlerts] = React.useState<RecampaignAlert[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // 서버가 이미 알던 기안 셀러 + 이번 세션에서 방금 기안한 셀러를 합쳐 버튼 상태를 관리
  const [proposed, setProposed] = React.useState<Set<string>>(() => new Set());
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    async function fetchAlerts() {
      try {
        const res = await fetch("/api/recampaign-alerts");
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "재캠페인 알림을 불러오지 못했습니다.");
        setAlerts(data.alerts ?? []);
        setProposed(new Set<string>(data.proposedSellerIds ?? []));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "재캠페인 알림 조회 중 오류가 발생했습니다.");
      } finally {
        setLoading(false);
      }
    }
    fetchAlerts();
  }, []);

  // 로딩 중엔 skeleton 대신 null — 알림 0건이면 카드 자체가 사라지므로,
  // skeleton을 보여줬다 즉시 제거되는 레이아웃 깜빡임이 더 나쁘다.
  if (loading) return null;
  if (loadError) {
    return (
      <div className={cn("rounded-xl border border-black/5 bg-white/85 shadow-soft-sm px-4 py-3", className)}>
        <p className="text-[11px] text-[var(--status-urgent)]">재캠페인 적기 알림: {loadError}</p>
      </div>
    );
  }
  if (alerts.length === 0) return null;

  const dueCount = alerts.filter((a) => a.state === "DUE").length;
  const upcomingCount = alerts.filter((a) => a.state === "UPCOMING").length;

  const handlePropose = async (sellerId: string, sellerName: string) => {
    if (pendingId) return;
    setPendingId(sellerId);
    try {
      const res = await fetch("/api/recampaign-proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? "기안 생성에 실패했습니다.");
      }
      // created든 skipped(이미 존재)든 결과적으로 열린 기안이 있으므로 '기안됨'으로 표시
      setProposed((prev) => new Set(prev).add(sellerId));
      toast.success(
        data?.skipped
          ? `${sellerName}: 이미 승인 대기 중인 기안이 있습니다.`
          : `${sellerName} 재캠페인 기안을 승인함에 올렸습니다.`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "기안 생성 중 오류가 발생했습니다.");
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className={cn("rounded-xl border border-black/5 bg-white/85 shadow-soft-sm", className)}>
      <div className="px-4 py-5">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <RotateCcw className="size-4 shrink-0 text-[var(--primary)]" />
            <p className="text-sm font-semibold tracking-wide text-[var(--primary)]">재캠페인 적기</p>
            {dueCount > 0 && (
              <Badge variant="outline" className="py-0.5 px-2 text-[10px] font-semibold bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/20 dark:text-amber-400 dark:border-amber-900/30">
                도래 {dueCount}
              </Badge>
            )}
            {upcomingCount > 0 && (
              <Badge variant="outline" className="py-0.5 px-2 text-[10px] font-semibold bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-950/20 dark:text-slate-400 dark:border-slate-800/40">
                임박 {upcomingCount}
              </Badge>
            )}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/70">
            셀러별 캠페인 시작 간격(중앙값) 기준 다음 제안 타이밍. 적기 도래 셀러는 &apos;기안&apos;으로 승인함에 올릴 수 있습니다. 가용 일정은 셀러에게 확인한 값만 표시됩니다.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {alerts.slice(0, 8).map((alert) => {
            const isProposed = proposed.has(alert.sellerId);
            return (
              <div key={alert.sellerId} className="rounded-xl border border-black/5 bg-[#FAF9F6] px-3.5 py-2.5 w-[240px] shrink-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-semibold text-[#1F2A30]" title={alert.sellerName}>
                    {alert.sellerName}
                  </p>
                  <span
                    className={
                      alert.state === "DUE"
                        ? "shrink-0 text-[10px] font-semibold text-amber-700"
                        : "shrink-0 text-[10px] font-semibold text-slate-500"
                    }
                  >
                    {alert.state === "DUE" ? `${-alert.daysUntilDue}일 경과` : `${alert.daysUntilDue}일 후`}
                  </span>
                </div>
                <p className="mt-1 text-[10px] text-slate-500">
                  {alert.medianIntervalDays}일 주기 · {alert.runCount}회 진행
                </p>
                {alert.availabilityNote && (
                  <p className="mt-0.5 truncate text-[10px] text-emerald-700" title={alert.availabilityNote}>
                    일정: {alert.availabilityNote}
                  </p>
                )}
                {alert.state === "DUE" && (
                  <div className="mt-2">
                    {isProposed ? (
                      <span className="inline-flex items-center text-[10px] font-semibold text-[var(--primary)]">
                        기안됨 · 승인함에서 확인
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[10px]"
                        disabled={pendingId === alert.sellerId}
                        onClick={() => handlePropose(alert.sellerId, alert.sellerName)}
                      >
                        {pendingId === alert.sellerId ? "기안 중..." : "기안"}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {alerts.length > 8 && (
          <p className="mt-2 text-[10px] text-muted-foreground/70">
            외 {alerts.length - 8}명: 셀러 목록에서 확인
          </p>
        )}
      </div>
    </div>
  );
}
