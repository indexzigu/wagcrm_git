import type { CampaignRow, CampaignStatus, SalesChannel, SnsType } from "./crm-types";
import { toKstYmd } from "./date-utils";
import { summarizeChecklist, type CampaignChecklistItemRow } from "./campaign-checklist";
import { decryptOrNull } from "./encryption";
import { getDisplayDealName } from "./deal-display";
import type { CampaignViolationSummary } from "./price-monitor/campaign-price-violation";
import {
  isSettlementCounterparty,
  isSettlementInvoiceMode,
  type SettlementCounterparty,
  type SettlementInvoiceMode,
} from "./settlement-items";

export type DecimalLike = number | string | { toString(): string } | null | undefined;

/** KST 달력 날짜 — 표기 자체는 `date-utils.toKstYmd`(client-safe SSOT)가 소유하고, 여기선 null·NaN 처리만 얹는다. */
export function toKstDateStr(date: Date | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return toKstYmd(d);
}

/**
 * Uses the linked Deal value when an old CampaignDeal snapshot is empty.
 */
function resolveSnapshotNumber(
  value: DecimalLike,
  fallback: DecimalLike,
): number | null {
  const fallbackNumber = fallback == null ? null : numberFromDecimal(fallback);
  if (value == null) return fallbackNumber;

  const valueNumber = numberFromDecimal(value);
  if (valueNumber === 0 && fallbackNumber != null && fallbackNumber > 0) {
    return fallbackNumber;
  }
  return valueNumber;
}

