import { getSellerPayoutBase, calcIndividualIncomeTax } from "./seller-tax-utils";

/**
 * Revenue calculation utility.
 *
 * Pure function for computing net revenue, seller commission, and operating profit
 * from actual sales, operating expense, and margin rates.
 */

export type RevenueCalculation = {
  netRevenue: number;
  sellerCommission: number; // For individuals: post-tax payout
  taxExpense: number; // Withholding tax (3.3%) for individuals, 0 for business
  operatingProfit: number;
};

/**
 * Computes revenue metrics from actual sales and margin rates.
 *
 * @param actualSales - The actual sales amount (nullable)
 * @param operatingExpense - The operating expense amount (nullable, defaults to 0)
 * @param totalMarginRate - The total margin rate percentage (0–100)
 * @param sellerMarginRate - The seller margin rate percentage (0–100)
 * @param isIndividual - Whether the seller is an individual (3.3% tax applies)
 * @returns RevenueCalculation object or null if actualSales is null/undefined
 */

export function computeRevenue(
  actualSales: number | null,
  operatingExpense: number | null,
  totalMarginRate: number,
  sellerMarginRate: number,
  isIndividual = false,
): RevenueCalculation | null {
  if (actualSales == null) {
    return null;
  }

  const expense = operatingExpense ?? 0;

  const netRevenue = Math.floor((actualSales * totalMarginRate) / 100);
  
  const sellerBase = getSellerPayoutBase(actualSales, isIndividual);
  const preTaxSellerCommission = Math.floor((sellerBase * sellerMarginRate) / 100);
  
  let taxExpense = 0;
  const sellerCommission = preTaxSellerCommission;

  if (isIndividual) {
    const withholdingTax = calcIndividualIncomeTax(sellerCommission);
    const vat = Math.round(netRevenue - (netRevenue / 1.1));
    taxExpense = withholdingTax + vat;
  }

  const operatingProfit = actualSales - sellerCommission - taxExpense - expense;

  return {
    netRevenue,
    sellerCommission,
    taxExpense,
    operatingProfit,
  };
}
