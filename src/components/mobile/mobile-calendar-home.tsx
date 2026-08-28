"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { MobileCalendarCampaign } from "@/lib/mobile-calendar-data";
import type { DraftCampaignResult } from "@/lib/mobile-draft-campaign";
import { buildMobileCalendarItems } from "@/lib/mobile-calendar-groups";
import { sumGroupManualGoodsCost } from "@/lib/goods-cost";
import { toYmd } from "@/lib/mobile-schedule-grid";
import type { ScheduleGap, ScheduleGapBriefing } from "@/lib/schedule-gap-briefing";
import { MobileTodaySummaryBar } from "./mobile-today-summary-bar";
import {
  MobileCampaignDetailSheet,
  type MobileCampaignDetailData,
} from "./mobile-campaign-detail-sheet";
import { MobileDraftCampaignSheet } from "./mobile-draft-campaign-sheet";
import { MobileScheduleCalendar } from "./mobile-schedule-calendar";
import { MobileScheduleDayList } from "./mobile-schedule-day-list";
import { MobileScheduleGapBars } from "./mobile-schedule-gap-bars";
import { MobileUpcomingSchedule, selectUpcomingItems } from "./mobile-upcoming-schedule";

type MobileCalendarHomeProps = {
  gapBriefing: ScheduleGapBriefing;
  initialYear: number;
  initialMonthIndex: number;
  initialCampaigns: MobileCalendarCampaign[];
};

function monthKey(year: number, monthIndex: number): string {
  return `${year}-${`${monthIndex + 1}`.padStart(2, "0")}`;
}

