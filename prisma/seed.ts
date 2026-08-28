/**
 * 로컬 sqlite 개발 픽스처 — `npm run db:seed:local` (DATABASE_URL=file:./dev.db).
 *
 * 날짜는 전부 **실행 시점 상대 오프셋**으로 만든다. 절대 날짜를 박으면 몇 달 뒤
 * 데스크톱 대시보드의 "최근 6개월" 추이 창 밖으로 캠페인이 통째로 밀려나
 * dev:local 에서 차트가 빈 화면이 되고, 그 화면은 로컬에서 검증 자체가 불가능해진다
 * (같은 이유로 `seed-demo.ts` 도 상대 오프셋을 쓴다).
 */
import "dotenv/config";
import { generateCampaignName } from "../src/lib/campaign-name";
import { mockDashboardData } from "../src/lib/mock-data";
import { createPrismaClient } from "../src/lib/prisma-client";

// 로컬 전용 가드 — 이 시드는 아래 12개 테이블을 deleteMany 로 비운다(RevenueGoal =
// 오너의 실제 매출 목표 포함). 레포 `.env` 의 DATABASE_URL 은 프로덕션 Supabase 이므로
// (AGENTS.md P0) file: 대상이 아니면 즉시 중단한다 — `seed-demo.ts` 와 같은 방식이다.
const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL.startsWith("file:")) {
  console.error(
    "[seed] 중단: 로컬 sqlite 픽스처 전용입니다. DATABASE_URL=file:... 에서만 실행하세요 (npm run db:seed:local).",
  );
  process.exit(1);
}

const prisma = createPrismaClient();

// ---------------------------------------------------------------------------
// 상대 날짜 헬퍼
//
// 추이 차트·월 목표 매칭은 **UTC 월키**로 이뤄지므로(`desktop-dashboard.monthKey` =
// `toISOString().slice(0, 7)`) 월 경계도 UTC 로 잡는다. KST 로 계산하면 월초·월말에
// 픽스처가 옆 달로 새어 "왜 이번 달이 비지?" 를 디버깅하게 된다.
// ---------------------------------------------------------------------------
const NOW = new Date();
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

/** `back`개월 전 달의 `day`일 UTC 자정. day 는 1~28 만 쓴다(모든 달에 존재). */
const monthDay = (back: number, day: number) =>
  new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - back, day));

const currentYear = String(NOW.getUTCFullYear());
const previousYear = String(NOW.getUTCFullYear() - 1);

// ---------------------------------------------------------------------------
// 캠페인 회차 — 최근 6개월(0=당월 … 5=5개월 전)에 하나씩 깔아 추이 차트를 채운다.
//
// mock-data 의 캠페인 2건은 각 시리즈의 **최신 회차**로 유지한다. 특히
// `camp-glow-mina` 는 Asset 2건과 TrackingAttribution 이 참조하므로 id 가 반드시
// 살아 있어야 한다. 나머지 회차는 여기서만 만드는 로컬 픽스처다.
// ---------------------------------------------------------------------------
type CampaignTemplate = (typeof mockDashboardData.campaigns)[number];

/**
 * 템플릿은 **id 로** 찾는다. 배열 순서로 구조분해하면 mock-data 의 캠페인 순서가
 * 바뀌거나 항목이 끼어드는 순간 조용히 다른 딜·셀러·마진율·추적링크가 박히고,
 * 대시보드는 멀쩡히 렌더돼서 알아채지 못한다 — 여기서 시끄럽게 죽는 편이 낫다.
 */
function campaignTemplate(id: string): CampaignTemplate {
  const template = mockDashboardData.campaigns.find((campaign) => campaign.id === id);
  if (!template) {
    throw new Error(
      `[seed] mock-data 에 캠페인 템플릿 "${id}" 가 없습니다. src/lib/mock-data.ts 의 campaigns 에서 id 가 바뀌었는지 확인하세요.`,
    );
  }
  return template;
}

const glowTemplate = campaignTemplate("camp-glow-mina");
const wellnessTemplate = campaignTemplate("camp-wellness-jun");

type SeededCampaign = {
  id: string;
  template: CampaignTemplate;
  roundNumber: number;
  startDate: Date;
  endDate: Date;
  status: string;
  actualSales: number | null;
};

