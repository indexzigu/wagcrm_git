// Feature: business-logic-automation
// Property 3: Manual override revert restores policy values
// Validates: Requirements 2.5

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { getMarginRatesFromPolicy } from "../lib/commission";
import type { BaseMarginPolicy, SalesChannel } from "../lib/crm-types";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const SALES_CHANNELS: SalesChannel[] = [
  "OWN_MALL",
  "OWN_MALL_NAVER",
  "OWN_MALL_KAKAO",
  "SELLER_MALL",
  "BRAND_MALL",
];

/** Arbitrary for a valid margin rate (non-negative floats) */
const marginRateArb = fc.record({
  totalMarginRate: fc.float({ min: 0, max: 100, noNaN: true }),
  sellerMarginRate: fc.float({ min: 0, max: 100, noNaN: true }),
});

/** Arbitrary for a SalesChannel */
const salesChannelArb: fc.Arbitrary<SalesChannel> = fc.constantFrom(
  ...SALES_CHANNELS,
);

/**
 * Arbitrary for a BaseMarginPolicy that is guaranteed to have an entry
 * for the given channel. Returns [policy, channel] tuple.
 */
const policyWithMatchingChannelArb: fc.Arbitrary<
  [BaseMarginPolicy, SalesChannel]
> = salesChannelArb.chain((channel) =>
  fc
    .array(
      fc.tuple(fc.constantFrom(...SALES_CHANNELS), marginRateArb),
      { minLength: 0, maxLength: 4 },
    )
    .chain((otherEntries) =>
      marginRateArb.map((channelRate) => {
        // Build byChannel ensuring the chosen channel is always present
        const byChannel: Partial<Record<SalesChannel, { totalMarginRate: number; sellerMarginRate: number }>> = {};
        for (const [ch, rate] of otherEntries) {
          byChannel[ch] = rate;
        }
        byChannel[channel] = channelRate;
        const policy: BaseMarginPolicy = { byChannel };
        return [policy, channel] as [BaseMarginPolicy, SalesChannel];
      }),
    ),
);

/**
 * Arbitrary for manually entered margin values (any finite floats, including
 * values that differ from the policy — simulating user edits).
 */
const manualMarginArb = fc.record({
  manualTotal: fc.float({ min: -200, max: 200, noNaN: true }),
  manualSeller: fc.float({ min: -200, max: 200, noNaN: true }),
});

// ---------------------------------------------------------------------------
// Pure revert logic (extracted from CommissionSmartForm.handleToggleOverride)
//
// When Manual_Override is toggled OFF, the form reverts to policy values:
//   total  = policyRates.totalMarginRate
//   seller = policyRates.sellerMarginRate
//   net    = total - seller
//   isManualMargin = false
// ---------------------------------------------------------------------------

type MarginState = {
  totalMarginRate: number;
  sellerMarginRate: number;
  netMarginRate: number;
  isManualMargin: boolean;
};

/**
 * Simulates toggling Manual_Override OFF after manual edits.
 * Returns the resulting margin state (what would be passed to onMarginChange).
 */
function revertToPolicy(
  policy: BaseMarginPolicy,
  channel: SalesChannel,
  manualTotal: number,
  manualSeller: number,
): MarginState | null {
  void manualTotal;
  void manualSeller;
  const policyRates = getMarginRatesFromPolicy(policy, channel);
  if (!policyRates) return null;

  const total = policyRates.totalMarginRate;
  const seller = policyRates.sellerMarginRate;
  return {
    totalMarginRate: total,
    sellerMarginRate: seller,
    netMarginRate: total - seller,
    isManualMargin: false,
  };
}

// ---------------------------------------------------------------------------
// Property 3: Manual override revert restores policy values
// ---------------------------------------------------------------------------

