import type { CampaignRow } from "./crm-types";

export type RankedItem = {
  id: string;
  name: string;
  subLabel: string;
  netMargin: number;
  count: number;
  brandName?: string | null;
  partnerName?: string | null;
};

/**
 * Filter campaigns to COMPLETED status with endDate within the last 3 months
 * relative to the given reference date.
 */
function filterCompletedRecent(
  campaigns: CampaignRow[],
  referenceDate: Date,
): CampaignRow[] {
  const threeMonthsAgo = new Date(referenceDate);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  return campaigns.filter((c) => {
    if (c.status !== "COMPLETED") return false;
    if (!c.endDate) return false;
    const end = new Date(c.endDate);
    return end >= threeMonthsAgo && end <= referenceDate;
  });
}

/**
 * Compute net margin amount for a campaign:
 * (actualSales * netMarginRate) / 100
 */
function computeNetMarginAmount(campaign: CampaignRow): number {
  const actualSales = campaign.actualSales ?? 0;
  const netMarginRate = campaign.netMarginRate ?? 0;
  return (actualSales * netMarginRate) / 100;
}

/**
 * 최근 3개월 완료 캠페인 기준 딜별 순이익 랭킹.
 * Groups by dealId, sums net margin, counts campaigns.
 * Returns top 5 sorted by netMargin descending.
 */
export function rankDealsByProfit(
  campaigns: CampaignRow[],
  referenceDate: Date = new Date(),
): RankedItem[] {
  const filtered = filterCompletedRecent(campaigns, referenceDate);

  const grouped = new Map<
    string,
    {
      name: string;
      subLabel: string;
      netMargin: number;
      count: number;
      brandName?: string | null;
      partnerName?: string | null;
    }
  >();

  for (const c of filtered) {
    const key = c.dealId;
    const existing = grouped.get(key);
    if (existing) {
      existing.netMargin += computeNetMarginAmount(c);
      existing.count += 1;
    } else {
      grouped.set(key, {
        name: c.dealName,
        subLabel: c.partnerName,
        netMargin: computeNetMarginAmount(c),
        count: 1,
        brandName: c.deal?.brandName || null,
        partnerName: c.partnerName || null,
      });
    }
  }

  return Array.from(grouped.entries())
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => b.netMargin - a.netMargin)
    .slice(0, 5);
}

/**
 * 최근 3개월 완료 캠페인 기준 셀러별 순이익 랭킹.
 * Groups by sellerId, sums net margin, counts campaigns.
 * Returns top 5 sorted by netMargin descending.
 */
export function rankSellersByProfit(
  campaigns: CampaignRow[],
  referenceDate: Date = new Date(),
): RankedItem[] {
  const filtered = filterCompletedRecent(campaigns, referenceDate);

  const grouped = new Map<
    string,
    { name: string; subLabel: string; netMargin: number; count: number }
  >();

  for (const c of filtered) {
    const key = c.sellerId;
    const existing = grouped.get(key);
    if (existing) {
      existing.netMargin += computeNetMarginAmount(c);
      existing.count += 1;
    } else {
      grouped.set(key, {
        name: c.sellerName,
        subLabel: c.snsHandle,
        netMargin: computeNetMarginAmount(c),
        count: 1,
      });
    }
  }

  return Array.from(grouped.entries())
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => b.netMargin - a.netMargin)
    .slice(0, 5);
}

/**
 * 최근 3개월 완료 캠페인 기준 파트너(브랜드)별 순이익 랭킹.
 * Groups by partnerName (since CampaignRow doesn't have partnerId),
 * sums net margin, counts unique deals.
 * Returns top 5 sorted by netMargin descending.
 */
export function rankPartnersByProfit(
  campaigns: CampaignRow[],
  referenceDate: Date = new Date(),
): RankedItem[] {
  const filtered = filterCompletedRecent(campaigns, referenceDate);

  const grouped = new Map<
    string,
    { name: string; subLabel: string; netMargin: number; dealIds: Set<string> }
  >();

  for (const c of filtered) {
    const key = c.partnerName;
    const existing = grouped.get(key);
    if (existing) {
      existing.netMargin += computeNetMarginAmount(c);
      existing.dealIds.add(c.dealId);
    } else {
      grouped.set(key, {
        name: c.partnerName,
        subLabel: "",
        netMargin: computeNetMarginAmount(c),
        dealIds: new Set([c.dealId]),
      });
    }
  }

  return Array.from(grouped.entries())
    .map(([id, data]) => ({
      id,
      name: data.name,
      subLabel: data.subLabel,
      netMargin: data.netMargin,
      count: data.dealIds.size,
    }))
    .sort((a, b) => b.netMargin - a.netMargin)
    .slice(0, 5);
}
