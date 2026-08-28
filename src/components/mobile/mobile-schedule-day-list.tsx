"use client";

import React from "react";
import { UserRoundIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { formatCurrency } from "@/lib/format";
import {
  MONEY_DIRECTION_ICON,
  MONEY_DIRECTION_TEXT,
  MONEY_ROW_AMOUNT_NEUTRAL,
  MONEY_ROW_SETTLED_MUTED,
} from "@/lib/money-direction";
import { sumMoneySlotAmounts } from "@/lib/calendar-entities";
import { buildMobileCalendarItems, type MobileCalendarItem } from "@/lib/mobile-calendar-groups";
import type { MobileCalendarCampaign } from "@/lib/mobile-calendar-data";
import {
  resolveMoneySlotEffectiveDate,
  resolveMoneySlotsForChannels,
  type CampaignMoneySlot,
} from "@/lib/tax-filing-board";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

type MoneyEvent = {
  key: string;
  campaign: MobileCalendarItem;
  /** 아이콘 색 축 = 자금 방향. 자사몰의 두 지급은 둘 다 `payout`(색으로 가르지 않는다). */
  direction: "deposit" | "payout";
  /** 배지 문구 — 자사몰의 두 지급은 **상대만으로** 구분된다. */
  slot: CampaignMoneySlot;
  /** 이 줄이 예정인가 완료인가 — 날짜가 예정일인지 실제일인지와 같은 축이다. */
  done: boolean;
  amount: number | null;
};

type MobileScheduleDayListProps = {
  selectedYmd: string;
  todayYmd: string;
  campaigns: MobileCalendarCampaign[];
  onOpenCampaign: (campaignId: string) => void;
  /** 예비 캠페인 생성 시트 열기 (§4) — 전달 시에만 헤더 우측 버튼 렌더 */
  onCreateDraft?: () => void;
};

function formatDayHeader(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  const weekday = WEEKDAY_LABELS[new Date(ymd.slice(0, 10) + "T00:00:00").getDay()];
  return `${m}월 ${d}일 (${weekday})`;
}

function campaignPhaseLabel(campaign: MobileCalendarItem, ymd: string): string {
  if (campaign.startDate.slice(0, 10) === ymd) return "시작";
  if (campaign.endDate.slice(0, 10) === ymd) return "마감";
  return "진행중";
}

export const MobileScheduleDayList = React.memo(function MobileScheduleDayList({
  selectedYmd,
  todayYmd,
  campaigns,
  onOpenCampaign,
  onCreateDraft,
}: MobileScheduleDayListProps) {
  const calendarItems = React.useMemo(() => buildMobileCalendarItems(campaigns), [campaigns]);

  const dayCampaigns = calendarItems.filter(
    (item) =>
      item.startDate.slice(0, 10) <= selectedYmd &&
      item.endDate.slice(0, 10) >= selectedYmd,
  );

  const moneyEvents: MoneyEvent[] = [];
  for (const item of calendarItems) {
    // ⛔ 입금·지급을 손으로 열거하지 말 것 — 슬롯이 채널별 레그를 들고 온다.
    // 자사몰은 지급(공급사)·지급(셀러) 두 행이 서고 입금 행은 서지 않는다.
    for (const slot of resolveMoneySlotsForChannels(item.salesChannels)) {
      // ⛔ 예정일을 직접 읽고 완료 건을 걸러내지 말 것 — 완료된 칸은 사라지는 게 아니라
      // **실제로 오간 날**로 옮겨가 완료 줄로 뜬다(오너 확정 2026-08-26). 종전처럼
      // 숨기면 링·도트는 그 날을 가리키는데 목록만 비어 있는 상태가 된다.
      const { date: effective } = resolveMoneySlotEffectiveDate(slot, item);
      if (effective?.slice(0, 10) !== selectedYmd) continue;
      moneyEvents.push({
        key: `${item.key}:${slot.key}`,
        campaign: item,
        direction: slot.kind === "DEPOSIT" ? "deposit" : "payout",
        slot,
        done: Boolean(item[slot.flagField]),
        amount: sumMoneySlotAmounts(item.members, slot),
      });
    }
  }

  /**
   * 같은 날짜 안에서 **아직 남은 대금이 먼저** 온다.
   *
   * 완료 줄은 숨기지 않고 실제 이체일에 세우는 것이 오너 확정(2026-08-26)인데, 그러면
   * 한 날짜에 「끝난 일」과 「할 일」이 섞인다. 이 화면의 목적은 빠른 상태 확인·리스크
   * 감지(P3)라, 끝난 줄이 위에 있으면 남은 일을 찾는 데 스캔이 한 번 더 든다.
   *
   * 같은 날짜 안에는 시각(시:분) 개념이 없으므로 시간 순서를 뒤집는 것이 아니다.
   * `done` 한 축으로만 가르고 그 안의 순서(캠페인·슬롯 순회 순)는 안정 정렬로 보존한다.
   */
  const orderedMoneyEvents = [...moneyEvents].sort(
    (a, b) => Number(a.done) - Number(b.done),
  );

  const isEmpty = dayCampaigns.length === 0 && moneyEvents.length === 0;

  return (
    <section className="rounded-2xl border border-white/60 bg-white/85 backdrop-blur-lg shadow-soft-sm">
      <div className="flex min-h-11 items-center gap-2 px-6 py-2">
        <span className="text-[13px] font-medium text-foreground">
          {formatDayHeader(selectedYmd)}
        </span>
        {selectedYmd === todayYmd ? <Badge variant="secondary">오늘</Badge> : null}
        {onCreateDraft ? (
          <button
            type="button"
            onClick={onCreateDraft}
            // 배경도 테두리도 없는 텍스트 링크(계층 ④)라 라디우스가 렌더에 영향이
            // 없다 — 죽은 클래스라 뺀다. 나중에 가시적 배경을 주면 그때 xl 로 올릴 것.
            className="ml-auto min-h-11 shrink-0 px-2 text-xs font-medium text-primary transition-opacity duration-150 active:opacity-60"
          >
            + 예비 일정
          </button>
        ) : null}
      </div>

      {isEmpty ? (
        <Empty className="border-t border-slate-100 py-5">
          <EmptyHeader>
            <EmptyTitle>이 날짜에 예정된 일정이 없습니다.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div>
          {dayCampaigns.map((campaign) => (
            <button
              key={campaign.key}
              type="button"
              onClick={() => onOpenCampaign(campaign.key)}
              className="flex min-h-11 w-full items-center gap-2 border-t border-slate-100 px-6 py-3 text-left transition-colors duration-150 active:bg-slate-50/70"
            >
              <span className="truncate text-[13px] font-medium text-foreground">
                {campaign.dealName}
              </span>
              <UserRoundIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs text-muted-foreground">{campaign.sellerName}</span>
              {campaign.roundNumber ? (
                <Badge className="shrink-0 bg-primary/10 text-primary hover:bg-primary/10">
                  {campaign.roundNumber}차
                </Badge>
              ) : null}
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {campaignPhaseLabel(campaign, selectedYmd)}
              </span>
            </button>
          ))}
          {orderedMoneyEvents.map((event) => (
            <button
              key={event.key}
              type="button"
              onClick={() => onOpenCampaign(event.campaign.key)}
              className="flex min-h-11 w-full items-center gap-2 border-t border-slate-100 px-6 py-3 text-left transition-colors duration-150 active:bg-slate-50/70"
            >
              {/* 방향 색은 규칙 SSOT(lib/money-direction) — 이전에는 입금·지급이 둘 다
                  text-primary 라 같은 네이비였다(방향이 색으로 구분되지 않음).
                  ⛔ 완료 줄에 방향색을 되살리지 말 것 — 색은 **아직 오갈 돈**에만 남긴다
                  (근거는 MONEY_ROW_SETTLED_MUTED 주석). 화살표 모양은 그대로라 입금/지급
                  구분은 잃지 않는다. */}
              {event.direction === "deposit" ? (
                <MONEY_DIRECTION_ICON.in
                  aria-hidden="true"
                  className={`size-4 shrink-0 ${event.done ? MONEY_ROW_SETTLED_MUTED : MONEY_DIRECTION_TEXT.in}`}
                />
              ) : (
                <MONEY_DIRECTION_ICON.out
                  aria-hidden="true"
                  className={`size-4 shrink-0 ${event.done ? MONEY_ROW_SETTLED_MUTED : MONEY_DIRECTION_TEXT.out}`}
                />
              )}
              <span className="truncate text-xs text-muted-foreground">
                {event.campaign.dealName} · {event.campaign.sellerName}
              </span>
              {/* 완료는 데스크톱 캘린더 도트·정산 칸(#483)·StatusBadge 의 COMPLETED 와 같은
                  `status-success` 어휘를 쓴다 — 신규 hue 가 아니라 생애주기축 재사용이다(P8 §4).
                  예정 줄은 중립을 유지한다: 그쪽은 왼쪽 방향 아이콘이 이미 유채색이라,
                  둘 다 칠하면 한 줄에 색 캐리어가 둘이 되어 위계가 흐려진다(P8 §2·§3). */}
              <Badge
                variant={event.done ? "status-success" : "secondary"}
                className="shrink-0 text-[11px]"
              >
                {event.slot.verb} {event.done ? "완료" : "예정"} ({event.slot.counterpartLabel})
              </Badge>
              {/* ⛔ 이 줄에 지연(연체) 배지를 붙이지 말 것 — 설계 단계에서 기각했다(2026-08-26).
                  #485 의 디자인 검토가 P3 로 남긴 제안이었고, 오너 발주로 검토한 결과 기각이다.
                  ① **변별력이 0 이다.** 위 `effective?.slice(0, 10) !== selectedYmd` 필터가 남기는
                     것은 선택한 날짜와 일치하는 줄뿐이고, `resolveMoneySlotEffectiveDate` 는
                     미완료 슬롯에 **예정일을 그대로** 돌려준다(`flagField` 가 false 면 완료일
                     경로가 단락평가로 닫혀 반례가 구조적으로 없다). 그래서 예정 줄은 예외 없이
                     `예정일 === 선택한 날짜`이고, 연체 판정(`예정일 < 오늘`)은
                     `선택한 날짜 < 오늘`로 붕괴한다 — 과거 날짜를 열면 예정 줄이 **전부** 켜지고
                     오늘·미래에는 **하나도** 안 켜진다. 배지가 말하는 것은 "이 건이 늦었다"가
                     아니라 "과거 날짜를 보고 있다"이고, 그건 헤더 날짜와 「오늘」 배지가 이미
                     말한다. `settlement-table.tsx` 의 지연 경고가 제거된 사유 ①과 같은 붕괴다.
                  ② **소유 표면이 따로 있다.** 모바일의 대금 지연 신호는 홈 자금 카드가 여는
                     `MobileSettlementPendingSheet` 가 소유한다 — 날짜에 매이지 않은 대기 목록이라
                     모집단이 여러 날짜에 걸쳐 있고, 거기서는 배지가 실제로 행을 가른다(지연 우선
                     정렬 + `MobileOverdueBadge`). 이 화면은 "이 날 무슨 일이 있(었)나"를 답하는
                     달력이지 "무엇이 위험한가"를 답하는 표면이 아니다.
                  ③ **배지로는 원리적으로 못 메우는 것이 있다.** 미완료 줄은 자기 예정일 칸에만
                     뜨므로 예정일이 지난 미수금은 오늘 목록에 **아예 없다**. 배지는 줄이 이미
                     렌더되는 자리에만 붙는다.
                  ⚠️ ② 의 대기 시트는 상태를 `SETTLEMENT_WAIT`/`SETTLEMENT_IN_PROGRESS` 로 좁히므로
                     그 이전 단계(`ACTIVE`·`CLOSED`)에서 예정일이 지난 건은 못 잡는다(데스크톱 아젠다
                     `buildOverdueSettlementItems` 도 같다). 오너 확인 2026-08-26 — 예정일이 사전에
                     정해지는 경우가 **있어서** 이 사각은 실재한다. 별건으로 티켓에 올렸다.
                     ⛔ 그 사각을 이 화면의 배지로 덮으려 하지 말 것 — ① 이 그대로라 덮이지 않는다.
                  다시 필요하면 이 줄이 아니라 **월 그리드**(`mobile-schedule-calendar.tsx` 의
                  `MoneyRing`)가 후보다. 모집단이 한 달이라 ① 의 붕괴가 없다 — 다만 방향색
                  (입금/지급)이 쓰는 캐리어에 심각도를 얹게 되므로 P8 §1 「축을 섞지 말 것」과
                  부딪힌다. **그 축 충돌을 감수할지는 오너만 결정한다** — 스스로 판단해 링 색을
                  심각도로 돌리지 말 것. */}
              {/* 목록 행 금액 = 무채색(규칙 SSOT: lib/money-direction). 방향은 왼쪽 아이콘이 말한다.
                  완료 줄은 한 단계 더 낮은 랭크다 — 웨이트(font-semibold)는 유지해 금액 열의
                  세로 정렬이 흐트러지지 않게 하고, 무게는 색으로만 내린다. */}
              <span
                className={`ml-auto shrink-0 text-xs font-semibold tabular-nums ${
                  event.done ? MONEY_ROW_SETTLED_MUTED : MONEY_ROW_AMOUNT_NEUTRAL
                }`}
              >
                {event.amount == null ? "금액 미정" : `₩${formatCurrency(event.amount)}`}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
});