const seededCampaigns: SeededCampaign[] = [
  { id: "camp-glow-mina-r1", template: glowTemplate, roundNumber: 1, startDate: monthDay(5, 8), endDate: monthDay(5, 14), status: "COMPLETED", actualSales: 26_800_000 },
  { id: "camp-wellness-jun-r1", template: wellnessTemplate, roundNumber: 1, startDate: monthDay(4, 8), endDate: monthDay(4, 14), status: "COMPLETED", actualSales: 18_400_000 },
  { id: "camp-glow-mina-r2", template: glowTemplate, roundNumber: 2, startDate: monthDay(3, 8), endDate: monthDay(3, 14), status: "COMPLETED", actualSales: 33_500_000 },
  { id: "camp-wellness-jun-r2", template: wellnessTemplate, roundNumber: 2, startDate: monthDay(2, 8), endDate: monthDay(2, 14), status: "COMPLETED", actualSales: 23_100_000 },
  { id: "camp-glow-mina-r3", template: glowTemplate, roundNumber: 3, startDate: monthDay(1, 8), endDate: monthDay(1, 14), status: "COMPLETED", actualSales: 38_900_000 },
  // 당월 진행중 — 항상 "오늘"을 걸치게 잡아, 실행일이 1일이든 31일이든 당월 실적이 채워진다.
  { id: "camp-glow-mina", template: glowTemplate, roundNumber: 4, startDate: daysAgo(4), endDate: daysAhead(2), status: "ACTIVE", actualSales: 41_200_000 },
  // 예정 — 홈 '다가오는 일정'(now ~ now+14일 창)에 시작 이벤트가 걸리도록 +9일 시작.
  { id: "camp-wellness-jun", template: wellnessTemplate, roundNumber: 3, startDate: daysAhead(9), endDate: daysAhead(15), status: "PREPARATION", actualSales: null },
];

/** 실적이 확정된 시점 — 종료된 회차는 종료 다음 날, 진행중이면 어제. */
const salesRecordedAt = (campaign: SeededCampaign) =>
  campaign.endDate < NOW ? new Date(campaign.endDate.getTime() + DAY_MS) : daysAgo(1);

/**
 * 정산 필드 — `COMPLETED`(정산완료) 회차에만 채운다.
 *
 * 이걸 비워두면 `computeDataIntegrityIssues`의 SETTLEMENT_INCOMPLETE 가 회차마다 걸려
 * 홈 '데이터 점검' 카드가 픽스처 잡음으로 가득 찬다 — 상태와 플래그는 같이 움직여야 한다.
 * 금액은 딜의 마진 정책에서 그대로 유도해 서로 모순이 없게 만든다
 * (총수수료 = 셀러 지급 + 순마진).
 */
function settlementFields(campaign: SeededCampaign) {
  if (campaign.status !== "COMPLETED" || campaign.actualSales == null) return {};
  const rate = (percent: number) => Math.round((campaign.actualSales! * percent) / 100);
  const settledAt = new Date(campaign.endDate.getTime() + 14 * DAY_MS);
  return {
    settlementSales: campaign.actualSales,
    operatingProfit: rate(Number(campaign.template.netMarginRate)),
    isDepositReceived: true,
    isPayoutCompleted: true,
    depositReceivedAt: settledAt,
    payoutCompletedAt: settledAt,
    expectedDepositDate: settledAt,
    expectedPayoutDate: settledAt,
  };
}

// ---------------------------------------------------------------------------
// 매출 목표 — 운영 설정 UI(`PATCH /api/settings/revenue-goals`)가 쓰는 모양 그대로
// YEAR 1행 + MONTH 12행을 만든다. 이게 없으면 대시보드 히어로·추이 차트의
// "목표 대비 달성" 분기가 로컬에서 **한 번도** 렌더되지 않고 '미설정'만 보인다.
//
// 값 설계(밴드를 눈으로 확인하려는 의도다 — `src/lib/goal-band.ts`):
// - 월 목표는 30,000,000 에서 매월 1,000,000 씩 오르는 완만한 램프다. 평평하게 두면
//   목표선이 데이터에서 온 건지 상수인지 화면에서 구분되지 않는다.
// - 당월 실적 41,200,000 은 어느 달에 시드해도 그 달 목표(30~41M)를 넘으므로
//   월 달성률은 항상 **달성(≥100%, 골드)** 밴드다.
// - 연 목표는 12개월 합(426,000,000)이라 연중 YTD 달성률은 **심각(<80%)** 밴드다.
//   → 히어로 한 화면에서 색이 있는 두 밴드를 동시에 확인할 수 있다.
//
// 연도 경계 — **전년도 목표도 같은 모양으로 만든다.** 1~5월에 시드하면 최근 6개월
// 창의 앞쪽 월이 전년도로 넘어가기 때문이다. 종전에는 전년도 행을 만들어도 추이
// 목표선이 비어 보였는데(원인은 시드가 아니라 조회 — `findRevenueGoalsSafe(year)`가
// 당해년도 행만 가져왔고, 프로덕션에서도 1~5월에 그대로 보이던 앱 동작이었다),
// 조회 범위를 **추이 창이 걸치는 모든 연도**로 넓혀 해소했다
// (`src/lib/revenue-goals.ts` · 회귀 테스트 `src/lib/desktop-dashboard.test.ts`).
// 히어로의 월·연 달성률은 항상 당해년도 기준이라 이 경계와 무관하다.
// ---------------------------------------------------------------------------
const MONTHLY_TARGETS = Array.from({ length: 12 }, (_, index) => 30_000_000 + index * 1_000_000);
const ANNUAL_TARGET = MONTHLY_TARGETS.reduce((sum, target) => sum + target, 0);

