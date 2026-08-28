// Feature: core-data-management
// Property 1: Entity creation round-trip
// Property 7: Deal status transition state machine
// Property 8: Margin policy schema validation
// Validates: Requirements 9.1, 9.3, 9.4, 10.5

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  DEAL_STATUSES,
  isValidTransition,
  getValidNextStatuses,
} from "../lib/deal-status";
import type { DealStatus } from "../lib/deal-status";
import {
  createDealSchema,
  baseMarginPolicySchema,
  type CreateDealInput,
  type BaseMarginPolicy,
} from "../lib/validations/deal";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for a non-empty string (trimmed) */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 80 }).filter(
  (s) => s.trim().length > 0,
);

/** Arbitrary for a valid channel key (avoid prototype pollution keys) */
const channelKeyArb = fc.string({ minLength: 1, maxLength: 20 }).filter(
  (k) => k !== "__proto__" && k !== "constructor" && k !== "prototype",
);

/** Arbitrary for a valid margin rate object */
const marginRateArb = fc.record({
  totalMarginRate: fc.float({ min: 0, max: 100, noNaN: true }),
  sellerMarginRate: fc.float({ min: 0, max: 100, noNaN: true }),
});

/** Arbitrary for a valid slide rule */
const slideRuleArb = fc.record({
  minActualSales: fc.float({ min: 0, max: 1_000_000_000, noNaN: true }),
  totalMarginAddRate: fc.float({ min: 0, max: 50, noNaN: true }),
  sellerMarginAddRate: fc.option(
    fc.float({ min: 0, max: 50, noNaN: true }),
    { nil: undefined },
  ),
});

/** Arbitrary for a valid BaseMarginPolicy */
const baseMarginPolicyArb: fc.Arbitrary<BaseMarginPolicy> = fc
  .array(
    fc.tuple(
      fc.constantFrom("OWN_MALL", "NAVER", "COUPANG", "KAKAO", "INSTAGRAM"),
      marginRateArb,
    ),
    { minLength: 1, maxLength: 5 },
  )
  .chain((channelEntries) =>
    fc
      .option(fc.array(slideRuleArb, { minLength: 0, maxLength: 3 }), {
        nil: undefined,
      })
      .map((slides) => ({
        byChannel: Object.fromEntries(channelEntries),
        ...(slides !== undefined ? { slides } : {}),
      })),
  );

/** Arbitrary for a valid CreateDealInput */
const createDealInputArb: fc.Arbitrary<CreateDealInput> = fc.record({
  dealName: nonEmptyStringArb,
  partnerId: nonEmptyStringArb,
  costPrice: fc.float({ min: 0, max: 10_000_000, noNaN: true }),
  sellingPrice: fc.float({ min: 0, max: 10_000_000, noNaN: true }),
  baseMarginPolicy: baseMarginPolicyArb,
});

/** Arbitrary for a DealStatus */
const dealStatusArb: fc.Arbitrary<DealStatus> = fc.constantFrom(
  ...DEAL_STATUSES,
);

// ---------------------------------------------------------------------------
// Property 1: Entity creation round-trip (schema validation layer)
// ---------------------------------------------------------------------------
// Since these are pure logic tests (no DB), we validate that:
//   - createDealSchema.parse(validInput) succeeds and returns all provided fields
//   - The parsed output matches the input for all required fields

