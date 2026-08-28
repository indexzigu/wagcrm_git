"use client";

import { formatCurrency, formatNumber } from "@/lib/format";

interface AnimatedNumberProps {
  value: number | null | undefined;
  duration?: number;
  format?: "currency" | "number" | "percent" | "raw";
  decimalPlaces?: number;
  className?: string;
  suffix?: string;
  fallback?: string;
}

/**
 * KPI 숫자 표시.
 *
 * ss-motion 규칙("Number/balance/KPI reveal → none — don't animate the
 * payload")에 따라 카운트업 애니메이션을 제거했다. 이전 구현은 motion value로
 * 0→value를 구동해 최초 페인트가 0에서 시작했는데, 이는 그 규칙과 정면으로
 * 충돌했다. 지금은 최종 포맷값을 첫 페인트에 바로 렌더링한다.
 *
 * 공개 API(props)는 그대로 유지한다. `duration`은 호출부 호환을 위해
 * 시그니처에 남아있지만 더 이상 아무 동작도 하지 않는다(no-op).
 */
export function AnimatedNumber({
  value,
  duration = 1000,
  format = "number",
  decimalPlaces = 0,
  className,
  suffix = "",
  fallback = "-",
}: AnimatedNumberProps) {
  // no-op: 더 이상 애니메이션을 구동하지 않으므로 duration은 사용하지 않는다.
  void duration;

  if (value == null || Number.isNaN(value)) {
    return <span className={className}>{fallback}</span>;
  }

  const formatValue = (n: number): string => {
    if (format === "currency") return formatCurrency(Math.round(n));
    if (format === "percent") return `${n.toFixed(decimalPlaces)}%`;
    if (format === "raw") return n.toFixed(decimalPlaces);
    return formatNumber(Math.round(n));
  };

  return <span className={className}>{`${formatValue(value)}${suffix}`}</span>;
}
