import { getPrisma } from "@/lib/prisma";
import { buildEffectiveCampaignPeriods } from "@/lib/campaign-group-count";
import { findRevenueGoalsSafe } from "@/lib/revenue-goals";
import { getScheduleGapBriefing } from "./schedule-gap-briefing";
import { computeDataIntegrityIssues } from "./data-integrity";
import {
  resolveCampaignMoneySlots,
  resolveMoneySlotEffectiveDate,
  type MoneySlotDateSource,
} from "./tax-filing-board";

const DAY_MS = 24 * 60 * 60 * 1000;

type CampaignMetricSource = {
  id: string;
  startDate: Date;
  endDate: Date;
  actualSales: { toString(): string } | number | string | null;
  netMarginRate: { toString(): string } | number | string;
  operatingProfit: { toString(): string } | number | string | null;
  settlementSales: { toString(): string } | number | string | null;
  actualPayoutAmount: { toString(): string } | number | string | null;
  expectedDepositDate: Date | null;
  expectedPayoutDate: Date | null;
  returnPeriodEndDate: Date | null;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  status: string;
  deal: { dealName: string; partner: { name: string } | null };
  seller: { name: string; alias: string | null };
};

export type DesktopDashboardData = Awaited<ReturnType<typeof getDesktopDashboardData>>;

function numberValue(value: { toString(): string } | number | string | null | undefined) {
  return value == null ? 0 : Number(value.toString());
}

function monthKey(date: Date) {
  return date.toISOString().slice(0, 7);
}

function startOfMonth(key: string) {
  return new Date(`${key}-01T00:00:00.000Z`);
}

function endOfMonth(key: string) {
  const start = startOfMonth(key);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

function inclusiveDays(start: Date, end: Date) {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1);
}

export function allocateCampaignToMonth(
  campaign: Pick<CampaignMetricSource, "startDate" | "endDate">,
  key: string,
) {
  const overlapStart = new Date(Math.max(campaign.startDate.getTime(), startOfMonth(key).getTime()));
  const overlapEnd = new Date(Math.min(campaign.endDate.getTime(), endOfMonth(key).getTime()));
  const operatingDays = overlapStart > overlapEnd ? 0 : inclusiveDays(overlapStart, overlapEnd);
  const totalDays = inclusiveDays(campaign.startDate, campaign.endDate);
  return {
    operatingDays,
    weightedCampaignCount: totalDays === 0 ? 0 : operatingDays / totalDays,
  };
}

function recentMonthKeys(now: Date, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - index - 1), 1));
    return monthKey(date);
  });
}

function campaignSales(campaign: CampaignMetricSource) {
  return numberValue(campaign.actualSales);
}

export type UpcomingCampaign = {
  campaignName: string | null;
  /** 대금 일정 칸 구성의 유일한 판정 입력 — 슬롯 SSOT `resolveCampaignMoneySlots`. */
  salesChannel: string;
  startDate: Date;
  endDate: Date;
  expectedDepositDate: Date | null;
  expectedPayoutDate: Date | null;
  expectedSupplierPayoutDate: Date | null;
  /**
   * 실제로 오간 날 + 완료 플래그. 완료된 칸은 예정일이 아니라 이 날짜에 서고 문구도
   * 「완료」가 된다(`resolveMoneySlotEffectiveDate`) — 빠뜨리면 이미 지급한 건이
   * 예정일마다 「지급 예정」으로 되살아난다.
   */
  depositReceivedAt: Date | null;
  payoutCompletedAt: Date | null;
  supplierPayoutCompletedAt: Date | null;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  isSupplierPayoutCompleted: boolean;
  groupId: string | null;
  group: {
    name: string | null;
    startDate: Date | null;
    endDate: Date | null;
    expectedDepositDate: Date | null;
    expectedPayoutDate: Date | null;
    expectedSupplierPayoutDate: Date | null;
    depositReceivedAt: Date | null;
    payoutCompletedAt: Date | null;
    supplierPayoutCompletedAt: Date | null;
    isDepositReceived: boolean;
    isPayoutCompleted: boolean;
    isSupplierPayoutCompleted: boolean;
  } | null;
  deal: { dealName: string };
  seller: { name: string; alias: string | null };
};

