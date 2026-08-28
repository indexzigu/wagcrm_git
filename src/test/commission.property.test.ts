// Feature: business-logic-automation
// Property 1: Margin rate extraction from policy
// Property 2: Net margin rate computation invariant
// Validates: Requirements 1.1, 1.2, 1.3, 1.4

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

/** Arbitrary for a single SalesChannel */
const salesChannelArb: fc.Arbitrary<SalesChannel> = fc.constantFrom(
  ...SALES_CHANNELS,
);

/** Arbitrary for a margin rate value (0–100, finite) */
const marginRateValueArb = fc.float({ min: 0, max: 100, noNaN: true });

/** Arbitrary for a MarginRate record */
const marginRateArb = fc.record({
  totalMarginRate: marginRateValueArb,
  sellerMarginRate: marginRateValueArb,
});

/**
 * Arbitrary for a BaseMarginPolicy that contains at least one channel entry.
 * Uses a subset of SALES_CHANNELS so the byChannel map is always valid.
 */
const policyWithChannelsArb: fc.Arbitrary<BaseMarginPolicy> = fc
  .subarray(SALES_CHANNELS, { minLength: 1, maxLength: SALES_CHANNELS.length })
  .chain((channels) =>
    fc
      .tuple(...channels.map(() => marginRateArb))
      .map((rates) => ({
        byChannel: Object.fromEntries(
          channels.map((ch, i) => [ch, rates[i]]),
        ) as Partial<Record<SalesChannel, { totalMarginRate: number; sellerMarginRate: number }>>,
      })),
  );

/**
 * Arbitrary for a BaseMarginPolicy with an EMPTY byChannel map.
 */
const emptyPolicyArb: fc.Arbitrary<BaseMarginPolicy> = fc.constant({
  byChannel: {},
});

// ---------------------------------------------------------------------------
// Property 1: Margin rate extraction from policy
// Validates: Requirements 1.1, 1.2, 1.3
// ---------------------------------------------------------------------------

describe("Property 1: Margin rate extraction from policy", () => {
  it(
    "returns the correct totalMarginRate and sellerMarginRate when channel exists in policy",
    () => {
      fc.assert(
        fc.property(
          policyWithChannelsArb,
          salesChannelArb,
          (policy, channel) => {
            // Only test channels that are actually in the policy
            fc.pre(channel in policy.byChannel);

            const result = getMarginRatesFromPolicy(policy, channel);

            expect(result).not.toBeNull();
            const channelRate = policy.byChannel[channel]!;
            expect(result!.totalMarginRate).toBe(channelRate.totalMarginRate);
            expect(result!.sellerMarginRate).toBe(channelRate.sellerMarginRate);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "returns null when the channel does not exist in the policy byChannel map",
    () => {
      fc.assert(
        fc.property(
          policyWithChannelsArb,
          salesChannelArb,
          (policy, channel) => {
            // Only test channels that are NOT in the policy
            fc.pre(!(channel in policy.byChannel));

            const result = getMarginRatesFromPolicy(policy, channel);

            expect(result).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "returns null for every channel when byChannel is empty",
    () => {
      fc.assert(
        fc.property(emptyPolicyArb, salesChannelArb, (policy, channel) => {
          const result = getMarginRatesFromPolicy(policy, channel);
          expect(result).toBeNull();
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "result contains exactly the three fields: totalMarginRate, sellerMarginRate, netMarginRate",
    () => {
      fc.assert(
        fc.property(
          policyWithChannelsArb,
          salesChannelArb,
          (policy, channel) => {
            fc.pre(channel in policy.byChannel);

            const result = getMarginRatesFromPolicy(policy, channel);

            expect(result).not.toBeNull();
            expect(result).toHaveProperty("totalMarginRate");
            expect(result).toHaveProperty("sellerMarginRate");
            expect(result).toHaveProperty("netMarginRate");
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 2: Net margin rate computation invariant
// Validates: Requirements 1.4, 2.4
// ---------------------------------------------------------------------------

describe("Property 2: Net margin rate computation invariant", () => {
  it(
    "netMarginRate always equals totalMarginRate minus sellerMarginRate (from policy)",
    () => {
      fc.assert(
        fc.property(
          policyWithChannelsArb,
          salesChannelArb,
          (policy, channel) => {
            fc.pre(channel in policy.byChannel);

            const result = getMarginRatesFromPolicy(policy, channel);

            expect(result).not.toBeNull();
            // The invariant: net = total - seller
            expect(result!.netMarginRate).toBe(
              result!.totalMarginRate - result!.sellerMarginRate,
            );
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "netMarginRate invariant holds for any arbitrary totalMarginRate and sellerMarginRate values",
    () => {
      fc.assert(
        fc.property(
          marginRateValueArb,
          marginRateValueArb,
          salesChannelArb,
          (total, seller, channel) => {
            // Build a policy with exactly these values for the given channel
            const policy: BaseMarginPolicy = {
              byChannel: {
                [channel]: {
                  totalMarginRate: total,
                  sellerMarginRate: seller,
                },
              },
            };

            const result = getMarginRatesFromPolicy(policy, channel);

            expect(result).not.toBeNull();
            expect(result!.totalMarginRate).toBe(total);
            expect(result!.sellerMarginRate).toBe(seller);
            expect(result!.netMarginRate).toBe(total - seller);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "netMarginRate is consistent regardless of which channel is queried",
    () => {
      fc.assert(
        fc.property(policyWithChannelsArb, (policy) => {
          // For every channel present in the policy, the invariant must hold
          for (const channel of SALES_CHANNELS) {
            if (!(channel in policy.byChannel)) continue;

            const result = getMarginRatesFromPolicy(policy, channel);
            expect(result).not.toBeNull();
            expect(result!.netMarginRate).toBe(
              result!.totalMarginRate - result!.sellerMarginRate,
            );
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "netMarginRate can be negative when sellerMarginRate exceeds totalMarginRate",
    () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 50, noNaN: true }),
          fc.float({ min: 51, max: 100, noNaN: true }),
          salesChannelArb,
          (total, seller, channel) => {
            // seller > total → net should be negative
            const policy: BaseMarginPolicy = {
              byChannel: {
                [channel]: {
                  totalMarginRate: total,
                  sellerMarginRate: seller,
                },
              },
            };

            const result = getMarginRatesFromPolicy(policy, channel);

            expect(result).not.toBeNull();
            expect(result!.netMarginRate).toBe(total - seller);
            expect(result!.netMarginRate).toBeLessThan(0);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
