import type { Prisma } from "@prisma/client";
import {
  calculateDerivedCampaignFinancials,
  computeOperatingProfit,
  resolveSellerFee,
  resolveSellerFeeBasisEligibility,
  type DerivedCampaignFinancials,
} from "@/lib/campaign-financials";
import {
  isIndividualSeller,
  getSellerPayoutBase,
  calcIndividualIncomeTax,
} from "@/lib/seller-tax-utils";
import type { DecimalLike } from "@/lib/campaign-row";

/** PATCH 요청 본문 중 파생 계산이 읽는 칸(미지정 = 이전 값 유지). */
export type FinancialDerivationData = {
  actualSales?: number | null;
  operatingExpense?: number | null;
  miscExpense?: number | null;
  totalMarginRate?: number;
  sellerMarginRate?: number;
  isManualSettlementSales?: boolean;
  isManualSellerExpense?: boolean;
  isManualTaxExpense?: boolean;
  settlementSales?: number | null;
  sellerExpense?: number | null;
  taxExpense?: number | null;
  sellerTaxType?: string | null;
  sellerFeeBasisOverride?: number | null;
  campaignDeals?: DerivationDealRow[];
};

/** 품목 한 줄 — 요청 본문의 품목(숫자)과 DB 행(Decimal)을 같은 모양으로 받는다. */
export type DerivationDealRow = {
  actualSales: DecimalLike;
  feeRate?: DecimalLike;
  sellerMarginRate?: DecimalLike;
};

/** 수정 **이전** 캠페인 행 중 파생 계산이 읽는 칸. */
export type FinancialDerivationPrevious = {
  actualSales: DecimalLike;
  operatingExpense: DecimalLike;
  miscExpense: DecimalLike;
  totalMarginRate: DecimalLike;
  sellerMarginRate: DecimalLike;
  isManualSettlementSales: boolean;
  isManualSellerExpense: boolean;
  isManualTaxExpense: boolean;
  settlementSales: DecimalLike;
  sellerExpense: DecimalLike;
  taxExpense: DecimalLike;
  sellerTaxType: string | null;
  sellerFeeBasisOverride?: DecimalLike;
  seller: { agency: { businessNumber: string | null } | null } | null;
};

export type FinancialDerivationResult = {
  /** 실매출이 비어 있으면(`null`) 빈 객체 — 파생을 계산할 근거가 없어 아무 칸도 덮지 않는다. */
  derivedFinancials: DerivedCampaignFinancials | Record<string, never>;
  nextNetMarginRate: number;
};

/**
 * 캠페인 재무 **파생값** 계산 — 캠페인 PATCH 트랜잭션 본체(`campaignService.updateCampaign`)와
 * 에이전트 WRITE 액션 `update_settlement_amount` 가 **같은 함수**를 부른다.
 *
 * ⛔ 이 산식을 호출부에서 다시 쓰지 말 것. 영업이익(`operatingProfit`)은 저장 컬럼이라
 * 금액 칸 하나를 고친 경로가 파생을 따로 계산하면, 같은 캠페인이 어느 화면에서 고쳤느냐에
 * 따라 다른 손익을 갖게 된다. 그래서 PATCH 본체에 인라인으로 있던 블록을 동작 변화 없이
 * 그대로 옮겼다(줄 단위 이관 — 품목별 차등 수수료율 보정 루프 포함).
 *
 * ⚠️ 쓰기는 하지 않는다 — 품목(`campaignDeal`)을 읽기만 하고, 결과를 호출부가 자기 update 에
 * 펼친다. tx 를 받는 이유는 그 읽기가 호출부 트랜잭션의 스냅샷을 보게 하려는 것이다.
 */
