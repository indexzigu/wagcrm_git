import { computeRevenue } from "./revenue-calc";
import { isIndividualSeller } from "./seller-tax-utils";

export type DerivedCampaignFinancials = {
  settlementSales: number;
  sellerExpense: number;
  taxExpense: number;
  operatingProfit: number;
};

/**
 * Recalculates campaign financial totals from gross sales and commission rates.
 * The current settlement workspace treats withholding/deducted tax as 10% of
 * net commission, then subtracts campaign costs from commission revenue.
 */
export function calculateDerivedCampaignFinancials({
  actualSales,
  operatingExpense,
  miscExpense,
  totalMarginRate,
  sellerMarginRate,
  sellerTaxType,
  sellerCompanyBusinessNumber,
  isManualSettlementSales = false,
  isManualSellerExpense = false,
  isManualTaxExpense = false,
  manualSettlementSales,
  manualSellerExpense,
  manualTaxExpense,
}: {
  actualSales: number;
  operatingExpense: number;
  miscExpense: number;
  totalMarginRate: number;
  sellerMarginRate: number;
  sellerTaxType?: string | null;
  sellerCompanyBusinessNumber?: string | null;
  isManualSettlementSales?: boolean;
  isManualSellerExpense?: boolean;
  isManualTaxExpense?: boolean;
  manualSettlementSales?: number | null;
  manualSellerExpense?: number | null;
  manualTaxExpense?: number | null;
}): DerivedCampaignFinancials {
  const isIndividual = isIndividualSeller({
    sellerTaxType,
    sellerCompanyBusinessNumber,
  });

  const calculated = computeRevenue(
    actualSales,
    0,
    totalMarginRate,
    sellerMarginRate,
    isIndividual,
  );
  
  const autoSettlementSales = calculated?.netRevenue ?? 0;
  const autoSellerExpense = calculated?.sellerCommission ?? 0;
  
  const settlementSales = isManualSettlementSales && manualSettlementSales != null
    ? manualSettlementSales
    : autoSettlementSales;
    
  const sellerExpense = isManualSellerExpense && manualSellerExpense != null
    ? manualSellerExpense
    : autoSellerExpense;

  const netCommission = settlementSales - sellerExpense;
  
  const autoTaxExpense = isIndividual
    ? Math.round((sellerExpense / 1.1) * 0.033) + Math.round(settlementSales - (settlementSales / 1.1))
    : Math.round(netCommission - (netCommission / 1.1));
    
  const taxExpense = isManualTaxExpense && manualTaxExpense != null
    ? manualTaxExpense
    : autoTaxExpense;

  const operatingProfit =
    settlementSales - sellerExpense - taxExpense - operatingExpense - miscExpense;

  return {
    settlementSales,
    sellerExpense,
    taxExpense,
    operatingProfit,
  };
}