export function MobileCalendarHome({
  gapBriefing,
  initialYear,
  initialMonthIndex,
  initialCampaigns,
}: MobileCalendarHomeProps) {
  // 하이드레이션 안전(react-reviewer MEDIUM): 서버 렌더와 클라 첫 렌더는 빈값으로 일치시키고
  // 마운트 후 실제 "오늘"을 적용한다 — 자정 경계에서 서버/클라 시계가 다른 날짜를 내는
  // 불일치 방지(bottom-nav의 mounted 게이트와 동일 패턴).
  const [todayYmd, setTodayYmd] = useState("");
  useEffect(() => {
    setTodayYmd(toYmd(new Date()));
  }, []);

  const [selectedYmdState, setSelectedYmd] = useState<string | null>(null);
  const selectedYmd = selectedYmdState ?? todayYmd;
  const [month, setMonth] = useState({ year: initialYear, monthIndex: initialMonthIndex });
  const [monthCache, setMonthCache] = useState<Record<string, MobileCalendarCampaign[]>>({
    [monthKey(initialYear, initialMonthIndex)]: initialCampaigns,
  });
  const [monthLoading, setMonthLoading] = useState(false);
  const [monthError, setMonthError] = useState<string | null>(null);

  // #149 리뷰 후속: 파이프라인 전체 스냅샷(initialData) 의존 제거. 자금 칩은 #149에서
  // 홈 정산 카드로 이관됐고, 남아 있던 스냅샷 소비는 (a) 상세 시트의 미사용 campaignRow
  // 보강과 (b) 도달 불가능한 id 폴백뿐이었다 — 날짜 목록의 캠페인 키는 calendarItems와
  // 동일한 buildMobileCalendarItems(monthCampaigns) 산출이라 항상 캘린더 경로로 해석된다.

  // 캠페인 상세 시트(§5) — SidePanel 대체. base=캘린더 월 데이터.
  const [detail, setDetail] = useState<MobileCampaignDetailData | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // 예비 캠페인 생성 시트(§4) — 선택일 헤더의 "+ 예비 일정" 버튼으로 진입.
  const [draftOpen, setDraftOpen] = useState(false);

  const currentKey = monthKey(month.year, month.monthIndex);
  const monthCampaigns = monthCache[currentKey] ?? [];

  // 상세 열기·다가오는 일정은 "보유한 모든 월 캐시"를 합쳐 계산한다 — 현재 월
  // 캐시만 쓰면 다른 월에서 진입한 항목의 상세 조회가 실패하고, 다가오는 일정도
  // 월 경계에서 조기 소진된다. 같은 캠페인이 여러 월 캐시에 겹칠 수 있어 id로
  // 중복 제거한다. (추가 API 조회 없음 — 데이터 범위는 방문한 월로 한정.)
  const mergedCalendarItems = useMemo(() => {
    const byId = new Map<string, MobileCalendarCampaign>();
    for (const list of Object.values(monthCache)) {
      for (const campaign of list) byId.set(campaign.id, campaign);
    }
    return buildMobileCalendarItems([...byId.values()]);
  }, [monthCache]);

  const upcomingItems = useMemo(
    () => selectUpcomingItems(mergedCalendarItems, todayYmd, 3, selectedYmd),
    [mergedCalendarItems, todayYmd, selectedYmd],
  );

  // 최신 요청 월 추적(react-reviewer HIGH): 빠른 연속 월 전환 시 늦게 도착한 응답이
  // 공유 loading/error 상태를 덮어쓰지 않도록, 현재 보고 있는 월의 응답만 상태에 반영한다.
  // (캐시 기록은 월별 슬롯이라 항상 안전 — stale 응답도 캐시에는 넣는다.)
  const latestMonthKeyRef = useRef(monthKey(initialYear, initialMonthIndex));

  const loadMonth = useCallback(async (year: number, monthIndex: number) => {
    const key = monthKey(year, monthIndex);
    latestMonthKeyRef.current = key;
    setMonth({ year, monthIndex });
    setMonthError(null);
    if (monthCache[key]) {
      setMonthLoading(false);
      return;
    }
    setMonthLoading(true);
    try {
      const response = await fetch(`/api/campaigns/calendar?month=${key}`);
      if (!response.ok) throw new Error(`calendar ${response.status}`);
      const payload = (await response.json()) as { campaigns: MobileCalendarCampaign[] };
      setMonthCache((previous) => ({ ...previous, [key]: payload.campaigns }));
      if (latestMonthKeyRef.current === key) setMonthLoading(false);
    } catch {
      if (latestMonthKeyRef.current === key) {
        setMonthError("일정을 불러오지 못했습니다. 다시 시도해주세요.");
        setMonthLoading(false);
      }
    }
  }, [monthCache]);

  const handleMonthChange = useCallback((delta: number) => {
    const base = new Date(month.year, month.monthIndex + delta, 1);
    void loadMonth(base.getFullYear(), base.getMonth());
  }, [month.year, month.monthIndex, loadMonth]);

  const handleSelectGap = useCallback((gap: ScheduleGap) => {
    const start = new Date(gap.startDate);
    setSelectedYmd(gap.startDate.slice(0, 10));
    void loadMonth(start.getFullYear(), start.getMonth());
  }, [loadMonth]);

  const handleOpenCampaignById = useCallback((campaignKey: string) => {
    // #152: 상세 시트는 캘린더 데이터만 소비(campaignRow 폴백 제거). 조회 소스는
    // 다가오는 일정과 동일한 mergedCalendarItems(보유 월 캐시 병합)라 타 월에서
    // 진입한 항목도 상세가 열린다(r2).
    const calendarItem = mergedCalendarItems.find((item) => item.key === campaignKey);
    if (!calendarItem) return;

    // Map MobileCalendarItem to MobileCampaignDetailData
    const detailData: MobileCampaignDetailData = {
      id: calendarItem.key,
      kind: calendarItem.kind,
      groupId: calendarItem.groupId,
      dealName: calendarItem.dealName,
      sellerName: calendarItem.sellerName,
      roundNumber: calendarItem.roundNumber,
      status: calendarItem.status,
      startDate: calendarItem.startDate,
      endDate: calendarItem.endDate,
      // ⛔ 이 세 줄을 빼지 말 것 — 상세 시트의 대금 줄도 슬롯 파생이라(#458) 채널이
      // 없으면 **타입 에러 없이** 기본(셀러몰) 구성으로 접힌다. 자사몰 항목을 캘린더에서
      // 열면 있지도 않은 입금 줄이 서고 공급사 지급 줄이 사라진다(침묵형 오표시).
      // ⚠️ 상세 시트는 아직 **단일 채널**만 받는다(`MobileCampaignDetailData.salesChannel`).
      // 묶음이면 대표(첫) 멤버 채널이 가고, 채널이 섞인 그룹에서는 시트의 대금 줄이
      // 한쪽 레그를 놓칠 수 있다 — 캘린더 화면(링·날짜 목록)은 합집합으로 고쳤지만
      // 시트 타입 확장은 그 파일 소관이라 여기서 넓히지 않았다(후속).
      salesChannel: calendarItem.salesChannels[0] ?? null,
      expectedDepositDate: calendarItem.expectedDepositDate,
      expectedPayoutDate: calendarItem.expectedPayoutDate,
      expectedSupplierPayoutDate: calendarItem.expectedSupplierPayoutDate,
      depositReceivedAt: calendarItem.depositReceivedAt,
      payoutCompletedAt: calendarItem.payoutCompletedAt,
      supplierPayoutCompletedAt: calendarItem.supplierPayoutCompletedAt,
      // 근거 4필드는 **대표 멤버** 것이다 — 시트의 대금 줄은 아래 `members` 를 합산해
      // 계산하므로(기준이 채널마다 달라 평평하게 접을 수 없다) 이 넷은 단일 항목용이다.
      settlementSales: calendarItem.members[0]?.settlementSales ?? null,
      actualSales: calendarItem.members[0]?.actualSales ?? null,
      sellerExpense: calendarItem.members[0]?.sellerExpense ?? null,
      actualPayoutAmount: calendarItem.members[0]?.actualPayoutAmount ?? null,
      // ⛔ 대표 멤버(`members[0]`)에서 읽지 말 것 — 그룹은 매입 계산서 **한 장**이라
      //    멤버 하나만 보면 나머지 몫이 통째로 빠진다. 접기 규약(한 멤버라도 미입력이면
      //    그룹 전체가 「미정」)은 SSOT 가 소유한다.
      settlementGoodsCost: sumGroupManualGoodsCost(calendarItem.members),
      isDepositReceived: calendarItem.isDepositReceived,
      isPayoutCompleted: calendarItem.isPayoutCompleted,
      isSupplierPayoutCompleted: calendarItem.isSupplierPayoutCompleted,
      members: calendarItem.members.map(member => ({
        id: member.id,
        dealName: member.dealName,
        sellerName: member.sellerName,
        roundNumber: member.roundNumber,
        status: member.status,
        startDate: member.startDate,
        endDate: member.endDate,
        settlementSales: member.settlementSales,
        actualSales: member.actualSales,
        sellerExpense: member.sellerExpense,
        actualPayoutAmount: member.actualPayoutAmount,
      })),
    };
    setDetail(detailData);
    setDetailOpen(true);
  }, [mergedCalendarItems]);

  // 예비 캠페인 생성 성공(§4) — 서버 반환값으로 MobileCalendarCampaign 을 조립해
  // 해당 월 캐시에 낙관 반영하고, 다른 월을 보고 있었다면 시작 월로 이동한다.
  // 예비 캠페인은 정산 필드가 아직 없으므로 expected*/settlement* 는 null 고정.
  const handleDraftCreated = useCallback((draft: DraftCampaignResult) => {
    const startYmd = draft.startDate.slice(0, 10);
    const year = Number(startYmd.slice(0, 4));
    const monthIndex = Number(startYmd.slice(5, 7)) - 1;
    const key = monthKey(year, monthIndex);

    const campaign: MobileCalendarCampaign = {
      id: draft.id,
      dealName: draft.dealName,
      sellerName: draft.sellerName,
      sellerId: draft.sellerId,
      groupId: null,
      groupName: null,
      roundNumber: draft.roundNumber,
      startDate: draft.startDate,
      endDate: draft.endDate,
      status: draft.status,
      // 채널은 서버가 딜 정책에서 유도한 값을 그대로 잇는다(추측 금지 — 자금 슬롯
      // 판정 축이라 틀리면 이후 일정이 붙는 순간 잘못된 구성으로 그려진다).
      salesChannel: draft.salesChannel,
      expectedDepositDate: null,
      expectedPayoutDate: null,
      expectedSupplierPayoutDate: null,
      // 예비 캠페인은 아직 아무것도 오가지 않았다 — 완료일도 정의상 없다.
      depositReceivedAt: null,
      payoutCompletedAt: null,
      supplierPayoutCompletedAt: null,
      settlementSales: null,
      actualSales: null,
      sellerExpense: null,
      actualPayoutAmount: null,
      settlementGoodsCost: null,
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
    };

    setMonthCache((previous) => {
      const cached = previous[key];
      // 캐시 미보유 월이면 push 생략 — 아래 loadMonth 가 서버에서 신규 건 포함 로드.
      if (!cached) return previous;
      return { ...previous, [key]: [...cached, campaign] };
    });

    setSelectedYmd(startYmd);
    if (key !== currentKey) void loadMonth(year, monthIndex);
  }, [currentKey, loadMonth]);

  // 하이드레이션 렌더링 에러 방지(Risk 1): 서버 렌더 빈 문자열일 때 렌더 보류
  if (!todayYmd) {
    return null;
  }

  return (
    <>
      <section className="mobile-tab-safe-top flex min-h-[calc(100dvh+1px)] flex-1 flex-col gap-3 bg-slate-50 px-5 pb-24">
        {/* v3.2(소유자 피드백 A): 리스크 브리핑+펄스 한 줄 → 오늘 판매 요약 통합 바.
            리스크 항목은 "업무 처리" 탭(/pipeline/tasks)이 담당한다. */}
        <MobileTodaySummaryBar />

        <MobileScheduleCalendar
          year={month.year}
          monthIndex={month.monthIndex}
          campaigns={monthCampaigns}
          selectedYmd={selectedYmd}
          todayYmd={todayYmd}
          onSelectDate={setSelectedYmd}
          onMonthChange={handleMonthChange}
        />
        {monthLoading ? (
          <p className="text-[11px] text-muted-foreground">일정을 불러오는 중…</p>
        ) : null}
        {monthError ? (
          <button
            type="button"
            onClick={() => void loadMonth(month.year, month.monthIndex)}
            className="text-left text-[11px] text-destructive underline underline-offset-2 transition-opacity duration-150 active:opacity-60"
          >
            {monthError}
          </button>
        ) : null}

        <MobileScheduleGapBars gaps={gapBriefing.gaps} onSelectGap={handleSelectGap} />

        {selectedYmd ? (
          <MobileScheduleDayList
            selectedYmd={selectedYmd}
            todayYmd={todayYmd}
            campaigns={monthCampaigns}
            onOpenCampaign={handleOpenCampaignById}
            onCreateDraft={() => setDraftOpen(true)}
          />
        ) : null}

        {/* 오너 피드백(2026-07-15): 최하단 "다가오는 일정" — 오늘 이후 시작일이
            가장 가까운 일정 3건(그룹은 1건). 탭하면 기존 상세 시트로 진입. */}
        <MobileUpcomingSchedule items={upcomingItems} onOpenCampaign={handleOpenCampaignById} />
      </section>

      {/* 예비 캠페인 생성 시트(§4) — 선택일 프리필, 성공 시 월 캐시 낙관 반영 */}
      <MobileDraftCampaignSheet
        open={draftOpen}
        onOpenChange={setDraftOpen}
        initialStartYmd={selectedYmd}
        onCreated={handleDraftCreated}
      />

      {/* 상세 시트는 예비 시트보다 뒤에 렌더 — 위로 겹쳐 열리고 닫으면 복귀 */}
      <MobileCampaignDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        campaign={detail}
        todayYmd={todayYmd}
      />
    </>
  );
}
