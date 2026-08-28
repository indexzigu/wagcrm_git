"use client";

// F3 소개 네트워크 다이얼로그 (GROWTH_FLYWHEEL_PLAN.md §F3) — 유입 경로 분포 + 커넥터
// 리더보드를 한 화면에 보여준다. 소유자가 "어디서 셀러가 오는가"와 "누구를 관계로 키울
// 것인가(핵심 소개자)"를 판단하는 용도. 데이터는 이미 로드된 셀러 목록에서 계산(신규 쿼리 0).

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
import {
  computeAcquisitionBreakdown,
  computeConnectorLeaderboard,
  computeReferralConversion,
} from "@/lib/referral-analytics";
import type { SellerSummary } from "@/lib/crm-types";

export function ReferralNetworkDialog({
  open,
  onOpenChange,
  sellers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sellers: SellerSummary[];
}) {
  const breakdown = React.useMemo(() => computeAcquisitionBreakdown(sellers), [sellers]);
  const leaderboard = React.useMemo(() => computeConnectorLeaderboard(sellers), [sellers]);
  const conversion = React.useMemo(() => computeReferralConversion(sellers), [sellers]);
  const totalTagged = breakdown.reduce((s, b) => (b.channel === "UNKNOWN" ? s : s + b.count), 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>소개 네트워크</DialogTitle>
          <DialogDescription>
            셀러가 어디서 오는지와 누가 소개를 만드는지: 소개는 이 사업의 핵심 획득 채널입니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 max-h-[60vh] overflow-y-auto pr-1">
          {/* 유입 경로 분포 */}
          <section>
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold text-foreground">유입 경로</h3>
              <span className="text-[10px] text-muted-foreground">
                소개 전환 {conversion.converted}/{conversion.referred} ({conversion.rate.toFixed(0)}%)
              </span>
            </div>
            <div className="mt-2 space-y-1.5">
              {breakdown.map((b) => {
                const pct = sellers.length > 0 ? (b.count / sellers.length) * 100 : 0;
                return (
                  <div key={b.channel}>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className={b.channel === "UNKNOWN" ? "text-muted-foreground" : "text-foreground font-medium"}>
                        {b.label}
                      </span>
                      <span className="text-muted-foreground">{b.count}명</span>
                    </div>
                    <div className="mt-0.5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className={b.channel === "REFERRAL" ? "h-full rounded-full bg-emerald-500" : "h-full rounded-full bg-slate-400"}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {totalTagged < sellers.length && (
              <p className="mt-1.5 text-[10px] text-amber-600">
                {sellers.length - totalTagged}명 미분류: 셀러 상세에서 유입 경로를 채우면 정확도가 올라갑니다.
              </p>
            )}
          </section>

          {/* 커넥터 리더보드 */}
          <section>
            <h3 className="text-xs font-semibold text-foreground">상위 소개자 (커넥터)</h3>
            {leaderboard.length === 0 ? (
              <p className="mt-2 rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-[11px] text-muted-foreground">
                아직 기록된 소개 관계가 없습니다. 셀러 상세에서 &apos;소개자&apos;를 지정하면 여기에 커넥터가 쌓입니다.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {leaderboard.map((row, i) => (
                  <li
                    key={row.connectorId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-bold text-muted-foreground w-4 shrink-0">{i + 1}</span>
                      <span className="text-xs font-medium text-foreground truncate">{row.connectorName}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="text-[10px]">
                        소개 {row.referredCount}명
                      </Badge>
                      {row.activeReferredCount > 0 && (
                        <span className="text-[10px] text-emerald-700">거래 {row.activeReferredCount}</span>
                      )}
                      {row.downstreamSales > 0 && (
                        <span className="text-[10px] font-mono text-slate-600">{formatCurrency(row.downstreamSales)}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[10px] text-muted-foreground/80">
              소개는 금전 보상 없이 관계로 유지됩니다. 상위 커넥터에게는 좋은 딜 우선 제안·성과 공유로 답하세요.
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
