"use client";

import { useEffect, useMemo, useState } from "react";
import { Wallet } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { MONEY_DIRECTION_ICON, MONEY_DIRECTION_TEXT } from "@/lib/money-direction";
import { toYmd } from "@/lib/mobile-schedule-grid";
import type { MobileSettlementCampaign } from "@/lib/mobile-settlement-data";
import {
  campaignRowToDetailData,
  MobileCampaignDetailSheet,
  type MobileCampaignDetailData,
} from "./mobile-campaign-detail-sheet";
import {
  buildSettlementPending,
  MobileSettlementPendingSheet,
} from "./mobile-settlement-pending-sheet";

/**
 * 홈 정산 대기 카드 (오너 피드백 2026-07-14) — 입금·지급 대기 금액을 일정탭
 * 자금 칩에서 홈 지표로 이동. 일정탭은 일정 정보·관리에 집중하고, 자금 리스크
 * 지표는 홈 대시보드가 소유한다.
 *
 * - 합계 계산은 일정탭 시절과 동일하게 buildSettlementPending 단일 출처 —
 *   타일 합계와 대기 목록 시트 합계가 항상 일치한다.
 * - 타일 탭 → 조회 전용 정산 대기 목록 시트, 행 탭 → 캠페인 상세 시트(조회 전용).
 * - todayYmd 는 마운트 후 클라이언트 시계로 계산(캘린더 홈과 동일한 하이드레이션
 *   안전 패턴) — 계산 전에는 스켈레톤을 렌더한다.
 */
export function MobileHomeSettlementCard({ campaigns }: { campaigns: MobileSettlementCampaign[] }) {
  const [todayYmd, setTodayYmd] = useState("");
  useEffect(() => {
    setTodayYmd(toYmd(new Date()));
  }, []);

  const [pendingOpen, setPendingOpen] = useState(false);
  const [detail, setDetail] = useState<MobileCampaignDetailData | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const pending = useMemo(
    () => (todayYmd ? buildSettlementPending(campaigns, todayYmd) : null),
    [campaigns, todayYmd],
  );

  const handleOpenCampaign = (campaign: MobileSettlementCampaign) => {
    setDetail(campaignRowToDetailData(campaign));
    setDetailOpen(true);
  };

  return (
    <>
      <Card className="border-black/5 bg-white shadow-soft-sm p-0">
        <CardContent className="px-4 py-4">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-100">
            <Wallet className="size-4 shrink-0 text-[var(--primary)]" />
            <p className="text-sm font-semibold text-[var(--primary)] tracking-tight">정산 대기</p>
          </div>
          {pending == null ? (
            <div
              aria-busy="true"
              aria-label="정산 대기 불러오는 중"
              className="mt-3 grid grid-cols-2 gap-2"
            >
              <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
              <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPendingOpen(true)}
                aria-label="입금 대기 목록 열기"
                className="flex min-h-16 flex-col items-start gap-1 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2.5 text-left transition-transform duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
              >
                {/* 방향 아이콘 + 색 한 쌍(규칙 SSOT: lib/money-direction). 이 카드는 5개 표면
                    중 유일하게 아이콘이 없어 입금·지급이 라벨 글자로만 구분됐다 — 첫 화면인데
                    가장 약한 표현이었다. 타일은 초점 숫자라 금액까지 칠한다(목록 행과 다름). */}
                <span className="flex items-center gap-1 text-[11px] font-medium text-slate-500">
                  <MONEY_DIRECTION_ICON.in
                    aria-hidden="true"
                    className={`size-3.5 shrink-0 ${MONEY_DIRECTION_TEXT.in}`}
                  />
                  입금 대기 <span className="tabular-nums">{pending.deposit.count}건</span>
                </span>
                <span className={`text-[15px] font-bold tabular-nums tracking-tight ${MONEY_DIRECTION_TEXT.in}`}>
                  ₩{formatCurrency(pending.deposit.total)}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPendingOpen(true)}
                aria-label="지급 대기 목록 열기"
                className="flex min-h-16 flex-col items-start gap-1 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2.5 text-left transition-transform duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
              >
                <span className="flex items-center gap-1 text-[11px] font-medium text-slate-500">
                  <MONEY_DIRECTION_ICON.out
                    aria-hidden="true"
                    className={`size-3.5 shrink-0 ${MONEY_DIRECTION_TEXT.out}`}
                  />
                  지급 대기 <span className="tabular-nums">{pending.payout.count}건</span>
                </span>
                <span className={`text-[15px] font-bold tabular-nums tracking-tight ${MONEY_DIRECTION_TEXT.out}`}>
                  ₩{formatCurrency(pending.payout.total)}
                </span>
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      <MobileSettlementPendingSheet
        open={pendingOpen}
        onOpenChange={setPendingOpen}
        campaigns={campaigns}
        todayYmd={todayYmd}
        onOpenCampaign={handleOpenCampaign}
      />

      {/* 상세 시트는 대기 목록보다 뒤에 렌더 — 목록 위로 겹쳐 열리고 닫으면 목록으로 복귀 */}
      <MobileCampaignDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        campaign={detail}
        todayYmd={todayYmd || undefined}
      />
    </>
  );
}