/** 운영 설정 UI 가 쓰는 모양 그대로 — 해당 연도의 YEAR 1행 + MONTH 12행. */
function buildYearGoals(year: string) {
  return [
    { periodType: "YEAR", periodKey: year, revenueTarget: ANNUAL_TARGET },
    ...MONTHLY_TARGETS.map((revenueTarget, index) => ({
      periodType: "MONTH",
      periodKey: `${year}-${String(index + 1).padStart(2, "0")}`,
      revenueTarget,
    })),
  ];
}

async function main() {
  await prisma.trackingAttribution.deleteMany();
  await prisma.campaignActivity.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.storageIntegration.deleteMany();
  await prisma.apiCallLog.deleteMany();
  await prisma.revenueGoal.deleteMany();
  await prisma.salesTask.deleteMany();
  await prisma.salesCampaign.deleteMany();
  await prisma.sellersHistory.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.seller.deleteMany();
  await prisma.partner.deleteMany();

  for (const deal of mockDashboardData.deals) {
    await prisma.partner.upsert({
      where: { id: deal.partner.id },
      update: {},
      create: {
        id: deal.partner.id,
        name: deal.partner.name,
        type: deal.partner.type,
        contactInfo: `${deal.partner.name.toLowerCase()}@example.com`,
        bankAccount: "국민 000000-00-000000",
      },
    });

    await prisma.deal.create({
      data: {
        id: deal.id,
        dealName: deal.dealName,
        brandName: deal.brandName,
        costPrice: deal.costPrice,
        status: deal.status,
        partnerId: deal.partner.id,
        baseMarginPolicy: JSON.stringify(deal.baseMarginPolicy),
      },
    });
  }

  for (const seller of mockDashboardData.sellers) {
    const histories = seller.histories ?? [];
    await prisma.seller.create({
      data: {
        id: seller.id,
        name: seller.name,
        snsType: seller.snsType,
        snsHandle: seller.snsHandle,
        currentFollowers: seller.currentFollowers,
        category: seller.category,
        histories: {
          // 팔로워 스냅샷은 mock-data 의 절대 날짜 대신 "최근 N주" 주간 시계열로 깐다.
          create: histories.map((history, index) => ({
            snapshotDate: daysAgo((histories.length - 1 - index) * 7),
            followersCount: history.followersCount,
            source: seller.snsType === "INSTAGRAM" ? "INSTAGRAM" : "YOUTUBE",
          })),
        },
      },
    });
  }

  await prisma.salesTask.createMany({
    data: [
      {
        id: "task-glow-mina",
        dealId: "deal-glow-ampoule",
        sellerId: "seller-mina",
        status: "PROPOSED",
        contactChannel: "DM",
        proposalMessage: "앰플 공구 가능 여부와 대략적인 진행 일정을 문의했습니다.",
        proposalSentAt: daysAgo(6),
        nextReminderAt: daysAhead(2),
      },
      {
        id: "task-glow-jun",
        dealId: "deal-glow-ampoule",
        sellerId: "seller-jun",
        status: "NEGOTIATION",
        contactChannel: "EMAIL",
        proposalMessage: "러프 조건과 가능한 매출 규모를 먼저 확인 중입니다.",
        proposalSentAt: daysAgo(8),
        respondedAt: daysAgo(7),
      },
      {
        id: "task-wellness-mina",
        dealId: "deal-wellness-pack",
        sellerId: "seller-mina",
        status: "TESTING",
        contactChannel: "KAKAO",
        proposalMessage: "브랜드 1차 스크리닝 후 테스트 진행 여부를 확인 중입니다.",
        proposalSentAt: daysAgo(10),
        respondedAt: daysAgo(9),
      },
      {
        id: "task-wellness-jun",
        dealId: "deal-wellness-pack",
        sellerId: "seller-jun",
        status: "PENDING_APPROVAL",
        contactChannel: "DM",
        proposalMessage: "테스트 완료 후 행사 진행이 확정되었습니다.",
        proposalSentAt: daysAgo(13),
        respondedAt: daysAgo(12),
        confirmedAt: daysAgo(5),
      },
    ],
  });

  for (const campaign of seededCampaigns) {
    const { template } = campaign;
    const createdAt = new Date(campaign.startDate.getTime() - 4 * DAY_MS);
    const updatedAt = campaign.actualSales == null ? createdAt : salesRecordedAt(campaign);

    await prisma.salesCampaign.create({
      data: {
        id: campaign.id,
        dealId: template.dealId,
        sellerId: template.sellerId,
        campaignName: generateCampaignName(template.dealName, template.sellerName, campaign.roundNumber),
        roundNumber: campaign.roundNumber,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        salesChannel: template.salesChannel,
        baseNaverLink: template.baseNaverLink,
        generatedTrackingLink: template.generatedTrackingLink.replace(
          `nt_detail=${template.id}`,
          `nt_detail=${campaign.id}`,
        ),
        actualSales: campaign.actualSales,
        totalMarginRate: template.totalMarginRate,
        sellerMarginRate: template.sellerMarginRate,
        netMarginRate: template.netMarginRate,
        status: campaign.status,
        isManualMargin: template.isManualMargin,
        ...settlementFields(campaign),
        createdAt,
        updatedAt,
      },
    });

    await prisma.campaignActivity.create({
      data: {
        id: `${campaign.id}-activity-created`,
        campaignId: campaign.id,
        action: "CREATED",
        label: "Campaign created",
        details: `${campaign.status} · ${template.salesChannel}`,
        actor: "SYSTEM",
        createdAt,
      },
    });

    if (campaign.actualSales != null) {
      await prisma.campaignActivity.create({
        data: {
          id: `${campaign.id}-activity-sales`,
          campaignId: campaign.id,
          action: "ACTUAL_SALES_UPDATED",
          label: "Actual sales updated",
          details: `${campaign.actualSales.toLocaleString("ko-KR")} · auto margin recalculated`,
          actor: "SYSTEM",
          createdAt: updatedAt,
        },
      });
    }
  }

  await prisma.revenueGoal.createMany({
    data: [previousYear, currentYear].flatMap(buildYearGoals),
  });

  for (const [index, log] of mockDashboardData.apiCallLogs.entries()) {
    await prisma.apiCallLog.create({
      data: {
        id: log.id,
        provider: log.provider,
        permissionScope: log.permissionScope,
        endpoint: log.endpoint,
        statusCode: log.statusCode,
        success: log.success,
        calledAt: new Date(daysAgo(1).getTime() + index * 5 * 60 * 1000),
      },
    });
  }

  for (const [index, asset] of mockDashboardData.assets.entries()) {
    await prisma.asset.create({
      data: {
        id: asset.id,
        provider: asset.provider,
        section: asset.section,
        entityType: asset.entityType,
        entityId: asset.entityId,
        campaignId: asset.campaignId,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        storagePath: asset.storagePath,
        externalFileId: asset.externalFileId,
        externalUrl: asset.externalUrl,
        thumbnailUrl: asset.thumbnailUrl,
        notes: asset.notes,
        archivedAt: asset.archivedAt ? new Date(asset.archivedAt) : null,
        createdAt: new Date(daysAgo(2).getTime() + index * HOUR_MS),
      },
    });
  }

  await prisma.storageIntegration.create({
    data: {
      provider: "GOOGLE_DRIVE",
      status: "DISCONNECTED",
      metadata: JSON.stringify({ rootFolderName: "WAG CRM Assets" }),
    },
  });

  await prisma.trackingAttribution.create({
    data: {
      campaignId: "camp-glow-mina",
      ntSource: "INSTAGRAM",
      ntMedium: "seller-mina",
      ntDetail: "camp-glow-mina",
      landingUrl:
        "https://wag.example.com/?nt_source=INSTAGRAM&nt_medium=seller-mina&nt_detail=camp-glow-mina",
      conversionEvent: "seed_conversion",
      payload: JSON.stringify({ orderNo: "ORDER-SEED-1" }),
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
