import type { DesktopDashboardData } from "@/lib/desktop-dashboard";
// #152: 홈 정산 카드는 파이프라인 스냅샷이 아닌 전용 경량 스냅샷을 소비한다.
import type { MobileSettlementCampaign } from "@/lib/mobile-settlement-data";
import { Card } from "@/components/ui/card";
import { Target, Wallet } from "lucide-react";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { formatCurrency } from "@/lib/format";
import {
  GOAL_BAND_FILL_ON_NAVY,
  GOAL_BAND_TEXT_ON_NAVY,
  GOAL_BAND_TEXT_UNSET_ON_NAVY,
  goalBarWidth,
  resolveGoalBand,
} from "@/lib/goal-band";
import { cn } from "@/lib/utils";
import { MobileHomePulseCard } from "./mobile-home-pulse-card";
import { MobileHomeRiskCard } from "./mobile-home-risk-card";
import { MobileHomeSettlementCard } from "./mobile-home-settlement-card";
import { MobileTopBar } from "./mobile-top-bar";

function rate(actual: number, target: number | null | undefined): number | null {
  if (target == null || target <= 0) return null;
  return Math.round((actual / target) * 1000) / 10;
}

function monthLabel(monthKey: string) {
  const m = parseInt(monthKey.slice(5, 7), 10);
  return `${m}월`;
}

export function MobileHomeView({
  initialData,
  campaigns = [],
}: {
  initialData: DesktopDashboardData;
  campaigns?: MobileSettlementCampaign[];
}) {
  const currentMonthKey = initialData.selectedMonth;
  const monthRate = rate(initialData.goals.monthActual, initialData.goals.monthTarget);
  const annualRate = rate(initialData.goals.ytdActual, initialData.goals.annualTarget);
  // 달성률 색은 밴드에서 한 번 산출해 숫자와 진행바가 함께 탄다(규칙 SSOT: lib/goal-band).
  // 이전에는 값과 무관하게 항상 골드였다 — 61%도 119%도 같은 색이라 색이 정보가 아니었다.
  const annualBand = resolveGoalBand(annualRate);
  const monthBand = resolveGoalBand(monthRate);

  return (
    <div className="flex flex-col min-h-[calc(100dvh+1px)] bg-slate-50 pb-[calc(env(safe-area-inset-bottom)+5rem)]">
      <main className="mobile-tab-safe-top flex-1 space-y-3 overflow-y-auto px-5 pb-4">
        {/* 상단바 — 일정탭 카드 디자인 공용 셸(오너 피드백: 3탭 통일) */}
        <MobileTopBar title="홈 대시보드">
          <p className="mt-0.5 text-xs text-slate-500">주요 운영 지표 및 달성 현황</p>
        </MobileTopBar>
        {/* 매출 목표 히어로 (Mobile Optimized) */}
        <Card className="overflow-hidden border-0 bg-[var(--hero-navy,#0f172a)] text-white shadow-soft-lg p-5 flex flex-col">
          <div className="space-y-3">
            <div className="flex items-start justify-between">
              <h2 className="text-base font-bold text-white/90">연간 누적</h2>
              <Target className="size-4 text-white/30" />
            </div>
            <div className="flex items-baseline justify-between gap-2 pt-1">
              <div>
                <p className="text-2xl font-bold tabular-nums tracking-tight text-white/90">
                  ₩<AnimatedNumber value={initialData.goals.ytdActual} format="currency" />
                </p>
                <p className="text-[10px] tabular-nums text-white/50 mt-0.5">
                  목표 {initialData.goals.annualTarget == null ? "미설정" : `₩${formatCurrency(initialData.goals.annualTarget)}`}
                </p>
              </div>
              <p className={cn("text-xl font-bold tabular-nums", annualBand ? GOAL_BAND_TEXT_ON_NAVY[annualBand] : GOAL_BAND_TEXT_UNSET_ON_NAVY)}>
                {annualRate == null ? "미설정" : <AnimatedNumber value={annualRate} format="percent" decimalPlaces={1} fallback="미설정" />}
              </p>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10 mt-1">
              <div
                className={cn("h-full rounded-full animate-grow-x", annualBand && GOAL_BAND_FILL_ON_NAVY[annualBand])}
                style={{ width: `${goalBarWidth(annualRate)}%` }}
              />
            </div>
          </div>

          <div className="border-t border-white/10 mt-4 pt-4 space-y-3">
            <div className="flex items-start justify-between">
              <h2 className="text-base font-bold text-white/90">이번 달 매출 ({monthLabel(currentMonthKey)})</h2>
              <Wallet className="size-4 text-white/30" />
            </div>
            <div className="flex items-baseline justify-between gap-2 pt-1">
              <div>
                <p className="text-2xl font-bold tabular-nums tracking-tight">
                  ₩<AnimatedNumber value={initialData.goals.monthActual} format="currency" />
                </p>
                <p className="text-[10px] tabular-nums text-white/50 mt-0.5">
                  목표 {initialData.goals.monthTarget == null ? "미설정" : `₩${formatCurrency(initialData.goals.monthTarget)}`}
                </p>
              </div>
              <p className={cn("text-xl font-bold tabular-nums", monthBand ? GOAL_BAND_TEXT_ON_NAVY[monthBand] : GOAL_BAND_TEXT_UNSET_ON_NAVY)}>
                {monthRate == null ? "미설정" : <AnimatedNumber value={monthRate} format="percent" decimalPlaces={1} fallback="미설정" />}
              </p>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10 mt-1">
              <div
                className={cn("h-full rounded-full animate-grow-x", monthBand && GOAL_BAND_FILL_ON_NAVY[monthBand])}
                style={{ width: `${goalBarWidth(monthRate)}%` }}
              />
            </div>
          </div>
        </Card>

        {/* 오늘의 펄스 — 오늘 매출·주문 + 캠페인별 상위 3건 (안 C 신규, 오너 승인 2026-07-15) */}
        <MobileHomePulseCard />

        {/* 정산 대기 — 입금·지급 대기 금액(일정탭에서 이동, 오너 피드백 2026-07-14) */}
        <MobileHomeSettlementCard campaigns={campaigns} />

        {/* 리스크 신호 — 정합성 오류·후속 액션 신호, 0건이면 미렌더 (안 C 신규).
            구 "최근 90일 영업 전환" 퍼널 카드는 안 C 에서 제거 — 영업 퍼널은
            데스크톱 대시보드·영업 관리 화면이 소유(P3: 모바일은 데스크톱 패리티 아님). */}
        <MobileHomeRiskCard
          issues={initialData.dataIntegrityIssues}
          exceptions={initialData.exceptions}
        />
      </main>
    </div>
  );
}