export async function deriveCampaignFinancialsForUpdate(
  tx: Prisma.TransactionClient,
  input: { id: string; data: FinancialDerivationData; previous: FinancialDerivationPrevious },
): Promise<FinancialDerivationResult> {
  const { id, data, previous } = input;
  const nextActualSales =
    data.actualSales !== undefined
      ? data.actualSales
      : previous.actualSales == null
        ? null
        : Number(previous.actualSales.toString());
  const nextOperatingExpense =
    data.operatingExpense !== undefined
      ? Number(data.operatingExpense ?? 0)
      : Number(previous.operatingExpense?.toString() ?? 0);
  const nextMiscExpense = Number(previous.miscExpense?.toString() ?? 0);
  const resolvedMiscExpense =
    data.miscExpense !== undefined ? Number(data.miscExpense ?? 0) : nextMiscExpense;
  const nextTotalMarginRate =
    data.totalMarginRate !== undefined
      ? data.totalMarginRate
      : Number(previous.totalMarginRate?.toString() ?? 0);
  const nextSellerMarginRate =
    data.sellerMarginRate !== undefined
      ? data.sellerMarginRate
      : Number(previous.sellerMarginRate?.toString() ?? 0);
  const nextNetMarginRate = Number((nextTotalMarginRate - nextSellerMarginRate).toFixed(2));

  const nextIsManualSettlementSales =
    data.isManualSettlementSales !== undefined
      ? data.isManualSettlementSales
      : previous.isManualSettlementSales;
  const nextIsManualSellerExpense =
    data.isManualSellerExpense !== undefined
      ? data.isManualSellerExpense
      : previous.isManualSellerExpense;
  const nextIsManualTaxExpense =
    data.isManualTaxExpense !== undefined
      ? data.isManualTaxExpense
      : previous.isManualTaxExpense;

  const nextSettlementSales =
    data.settlementSales !== undefined
      ? (data.settlementSales != null ? Number(data.settlementSales) : null)
      : (previous.settlementSales != null ? Number(previous.settlementSales.toString()) : null);
  const nextSellerExpense =
    data.sellerExpense !== undefined
      ? (data.sellerExpense != null ? Number(data.sellerExpense) : null)
      : (previous.sellerExpense != null ? Number(previous.sellerExpense.toString()) : null);
  const nextTaxExpense =
    data.taxExpense !== undefined
      ? (data.taxExpense != null ? Number(data.taxExpense) : null)
      : (previous.taxExpense != null ? Number(previous.taxExpense.toString()) : null);

  const resolvedSellerTaxType =
    data.sellerTaxType !== undefined ? data.sellerTaxType : previous.sellerTaxType;
  // 수동 정산 기준액 — null 이 곧 자동(0 은 유효값이라 `!= null` 로만 판정).
  const nextSellerFeeBasisOverride =
    data.sellerFeeBasisOverride !== undefined
      ? data.sellerFeeBasisOverride
      : previous.sellerFeeBasisOverride != null
        ? Number(previous.sellerFeeBasisOverride.toString())
        : null;

  const derivedFinancials =
    nextActualSales == null
      ? {}
      : calculateDerivedCampaignFinancials({
          actualSales: nextActualSales,
          operatingExpense: nextOperatingExpense,
          miscExpense: resolvedMiscExpense,
          totalMarginRate: nextTotalMarginRate,
          sellerMarginRate: nextSellerMarginRate,
          sellerTaxType: resolvedSellerTaxType,
          sellerCompanyBusinessNumber: previous.seller?.agency?.businessNumber ?? null,
          isManualSettlementSales: nextIsManualSettlementSales,
          isManualSellerExpense: nextIsManualSellerExpense,
          isManualTaxExpense: nextIsManualTaxExpense,
          manualSettlementSales: nextSettlementSales,
          manualSellerExpense: nextSellerExpense,
          manualTaxExpense: nextTaxExpense,
          sellerFeeBasisOverride: nextSellerFeeBasisOverride,
        });

  // 개별 품목(option)별 차등 수수료율 보정 로직 주입
  if (nextActualSales != null && "sellerExpense" in derivedFinancials) {
    let dealsList: DerivationDealRow[] = [];
    if (data.campaignDeals !== undefined) {
      dealsList = data.campaignDeals;
    } else {
      dealsList = await tx.campaignDeal.findMany({ where: { campaignId: id } });
    }

    if (dealsList.length > 0) {
      let calculatedSellerExpenseSum = 0;
      let calculatedTotalMarginSum = 0;
      let calculatedTaxExpenseSum = 0;

      const isIndividual = isIndividualSeller({
        sellerTaxType: resolvedSellerTaxType,
        sellerCompanyBusinessNumber: previous.seller?.agency?.businessNumber ?? null,
      });

      for (const cd of dealsList) {
        const sRate = cd.sellerMarginRate != null ? Number(cd.sellerMarginRate) : nextSellerMarginRate;
        const tRate = cd.feeRate != null ? Number(cd.feeRate) : nextTotalMarginRate;
        const salesVal = cd.actualSales != null ? Number(cd.actualSales.toString()) : 0;

        calculatedTotalMarginSum += Math.round(salesVal * (tRate / 100));

        const sellerBase = getSellerPayoutBase(salesVal, isIndividual);
        const preTaxPayout = Math.round(sellerBase * (sRate / 100));

        if (isIndividual) {
          const tax = calcIndividualIncomeTax(preTaxPayout);
          calculatedTaxExpenseSum += tax;
          calculatedSellerExpenseSum += preTaxPayout;
        } else {
          calculatedSellerExpenseSum += preTaxPayout;
        }
      }

      const financials = derivedFinancials as {
        settlementSales: number;
        sellerExpense: number;
        taxExpense: number;
        operatingProfit: number;
      };

      if (!nextIsManualSettlementSales) {
        financials.settlementSales = calculatedTotalMarginSum;
      }
      // 판매대행비·원천세의 수동 층(수동 판매대행비 > 수동 기준액 > 자동)은
      // `resolveSellerFee` 한 곳이 정한다 — 이 루프는 자동값(품목 합계)만 만든다.
      const basisEligibility = resolveSellerFeeBasisEligibility({
        deals: dealsList,
        campaignSellerMarginRate: nextSellerMarginRate,
      });
      const fee = resolveSellerFee({
        autoSellerExpense: calculatedSellerExpenseSum,
        autoWithholdingSum: calculatedTaxExpenseSum,
        sellerFeeBasisOverride: nextSellerFeeBasisOverride,
        overrideSellerRate: basisEligibility.eligible ? basisEligibility.sellerRate : null,
        isManualSellerExpense: Boolean(nextIsManualSellerExpense),
        manualSellerExpense: nextSellerExpense,
      });
      financials.sellerExpense = fee.sellerExpense;

      const netCommission = financials.settlementSales - financials.sellerExpense;

      if (!nextIsManualTaxExpense) {
        financials.taxExpense = isIndividual
          ? fee.individualWithholding + Math.round(financials.settlementSales - (financials.settlementSales / 1.1))
          : Math.round(netCommission - (netCommission / 1.1));
      }

      financials.operatingProfit = computeOperatingProfit({
        settlementSales: financials.settlementSales,
        sellerExpense: financials.sellerExpense,
        taxExpense: financials.taxExpense,
        operatingExpense: nextOperatingExpense,
        miscExpense: resolvedMiscExpense,
      });
    }
  }

  return { derivedFinancials, nextNetMarginRate };
}
