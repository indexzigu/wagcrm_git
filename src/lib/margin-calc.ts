/**
 * Margin calculation utility.
 *
 * Pure function for computing net margin rate from total and seller margin rates.
 */

/**
 * netMarginRate = totalMarginRate - sellerMarginRate
 *
 * @param totalMarginRate - The total margin rate (percentage)
 * @param sellerMarginRate - The seller margin rate (percentage)
 * @returns The net margin rate (totalMarginRate - sellerMarginRate)
 */
export function computeNetMarginRate(
  totalMarginRate: number,
  sellerMarginRate: number,
): number {
  return totalMarginRate - sellerMarginRate;
}
