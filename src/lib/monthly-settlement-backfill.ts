/**
 * 기존 캠페인 → 월별 정산 줄 1개 이전 매핑(T-240) — 순수 함수, 서버 전용 소비.
 *
 * 언제 도는가: 배포 시 자동으로 돌지 않는다(명세 「사람 검수 없는 자동 실행 금지」). 오너가 거래처의
 * 월정산을 켜는 순간 `monthlySettlementService.setPartnerMonthlySettlement` 가 그 거래처
 * 캠페인 중 줄이 없는 것에 이 매핑으로 1줄씩 만든다.
 *
 * 무엇을 옮기나(명세 「기존 물품대금·계산서 수취 체크·수취일자·지급 정보를 그 줄로」):
 * - 귀속 월 = 종료일의 KST 월, 귀속 기간 = 캠페인 전체(오너가 나중에 달을 나눈다).
 * - 주문수량·거래액·수수료율·영업수익은 **값을 복사만** 한다 — 캠페인 값은 그대로다.
 * - 물품대금 = `settlementGoodsCost` 3-상태 그대로(null 은 null, 0 은 0). 그래서 이전 직후
 *   롤업(Σ 물품대금)이 원래 캠페인 값과 같다 — 검증 케이스 「물품대금 합계 유지」가 여기에 걸린다.
 * - 브랜드 측 계산서 날짜(`supplierInvoiceIssuedAt`, 그룹이면 그룹 값)는 채널의 방향이 정한
 *   칸으로 간다 — 발행(ISSUE)이면 매출 계산서, 수취(RECEIVE)면 매입 계산서. 방향 판정은
 *   `TAX_INVOICE_OBLIGATION_TABLE` 이 소유한다(⛔ 채널 분기를 여기서 다시 쓰지 말 것).
 * - 공급사 지급 일정·완료는 `resolveCampaignMoneySlots` 의 공급사 지급 슬롯 필드에서 읽는다
 *   (자사몰은 전용 supplierPayout 3종, 셀러몰은 payout 3종 — 슬롯 SSOT 가 고른다).
 * - 체크리스트는 대응 값이 있을 때만 체크한다(처리일 = 그 날짜). 지급 일정 확정은 기한이
 *   있으면 이전 시각으로 체크한다(언제 확정했는지 기록이 없다).
 * ⚠️ 승인번호는 옮기지 않는다 — 종전 `invoiceInfo.approvalNumber` 는 어느 계산서의 번호인지
 *   구분이 없어 매출/매입 중 어디로 갈지 판정할 수 없다(UI 도 그 값을 쓰지 않았다).
 */
import {
  TAX_INVOICE_OBLIGATION_TABLE,
  resolveCampaignMoneySlots,
  resolveTaxFilingChannelGroup,
} from "./tax-filing-board";
import { splitMonthlyCommission, toKstYearMonth } from "./monthly-settlement";

/** 이전에 필요한 캠페인 값 — 그룹 소속이면 그룹 스칼라를 이미 골라 넣은 상태로 받는다. */
export type MonthlyBackfillSource = {
  startDate: Date;
  endDate: Date;
  salesChannel: string;
  quantity: number | null;
  actualSales: number | null;
  totalMarginRate: number | null;
  settlementSales: number | null;
  settlementGoodsCost: number | null;
  supplierInvoiceIssuedAt: Date | null;
  // 대금 슬롯 필드 전부 — 슬롯 SSOT 가 고른 필드명으로 읽으므로 입금 3종도 모양에 둔다.
  expectedDepositDate: Date | null;
  depositReceivedAt: Date | null;
  isDepositReceived: boolean;
  expectedPayoutDate: Date | null;
  payoutCompletedAt: Date | null;
  isPayoutCompleted: boolean;
  expectedSupplierPayoutDate: Date | null;
  supplierPayoutCompletedAt: Date | null;
  isSupplierPayoutCompleted: boolean;
};

/** Prisma create 입력과 같은 모양(Decimal 열엔 number 를 넘긴다). */
export type MonthlyBackfillLine = {
  yearMonth: string;
  periodStart: Date;
  periodEnd: Date;
  quantity: number | null;
  transactionAmount: number | null;
  commissionRate: number | null;
  commissionAmount: number | null;
  supplyAmount: number | null;
  vat: number | null;
  salesInvoiceIssuedAt: Date | null;
  purchaseInvoiceReceivedAt: Date | null;
  goodsAmount: number | null;
  paymentAmount: number | null;
  paymentDueDate: Date | null;
  paymentPaidAt: Date | null;
  salesInvoiceCheckedAt: Date | null;
  purchaseInvoiceCheckedAt: Date | null;
  paymentScheduleCheckedAt: Date | null;
  paymentCompletedCheckedAt: Date | null;
};

function resolveSupplierPayout(source: MonthlyBackfillSource): {
  dueDate: Date | null;
  paidAt: Date | null;
} {
  const slot = resolveCampaignMoneySlots(source.salesChannel).find(
    (s) => s.kind === "PAYOUT" && s.counterpart === "SUPPLIER",
  );
  if (!slot) return { dueDate: null, paidAt: null };
  const dueDate = source[slot.expectedField];
  const isCompleted = source[slot.flagField];
  // 완료 플래그가 정본이다 — 완료일만 남고 플래그가 꺼진 행은 「지급 안 됨」으로 읽는다.
  const paidAt = isCompleted ? (source[slot.completedAtField] ?? null) : null;
  return { dueDate: dueDate ?? null, paidAt };
}

export function buildMonthlyBackfillLine(
  source: MonthlyBackfillSource,
  now: Date,
): MonthlyBackfillLine {
  const brandObligation =
    TAX_INVOICE_OBLIGATION_TABLE[resolveTaxFilingChannelGroup(source.salesChannel)]
      .supplierInvoiceIssuedAt;
  const brandInvoiceDate = source.supplierInvoiceIssuedAt;
  const salesInvoiceIssuedAt = brandObligation?.direction === "ISSUE" ? brandInvoiceDate : null;
  const purchaseInvoiceReceivedAt =
    brandObligation?.direction === "RECEIVE" ? brandInvoiceDate : null;
  const { dueDate, paidAt } = resolveSupplierPayout(source);
  const { supplyAmount, vat } = splitMonthlyCommission(source.settlementSales);

  return {
    yearMonth: toKstYearMonth(source.endDate),
    periodStart: source.startDate,
    periodEnd: source.endDate,
    quantity: source.quantity,
    transactionAmount: source.actualSales,
    commissionRate: source.totalMarginRate,
    commissionAmount: source.settlementSales,
    supplyAmount,
    vat,
    salesInvoiceIssuedAt,
    purchaseInvoiceReceivedAt,
    goodsAmount: source.settlementGoodsCost,
    // 지급액은 비워 둔다 — 비면 물품대금을 지급액으로 본다(resolveMonthlyPaymentAmount).
    // 복사해 두면 물품대금을 고쳐도 지급액이 옛 값에 남는다.
    paymentAmount: null,
    paymentDueDate: dueDate,
    paymentPaidAt: paidAt,
    salesInvoiceCheckedAt: salesInvoiceIssuedAt,
    purchaseInvoiceCheckedAt: purchaseInvoiceReceivedAt,
    paymentScheduleCheckedAt: dueDate ? now : null,
    paymentCompletedCheckedAt: paidAt,
  };
}