function campaignDisplayName(c: Pick<UpcomingCampaign, "campaignName" | "deal" | "seller">) {
  const sellerDisplayName =
    c.seller.alias && c.seller.alias.trim() !== "" ? c.seller.alias : c.seller.name;
  const rawName =
    c.campaignName && c.campaignName.trim() !== ""
      ? c.campaignName
      : `${c.deal.dealName} - ${sellerDisplayName}`;
  return rawName.replace(/ · /g, " - ");
}

function earliest(dates: (Date | null)[]): Date | null {
  const valid = dates.filter((d): d is Date => d != null);
  return valid.length ? valid.reduce((a, b) => (a <= b ? a : b)) : null;
}

function latest(dates: (Date | null)[]): Date | null {
  const valid = dates.filter((d): d is Date => d != null);
  return valid.length ? valid.reduce((a, b) => (a >= b ? a : b)) : null;
}

/**
 * 대금 일정 이벤트를 **채널 슬롯에서 파생**한다 — 브랜드몰 `입금 예정 (공급사)` ·
 * 셀러몰 `입금 예정 (셀러)` · 자사몰 `지급 예정 (공급사)` + `지급 예정 (셀러)`.
 *
 * ⛔ `"입금 예정"`/`"지급 예정"` 을 손으로 적지 말 것 — 종전이 그랬고, 자사몰이 지급 두
 * 레그로 갈라진 뒤로는 ①공급사 지급 예정일이 타임라인에 **아예 안 뜨고** ②남은 한 줄이
 * 어느 상대인지 말하지 못했다. 상대 병기는 정산 카드(`지급 예정 (공급사)`)와 같은 문법이다.
 *
 * `dateOf` 는 그룹 폴백을 호출부가 주입하는 자리다 — 미그룹은 캠페인 컬럼, 그룹은
 * 「그룹 스칼라 우선, null 이면 멤버 최솟값」(`buildUpcomingEvents` 의 기존 규칙).
 */
function moneyEvents(salesChannel: string, label: string, source: MoneySlotDateSource<Date>) {
  return resolveCampaignMoneySlots(salesChannel).map((slot) => {
    // ⛔ `source[slot.expectedField]` 로 되돌리지 말 것 — 이미 지급한 건이 예정일마다
    // 「지급 예정」으로 되살아난다(오너 지적 2026-07-15). 캘린더와 같은 판정을 쓴다.
    const { date, isActual } = resolveMoneySlotEffectiveDate(slot, source);
    return {
      date,
      type: `${slot.verb} ${isActual ? "완료" : "예정"} (${slot.counterpartLabel})`,
      label,
    };
  });
}

/** 슬롯이 가리킬 수 있는 날짜 필드 전부 — 그룹 폴백 헬퍼의 키 타입. */
const MONEY_DATE_FIELDS = [
  "expectedDepositDate",
  "expectedPayoutDate",
  "expectedSupplierPayoutDate",
  "depositReceivedAt",
  "payoutCompletedAt",
  "supplierPayoutCompletedAt",
] as const;

/** 완료일 3종 — 그룹이면 **폴백 없이** 그룹 스칼라가 정본이다(위 호출부 주석 참조). */
const COMPLETED_AT_FIELDS = [
  "depositReceivedAt",
  "payoutCompletedAt",
  "supplierPayoutCompletedAt",
] as const;

/** 완료 플래그 3종 — 그룹이면 그룹 스칼라가 정본이다(CG-1). */
const MONEY_FLAG_FIELDS = [
  "isDepositReceived",
  "isPayoutCompleted",
  "isSupplierPayoutCompleted",
] as const;

