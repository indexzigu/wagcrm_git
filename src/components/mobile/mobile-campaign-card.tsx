"use client";

import { UserRoundIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { type CampaignRow, type CampaignStatus } from "@/lib/crm-types";
import { StatusBadge } from "@/components/crm/status-badge";
import { formatCampaignActionDate, getCampaignAction } from "@/lib/campaign-actions";
import {
  isInSetupWindow,
  needsChannelAssignment,
  needsOrderRegistration,
} from "@/lib/campaign-setup";
import { formatCurrency } from "@/lib/format";
import { resolveCampaignMoneySlots } from "@/lib/tax-filing-board";
import { cn } from "@/lib/utils";

type MobileCampaignCardProps = {
  campaign: CampaignRow;
  variant?: "monitor" | "pipeline" | "settlement";
  /**
   * 그룹 카드(조합 캠페인 1장 표시)일 때 멤버 수. 2 이상이면 "N개 딜" 배지를
   * 노출하고, 개별 멤버 값이라 그룹 합성 행에서 의미가 깨지는 마진은 숨긴다.
   */
  groupMemberCount?: number;
  onOpen: (campaign: CampaignRow) => void;
};

function toneVariant(tone: ReturnType<typeof getCampaignAction>["tone"]) {
  switch (tone) {
    case "overdue":
      return "status-urgent";
    case "today":
      return "status-pending";
    case "upcoming":
      return "status-info";
    default:
      return "secondary";
  }
}

export function MobileCampaignCard({
  campaign,
  variant = "pipeline",
  groupMemberCount,
  onOpen,
}: MobileCampaignCardProps) {
  const isGroup = groupMemberCount != null && groupMemberCount > 1;
  const action = getCampaignAction(campaign);
  const inSetupWindow = campaign.status === "PREPARATION" && isInSetupWindow(campaign);
  const needsChannelSetup = inSetupWindow && needsChannelAssignment(campaign);
  const needsOrderSetup = inSetupWindow && needsOrderRegistration(campaign);
  const actionLabel = action.dueDate
    ? `${action.label} - ${formatCampaignActionDate(action.dueDate)}`
    : action.label;
  const periodLabel = `${campaign.startDate.slice(5)} ~ ${campaign.endDate.slice(5)}`;
  // 정산 변형의 상태 문구 — 채널 슬롯 순서의 **첫 미완료 칸**이 곧 다음 할 일이다.
  // ⛔ `!입금 → 입금 확인 필요` 로 되돌리지 말 것: 자사몰은 입금 칸이 없어 그 플래그가
  // 영원히 false 라, 공급사·셀러 지급을 다 끝낸 캠페인도 「입금 확인 필요」로 굳는다.
  const nextMoneySlot = resolveCampaignMoneySlots(campaign.salesChannel).find(
    (slot) => !campaign[slot.flagField],
  );
  const settlementState = nextMoneySlot
    ? `${nextMoneySlot.counterpartLabel} ${nextMoneySlot.verb} 필요`
    : "정산 완료";
  // ₩ 프리픽스 — 홈 펄스·정산 카드·시트 금액 표기(₩1,234,567)와 동일 규약으로 통일.
  // null 은 프리픽스 전에 가드한다(안 하면 "₩-" 가 렌더된다) — mobile-sheet-card 등
  // 같은 규약을 쓰는 표면들의 "금액 미정" 관례를 그대로 따른다.
  const primaryMetricAmount =
    variant === "settlement"
      ? (campaign.actualPayoutAmount ?? campaign.sellerExpense)
      : campaign.actualSales;
  const primaryMetric =
    primaryMetricAmount == null ? "금액 미정" : `₩${formatCurrency(primaryMetricAmount)}`;
  const primaryMetricLabel = variant === "settlement" ? settlementState : "실매출";
  // 마진은 그룹(첫 멤버 값이라 오독)·정산 변형에서 숨긴다 — 적자 배지도 마진의 캐리어라
  // 마진이 안 보이는 카드에는 함께 숨긴다(근거 없는 배지 방지).
  const showMargin = variant !== "settlement" && !isGroup;
  const isLoss = showMargin && campaign.netMarginRate < 0;

  return (
    // 프레스는 딤이다(오너 결정 2026-07-22) — 축소는 그리드 타일 전용. 배경색 대신
    // brightness 를 쓰는 이유: 이 카드는 bg-white/80 글래스라 active:bg-* 로 덮으면
    // 유리 재질이 사라진다. 필터는 재질을 유지한 채 어둡게만 만든다.
    <article className="rounded-2xl border border-white/60 bg-white/80 p-3.5 shadow-soft-sm backdrop-blur-sm transition-[filter] duration-150 active:brightness-[0.93]">
      <button
        type="button"
        onClick={() => onOpen(campaign)}
        className="flex w-full flex-col gap-2.5 text-left"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[14px] font-bold text-slate-800 tracking-tight">
              {campaign.dealName}
            </div>
            {/* 셀러·브랜드 — 일정 리스트/상세 시트와 동일한 아이콘+뮤트 패턴으로 통일(item 7).
                딜명만 강조 티어, 나머지 부가정보는 text-xs 뮤트 한 티어로 정리. */}
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium text-slate-500">
              <span className="inline-flex min-w-0 items-center gap-1">
                <UserRoundIcon aria-hidden="true" className="size-3 shrink-0 text-slate-400" />
                <span className="truncate text-slate-600">{campaign.sellerName}</span>
              </span>
              {isGroup ? (
                // 조합 캠페인 그룹 카드 — 상세 시트 헤더의 "N개 딜" 배지와 동일 스타일.
                <Badge className="shrink-0 bg-primary/10 text-primary hover:bg-primary/10 border-0 h-5 px-1.5 text-[10px]">
                  {groupMemberCount}개 딜
                </Badge>
              ) : null}
              {campaign.deal?.brandName || campaign.partnerName ? (
                <span className="truncate">· {campaign.deal?.brandName || campaign.partnerName}</span>
              ) : null}
            </div>
          </div>
          <StatusBadge status={campaign.status as CampaignStatus} className="shrink-0 text-[10px] h-5 shadow-soft-sm" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={toneVariant(action.tone)} className="text-[10px] px-2 py-0.5 h-5">
            {actionLabel}
          </Badge>
          {/* 세팅 대기의 "업데이트 지연"은 SSOT 에서 제거됐다(updatedAt = 배치 나이라
              구조적 오탐). 그 자리를 대신하는 실제 할 일 — 데스크톱 카드와 같은 판정
              (`campaign-setup.ts`)을 쓴다. 모바일은 오너가 현장에서 보는 표면이라
              데스크톱에만 신호를 두면 여기만 조용해진다(P3 리스크 감지). */}
          {needsChannelSetup ? (
            <Badge variant="status-caution" className="text-[10px] px-2 py-0.5 h-5">
              판매채널 지정 필요
            </Badge>
          ) : needsOrderSetup ? (
            <Badge variant="status-caution" className="text-[10px] px-2 py-0.5 h-5">
              주문관리 등록 필요
            </Badge>
          ) : action.isStagnant ? (
            <Badge variant="outline" className="text-[10px] px-2 py-0.5 h-5 bg-slate-50 text-slate-500 border-slate-200">
              업데이트 지연 {action.stagnantDays}일
            </Badge>
          ) : null}
          {campaign.hasPriceViolation ? (
            <span title={`최저가 위반 딜 ${campaign.violatedDealCount ?? 0}건`}>
              {/* 리터럴 red-600 → status-urgent 토큰. 같은 카드의 지연 배지(toneVariant)가 이미
                  --status-urgent 를 쓰고 있어 같은 "위험" 의미에 빨강 두 개가 공존했다. */}
              <Badge variant="status-urgent" className="text-[10px] px-2 py-0.5 h-5">
                최저가 위반
              </Badge>
            </span>
          ) : null}
          {/* 적자 = 마진 숫자 색과 짝을 이루는 2번째 캐리어. 마진 글씨는 11px 이고 카드가 목록으로
              수십 장 쌓여 실외 시인성이 가장 나쁜 자리라, 숫자 색만으로는 안 읽힌다(P3).
              색은 같은 카드의 지연 배지(toneVariant)와 같은 status-urgent 계열 — 적자는 심각도지
              자금 방향이 아니다. --money-out 은 쓰지 않는다(그 토큰 주석이 "지급은 위험이
              아니라서 --status-urgent 에 흡수할 수 없다"고 선언한 반대편 축이다). */}
          {isLoss ? (
            <Badge variant="status-urgent" className="text-[10px] px-2 py-0.5 h-5">
              적자
            </Badge>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-slate-500 mt-0.5">
          <span className="bg-slate-100/80 px-2 py-0.5 rounded-md tabular-nums">{periodLabel}</span>
          <span>
            {primaryMetricLabel} <span className="font-bold tabular-nums text-slate-700">{primaryMetric}</span>
          </span>
          {/* 마진은 음수(적자)일 때만 색이 붙는다 — 카드가 목록으로 수십 장 쌓이므로 흑자까지
              칠하면 적자가 안 튄다("주의가 필요한 소수에만", P8). 실매출은 모든 카드가 가지므로
              색을 줘도 변별력이 0이라 손대지 않는다.
              -text 변형인 이유: 이 값은 11px 소형 텍스트다. 기본 --status-urgent(#BF5050)은 흰
              배경에서 4.69:1 로 AA 경계라 --status-urgent-text(#8F3C3C, 7.29:1)를 쓴다 —
              mobile-outreach-view 의 경과일 램프가 같은 근거로 같은 선택을 했다. 적자 배지와
              같은 hex 라 배지·숫자가 한 색으로 읽힌다. */}
          {showMargin ? (
            <span>
              마진{" "}
              <span className={cn("font-bold tabular-nums", isLoss ? "text-status-urgent-text" : "text-slate-700")}>
                {campaign.netMarginRate}%
              </span>
            </span>
          ) : null}
        </div>
      </button>
    </article>
  );
}
