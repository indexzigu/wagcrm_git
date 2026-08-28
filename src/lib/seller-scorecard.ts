type CampaignForScorecard = {
  actualSales: number | null;
};

type Scorecard = {
  cumulativeSales: number;
  campaignCount: number;
};

type ScorecardWithGrowth = Scorecard & {
  followerGrowthRate: number | null;
};

export function computeScorecard(campaigns: CampaignForScorecard[]): Scorecard {
  const campaignCount = campaigns.length;
  const cumulativeSales = campaigns.reduce((sum, c) => sum + (c.actualSales ?? 0), 0);

  return { cumulativeSales, campaignCount };
}

/**
 * Compute follower growth rate from snapshots within the last 30 days.
 * Returns null if fewer than 2 snapshots in the window or earliest has 0 followers.
 * Otherwise returns ((latest - earliest) / earliest) * 100.
 */
export function computeFollowerGrowthRate(
  snapshots: Array<{ snapshotDate: Date | string; followersCount: number }>
): number | null {
  const toDayMs = (value: Date | string): number => {
    const date = value instanceof Date ? value : new Date(value);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  };

  const now = new Date();
  const nowDayMs = toDayMs(now);
  const thirtyDaysAgoDayMs = toDayMs(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));

  // Filter to last 30 days
  const recentSnapshots = snapshots.filter((s) => {
    const dayMs = toDayMs(s.snapshotDate);
    return dayMs >= thirtyDaysAgoDayMs && dayMs <= nowDayMs;
  });

  if (recentSnapshots.length < 2) {
    return null;
  }

  // Sort by date ascending to find earliest and latest
  const sorted = [...recentSnapshots].sort((a, b) => {
    return toDayMs(a.snapshotDate) - toDayMs(b.snapshotDate);
  });

  const earliest = sorted[0];
  const latest = sorted[sorted.length - 1];

  if (earliest.followersCount === 0) {
    return null;
  }

  return ((latest.followersCount - earliest.followersCount) / earliest.followersCount) * 100;
}

/**
 * Combines existing computeScorecard with computeFollowerGrowthRate.
 */
export function computeScorecardWithGrowth(
  campaigns: CampaignForScorecard[],
  snapshots: Array<{ snapshotDate: Date | string; followersCount: number }>
): ScorecardWithGrowth {
  const scorecard = computeScorecard(campaigns);
  const followerGrowthRate = computeFollowerGrowthRate(snapshots);

  return { ...scorecard, followerGrowthRate };
}

export type { CampaignForScorecard, Scorecard, ScorecardWithGrowth };