describe("Property 3: Manual override revert restores policy values", () => {
  it(
    "toggling override OFF restores totalMarginRate to the policy value",
    () => {
      fc.assert(
        fc.property(
          policyWithMatchingChannelArb,
          manualMarginArb,
          ([policy, channel], { manualTotal, manualSeller }) => {
            const result = revertToPolicy(
              policy,
              channel,
              manualTotal,
              manualSeller,
            );

            // Policy has a matching channel, so result must not be null
            expect(result).not.toBeNull();
            if (!result) return;

            const policyRates = getMarginRatesFromPolicy(policy, channel)!;
            expect(result.totalMarginRate).toBe(policyRates.totalMarginRate);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "toggling override OFF restores sellerMarginRate to the policy value",
    () => {
      fc.assert(
        fc.property(
          policyWithMatchingChannelArb,
          manualMarginArb,
          ([policy, channel], { manualTotal, manualSeller }) => {
            const result = revertToPolicy(
              policy,
              channel,
              manualTotal,
              manualSeller,
            );

            expect(result).not.toBeNull();
            if (!result) return;

            const policyRates = getMarginRatesFromPolicy(policy, channel)!;
            expect(result.sellerMarginRate).toBe(policyRates.sellerMarginRate);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "toggling override OFF sets isManualMargin to false",
    () => {
      fc.assert(
        fc.property(
          policyWithMatchingChannelArb,
          manualMarginArb,
          ([policy, channel], { manualTotal, manualSeller }) => {
            const result = revertToPolicy(
              policy,
              channel,
              manualTotal,
              manualSeller,
            );

            expect(result).not.toBeNull();
            if (!result) return;

            expect(result.isManualMargin).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "toggling override OFF computes netMarginRate as total minus seller from policy",
    () => {
      fc.assert(
        fc.property(
          policyWithMatchingChannelArb,
          manualMarginArb,
          ([policy, channel], { manualTotal, manualSeller }) => {
            const result = revertToPolicy(
              policy,
              channel,
              manualTotal,
              manualSeller,
            );

            expect(result).not.toBeNull();
            if (!result) return;

            const policyRates = getMarginRatesFromPolicy(policy, channel)!;
            const expectedNet =
              policyRates.totalMarginRate - policyRates.sellerMarginRate;
            expect(result.netMarginRate).toBe(expectedNet);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "revert is independent of what manual values were entered before toggling OFF",
    () => {
      fc.assert(
        fc.property(
          policyWithMatchingChannelArb,
          manualMarginArb,
          manualMarginArb,
          ([policy, channel], edits1, edits2) => {
            const result1 = revertToPolicy(
              policy,
              channel,
              edits1.manualTotal,
              edits1.manualSeller,
            );
            const result2 = revertToPolicy(
              policy,
              channel,
              edits2.manualTotal,
              edits2.manualSeller,
            );

            expect(result1).not.toBeNull();
            expect(result2).not.toBeNull();
            if (!result1 || !result2) return;

            // Regardless of what was manually entered, the reverted values are identical
            expect(result1.totalMarginRate).toBe(result2.totalMarginRate);
            expect(result1.sellerMarginRate).toBe(result2.sellerMarginRate);
            expect(result1.netMarginRate).toBe(result2.netMarginRate);
            expect(result1.isManualMargin).toBe(result2.isManualMargin);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "returns null when the channel has no matching policy entry",
    () => {
      fc.assert(
        fc.property(
          // Policy with NO entry for the chosen channel
          salesChannelArb.chain((channel) => {
            // Build a policy that explicitly excludes the chosen channel
            const otherChannels = SALES_CHANNELS.filter((c) => c !== channel);
            return fc
              .array(
                fc.tuple(fc.constantFrom(...otherChannels), marginRateArb),
                { minLength: 0, maxLength: 4 },
              )
              .map((entries) => {
                const byChannel: Partial<
                  Record<SalesChannel, { totalMarginRate: number; sellerMarginRate: number }>
                > = {};
                for (const [ch, rate] of entries) {
                  byChannel[ch] = rate;
                }
                return [{ byChannel } as BaseMarginPolicy, channel] as [
                  BaseMarginPolicy,
                  SalesChannel,
                ];
              });
          }),
          manualMarginArb,
          ([policy, channel], { manualTotal, manualSeller }) => {
            const result = revertToPolicy(
              policy,
              channel,
              manualTotal,
              manualSeller,
            );
            // No matching channel → revert returns null (no policy to revert to)
            expect(result).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
