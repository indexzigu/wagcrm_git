import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { createDealSchema, type BaseMarginPolicy } from "../validations/deal";
import { createPartnerSchema, PARTNER_TYPES } from "../validations/partner";
import { createSellerSchema, SNS_TYPES } from "../validations/seller";
import { campaignFormSchema } from "../validations/campaign";

const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 80 }).filter(
  (value) => value.trim().length > 0,
);

const isoDateArb = fc
  .date({
    min: new Date("2024-01-01T00:00:00.000Z"),
    max: new Date("2027-12-31T00:00:00.000Z"),
  })
  .map((date) => date.toISOString().slice(0, 10));

const marginRateArb = fc.record({
  totalMarginRate: fc.float({ min: 0, max: 100, noNaN: true }),
  sellerMarginRate: fc.float({ min: 0, max: 100, noNaN: true }),
});

const baseMarginPolicyArb: fc.Arbitrary<BaseMarginPolicy> = fc
  .dictionary(
    fc.constantFrom("OWN_MALL", "OWN_MALL_NAVER", "OWN_MALL_KAKAO", "SELLER_MALL", "BRAND_MALL"),
    marginRateArb,
  )
  .filter((byChannel) => Object.keys(byChannel).length > 0)
  .map((byChannel) => ({ byChannel }));

describe("Property 2: valid entity creation inputs pass schema validation", () => {
  it("accepts valid deal inputs", () => {
    fc.assert(
      fc.property(
        fc.record({
          dealName: nonEmptyStringArb,
          partnerId: nonEmptyStringArb,
          costPrice: fc.float({ min: 0, max: 10_000_000, noNaN: true }),
          sellingPrice: fc.float({ min: 0, max: 10_000_000, noNaN: true }),
          brandName: fc.option(nonEmptyStringArb, { nil: undefined }),
          baseMarginPolicy: baseMarginPolicyArb,
        }),
        (payload) => {
          expect(createDealSchema.safeParse(payload).success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts valid partner inputs", () => {
    fc.assert(
      fc.property(
        fc.record({
          name: nonEmptyStringArb,
          type: fc.constantFrom(...PARTNER_TYPES),
          contactInfo: fc.option(nonEmptyStringArb, { nil: undefined }),
          bankAccount: fc.option(nonEmptyStringArb, { nil: undefined }),
        }),
        (payload) => {
          expect(createPartnerSchema.safeParse(payload).success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts valid seller inputs", () => {
    fc.assert(
      fc.property(
        fc.record({
          name: nonEmptyStringArb,
          snsType: fc.constantFrom(...SNS_TYPES),
          snsHandle: nonEmptyStringArb,
          currentFollowers: fc.integer({ min: 0, max: 10_000_000 }),
          category: fc.option(nonEmptyStringArb, { nil: undefined }),
        }),
        (payload) => {
          expect(createSellerSchema.safeParse(payload).success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts valid campaign inputs", () => {
    fc.assert(
      fc.property(
        fc.record({
          dealId: nonEmptyStringArb,
          sellerId: nonEmptyStringArb,
          salesChannel: fc.constantFrom(
            "OWN_MALL",
            "OWN_MALL_NAVER",
            "OWN_MALL_KAKAO",
            "SELLER_MALL",
            "BRAND_MALL",
          ),
        }),
        fc.tuple(isoDateArb, isoDateArb),
        (payload, [left, right]) => {
          const startDate = left <= right ? left : right;
          const endDate = left <= right ? right : left;
          expect(
            campaignFormSchema.safeParse({ ...payload, startDate, endDate }).success,
          ).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
