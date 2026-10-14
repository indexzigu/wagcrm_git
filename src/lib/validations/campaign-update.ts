import { z } from "zod";
import { financialExpectationSchema } from "@/lib/campaign-financial-guard";
import { SETTLEMENT_COUNTERPARTIES, SETTLEMENT_INVOICE_MODES } from "@/lib/settlement-items";

/**
 * `PATCH /api/campaigns/[id]` 의 요청 스키마 — 라우트에서 옮겨 왔다(내용 그대로).
 *
 * 화면 저장과 에이전트 `update_record` 기안이 **같은 스키마**로 값을 거르도록 라우트 밖에 둔다
 * (Next 라우트 파일은 HTTP 메서드 외의 이름을 내보낼 수 없다). ⛔ 에이전트 쪽에 칸 목록을 따로
 * 만들지 말 것 — 화면에서 고칠 수 있는 칸이 곧 기안할 수 있는 칸이다.
 */
export const updateCampaignSchema = z.object({
  status: z
    .enum([
      "PROPOSAL",
      "PREPARATION",
      "ACTIVE",
      "CLOSED",
      "SETTLEMENT_WAIT",
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
      "DROPPED",
    ])
    .optional(),
  salesChannel: z.enum(["UNSPECIFIED", "OWN_MALL", "OWN_MALL_NAVER", "OWN_MALL_KAKAO", "SELLER_MALL", "BRAND_MALL"]).optional(),
  actualSales: z.coerce.number().nonnegative().nullable().optional(),
  operatingExpense: z.coerce.number().min(-999_999_999).max(999_999_999).nullable().optional(),
  miscExpense: z.coerce.number().min(-999_999_999).max(999_999_999).nullable().optional(),
  quantity: z.coerce.number().int().nonnegative().max(999_999).nullable().optional(),
  itemCount: z.coerce.number().int().nonnegative().max(999_999).nullable().optional(),
  totalMarginRate: z.coerce.number().nonnegative().optional(),
  sellerMarginRate: z.coerce.number().nonnegative().optional(),
  netMarginRate: z.coerce.number().optional(),
  isManualMargin: z.boolean().optional(),
  isManualSettlementSales: z.boolean().optional(),
  isManualSellerExpense: z.boolean().optional(),
  isManualTaxExpense: z.boolean().optional(),
  settlementSales: z.coerce.number().nonnegative().nullable().optional(),
  sellerExpense: z.coerce.number().nonnegative().nullable().optional(),
  taxExpense: z.coerce.number().nonnegative().nullable().optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  isDepositReceived: z.boolean().optional(),
  depositReceivedAt: z.string().date().nullable().optional(),
  isPayoutCompleted: z.boolean().optional(),
  payoutCompletedAt: z.string().date().nullable().optional(),
  // 자사몰 공급사 지급 레그 — 슬롯 SSOT: resolveCampaignMoneySlots(tax-filing-board.ts)
  isSupplierPayoutCompleted: z.boolean().optional(),
  supplierPayoutCompletedAt: z.string().date().nullable().optional(),
  returnPeriodEndDate: z.string().date().nullable().optional(),
  settlementSupplyCost: z.coerce.number().nonnegative().nullable().optional(),
  // 수기 물품대금(세무 대조 전용) — 0 은 「타 캠페인 계산서에 합산됨」 마커라 유효값이다.
  settlementGoodsCost: z.coerce.number().nonnegative().nullable().optional(),
  // 수동 정산 기준액 — null = 자동으로 되돌림, 0 이상 숫자 = 수동(0 은 「전량 자체 판매」라 유효값).
  sellerFeeBasisOverride: z.coerce.number().nonnegative().nullable().optional(),
  /**
   * 정산 부가 항목 — **전체 교체**(보낸 배열이 곧 최종 상태, 생략하면 무변경).
   * 행이 몇 개 안 되는 목록이라 부분 패치보다 교체가 단순하고, 편집 모드가 통째로
   * 저장하는 화면 흐름과도 맞는다.
   *
   * ⛔ `amount` 는 **부호 있는 값**이라 `nonnegative()` 를 걸지 않는다 — 음수는
   * 역방향 정정(수정세금계산서·반품 조정 차감)이고 자사 항목에선 지출을 뜻한다
   * (설계 §2-2, `resolveSettlementItemSignedAmount`).
   */
  settlementItems: z
    .array(
      z.object({
        invoiceMode: z.enum(SETTLEMENT_INVOICE_MODES),
        counterparty: z.enum(SETTLEMENT_COUNTERPARTIES),
        amount: z.coerce.number().min(-999_999_999).max(999_999_999),
        note: z.string().trim().max(200).nullable().optional(),
      }),
    )
    .max(50)
    .optional(),
  supplierInvoiceIssuedAt: z.string().date().nullable().optional(),
  sellerInvoiceIssuedAt: z.string().date().nullable().optional(),
  expectedDepositDate: z.string().date().nullable().optional(),
  expectedPayoutDate: z.string().date().nullable().optional(),
  expectedSupplierPayoutDate: z.string().date().nullable().optional(),
  accountingCompletedAt: z.string().date().nullable().optional(),
  invoiceInfo: z.string().max(1000).nullable().optional(),
  roundNumber: z.coerce.number().int().nonnegative().nullable().optional(),
  campaignName: z.string().max(100).nullable().optional(),
  dealId: z.string().optional(),
  sellerId: z.string().optional(),
  baseNaverLink: z.string().optional(),
  assignedTo: z.string().optional(),
  handoffMemo: z.string().optional(),
  dropReason: z.string().trim().max(500).optional(),
  notesFromImport: z.string().max(1000).nullable().optional(),
  sellerTaxType: z.string().nullable().optional(),
  salesTask: z
    .object({
      contactChannel: z.string().nullable().optional(),
      proposalMessage: z.string().nullable().optional(),
      negotiationMemo: z.string().nullable().optional(),
      testingMemo: z.string().nullable().optional(),
    })
    .optional(),
  campaignDeals: z.array(z.object({
    id: z.string().optional(),
    dealId: z.string(),
    quantity: z.coerce.number().int().nonnegative(),
    actualSales: z.coerce.number().nonnegative(),
    feeRate: z.coerce.number().nonnegative().nullable().optional(),
    sellerMarginRate: z.coerce.number().nonnegative().nullable().optional(),
    costPrice: z.coerce.number().nonnegative().nullable().optional(),
    sellingPrice: z.coerce.number().nonnegative().nullable().optional(),
  })).optional(),
  /**
   * 낙관적 동시성 — 화면이 본 재무 필드·부가 항목·품목의 이전 값(`campaign-financial-guard.ts`).
   * 저장 필드가 아니라 **조건**이다: 아래에서 `data` 와 분리해 서비스에만 넘긴다.
   */
  expectedFinancials: financialExpectationSchema.optional(),
});

export type UpdateCampaignRequest = z.infer<typeof updateCampaignSchema>;
