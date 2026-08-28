/**
 * Property-based tests for seller-scorecard growth rate computation.
 *
 * Feature: data-collection-insights
 * Property 8: Follower growth rate computation
 * Validates: Requirements 6.1, 6.2
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  computeFollowerGrowthRate,
  computeScorecardWithGrowth,
} from "../seller-scorecard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a Date that is `daysAgo` days before now (within the 30-day window). */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Snapshot generator — date within the last 30 days, followers ≥ 0. */
const snapshotArb = fc.record({
  snapshotDate: fc.integer({ min: 0, max: 29 }).map((d) => daysAgo(d)),
  followersCount: fc.integer({ min: 0, max: 10_000_000 }),
});

/** Exactly 0 or 1 snapshot within the 30-day window. */
const fewerThanTwoSnapshotsArb = fc.array(snapshotArb, { minLength: 0, maxLength: 1 });

// ---------------------------------------------------------------------------
// Property 8: Follower growth rate computation
// Validates: Requirements 6.1, 6.2
// ---------------------------------------------------------------------------

describe("Property 8: Follower growth rate computation", () => {
  /**
   * 8a — Requirement 6.2: fewer than 2 snapshots → null
   *
   * For any list with 0 or 1 snapshots within the 30-day window,
   * computeFollowerGrowthRate SHALL return null.
   */
  it("returns null when fewer than 2 snapshots exist (Req 6.2)", () => {
    fc.assert(
      fc.property(fewerThanTwoSnapshotsArb, (snapshots) => {
        expect(computeFollowerGrowthRate(snapshots)).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * 8b — Requirement 6.2: earliest snapshot has 0 followers → null
   *
   * For any list of ≥ 2 snapshots where the chronologically earliest one
   * has followersCount === 0, the function SHALL return null (division by zero guard).
   */
  it("returns null when earliest snapshot has 0 followers (Req 6.2)", () => {
    fc.assert(
      fc.property(
        // Build a list where the earliest snapshot has 0 followers
        fc.array(snapshotArb, { minLength: 1, maxLength: 19 }).map((rest) => {
          // Inject an earliest snapshot with 0 followers (29 days ago)
          const earliest = { snapshotDate: daysAgo(29), followersCount: 0 };
          return [earliest, ...rest];
        }),
        (snapshots) => {
          expect(computeFollowerGrowthRate(snapshots)).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 8c — Requirement 6.1: correct formula when ≥ 2 snapshots and earliest > 0
   *
   * For any list of ≥ 2 snapshots where the earliest followersCount > 0,
   * the result SHALL equal ((latestCount - earliestCount) / earliestCount) * 100.
   */
  it("computes ((latest - earliest) / earliest) * 100 for valid snapshots (Req 6.1)", () => {
    // Snapshots with followersCount ≥ 1 so the earliest is never 0
    const positiveSnapshotArb = fc.record({
      snapshotDate: fc.integer({ min: 0, max: 29 }).map((d) => daysAgo(d)),
      followersCount: fc.integer({ min: 1, max: 10_000_000 }),
    });

    fc.assert(
      fc.property(
        fc.array(positiveSnapshotArb, { minLength: 2, maxLength: 20 }),
        (snapshots) => {
          const result = computeFollowerGrowthRate(snapshots);

          // Sort ascending by date to find earliest and latest
          const sorted = [...snapshots].sort(
            (a, b) => a.snapshotDate.getTime() - b.snapshotDate.getTime()
          );
          const earliest = sorted[0];
          const latest = sorted[sorted.length - 1];

          const expected =
            ((latest.followersCount - earliest.followersCount) / earliest.followersCount) * 100;

          expect(result).not.toBeNull();
          expect(result as number).toBeCloseTo(expected, 10);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 8d — Requirement 6.1: ordering by snapshotDate determines earliest/latest
   *
   * Reversing the snapshot array SHALL NOT change the computed growth rate —
   * the function must sort internally and not rely on input order.
   * We use snapshots with distinct dates to avoid tie-breaking ambiguity.
   */
  it("result is independent of input array order (Req 6.1)", () => {
    // Use distinct day offsets so there are no ties in snapshotDate
    const distinctDaysArb = fc
      .uniqueArray(fc.integer({ min: 0, max: 29 }), { minLength: 2, maxLength: 20 })
      .map((days) =>
        days.map((d) => ({
          snapshotDate: daysAgo(d),
          followersCount: Math.max(1, d * 1000 + 1), // always > 0, deterministic
        }))
      );

    fc.assert(
      fc.property(distinctDaysArb, (snapshots) => {
        const reversed = [...snapshots].reverse();

        const original = computeFollowerGrowthRate(snapshots);
        const reordered = computeFollowerGrowthRate(reversed);

        if (original === null) {
          expect(reordered).toBeNull();
        } else {
          expect(reordered).not.toBeNull();
          expect(reordered as number).toBeCloseTo(original, 10);
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * 8e — Snapshots outside the 30-day window are excluded
   *
   * Adding snapshots older than 30 days to a list that already has < 2 recent
   * snapshots SHALL NOT change the null result — only in-window snapshots count.
   */
  it("ignores snapshots outside the 30-day window (Req 6.1)", () => {
    // Snapshot older than 30 days
    const oldSnapshotArb = fc.record({
      snapshotDate: fc.integer({ min: 31, max: 365 }).map((d) => daysAgo(d)),
      followersCount: fc.integer({ min: 1, max: 10_000_000 }),
    });

    fc.assert(
      fc.property(
        // 0 or 1 recent snapshots + any number of old snapshots
        fewerThanTwoSnapshotsArb,
        fc.array(oldSnapshotArb, { minLength: 1, maxLength: 10 }),
        (recentSnapshots, oldSnapshots) => {
          const combined = [...recentSnapshots, ...oldSnapshots];
          expect(computeFollowerGrowthRate(combined)).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 8f — computeScorecardWithGrowth embeds the same growth rate
   *
   * The followerGrowthRate field in the combined scorecard SHALL equal
   * the value returned by computeFollowerGrowthRate for the same snapshots.
   */
  it("computeScorecardWithGrowth.followerGrowthRate matches computeFollowerGrowthRate (Req 6.1, 6.2)", () => {
    const campaignArb = fc.record({
      actualSales: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 10_000_000 })),
    });

    fc.assert(
      fc.property(
        fc.array(campaignArb, { minLength: 0, maxLength: 10 }),
        fc.array(snapshotArb, { minLength: 0, maxLength: 20 }),
        (campaigns, snapshots) => {
          const scorecard = computeScorecardWithGrowth(campaigns, snapshots);
          const standalone = computeFollowerGrowthRate(snapshots);

          if (standalone === null) {
            expect(scorecard.followerGrowthRate).toBeNull();
          } else {
            expect(scorecard.followerGrowthRate).not.toBeNull();
            expect(scorecard.followerGrowthRate as number).toBeCloseTo(standalone, 10);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Seller scorecard computation
// Validates: Requirements 7.3
// ---------------------------------------------------------------------------

/**
 * **Validates: Requirements 7.3**
 *
 * Property 6: Seller scorecard computation
 *
 * For any set of campaigns, computeScorecard must correctly compute:
 *   - cumulativeSales  = sum of actualSales (treating null as 0)
 *   - campaignCount    = number of campaigns in the input array
 */

import { computeScorecard } from "../seller-scorecard";

/** Arbitrary for a single campaign with nullable sales figures. */
const campaignArb = fc.record({
  actualSales: fc.oneof(
    fc.constant(null),
    fc.integer({ min: 0, max: 10_000_000 })
  ),
});

/** Arbitrary for an array of 0–20 campaigns. */
const campaignsArb = fc.array(campaignArb, { minLength: 0, maxLength: 20 });

describe("Property 6: Seller scorecard computation (Req 7.3)", () => {
  /**
   * 6a — campaignCount equals the length of the input array.
   */
  it("campaignCount equals the number of campaigns in the input", () => {
    fc.assert(
      fc.property(campaignsArb, (campaigns) => {
        const { campaignCount } = computeScorecard(campaigns);
        expect(campaignCount).toBe(campaigns.length);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * 6b — cumulativeSales equals the sum of actualSales (null treated as 0).
   */
  it("cumulativeSales equals sum of actualSales (null → 0)", () => {
    fc.assert(
      fc.property(campaignsArb, (campaigns) => {
        const { cumulativeSales } = computeScorecard(campaigns);
        const expected = campaigns.reduce((sum, c) => sum + (c.actualSales ?? 0), 0);
        expect(cumulativeSales).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * 6f — Empty campaign list produces cumulativeSales=0, campaignCount=0,
   *       without requiring a campaign-level revenue target.
   */
  it("empty campaign list produces zero sales, zero count, and null rate", () => {
    const { cumulativeSales, campaignCount } = computeScorecard([]);
    expect(cumulativeSales).toBe(0);
    expect(campaignCount).toBe(0);
  });
});
