import type { BaseMarginPolicy, MarginRate, SalesChannel } from "./crm-types";

export type MarginRateWithNet = MarginRate & { netMarginRate: number };

export function resolveBaseMargin(
  policy: BaseMarginPolicy,
  salesChannel: SalesChannel,
): MarginRate {
  const selected = policy.byChannel[salesChannel];
  if (!selected) {
    return { totalMarginRate: 0, sellerMarginRate: 0 };
  }
  return selected;
}

export function applySlideMargin(
  policy: BaseMarginPolicy,
  salesChannel: SalesChannel,
  actualSales: number | null | undefined,
): MarginRateWithNet {
  const base = resolveBaseMargin(policy, salesChannel);
  if (!actualSales || !policy.slides?.length) return withNet(base);

  const matched = [...policy.slides]
    .filter((rule) => actualSales >= rule.minActualSales)
    .sort((a, b) => b.minActualSales - a.minActualSales)[0];

  if (!matched) return withNet(base);

  return withNet({
    totalMarginRate: base.totalMarginRate + matched.totalMarginAddRate,
    sellerMarginRate:
      base.sellerMarginRate + (matched.sellerMarginAddRate ?? 0),
  });
}

export function withNet(rate: MarginRate): MarginRateWithNet {
  return {
    ...rate,
    netMarginRate: Number(
      (rate.totalMarginRate - rate.sellerMarginRate).toFixed(2),
    ),
  };
}

export function parseMarginPolicy(value: unknown): BaseMarginPolicy {
  if (typeof value === "string") {
    return JSON.parse(value) as BaseMarginPolicy;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Invalid margin policy");
  }
  return value as BaseMarginPolicy;
}