type CampaignWithRelations = {
  id: string;
  dealId: string;
  sellerId: string;
  groupId?: string | null;
  group?: {
    _count?: { members: number };
    expectedDepositDate?: Date | null;
    depositReceivedAt?: Date | null;
    isDepositReceived?: boolean;
    expectedPayoutDate?: Date | null;
    payoutCompletedAt?: Date | null;
    isPayoutCompleted?: boolean;
    expectedSupplierPayoutDate?: Date | null;
    supplierPayoutCompletedAt?: Date | null;
    isSupplierPayoutCompleted?: boolean;
    supplierInvoiceIssuedAt?: Date | null;
    sellerInvoiceIssuedAt?: Date | null;
    accountingCompletedAt?: Date | null;
    invoiceInfo?: string | null;
  } | null;
  campaignName?: string | null;
  salesCode?: string | null;
  updatedAt: Date;
  startDate: Date;
  endDate: Date;
  salesChannel: string;
  /**
   * optional 인 이유: 이 입력 타입은 여러 쿼리가 공유하고, `select` 로 필드를 고른
   * 호출부는 이 값을 안 실을 수 있다. 미포함 시 `isOrderRegistered: false` 로 떨어져
   * "미등록"으로 보이는데, 그 오판이 만드는 건 **없어도 될 배지 하나**뿐이라 안전
   * 실패다(반대로 true 로 폴백하면 진짜 할 일이 조용히 사라진다).
   */
  orderCampaignId?: string | null;
  baseNaverLink: string;
  generatedTrackingLink: string;
  actualSales: DecimalLike;
  sellerExpense?: DecimalLike;
  operatingExpense?: DecimalLike;
  operatingProfit?: DecimalLike;
  settlementSales?: DecimalLike;
  quantity?: number | null;
  itemCount?: number | null;
  totalMarginRate: DecimalLike;
  sellerMarginRate: DecimalLike;
  netMarginRate: DecimalLike;
  status: string;
  isManualMargin: boolean;
  isManualSettlementSales?: boolean | null;
  isManualSellerExpense?: boolean | null;
  isManualTaxExpense?: boolean | null;
  sellerTaxType?: string | null;
  commissionBasis?: string | null;
  isDepositReceived?: boolean;
  isPayoutCompleted?: boolean;
  depositReceivedAt?: Date | null;
  payoutCompletedAt?: Date | null;
  returnPeriodEndDate?: Date | null;
  settlementSupplyCost?: DecimalLike | null;
  settlementGoodsCost?: DecimalLike | null;
  settlementItems?: Array<{
    id: string;
    invoiceMode: string;
    counterparty: string;
    amount: DecimalLike;
    note: string | null;
    sortOrder: number;
  }>;
  supplierInvoiceIssuedAt?: Date | null;
  sellerInvoiceIssuedAt?: Date | null;
  expectedDepositDate?: Date | null;
  expectedPayoutDate?: Date | null;
  expectedSupplierPayoutDate?: Date | null;
  supplierPayoutCompletedAt?: Date | null;
  isSupplierPayoutCompleted?: boolean;
  accountingCompletedAt?: Date | null;
  actualPayoutAmount?: DecimalLike;
  taxExpense?: DecimalLike;
  miscExpense?: DecimalLike;
  roundNumber?: number | null;
  assignedTo?: string | null;
  nextAction?: string | null;
  rawSchedule?: string | null;
  sourceCreatedAt?: Date | null;
  notesFromImport?: string | null;
  deal: {
    dealName: string;
    unit?: string | null;
    unitQuantity?: number | null;
    supplementaryInfo?: string | null;
    costPrice: DecimalLike;
    sellingPrice: DecimalLike;
    brandName?: string | null;
    // 세금계산서 공급받는자가 공급사인 행(브랜드몰 발행·우리몰 수취)을 지원하려면
    // name 문자열만으로는 부족하다 — 사업자등록번호·대표자명 등이 필요하다(2026-08-04,
    // tax-invoice-builder 공급사 상대 지원). 호출부는 이미 전량 `partner: true` 로
    // 조회하므로(route.ts) 쿼리 변경 없이 타입만 넓힌다.
    partner: {
      // 정산 화면의 공급사 탭이 계좌번호를 그 자리에서 수정(거래처 PATCH)하려면
      // 대상 거래처 id 가 필요하다(2026-08-27). bankAccount 는 구글 캘린더 대금
      // 이벤트가 이미 별도 쿼리로 읽던 값을 캠페인 DTO 로도 노출하는 것이다.
      // ⚠️ 전 호출부가 `partner: true` 인 것은 아니다 — `cached-crm-data.ts` 의
      // 모바일 투데이 쿼리는 `partner: { select: { name } }` 로 좁혀 이 두 필드가
      // null 로 떨어진다(그 경로는 공급사 탭을 열지 않으므로 현재 무해). 새 화면이
      // 이 필드를 소비하면 자기 쿼리의 partner select 부터 확인할 것.
      id?: string;
      name: string;
      businessNumber?: string | null;
      ceoName?: string | null;
      address?: string | null;
      businessType?: string | null;
      businessItem?: string | null;
      representativeEmail?: string | null;
      bankAccount?: string | null;
    } | null;
  };
  seller: {
    name: string;
    alias?: string | null;
    realName?: string | null;
    snsType: string;
    snsHandle: string;
    fitLevel?: string | null;
    currentFollowers?: number;
    category?: string | null;
    accountNumber?: string | null;
    residentNumber?: string | null;
    _count?: {
      campaigns: number;
    };
    agency?: {
      name: string;
      type: string;
      businessNumber?: string | null;
      companyStatus?: string | null;
      companyRole?: string | null;
      ceoName?: string | null;
      address?: string | null;
      bankAccount?: string | null;
      businessType?: string | null;
      businessItem?: string | null;
      representativeEmail?: string | null;
      contacts?: Array<{
        email?: string | null;
      }>;
    } | null;
    histories?: Array<{
      snapshotDate: Date;
      followersCount: number;
    }>;
  };
  activities?: Array<{
    id: string;
    action: string;
    label: string;
    details: string | null;
    actor: string;
    createdAt: Date;
  }>;
  notes?: Array<{
    id: string;
    content: string;
    actor: string;
    actorName: string | null;
    createdAt: Date;
  }>;
  checklistItems?: CampaignChecklistItemRow[];
  campaignDeals?: Array<{
    id: string;
    campaignId: string;
    dealId: string;
    quantity: number;
    actualSales: DecimalLike;
    feeRate: DecimalLike;
    sellerMarginRate: DecimalLike;
    costPrice: DecimalLike;
    sellingPrice: DecimalLike;
    deal: {
      dealName: string;
      parentId?: string | null;
      unit?: string | null;
      unitQuantity?: number | null;
      supplementaryInfo?: string | null;
      costPrice?: DecimalLike;
      sellingPrice?: DecimalLike;
      totalCommissionRate?: DecimalLike;
      brokerageCommissionRate?: DecimalLike;
    };
  }>;
};

