"use client";

import { AlertCircleIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import type { CampaignRow } from "@/lib/crm-types";
import type { SettlementReportData } from "@/lib/settlement-report";
import { formatSettlementMonth } from "@/lib/settlement-report";
import { formatCurrency } from "@/lib/format";
import { MONEY_DIRECTION_ICON, MONEY_DIRECTION_TEXT } from "@/lib/money-direction";
import { resolveCampaignMoneySlots } from "@/lib/tax-filing-board";
import { MobileCampaignCard } from "./mobile-campaign-card";
import { MobileTopBar } from "./mobile-top-bar";

type MobileSettlementViewProps = {
  reportData: SettlementReportData | null;
  campaigns: CampaignRow[];
  selectedMonth: string;
  viewType: "month" | "year";
  selectedYear: string;
  localQuery: string;
  setLocalQuery: (value: string) => void;
  commitSearch: (value: string) => void;
  onOpenCampaign: (campaign: CampaignRow) => void;
  onRefresh: () => Promise<void>;
  loading: boolean;
};

export function MobileSettlementView({
  campaigns,
  selectedMonth,
  viewType,
  selectedYear,
  localQuery,
  setLocalQuery,
  commitSearch,
  onOpenCampaign,
  onRefresh,
  loading,
}: MobileSettlementViewProps) {
  // 섹션 분류는 **채널 슬롯**이 정한다(`resolveCampaignMoneySlots`).
  // ⛔ `!입금` / `입금 && !지급` 으로 되돌리지 말 것 — 자사몰은 입금 칸이 없어 그 식이면
  // ①전건이 「입금 확인」 섹션에 영구 상주하고 ②「지급」 섹션에는 **영원히 못 들어온다**
  // (선행 조건인 입금 플래그가 켜질 경로가 아예 없다).
  const withSlots = campaigns.map((campaign) => ({
    campaign,
    slots: resolveCampaignMoneySlots(campaign.salesChannel),
  }));

  // 「입금 확인 필요」 = 미완료 입금 칸이 있는 건. 「지급 필요」 = 그 채널의 입금이 전부
  // 끝났고(자사몰은 칸이 없어 공허참) 미완료 지급 칸이 남은 건 — 종전의 순차 규율
  // (받기 전에 내주지 않는다)을 채널 무관하게 일반화한 것이다.
  const depositPending = withSlots
    .filter(({ campaign, slots }) =>
      slots.some((slot) => slot.kind === "DEPOSIT" && !campaign[slot.flagField]),
    )
    .map(({ campaign }) => campaign);
  const payoutPending = withSlots
    .filter(
      ({ campaign, slots }) =>
        slots.every((slot) => slot.kind !== "DEPOSIT" || campaign[slot.flagField]) &&
        slots.some((slot) => slot.kind === "PAYOUT" && !campaign[slot.flagField]),
    )
    .map(({ campaign }) => campaign);

  // 대기 금액도 같은 축으로 센다 — 금액 컬럼이 셀러 축뿐이라 자사몰 공급사 지급은
  // 합계에 들어가지 않는다(모바일 대기 시트 `slotAmount` 와 같은 규약, 0 으로 접지 않음).
  const pendingDepositAmount = withSlots
    .filter(({ campaign, slots }) =>
      slots.some((slot) => slot.kind === "DEPOSIT" && !campaign[slot.flagField]),
    )
    .reduce((sum, { campaign }) => sum + (campaign.settlementSales || 0), 0);

  const pendingPayoutAmount = withSlots
    .filter(({ campaign, slots }) =>
      slots.some((slot) => slot.flagField === "isPayoutCompleted" && !campaign[slot.flagField]),
    )
    .reduce((sum, { campaign }) => sum + (campaign.sellerExpense || 0), 0);

  const sections = [
    {
      key: "deposit",
      title: "입금 확인 필요",
      description: "정산금 입금 여부를 먼저 확인합니다.",
      items: depositPending,
    },
    {
      key: "payout",
      title: "지급 필요",
      description: "입금 확인이 끝나고 지급이 남은 건입니다.",
      items: payoutPending,
    },
  ].filter((section) => section.items.length > 0);
  const periodLabel =
    viewType === "year" ? `${selectedYear}년` : formatSettlementMonth(selectedMonth);
 
  return (
    <div className="mobile-tab-safe-top flex min-h-[calc(100dvh+1px)] flex-1 flex-col gap-4 px-5 pb-24">
      <MobileTopBar title="정산 확인">
        <p className="mt-0.5 text-xs text-muted-foreground">
          {periodLabel} 기준 입금과 지급 상태를 확인합니다.
        </p>
        {/* 방향 아이콘 색은 규칙 SSOT(lib/money-direction) — 이전에는 입금·지급이 둘 다
            text-muted-foreground/70 이라 방향이 화살표 모양으로만 구분됐다. */}
        <div className="mt-2 flex items-center gap-3 text-xs font-medium text-muted-foreground">
          <span className="flex items-center gap-1">
            <MONEY_DIRECTION_ICON.in aria-hidden="true" className={`size-3.5 ${MONEY_DIRECTION_TEXT.in}`} />
            입금 대기 <span className="tabular-nums">₩{formatCurrency(pendingDepositAmount)}</span>
          </span>
          <span aria-hidden="true" className="text-muted-foreground/60">·</span>
          <span className="flex items-center gap-1">
            <MONEY_DIRECTION_ICON.out aria-hidden="true" className={`size-3.5 ${MONEY_DIRECTION_TEXT.out}`} />
            지급 대기 <span className="tabular-nums">₩{formatCurrency(pendingPayoutAmount)}</span>
          </span>
        </div>
      </MobileTopBar>

      <div className="flex items-center gap-2">
        <InputGroup className="h-11 rounded-2xl border border-white/60 bg-white/80 backdrop-blur-sm shadow-soft-sm">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={localQuery}
            onChange={(event) => {
              const value = event.target.value;
              setLocalQuery(value);
              commitSearch(value);
            }}
            placeholder="캠페인, 셀러 검색"
            className="h-full border-0 text-sm focus-visible:ring-0"
          />
        </InputGroup>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 shrink-0 rounded-xl"
          onClick={() => void onRefresh()}
          disabled={loading}
        >
          새로고침
        </Button>
      </div>

      {sections.length > 0 ? (
        <div className="flex flex-col gap-5">
          {sections.map((section) => (
            <section key={section.key} className="mobile-briefing-section flex flex-col gap-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">{section.title}</h2>
                <p className="text-xs text-muted-foreground">{section.description}</p>
              </div>
              <div className="flex flex-col gap-3">
                {section.items.map((campaign) => (
                  <MobileCampaignCard
                    key={campaign.id}
                    campaign={campaign}
                    variant="settlement"
                    onOpen={onOpenCampaign}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty className="border border-border/70 bg-background py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircleIcon />
            </EmptyMedia>
            <EmptyTitle>조회 조건에 맞는 정산 항목이 없습니다.</EmptyTitle>
            <EmptyDescription>월 또는 검색어를 바꿔 다른 정산 건을 확인할 수 있습니다.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