describe("Property 1: Entity creation round-trip — createDealSchema", () => {
  it(
    "parses valid deal input and preserves all provided fields",
    () => {
      fc.assert(
        fc.property(createDealInputArb, (input) => {
          const result = createDealSchema.safeParse(input);

          expect(result.success).toBe(true);
          if (!result.success) return;

          const data = result.data;
          expect(data.dealName).toBe(input.dealName);
          expect(data.partnerId).toBe(input.partnerId);
          // costPrice and sellingPrice may be coerced to defaults but should match
          expect(data.costPrice).toBe(input.costPrice);
          expect(data.sellingPrice).toBe(input.sellingPrice);
          // baseMarginPolicy channels should be preserved
          expect(Object.keys(data.baseMarginPolicy.byChannel)).toEqual(
            Object.keys(input.baseMarginPolicy.byChannel),
          );
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "rejects deal input with empty dealName",
    () => {
      fc.assert(
        fc.property(createDealInputArb, (input) => {
          const invalidInput = { ...input, dealName: "" };
          const result = createDealSchema.safeParse(invalidInput);
          expect(result.success).toBe(false);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "rejects deal input with empty partnerId",
    () => {
      fc.assert(
        fc.property(createDealInputArb, (input) => {
          const invalidInput = { ...input, partnerId: "" };
          const result = createDealSchema.safeParse(invalidInput);
          expect(result.success).toBe(false);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "rejects deal input with negative costPrice",
    () => {
      fc.assert(
        fc.property(
          createDealInputArb,
          fc.double({ min: -1_000_000, max: -Number.EPSILON, noNaN: true }),
          (input, negativePrice) => {
            const invalidInput = { ...input, costPrice: negativePrice };
            const result = createDealSchema.safeParse(invalidInput);
            expect(result.success).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 7: Deal status transition state machine
// ---------------------------------------------------------------------------

/** The ordered forward pipeline (excluding DROPPED) */
const PIPELINE_ORDER: DealStatus[] = [
  "SOURCING",
  "NEGOTIATING",
  "SAMPLE_TESTING",
  "CONFIRMED",
  "ARCHIVED",
];

describe("Property 7: Deal status transition state machine", () => {
  it(
    "accepts all valid forward transitions in the pipeline",
    () => {
      // For each consecutive pair in the pipeline, the transition must be valid
      for (let i = 0; i < PIPELINE_ORDER.length - 1; i++) {
        const from = PIPELINE_ORDER[i];
        const to = PIPELINE_ORDER[i + 1];
        expect(isValidTransition(from, to)).toBe(true);
      }
    },
  );

  it(
    "accepts DROPPED from any non-terminal status",
    () => {
      const nonDropped = DEAL_STATUSES.filter((s) => s !== "DROPPED");
      for (const status of nonDropped) {
        expect(isValidTransition(status, "DROPPED")).toBe(true);
      }
    },
  );

  it(
    "rejects all reverse transitions in the pipeline",
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: PIPELINE_ORDER.length - 1 }),
          fc.integer({ min: 0, max: PIPELINE_ORDER.length - 1 }),
          (fromIdx, toIdx) => {
            // Only test strict reverse transitions (toIdx < fromIdx)
            fc.pre(toIdx < fromIdx);
            const from = PIPELINE_ORDER[fromIdx];
            const to = PIPELINE_ORDER[toIdx];
            expect(isValidTransition(from, to)).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "rejects any transition out of DROPPED (terminal state)",
    () => {
      for (const to of DEAL_STATUSES) {
        expect(isValidTransition("DROPPED", to)).toBe(false);
      }
    },
  );

  it(
    "getValidNextStatuses returns only valid targets for any status",
    () => {
      fc.assert(
        fc.property(dealStatusArb, (status) => {
          const nextStatuses = getValidNextStatuses(status);
          for (const next of nextStatuses) {
            expect(isValidTransition(status, next)).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "no status can skip steps in the forward pipeline",
    () => {
      // SOURCING cannot jump directly to SAMPLE_TESTING or ARCHIVED
      expect(isValidTransition("SOURCING", "SAMPLE_TESTING")).toBe(false);
      expect(isValidTransition("SOURCING", "ARCHIVED")).toBe(false);
      // NEGOTIATING cannot jump directly to ARCHIVED
      expect(isValidTransition("NEGOTIATING", "ARCHIVED")).toBe(false);
    },
  );

  it(
    "self-transitions are not valid (status cannot stay the same via isValidTransition)",
    () => {
      // isValidTransition in deal-status.ts does NOT allow self-transitions
      // (only the validations/deal.ts version does)
      for (const status of DEAL_STATUSES) {
        expect(isValidTransition(status, status)).toBe(false);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Property 8: Margin policy schema validation
// ---------------------------------------------------------------------------

describe("Property 8: Margin policy schema validation", () => {
  it(
    "accepts any valid BaseMarginPolicy with at least one channel",
    () => {
      fc.assert(
        fc.property(baseMarginPolicyArb, (policy) => {
          const result = baseMarginPolicySchema.safeParse(policy);
          expect(result.success).toBe(true);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "rejects policy with missing byChannel",
    () => {
      fc.assert(
        fc.property(baseMarginPolicyArb, (policy) => {
          const invalid = { ...policy, byChannel: undefined };
          const result = baseMarginPolicySchema.safeParse(invalid);
          expect(result.success).toBe(false);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "rejects policy where a channel entry is missing totalMarginRate",
    () => {
      fc.assert(
        fc.property(
          baseMarginPolicyArb,
          channelKeyArb,
          (policy, channelKey) => {
            const invalidChannel = { sellerMarginRate: 10 }; // missing totalMarginRate
            const invalid = {
              ...policy,
              byChannel: {
                ...policy.byChannel,
                [channelKey]: invalidChannel,
              },
            };
            const result = baseMarginPolicySchema.safeParse(invalid);
            expect(result.success).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "rejects policy where a channel entry is missing sellerMarginRate",
    () => {
      fc.assert(
        fc.property(
          baseMarginPolicyArb,
          channelKeyArb,
          (policy, channelKey) => {
            const invalidChannel = { totalMarginRate: 15 }; // missing sellerMarginRate
            const invalid = {
              ...policy,
              byChannel: {
                ...policy.byChannel,
                [channelKey]: invalidChannel,
              },
            };
            const result = baseMarginPolicySchema.safeParse(invalid);
            expect(result.success).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "rejects policy where a slide rule is missing minActualSales",
    () => {
      fc.assert(
        fc.property(baseMarginPolicyArb, (policy) => {
          const invalidSlide = {
            totalMarginAddRate: 5,
            // missing minActualSales
          };
          const invalid = {
            ...policy,
            slides: [invalidSlide],
          };
          const result = baseMarginPolicySchema.safeParse(invalid);
          expect(result.success).toBe(false);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "rejects policy where a slide rule is missing totalMarginAddRate",
    () => {
      fc.assert(
        fc.property(baseMarginPolicyArb, (policy) => {
          const invalidSlide = {
            minActualSales: 1000000,
            // missing totalMarginAddRate
          };
          const invalid = {
            ...policy,
            slides: [invalidSlide],
          };
          const result = baseMarginPolicySchema.safeParse(invalid);
          expect(result.success).toBe(false);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "accepts policy with optional slides omitted",
    () => {
      fc.assert(
        fc.property(baseMarginPolicyArb, (policy) => {
          const withoutSlides = { byChannel: policy.byChannel };
          const result = baseMarginPolicySchema.safeParse(withoutSlides);
          expect(result.success).toBe(true);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "accepts policy with empty slides array",
    () => {
      fc.assert(
        fc.property(baseMarginPolicyArb, (policy) => {
          const withEmptySlides = { byChannel: policy.byChannel, slides: [] };
          const result = baseMarginPolicySchema.safeParse(withEmptySlides);
          expect(result.success).toBe(true);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "rejects completely non-object inputs",
    () => {
      const invalidInputs = [null, undefined, 42, "string", [], true];
      for (const invalid of invalidInputs) {
        const result = baseMarginPolicySchema.safeParse(invalid);
        expect(result.success).toBe(false);
      }
    },
  );
});