/** 날짜·플래그를 슬롯 SSOT 가 읽는 한 덩어리로 모은다. */
function moneySource(
  dateOf: (field: (typeof MONEY_DATE_FIELDS)[number]) => Date | null,
  flagOf: (field: (typeof MONEY_FLAG_FIELDS)[number]) => boolean,
): MoneySlotDateSource<Date> {
  const source: MoneySlotDateSource<Date> = {};
  for (const field of MONEY_DATE_FIELDS) source[field] = dateOf(field);
  for (const field of MONEY_FLAG_FIELDS) source[field] = flagOf(field);
  return source;
}

// 향후 14일 일정 이벤트 목록. 그룹캠페인(groupId 보유)은 타임라인에서 "1개 캠페인"으로
// 축약한다(오너 2026-07-14): 멤버별 개별 이벤트 대신 그룹 단위 1세트만 만든다. 그룹 롤업
// 날짜(startDate/endDate/대금 예정일)는 스키마상 SoT가 아니므로, null이면 멤버 날짜에서
// min(시작·대금 예정일)/max(종료)로 폴백한다. 미그룹 캠페인은 종전대로 개별 생성.
export function buildUpcomingEvents(campaigns: UpcomingCampaign[], now: Date, scheduleEnd: Date) {
  const grouped = new Map<string, UpcomingCampaign[]>();
  const singles: UpcomingCampaign[] = [];
  for (const campaign of campaigns) {
    if (campaign.groupId) {
      const members = grouped.get(campaign.groupId);
      if (members) members.push(campaign);
      else grouped.set(campaign.groupId, [campaign]);
    } else {
      singles.push(campaign);
    }
  }

  const singleEvents = singles.flatMap((campaign) => {
    const label = campaignDisplayName(campaign);
    return [
      { date: campaign.startDate, type: "캠페인 시작", label },
      { date: campaign.endDate, type: "캠페인 종료", label },
      ...moneyEvents(
        campaign.salesChannel,
        label,
        moneySource(
          (field) => campaign[field] ?? null,
          (field) => Boolean(campaign[field]),
        ),
      ),
    ];
  });

  const groupEvents = [...grouped.values()].flatMap((members) => {
    const group = members[0].group;
    const label =
      group?.name && group.name.trim() !== ""
        ? group.name
        : members.length > 1
          ? `${campaignDisplayName(members[0])} 외 ${members.length - 1}건`
          : campaignDisplayName(members[0]);
    const start = group?.startDate ?? earliest(members.map((m) => m.startDate));
    const end = group?.endDate ?? latest(members.map((m) => m.endDate));
    return [
      { date: start, type: "캠페인 시작", label },
      { date: end, type: "캠페인 종료", label },
      // 채널은 대표 멤버 것을 쓴다. 그룹의 앱 불변식은 "같은 셀러"뿐이라 멤버 채널이
      // 갈릴 수 있는데(tax-filing-board 의 그룹 후퇴 규약과 같은 사실), 여기서 조용히
      // 두 채널의 슬롯을 합치면 존재하지 않는 칸이 타임라인에 뜬다. 프로덕션 그룹은
      // 딜 분할이라 채널이 같고, 갈릴 때는 대표를 따르는 쪽이 덜 위험하다(없는 칸을
      // 지어내지 않는다).
      ...moneyEvents(
        members[0].salesChannel,
        label,
        moneySource(
          // ⚠️ **예정일과 완료일의 폴백 정책이 다르다 — 의도다.** 예정일은 그룹 롤업이
          // 비어 있으면 멤버 최솟값으로 폴백해 왔다(기존 동작). 완료일은 폴백하지 않는다:
          // 플래그를 그룹만 보는데 날짜만 관대하면, 「그룹 완료 플래그 true + 그룹 완료일
          // null」인 행에서 **멤버의 낡은 완료일이 실제 지급일로 둔갑**한다. 완료일은
          // 플래그와 같은 엄격도로 읽어 비대칭을 없앤다(CG-2 무폴백과 같은 규약).
          (field) =>
            COMPLETED_AT_FIELDS.includes(field as (typeof COMPLETED_AT_FIELDS)[number])
              ? (group ? group[field] : members[0]?.[field] ?? null)
              : group?.[field] ?? earliest(members.map((m) => m[field] ?? null)),
          // 완료 플래그의 SoT 는 그룹 스칼라다(CG-1) — 멤버 플래그는 그룹핑 시점에
          // 얼어붙어 낡을 수 있다(#196 과 같은 축). 그룹이 없을 때만 멤버를 본다.
          (field) => (group ? Boolean(group[field]) : members.every((m) => Boolean(m[field]))),
        ),
      ),
    ];
  });

  return [...singleEvents, ...groupEvents]
    .filter((event): event is { date: Date; type: string; label: string } =>
      event.date != null && event.date >= now && event.date <= scheduleEnd,
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 12)
    .map((event) => ({ ...event, date: event.date.toISOString() }));
}

