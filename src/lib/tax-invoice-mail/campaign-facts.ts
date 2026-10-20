/**
 * 대조 엔진이 쓰는 **캠페인 사실**을 DB 에서 한 번만 정의해 읽는다.
 *
 * 수취 조회 API(`/api/settlement/tax-invoice-receipts`)와 발행 자동확정 크론이 **같은
 * 캠페인 집합·같은 폴딩 규칙**을 봐야 한다. 두 곳이 각자 `findMany` 를 들고 있으면
 * select 하나가 갈리는 순간 한쪽만 조용히 다른 답을 낸다 — 이 레포가 반복해 밟은 함정이다
 * (`order-fetch-window`·`tax-filing-board` 가 같은 이유로 SSOT 로 모였다).
 *
 * ⚠️ 이 모듈만 Prisma 를 안다. 판정 계층(`expected-*.ts`·`*-match.ts`)은 순수를 유지한다.
 */

import type { PrismaClient } from "@prisma/client";
import type { CampaignIssuanceFacts } from "./expected-issuances";
import { toKstYmd } from "../date-utils";
import { SETTLEMENT_STAGE_STATUSES } from "../settlement-stage";
import {
  INVOICE_LOOKUP_DAYS_AFTER_END,
  addDaysToYmd,
  invoiceLookupSinceDays,
  isInvoiceLookupTarget,
} from "./invoice-lookup-scope";

/**
 * 작성일자 타당 창의 뒤쪽 여유.
 *
 * 계산서는 캠페인 종료 뒤 정산 시점에 끊기므로 종료일에 여유를 크게 준다. 창을 좁히면
 * 정상 건이 대량으로 「확인 필요」가 되어 경고가 무시당한다 — 판정의 목적은 이상을 눈에
 * 띄게 하는 것이지 건수를 늘리는 것이 아니다.
 */
export const WRITTEN_DATE_GRACE_DAYS = 90;

/**
 * 조회 창 앞쪽 여유(일). 계산서는 캠페인이 끝난 **뒤** 끊기므로, 메일 조회창(`sinceDays`)
 * 보다 캠페인 창을 더 넓게 잡아야 "지난달 종료 건의 이번달 계산서"가 대조 대상에 든다.
 * 미발행 건 다수가 이전 달 종료라는 것이 타 세션 프로덕션 실측이다 — 예외가 아니라
 * 다수에 걸리는 축이라 넉넉히 둔다.
 */
