/**
 * Y-axis label formatting and chart left margin computation for Korean currency display.
 *
 * Formatting rules:
 * - 0 → "0"
 * - 1 ~ 999,999 → comma-formatted (e.g., "500,000")
 * - 1,000,000 ~ 99,999,999 → "N만" or "N,NNN만" (e.g., "100만", "1,000만")
 * - 100,000,000+ → "N억" or "N.N억" (e.g., "1억", "1.5억")
 */

/**
 * Format a numeric value for Y-axis display using Korean abbreviated units.
 *
 * - Values ≥ 100,000,000 (1억) use "억" unit
 * - Values ≥ 1,000,000 (100만) use "만" unit
 * - Values < 1,000,000 use comma-formatted numbers
 */
export function formatYAxisLabel(value: number): string {
  if (value === 0) return "0";

  const absValue = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  // 억 unit: ≥ 100,000,000
  if (absValue >= 100_000_000) {
    const eok = absValue / 100_000_000;
    // If it's a clean integer in 억, show without decimal
    if (eok === Math.floor(eok)) {
      return `${sign}${formatWithCommas(Math.floor(eok))}억`;
    }
    // Otherwise show one decimal place
    const rounded = Math.round(eok * 10) / 10;
    if (rounded === Math.floor(rounded)) {
      return `${sign}${formatWithCommas(Math.floor(rounded))}억`;
    }
    return `${sign}${formatWithCommas(Math.floor(rounded))}.${Math.round((rounded % 1) * 10)}억`;
  }

  // 만 unit: ≥ 1,000,000
  if (absValue >= 1_000_000) {
    const man = Math.round(absValue / 10_000);
    return `${sign}${formatWithCommas(man)}만`;
  }

  // Below 1,000,000: comma-formatted
  return `${sign}${formatWithCommas(absValue)}`;
}

/**
 * Compute the optimal left margin (in pixels) for a recharts chart
 * based on the maximum Y-axis value label width.
 *
 * This ensures Y-axis labels are never clipped regardless of data scale.
 */
export function computeChartLeftMargin(maxValue: number): number {
  const label = formatYAxisLabel(maxValue);
  // Approximate character width: ~8px per character for typical chart font size (12px)
  const charWidth = 8;
  const labelWidth = label.length * charWidth;
  // Add padding (12px) for breathing room
  const margin = labelWidth + 12;
  // Minimum margin of 40px, maximum of 80px to prevent excessive whitespace
  return Math.max(40, Math.min(margin, 80));
}

/**
 * Format a number with comma separators (Korean locale style).
 */
function formatWithCommas(value: number): string {
  return value.toLocaleString("ko-KR");
}