export async function getDesktopDashboardData(now = new Date()) {
  const prisma = getPrisma();
  const selectedMonth = monthKey(now);
  const year = selectedMonth.slice(0, 4);
  const trendMonths = recentMonthKeys(now, 6);
  // 목표 조회 범위는 **추이 창이 걸치는 모든 연도**다 — 1~5월에 실행하면 창의 앞쪽
  // 월이 전년도로 넘어가므로, `year` 하나만 조회하면 그 달들의 목표선이 통째로
  // 비어 보인다(KPI 카드의 전월·전전월 목표도 1~2월에 같은 이유로 비었다).
  // `year`(당해년도)는 창의 마지막 달이라 항상 이 집합에 포함된다.
  const goalYears = [...new Set(trendMonths.map((key) => key.slice(0, 4)))];
  const ninetyDaysAgo = new Date(now.getTime() - 90 * DAY_MS);
  const scheduleEnd = new Date(now.getTime() + 14 * DAY_MS);

  const [campaigns, goalResult, outreach, googleCalendar, scheduleGapBriefing] = await Promise.all([
    prisma.salesCampaign.findMany({
      select: {
        id: true,
        sellerId: true,
        campaignName: true,
        startDate: true,
        endDate: true,
        actualSales: true,
        netMarginRate: true,
        operatingProfit: true,
        settlementSales: true,
        actualPayoutAmount: true,
        expectedDepositDate: true,
        expectedPayoutDate: true,
        // 자사몰 공급사 지급 레그 — 슬롯 SSOT 가 이 필드를 가리킬 수 있으므로 select 에서
        // 빠지면 「다가올 14일 일정」에 공급사 지급 예정일이 조용히 사라진다.
        expectedSupplierPayoutDate: true,
        // 완료일 3종 — 빠지면 「다가올 14일 일정」이 완료 건을 계속 예정으로 부른다.
        depositReceivedAt: true,
        payoutCompletedAt: true,
        supplierPayoutCompletedAt: true,
        returnPeriodEndDate: true,
        isDepositReceived: true,
        isPayoutCompleted: true,
        isSupplierPayoutCompleted: true,
        salesChannel: true,
        status: true,
        groupId: true,
        group: {
          select: {
            name: true,
            startDate: true,
            endDate: true,
            expectedDepositDate: true,
            expectedPayoutDate: true,
            expectedSupplierPayoutDate: true,
            depositReceivedAt: true,
            payoutCompletedAt: true,
            supplierPayoutCompletedAt: true,
            isDepositReceived: true,
            isPayoutCompleted: true,
            isSupplierPayoutCompleted: true,
          },
        },
        deal: { select: { dealName: true, partner: { select: { name: true } } } },
        seller: { select: { name: true, alias: true } },
      },
    }),
    findRevenueGoalsSafe(goalYears),
    prisma.salesTask.findMany({
      where: { createdAt: { gte: ninetyDaysAgo } },
      select: { status: true, respondedAt: true, confirmedAt: true, nextReminderAt: true },
    }),
    prisma.storageIntegration.findUnique({ where: { provider: "GOOGLE_CALENDAR" } }),
    getScheduleGapBriefing(now),
  ]);
  const goals = goalResult.goals;

  const prevMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevMonth = monthKey(prevMonthDate);

  const prevPrevMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  const prevPrevMonth = monthKey(prevPrevMonthDate);

  const monthlyGoal = goals.find((goal) => goal.periodKey === selectedMonth);
  const prevMonthlyGoal = goals.find((goal) => goal.periodKey === prevMonth);
  const prevPrevMonthlyGoal = goals.find((goal) => goal.periodKey === prevPrevMonth);
  const annualGoal = goals.find((goal) => goal.periodKey === year);

  const selectedCampaigns = campaigns.filter((campaign) => allocateCampaignToMonth(campaign, selectedMonth).operatingDays > 0);
  const prevCampaigns = campaigns.filter((campaign) => allocateCampaignToMonth(campaign, prevMonth).operatingDays > 0);
  const prevPrevCampaigns = campaigns.filter((campaign) => allocateCampaignToMonth(campaign, prevPrevMonth).operatingDays > 0);

  const ytdCampaigns = campaigns.filter((campaign) => campaign.startDate.getUTCFullYear() === Number(year));
  const monthActual = selectedCampaigns.reduce((sum, campaign) => sum + campaignSales(campaign), 0);
  const prevMonthActual = prevCampaigns.reduce((sum, campaign) => sum + campaignSales(campaign), 0);
  const prevPrevMonthActual = prevPrevCampaigns.reduce((sum, campaign) => sum + campaignSales(campaign), 0);
  const ytdActual = ytdCampaigns.reduce((sum, campaign) => sum + campaignSales(campaign), 0);

  const ytdHistory = Array.from({ length: now.getUTCMonth() + 1 }, (_, i) => {
    const mKey = `${year}-${String(i + 1).padStart(2, "0")}`;
    const mCampaigns = ytdCampaigns.filter((c) => c.startDate.getUTCMonth() <= i);
    return {
      month: mKey,
      ytd: mCampaigns.reduce((sum, c) => sum + campaignSales(c), 0),
    };
  });

  // 캠페인 "개수" 지표는 유효 캠페인 기준(그룹 = 멤버 포락선 1건, 오너 확정 2026-07-30).
  // 매출·마진 합산은 계속 행(멤버) 단위다 — actualSales가 딜 고유 값이라 병합 금지(CG-1).
  // allocateCampaignToMonth는 창 밖이면 weight 0을 돌려주므로 월 필터 없이 전량 reduce한다.
  const effectivePeriods = buildEffectiveCampaignPeriods(campaigns);
  const weightedCampaignCount = effectivePeriods.reduce(
    (sum, period) => sum + allocateCampaignToMonth(period, selectedMonth).weightedCampaignCount,
    0,
  );
  const prevWeightedCampaignCount = effectivePeriods.reduce(
    (sum, period) => sum + allocateCampaignToMonth(period, prevMonth).weightedCampaignCount,
    0,
  );
  // KPI 카드 3개월 표시(오너 2026-07-13) — 당월·전월에 더해 전전월 행을 노출한다.
  const prevPrevWeightedCampaignCount = effectivePeriods.reduce(
    (sum, period) => sum + allocateCampaignToMonth(period, prevPrevMonth).weightedCampaignCount,
    0,
  );

  // 운영일도 유효 캠페인 기준 — 같은 KPI 카드의 보조 수치라 분모가 갈리면 카드 안에서 모순된다
  // (동일 기간 3멤버 그룹이 캠페인 1.0건인데 운영일만 3배면 "1건이 90일 운영"으로 읽힌다).
  const operatingDays = effectivePeriods.reduce(
    (sum, period) => sum + allocateCampaignToMonth(period, selectedMonth).operatingDays,
    0,
  );
  const prevOperatingDays = effectivePeriods.reduce(
    (sum, period) => sum + allocateCampaignToMonth(period, prevMonth).operatingDays,
    0,
  );
  const latestActiveMonth = [...campaigns]
    .filter((campaign) => campaignSales(campaign) > 0)
    .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())[0];
  // 셀러 베이스 모멘텀 — 관계 기반 매출 근원의 성장/이탈 선행지표. 추가 쿼리 없이 campaigns 이력에서 산출.
  const oneEightyDaysAgo = new Date(now.getTime() - 180 * DAY_MS);
  const curMonthStart = startOfMonth(selectedMonth);
  const sellerStartTimes = new Map<string, { times: number[]; name: string; alias: string | null }>();
  for (const campaign of campaigns) {
    if (!campaign.sellerId) continue;
    const entry = sellerStartTimes.get(campaign.sellerId);
    if (entry) entry.times.push(campaign.startDate.getTime());
    else
      sellerStartTimes.set(campaign.sellerId, {
        times: [campaign.startDate.getTime()],
        name: campaign.seller.name,
        alias: campaign.seller.alias,
      });
  }
  let activeSellers = 0;
  let prevActiveSellers = 0;
  let newSellersThisMonth = 0;
  // 휴면 셀러 목록 — 대시보드 "재계약 검토" 팝업에서 페이지 이동 없이 대상 확인(오너 2026-07-24).
  // 최근 이탈 순 정렬: 가장 최근까지 활동한 셀러가 재계약 성사 확률이 높아 검토 우선순위가 된다.
  const dormantSellerList: Array<{ id: string; name: string; lastCampaignAt: string }> = [];
  for (const [sellerId, entry] of sellerStartTimes.entries()) {
    const { times } = entry;
    const maxTime = Math.max(...times);
    const minTime = Math.min(...times);
    const hasRecent = times.some((t) => t >= ninetyDaysAgo.getTime() && t <= now.getTime());
    const hasPrevWindow = times.some((t) => t >= oneEightyDaysAgo.getTime() && t < ninetyDaysAgo.getTime());
    if (hasRecent) activeSellers += 1;
    if (hasPrevWindow) prevActiveSellers += 1;
    // 신규 = 첫 캠페인이 이번 달(실제 활성화 기준 — 온보딩/대량 발굴 유입 노이즈 배제)
    if (minTime >= curMonthStart.getTime() && minTime <= now.getTime()) newSellersThisMonth += 1;
    // 휴면 = 과거 캠페인은 있으나 최근 90일 활동 없음(재계약 대상). 표기명은 별칭 우선(P2).
    if (!hasRecent && maxTime < ninetyDaysAgo.getTime()) {
      dormantSellerList.push({
        id: sellerId,
        name: entry.alias && entry.alias.trim() !== "" ? entry.alias : entry.name,
        lastCampaignAt: new Date(maxTime).toISOString(),
      });
    }
  }
  dormantSellerList.sort((a, b) => b.lastCampaignAt.localeCompare(a.lastCampaignAt));

  return {
    selectedMonth,
    latestActiveMonth: latestActiveMonth
      ? { month: monthKey(latestActiveMonth.startDate), revenue: campaignSales(latestActiveMonth) }
      : null,
    goals: {
      monthTarget: monthlyGoal ? numberValue(monthlyGoal.revenueTarget) : null,
      annualTarget: annualGoal ? numberValue(annualGoal.revenueTarget) : null,
      monthActual,
      ytdActual,
      prevMonthTarget: prevMonthlyGoal ? numberValue(prevMonthlyGoal.revenueTarget) : null,
      prevMonthActual,
      prevPrevMonthTarget: prevPrevMonthlyGoal ? numberValue(prevPrevMonthlyGoal.revenueTarget) : null,
      prevPrevMonthActual,
    },
    ytdHistory,
    scale: {
      weightedCampaignCount,
      operatingDays,
      prevWeightedCampaignCount,
      prevOperatingDays,
      prevPrevWeightedCampaignCount,
    },
    // 셀러 베이스 모멘텀 — 활성/신규/휴면/순증감(최근 90일 vs 직전 90일 활성 셀러 차)
    sellerMomentum: {
      active: activeSellers,
      newThisMonth: newSellersThisMonth,
      dormant: dormantSellerList.length,
      dormantList: dormantSellerList,
      netChange: activeSellers - prevActiveSellers,
    },
    // 확정 손익(정산 완료 후행 지표)은 실시간 현황판에서 제외 — 손익 리포트(/reports/pnl)가 담당
    profitability: {
      expectedMargin: selectedCampaigns.reduce(
        (sum, campaign) => sum + campaignSales(campaign) * numberValue(campaign.netMarginRate) / 100,
        0,
      ),
      prevExpectedMargin: prevCampaigns.reduce(
        (sum, campaign) => sum + campaignSales(campaign) * numberValue(campaign.netMarginRate) / 100,
        0,
      ),
      prevPrevExpectedMargin: prevPrevCampaigns.reduce(
        (sum, campaign) => sum + campaignSales(campaign) * numberValue(campaign.netMarginRate) / 100,
        0,
      ),
    },
    // 영업 후속 액션 신호만 담는다(아웃리치 단위 = 그룹 개념이 없어 행 단위가 정답).
    // ⛔ 정산 신호(입금 대기·정산 불일치)를 여기에 다시 넣지 말 것 — 정산 플래그의 SoT 는
    // 그룹 스칼라(CampaignGroup.isDepositReceived 등)이고 멤버 행 플래그는 낡을 수 있다.
    // 그 판정의 정본은 computeDataIntegrityIssues 의 SETTLEMENT_INCOMPLETE(그룹 dual-read
    // + 그룹당 1건 접기, src/lib/data-integrity.ts)이며 아래 dataIntegrityIssues 로 이미 나간다.
    exceptions: {
      overdueReminders: outreach.filter((task) => task.status === "PROPOSED" && task.nextReminderAt && task.nextReminderAt < now).length,
      pendingApprovals: outreach.filter((task) => task.status === "PENDING_APPROVAL").length,
    },
    outreach90d: {
      total: outreach.length,
      responded: outreach.filter((task) => task.respondedAt).length,
      confirmed: outreach.filter((task) => task.confirmedAt).length,
      converted: outreach.filter((task) => task.status === "CONVERTED").length,
    },
    // 정산 노출액(후행 지표)은 실시간 현황판에서 제외 — 정산 관리(/settlement)가 담당.
    // 종전 quality 블록(endedMissingSales·settlementMismatches·missingGoals)은 제거됐다:
    // 앞의 둘은 computeDataIntegrityIssues 의 MISSING_SALES·SETTLEMENT_INCOMPLETE 와 술어가
    // 같으면서 그룹을 접지 않아 멤버 수만큼 부풀었고, missingGoals 는 위 goals.monthTarget/
    // annualTarget 의 null 여부로 그대로 파생된다.
    trend: trendMonths.map((key) => {
      const inMonth = campaigns.filter((campaign) => allocateCampaignToMonth(campaign, key).operatingDays > 0);
      return {
        month: key,
        revenue: inMonth.reduce((sum, campaign) => sum + campaignSales(campaign), 0),
        expectedMargin: inMonth.reduce(
          (sum, campaign) => sum + campaignSales(campaign) * numberValue(campaign.netMarginRate) / 100,
          0,
        ),
        // KPI 스파크라인·모멘텀 미니차트용 — 월 환산 캠페인 수(유효 기준), 해당 월 활성(캠페인 보유) 셀러 수
        campaignCount: effectivePeriods.reduce(
          (sum, period) => sum + allocateCampaignToMonth(period, key).weightedCampaignCount,
          0,
        ),
        activeSellers: new Set(inMonth.map((campaign) => campaign.sellerId).filter(Boolean)).size,
        goal: goals.find((goal) => goal.periodKey === key)?.revenueTarget
          ? numberValue(goals.find((goal) => goal.periodKey === key)?.revenueTarget)
          : null,
      };
    }),
    // 연간 월별 매출·순마진(연초~현재) — 대시보드 매출 차트의 "연간 매출" 탭용(오너 2026-07-24).
    // trend 와 동일 로직(operating-month 멤버십 · campaignSales · netMarginRate · 월 목표)을 미러링해,
    // 두 차트가 같은 정의를 공유하고 Y축을 공통 도메인으로 맞출 수 있게 한다. 순마진도 함께 싣는다.
    yearlyTrend: Array.from({ length: now.getUTCMonth() + 1 }, (_, i) => {
      const key = `${year}-${String(i + 1).padStart(2, "0")}`;
      const inMonth = campaigns.filter((campaign) => allocateCampaignToMonth(campaign, key).operatingDays > 0);
      return {
        month: key,
        revenue: inMonth.reduce((sum, campaign) => sum + campaignSales(campaign), 0),
        expectedMargin: inMonth.reduce(
          (sum, campaign) => sum + campaignSales(campaign) * numberValue(campaign.netMarginRate) / 100,
          0,
        ),
        goal: goals.find((goal) => goal.periodKey === key)?.revenueTarget
          ? numberValue(goals.find((goal) => goal.periodKey === key)?.revenueTarget)
          : null,
      };
    }),
    upcomingEvents: buildUpcomingEvents(campaigns, now, scheduleEnd),
    googleCalendarConnected: googleCalendar?.status === "CONNECTED",
    revenueGoalSchemaReady: goalResult.schemaReady,
    scheduleGapBriefing,
    // F1 재캠페인 적기 데이터는 GET /api/recampaign-alerts로 이관 — 카드가 영업 관리(/outreach)로 옮겨감
    // 휴먼에러 게이트(§F5): 정산·매출 명백한 정합성 오류 목록 — 대시보드 '데이터 점검' 카드
    dataIntegrityIssues: computeDataIntegrityIssues(
      campaigns.map((campaign) => ({
        id: campaign.id,
        campaignName: campaign.campaignName,
        dealName: campaign.deal.dealName,
        sellerName: campaign.seller.name,
        sellerAlias: campaign.seller.alias,
        endDate: campaign.endDate,
        // 「정산 착수 지연」의 기준일(T-062). 빠지면 판매 종료 +14일 폴백으로만 판정되는데,
        // 반품기간을 손으로 넣어 둔 캠페인은 그 값이 정본이라 하루 이상 어긋난다.
        returnPeriodEndDate: campaign.returnPeriodEndDate,
        actualSales: campaign.actualSales != null ? Number(campaign.actualSales.toString()) : null,
        status: campaign.status,
        // 완료 판정 집합은 채널이 정한다 — 이 두 줄이 빠지면 정상 완료된 자사몰 건이
        // 전부 「입금 미확인」 오탐으로 뜬다(data-integrity 의 슬롯 판정 주석 참조).
        salesChannel: campaign.salesChannel,
        isDepositReceived: campaign.isDepositReceived,
        isPayoutCompleted: campaign.isPayoutCompleted,
        isSupplierPayoutCompleted: campaign.isSupplierPayoutCompleted,
        groupId: campaign.groupId,
        group: campaign.group
          ? {
              name: campaign.group.name,
              isDepositReceived: campaign.group.isDepositReceived,
              isPayoutCompleted: campaign.group.isPayoutCompleted,
              isSupplierPayoutCompleted: campaign.group.isSupplierPayoutCompleted,
            }
          : null,
      })),
      now,
    ),
  };
}