export const CAMPAIGN_WINDOW_LOOKBACK_DAYS = 180;

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDateKey(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function shiftDays(value: Date | null, days: number): string | null {
  if (!value) return null;
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface LoadedCampaignFacts {
  /** 미그룹 캠페인 — 각각 1건짜리 묶음으로 다룬다 */
  solo: CampaignIssuanceFacts[];
  /** groupId → 멤버 전원 */
  byGroup: Map<string, CampaignIssuanceFacts[]>;
  /** 순회 편의용 — 위 둘을 합친 평면 목록 */
  all: CampaignIssuanceFacts[];
}

/**
 * 조회 창과 겹치는 캠페인의 정산 사실을 읽는다.
 *
 * ⚠️ **그룹 소속이면 그룹의 발행일이 개별 캠페인 값을 가린다** — `campaign-row.ts` 의
 * 폴딩 규칙과 동일하다. `CampaignGroup` 이 이 두 필드를 멤버 전원 공유로 스키마에 두므로,
 * 그룹 소속인데 개별 값을 그대로 읽으면 그룹 완료 처리와 어긋난 값을 본다.
 *
 * ## ⛔ 그룹은 **창과 무관하게 멤버 전원**을 싣는다 (교차 검증 2026-08-06)
 *
 * 조회 창(`endDate >= …`)만으로 뽑으면 **창 경계를 걸친 그룹의 멤버 일부가 잘린다.**
 * `CampaignGroup` 의 멤버 기간에는 제약이 없다 — `rollupGroupPeriod` 가 포락선(min~max)을
 * 복사해 둘 뿐이라 멤버끼리 몇 달 떨어져 있을 수 있다.
 *
 * 그 절단이 왜 위험한가: `buildGroupExpectedIssuances` 의 후퇴 가드(채널·공급사 균일성)가
 * **잘려나간 부분집합**만 보고 "상대 동일"로 오판한다. 그러면 실제로는 공급사가 둘이라
 * 계산서가 두 장이어야 하는 그룹을, 보이는 멤버만 합산해 한 장과 맞춰 **그룹 필드를 찍고**,
 * 창 밖 멤버의 발행 의무가 미이행인 채로 보드에서 조용히 사라진다 — 이 설계가 막으려던
 * 바로 그 실패다.
 *
 * 그래서 2단계로 읽는다: ①창으로 후보를 찾고 ②그 후보들의 `groupId` 에 속한 캠페인을
 * **창 없이** 다시 읽어 멤버십을 완성한다. 프로덕션 그룹 수가 20 대라 비용은 무시할 만하다.
 */
export async function loadCampaignSettlementFacts(
  prisma: PrismaClient,
  options: { sinceDays: number },
): Promise<LoadedCampaignFacts> {
  const windowStart = new Date(
    Date.now() - (options.sinceDays + CAMPAIGN_WINDOW_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000,
  );

  // ① 창 안의 후보에서 그룹 id 를 모은다.
  const seeds = await prisma.salesCampaign.findMany({
    where: { endDate: { gte: windowStart }, groupId: { not: null } },
    select: { groupId: true },
  });
  const groupIds = [
    ...new Set(seeds.map((seed) => seed.groupId).filter((id): id is string => id !== null)),
  ];

  // ② 창 안의 건 **또는** 그 그룹에 속한 건 전부. OR 이라 그룹 멤버는 창 밖이어도 들어온다.
  const campaigns = await prisma.salesCampaign.findMany({
    where: {
      OR: [
        { endDate: { gte: windowStart } },
        ...(groupIds.length > 0 ? [{ groupId: { in: groupIds } }] : []),
      ],
    },
    select: {
      id: true,
      campaignName: true,
      salesChannel: true,
      startDate: true,
      endDate: true,
      actualSales: true,
      settlementSales: true,
      sellerExpense: true,
      settlementGoodsCost: true,
      // ⛔ 이 select 를 빼면 부가 항목이 있어도 기대액이 안 움직이고 **오류도 안 난다**
      //    (설계 §9-6-3 — 2-A 에서 가장 조용한 실패 지점). 자동 확정 크론이 이 사실로
      //    금액을 대조하므로, 빠지면 정상 건이 영구히 `AMOUNT_MISMATCH` 로 떨어진다.
      settlementItems: {
        select: { invoiceMode: true, counterparty: true, amount: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      },
      supplierInvoiceIssuedAt: true,
      sellerInvoiceIssuedAt: true,
      // 개인 셀러 판별용 — 보드와 같은 규칙을 쓰기 위해 필요하다.
      sellerTaxType: true,
      groupId: true,
      group: { select: { supplierInvoiceIssuedAt: true, sellerInvoiceIssuedAt: true } },
      seller: { select: { name: true, agency: { select: { name: true, businessNumber: true } } } },
      deal: {
        select: {
          dealName: true,
          partner: { select: { name: true, businessNumber: true, monthlySettlement: true } },
        },
      },
    },
  });

  function foldedInvoiceDate(
    campaign: (typeof campaigns)[number],
    field: "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt",
  ): string | null {
    const value = campaign.group ? campaign.group[field] : campaign[field];
    return value?.toISOString() ?? null;
  }

  const solo: CampaignIssuanceFacts[] = [];
  const byGroup = new Map<string, CampaignIssuanceFacts[]>();
  const all: CampaignIssuanceFacts[] = [];

  for (const campaign of campaigns) {
    const facts: CampaignIssuanceFacts = {
      campaignId: campaign.id,
      campaignLabel: campaign.campaignName ?? campaign.deal?.dealName ?? campaign.id,
      salesChannel: campaign.salesChannel,
      actualSales: toNumber(campaign.actualSales),
      settlementSales: toNumber(campaign.settlementSales),
      sellerExpense: toNumber(campaign.sellerExpense),
      // 수기 물품대금(`settlementGoodsCost`) — 있으면 공식보다 우선, 0 은 합산 이관 마커.
      // 의미론은 expected-receivables.ts 의 manualGoodsCost 주석이 정본이다.
      manualGoodsCost: toNumber(campaign.settlementGoodsCost),
      // 열거값 검증은 하지 않는다 — 판정 SSOT(`settlement-items.ts`)가 축을 정확히
      // 일치시켜 고르므로 모르는 값은 어느 축에도 안 걸려 자연히 무시된다(화면과 달리
      // 여기서는 "모르는 값을 렌더"할 위험이 없다).
      settlementItems: campaign.settlementItems.map((item) => ({
        invoiceMode: item.invoiceMode,
        counterparty: item.counterparty,
        amount: toNumber(item.amount) ?? 0,
      })),
      sellerBusinessNumber: campaign.seller?.agency?.businessNumber ?? null,
      sellerTaxType: campaign.sellerTaxType ?? null,
      sellerLabel: campaign.seller?.agency?.name ?? campaign.seller?.name ?? "셀러",
      partnerBusinessNumber: campaign.deal?.partner?.businessNumber ?? null,
      partnerLabel: campaign.deal?.partner?.name ?? "거래처 없음",
      partnerMonthlySettlement: campaign.deal?.partner?.monthlySettlement ?? false,
      supplierInvoiceIssuedAt: foldedInvoiceDate(campaign, "supplierInvoiceIssuedAt"),
      sellerInvoiceIssuedAt: foldedInvoiceDate(campaign, "sellerInvoiceIssuedAt"),
      validWrittenDateFrom: toDateKey(campaign.startDate),
      validWrittenDateTo: shiftDays(campaign.endDate, WRITTEN_DATE_GRACE_DAYS),
      groupId: campaign.groupId,
    };

    all.push(facts);
    if (campaign.groupId) {
      const members = byGroup.get(campaign.groupId);
      if (members) members.push(facts);
      else byGroup.set(campaign.groupId, [facts]);
    } else {
      solo.push(facts);
    }
  }

  return { solo, byGroup, all };
}

export interface InvoiceLookupTargets {
  /** 자동 조회 대상 캠페인 id — 그룹이면 멤버 전원(상태는 그룹 안에서 함께 움직인다) */
  campaignIds: Set<string>;
  /** 대상 캠페인이 속한 그룹 id — 그룹 단위 쓰기·월정산 단위 키 대조용 */
  groupIds: Set<string>;
  /** 메일 조회 창 일수(가장 이른 판매 종료일 +10일 ~ 오늘). 대상이 없으면 null — 메일함을 열지 않는다 */
  sinceDays: number | null;
  /** 월정산 단위 키(그룹 id 또는 캠페인 id — `loadAutoRecordUnits`)가 대상인가 */
  includesUnit(unitKey: string): boolean;
}

/**
 * 오늘 계산서 자동 조회 대상(정산 단계 · 판매 종료 후 60일 이내)을 읽는다 — 판정은
 * `invoice-lookup-scope.ts` 가 소유하고 여기는 읽기만 한다(오너 확정 2026-10-21).
 */
export async function loadInvoiceLookupTargets(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<InvoiceLookupTargets> {
  const todayYmd = toKstYmd(now);
  // 저장 시각대가 어긋나도 빠지지 않게 하루 넉넉히 거른 뒤 KST 날짜로 다시 판정한다.
  const endFloor = new Date(`${addDaysToYmd(todayYmd, -(INVOICE_LOOKUP_DAYS_AFTER_END + 1))}T00:00:00.000Z`);
  const rows = await prisma.salesCampaign.findMany({
    where: { status: { in: [...SETTLEMENT_STAGE_STATUSES] }, endDate: { gte: endFloor } },
    select: { id: true, groupId: true, status: true, endDate: true },
  });
  const targets = rows.filter((row) =>
    isInvoiceLookupTarget({ status: row.status, endYmd: toKstYmd(row.endDate) }, todayYmd),
  );
  const groupIds = new Set(targets.map((row) => row.groupId).filter((id): id is string => id !== null));
  const campaignIds = new Set(targets.map((row) => row.id));
  const endYmds = targets.map((row) => toKstYmd(row.endDate));
  if (groupIds.size > 0) {
    // 멤버의 종료일도 창에 넣는다 — 먼저 끝난 멤버가 있으면 그 멤버의 종료 +10일부터 본다.
    const members = await prisma.salesCampaign.findMany({
      where: { groupId: { in: [...groupIds] } },
      select: { id: true, endDate: true },
    });
    for (const member of members) {
      campaignIds.add(member.id);
      endYmds.push(toKstYmd(member.endDate));
    }
  }
  return {
    campaignIds,
    groupIds,
    sinceDays: invoiceLookupSinceDays(endYmds, todayYmd, "auto"),
    includesUnit: (unitKey) => groupIds.has(unitKey) || campaignIds.has(unitKey),
  };
}