/**
 * 판정 SSOT 가 모르는 방식·대상 조합을 가진 부가 항목을 걸러낸다.
 *
 * 왜 통과시키지 않는가: 조합을 모르면 부호도 구간도 정할 수 없어 화면이 **엉뚱한
 * 자리에 엉뚱한 부호로** 그린다. 지우는 쪽이 덜 위험하다.
 *
 * ⚠️ 다만 **조용히 지우지는 않는다**(P0 No Silent Failure). 지워진 행의 금액은
 * 구간 합계·조정 후 손익·명세서 합계에서 그만큼 빠지는데, 아무 신호가 없으면
 * "금액이 왜 다르지"를 추적할 단서가 없다. 현재 쓰기 경로(zod enum + 서비스
 * 정규화)로는 잘못된 값이 들어올 수 없어 이 경고는 평소 발화하지 않는다 —
 * 발화한다면 새 enum 값을 쓴 배포와 구버전이 겹쳤거나 수기 SQL 보정이 있었다는 뜻이다.
 */
function dropUnknownSettlementItems(
  items: CampaignWithRelations["settlementItems"],
  campaignId: string,
): Array<
  NonNullable<CampaignWithRelations["settlementItems"]>[number] & {
    invoiceMode: SettlementInvoiceMode;
    counterparty: SettlementCounterparty;
  }
> {
  const all = items ?? [];
  const kept = all.filter(
    (item): item is (typeof all)[number] & {
      invoiceMode: SettlementInvoiceMode;
      counterparty: SettlementCounterparty;
    } => isSettlementInvoiceMode(item.invoiceMode) && isSettlementCounterparty(item.counterparty),
  );

  if (kept.length !== all.length) {
    // 캠페인 id 만 남긴다 — 비고에는 거래처·비용 내역이 들어갈 수 있다(레포 public).
    console.warn(
      `[settlement-items] 알 수 없는 방식·대상 조합 ${all.length - kept.length}건을 제외했습니다(campaignId=${campaignId}). 구간 합계가 그만큼 줄어듭니다.`,
    );
  }
  return kept;
}

export function numberFromDecimal(value: DecimalLike): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return Number(value.toString());
}

