import type {
  CampaignGroupDetailRow,
  CampaignGroupMemberRow,
  CampaignGroupRow,
  CampaignStatus,
  SalesChannel,
} from "./crm-types";
import { numberFromDecimal, toKstDateStr, type DecimalLike } from "./campaign-row";
import {
  isSettlementCounterparty,
  isSettlementInvoiceMode,
  type SettlementCounterparty,
  type SettlementInvoiceMode,
} from "./settlement-items";

/**
 * CG-1 CampaignGroup → 응답 행 매퍼.
 *
 * 요약 행(`toCampaignGroupRow`)은 suggest 후보·bulk-combo 응답의 `group`에,
 * 상세 행(`toCampaignGroupDetail`)은 GET/POST/PATCH `[id]` 응답에 쓴다.
 * 셀러 표기는 별칭 우선(alias || name, P2), 날짜는 캠페인 행과 동일 KST YYYY-MM-DD.
 * 정산/입금/계산서 필드는 CG-1에서 항상 null/false(생성 시 null 시작, 배선은 CG-2).
 */

/** 매퍼 입력 — 저장소 read 헬퍼(findByIdOrThrow/findById/findManyForSeller/findSuggestions)의 반환형 구조. */
type GroupWithMembers = {
  id: string;
  sellerId: string;
  name: string | null;
  startDate: Date | null;
  endDate: Date | null;
  expectedDepositDate: Date | null;
  depositReceivedAt: Date | null;
  isDepositReceived: boolean;
  expectedPayoutDate: Date | null;
  payoutCompletedAt: Date | null;
  isPayoutCompleted: boolean;
  expectedSupplierPayoutDate: Date | null;
  supplierPayoutCompletedAt: Date | null;
  isSupplierPayoutCompleted: boolean;
  supplierInvoiceIssuedAt: Date | null;
  sellerInvoiceIssuedAt: Date | null;
  accountingCompletedAt: Date | null;
  returnPeriodEndDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  seller: { name: string; alias: string | null };
  members: Array<{
    id: string;
    campaignName: string | null;
    status: string;
    startDate: Date;
    endDate: Date;
    roundNumber: number | null;
    salesChannel: string;
    actualSales: DecimalLike;
    sellerExpense: DecimalLike;
    deal: { dealName: string };
    settlementItems?: Array<{
      id: string;
      invoiceMode: string;
      counterparty: string;
      amount: DecimalLike;
      note: string | null;
      sortOrder: number;
    }>;
  }>;
};

export function toCampaignGroupRow(group: GroupWithMembers): CampaignGroupRow {
  return {
    id: group.id,
    sellerId: group.sellerId,
    sellerName: group.seller.alias || group.seller.name,
    name: group.name ?? null,
    startDate: toKstDateStr(group.startDate),
    endDate: toKstDateStr(group.endDate),
    memberCount: group.members.length,
    memberCampaignIds: group.members.map((m) => m.id),
    expectedDepositDate: toKstDateStr(group.expectedDepositDate),
    depositReceivedAt: toKstDateStr(group.depositReceivedAt),
    isDepositReceived: group.isDepositReceived,
    expectedPayoutDate: toKstDateStr(group.expectedPayoutDate),
    payoutCompletedAt: toKstDateStr(group.payoutCompletedAt),
    isPayoutCompleted: group.isPayoutCompleted,
    expectedSupplierPayoutDate: toKstDateStr(group.expectedSupplierPayoutDate),
    supplierPayoutCompletedAt: toKstDateStr(group.supplierPayoutCompletedAt),
    isSupplierPayoutCompleted: group.isSupplierPayoutCompleted,
    supplierInvoiceIssuedAt: toKstDateStr(group.supplierInvoiceIssuedAt),
    sellerInvoiceIssuedAt: toKstDateStr(group.sellerInvoiceIssuedAt),
    accountingCompletedAt: toKstDateStr(group.accountingCompletedAt),
    returnPeriodEndDate: toKstDateStr(group.returnPeriodEndDate),
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

export function toCampaignGroupDetail(group: GroupWithMembers): CampaignGroupDetailRow {
  const members: CampaignGroupMemberRow[] = group.members.map((m) => ({
    campaignId: m.id,
    dealName: m.deal.dealName,
    campaignName: m.campaignName ?? null,
    status: m.status as CampaignStatus,
    startDate: toKstDateStr(m.startDate)!,
    endDate: toKstDateStr(m.endDate)!,
    roundNumber: m.roundNumber ?? null,
    salesChannel: m.salesChannel as SalesChannel,
    actualSales: m.actualSales == null ? null : numberFromDecimal(m.actualSales),
    sellerExpense: m.sellerExpense == null ? null : numberFromDecimal(m.sellerExpense),
    // ⚠️ 알 수 없는 열거값은 여기서 버린다 — `campaign-row.ts` 의
    // `dropUnknownSettlementItems` 와 같은 규율이다(판정 SSOT 가 모르는 값이
    // 화면·금액 계산으로 흘러들면 조용히 0원 취급된다).
    settlementItems: (m.settlementItems ?? [])
      .filter(
        (item) => isSettlementInvoiceMode(item.invoiceMode) && isSettlementCounterparty(item.counterparty),
      )
      .map((item) => ({
        id: item.id,
        invoiceMode: item.invoiceMode as SettlementInvoiceMode,
        counterparty: item.counterparty as SettlementCounterparty,
        amount: numberFromDecimal(item.amount),
        note: item.note,
        sortOrder: item.sortOrder,
      })),
  }));

  return { ...toCampaignGroupRow(group), members };
}
