/**
 * Discount rate computation utilities.
 *
 * Pure functions for calculating and formatting discount rates
 * based on listPrice and sellingPrice.
 */

/**
 * 할인율 계산: (listPrice - sellingPrice) / listPrice × 100
 * - listPrice가 null, undefined, 0, 또는 ≤ 0이면 null 반환
 * - sellingPrice가 null 또는 undefined이면 null 반환
 * - 결과는 소수점 1자리로 반올림
 */
export function computeDiscountRate(
  listPrice: number | null | undefined,
  sellingPrice: number | null | undefined,
): number | null {
  if (listPrice == null || listPrice <= 0) return null;
  if (sellingPrice == null) return null;

  const rate = ((listPrice - sellingPrice) / listPrice) * 100;
  return Math.round(rate * 10) / 10;
}

/**
 * 할인율 표시 포맷: number → "12.5%" 또는 null → "-"
 */
export function formatDiscountRate(rate: number | null): string {
  if (rate == null) return "-";
  return `${rate}%`;
}