export function toCampaignRow(
  campaign: CampaignWithRelations,
  violationSummaryByCampaignId?: Map<string, CampaignViolationSummary>,
): CampaignRow {
  const violationSummary = violationSummaryByCampaignId?.get(campaign.id);
  const group = campaign.group;

  return {
    id: campaign.id,
    dealId: campaign.dealId,
    sellerId: campaign.sellerId,
    groupId: campaign.groupId ?? null,
    groupMemberCount: campaign.group?._count?.members,
    campaignName: campaign.campaignName ?? null,
    salesCode: campaign.salesCode ?? null,
    dealName: campaign.deal.dealName,
    partnerName: campaign.deal.partner?.name ?? "거래처 없음",
    partnerId: campaign.deal.partner?.id ?? null,
    partnerBankAccount: campaign.deal.partner?.bankAccount ?? null,
    partnerBusinessNumber: campaign.deal.partner?.businessNumber ?? null,
    partnerCeoName: campaign.deal.partner?.ceoName ?? null,
    partnerAddress: campaign.deal.partner?.address ?? null,
    partnerBusinessType: campaign.deal.partner?.businessType ?? null,
    partnerBusinessItem: campaign.deal.partner?.businessItem ?? null,
    partnerEmail: campaign.deal.partner?.representativeEmail ?? null,
    sellerName: campaign.seller.alias || campaign.seller.name,
    // 법적 실명 — 원천징수 신고 등 법적 서류는 실명이 요건이라 별도로 싣는다.
    // ⛔ `name` 으로 폴백하지 않는다: `name` 에는 실무상 활동명(SNS 계정명)이 들어가 있어
    // 폴백하면 활동명이 실명처럼 신고서에 실린다(2026-08-04 오너 지적). 미입력은 미입력으로
    // 드러내고 `buildWithholdingReport` 가 경고한다.
    sellerRealName: campaign.seller.realName ?? null,
    sellerCompanyName: campaign.seller.agency?.name ?? null,
    sellerCompanyType: campaign.seller.agency?.type ?? null,
    sellerCompanyBusinessNumber: campaign.seller.agency?.businessNumber ?? null,
    sellerCompanyStatus: campaign.seller.agency?.companyStatus ?? null,
    sellerCompanyRole: campaign.seller.agency?.companyRole ?? null,
    sellerCompanyCeoName: campaign.seller.agency?.ceoName ?? null,
    sellerCompanyAddress: campaign.seller.agency?.address ?? null,
    sellerCompanyBankAccount: campaign.seller.agency?.bankAccount ?? null,
    sellerCompanyBusinessType: campaign.seller.agency?.businessType ?? null,
    sellerCompanyBusinessItem: campaign.seller.agency?.businessItem ?? null,
    sellerCompanyEmail:
      campaign.seller.agency?.representativeEmail ??
      campaign.seller.agency?.contacts?.[0]?.email ??
      null,
    // 여러 행을 한꺼번에 읽는 경로다(프리렌더도 여기를 탄다) — 한 행이 안 열린다고
    // 페이지·빌드를 통째로 죽이지 않는다. 실패는 경고로 남고 값은 null 이 된다.
    sellerResidentNumber: decryptOrNull(campaign.seller.residentNumber),
    sellerPersonalBankAccount: campaign.seller.accountNumber ?? null,
    snsType: campaign.seller.snsType as SnsType,
    snsHandle: campaign.seller.snsHandle,
    fitLevel: campaign.seller.fitLevel ?? null,
    currentFollowers: campaign.seller.currentFollowers ?? null,
    campaignCount: campaign.seller._count?.campaigns ?? 0,
    category: campaign.seller.category ?? null,
    startDate: toKstDateStr(campaign.startDate)!,
    endDate: toKstDateStr(campaign.endDate)!,
    salesChannel: campaign.salesChannel as SalesChannel,
    isOrderRegistered: campaign.orderCampaignId != null,
    baseNaverLink: campaign.baseNaverLink,
    generatedTrackingLink: campaign.generatedTrackingLink,
    actualSales:
      campaign.actualSales == null ? null : numberFromDecimal(campaign.actualSales),
    sellerExpense:
      campaign.sellerExpense == null ? null : numberFromDecimal(campaign.sellerExpense),
    operatingExpense:
      campaign.operatingExpense == null ? null : numberFromDecimal(campaign.operatingExpense),
    operatingProfit:
      campaign.operatingProfit == null ? null : numberFromDecimal(campaign.operatingProfit),
    settlementSales:
      campaign.settlementSales == null ? null : numberFromDecimal(campaign.settlementSales),
    quantity: campaign.quantity ?? null,
    itemCount: campaign.itemCount ?? null,
    totalMarginRate: numberFromDecimal(campaign.totalMarginRate),
    sellerMarginRate: numberFromDecimal(campaign.sellerMarginRate),
    netMarginRate: numberFromDecimal(campaign.netMarginRate),
    status: campaign.status as CampaignStatus,
    isManualMargin: campaign.isManualMargin,
    isManualSettlementSales: campaign.isManualSettlementSales ?? false,
    isManualSellerExpense: campaign.isManualSellerExpense ?? false,
    isManualTaxExpense: campaign.isManualTaxExpense ?? false,
    sellerTaxType: campaign.sellerTaxType ?? null,
    commissionBasis: campaign.commissionBasis ?? null,
    isDepositReceived: group?.isDepositReceived ?? campaign.isDepositReceived ?? false,
    isPayoutCompleted: group?.isPayoutCompleted ?? campaign.isPayoutCompleted ?? false,
    isSupplierPayoutCompleted: group?.isSupplierPayoutCompleted ?? campaign.isSupplierPayoutCompleted ?? false,
    depositReceivedAt: toKstDateStr(group?.depositReceivedAt === undefined ? campaign.depositReceivedAt : group.depositReceivedAt),
    payoutCompletedAt: toKstDateStr(group?.payoutCompletedAt === undefined ? campaign.payoutCompletedAt : group.payoutCompletedAt),
    supplierPayoutCompletedAt: toKstDateStr(group?.supplierPayoutCompletedAt === undefined ? campaign.supplierPayoutCompletedAt : group.supplierPayoutCompletedAt),
    returnPeriodEndDate: toKstDateStr(campaign.returnPeriodEndDate),
    settlementSupplyCost: campaign.settlementSupplyCost == null ? null : numberFromDecimal(campaign.settlementSupplyCost),
    settlementGoodsCost: campaign.settlementGoodsCost == null ? null : numberFromDecimal(campaign.settlementGoodsCost),
    // 부가 항목은 **그룹 폴딩 대상이 아니다** — 정산일 계열(위 group?.x ?? campaign.x)과
    // 달리 그룹 공유 필드가 아니라 멤버 각자의 비용이다. 광고비·반품배송비는 멤버(딜)마다
    // 다르고, 그룹 값으로 덮으면 한 건이 멤버 수만큼 부풀어 지급·손익이 틀어진다.
    // 저장 쪽도 같은 이유로 팬아웃하지 않는다(`campaignService` 의 settlementItems 주석).
    settlementItems: dropUnknownSettlementItems(campaign.settlementItems, campaign.id)
      .map((item) => ({
        id: item.id,
        invoiceMode: item.invoiceMode,
        counterparty: item.counterparty,
        amount: numberFromDecimal(item.amount),
        note: item.note,
        sortOrder: item.sortOrder,
      })),
    supplierInvoiceIssuedAt: toKstDateStr(group?.supplierInvoiceIssuedAt === undefined ? campaign.supplierInvoiceIssuedAt : group.supplierInvoiceIssuedAt),
    sellerInvoiceIssuedAt: toKstDateStr(group?.sellerInvoiceIssuedAt === undefined ? campaign.sellerInvoiceIssuedAt : group.sellerInvoiceIssuedAt),
    expectedDepositDate: toKstDateStr(group?.expectedDepositDate === undefined ? campaign.expectedDepositDate : group.expectedDepositDate),
    expectedPayoutDate: toKstDateStr(group?.expectedPayoutDate === undefined ? campaign.expectedPayoutDate : group.expectedPayoutDate),
    expectedSupplierPayoutDate: toKstDateStr(group?.expectedSupplierPayoutDate === undefined ? campaign.expectedSupplierPayoutDate : group.expectedSupplierPayoutDate),
    accountingCompletedAt: toKstDateStr(group?.accountingCompletedAt === undefined ? campaign.accountingCompletedAt : group.accountingCompletedAt),
    sourceCreatedAt: toKstDateStr(campaign.sourceCreatedAt),
    actualPayoutAmount: campaign.actualPayoutAmount == null ? null : numberFromDecimal(campaign.actualPayoutAmount),
    taxExpense: campaign.taxExpense == null ? null : numberFromDecimal(campaign.taxExpense),
    miscExpense: campaign.miscExpense == null ? null : numberFromDecimal(campaign.miscExpense),
    roundNumber: campaign.roundNumber ?? null,
    assignedTo: campaign.assignedTo ?? null,
    nextAction: campaign.nextAction ?? null,
    checklistSummary: summarizeChecklist(
      campaign.checklistItems,
      campaign.status as CampaignStatus,
    ),
    rawSchedule: campaign.rawSchedule ?? null,
    notesFromImport: group?.invoiceInfo === undefined ? campaign.notesFromImport ?? null : group.invoiceInfo,
    updatedAt: campaign.updatedAt.toISOString(),
    deal: {
      costPrice: numberFromDecimal(campaign.deal.costPrice),
      sellingPrice: numberFromDecimal(campaign.deal.sellingPrice),
      brandName: campaign.deal.brandName ?? null,
      status: (campaign.deal as any).status ?? null,
    },
    followerHistory:
      campaign.seller.histories?.map((history) => ({
        date: history.snapshotDate.toISOString().slice(5, 10),
        followers: history.followersCount,
      })) ?? [],
    activityHistory:
      campaign.activities?.map((act) => ({
        id: act.id,
        action: act.action,
        label: act.label,
        details: act.details,
        actor: act.actor,
        createdAt: act.createdAt.toISOString(),
      })) ?? [],
    notes:
      campaign.notes?.map((note) => ({
        id: note.id,
        content: note.content,
        actor: note.actor,
        actorName: note.actorName,
        createdAt: note.createdAt.toISOString(),
      })) ?? [],
    campaignDeals:
      campaign.campaignDeals?.map((cd) => {
        const fallbackFeeRate =
          cd.deal.totalCommissionRate ?? cd.deal.brokerageCommissionRate ?? null;

        return {
          id: cd.id,
          campaignId: cd.campaignId,
          dealId: cd.dealId,
          dealName: getDisplayDealName(cd.deal),
          quantity: cd.quantity,
          actualSales: numberFromDecimal(cd.actualSales),
          feeRate: resolveSnapshotNumber(cd.feeRate, fallbackFeeRate),
          sellerMarginRate: cd.sellerMarginRate == null ? null : numberFromDecimal(cd.sellerMarginRate),
          costPrice: resolveSnapshotNumber(cd.costPrice, cd.deal.costPrice),
          sellingPrice: resolveSnapshotNumber(cd.sellingPrice, cd.deal.sellingPrice),
        };
      }) ?? [],
    hasPriceViolation: violationSummary != null,
    violatedDealCount: violationSummary?.violatedDealCount ?? 0,
  };
}
